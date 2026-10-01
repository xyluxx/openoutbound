/**
 * Provider health (spec 3): a provider whose credentials were rejected, whose access was
 * refused or whose quota is used up stops being called for that workspace, with one clear
 * problem, instead of failing call after call.
 *
 * - `auth_invalid`, `forbidden` and `quota_exhausted` failures that reach past the call (scope
 *   account or provider) open one `provider_down` problem per workspace, slot and provider (high,
 *   owner person) and pause the provider: calls fail at once with the stored failure, without a
 *   network call or credits. `auth_invalid` and `forbidden` pauses last until the credentials or
 *   settings change (`providers.set`, a new env key) or `providers.test` passes; a quota pause
 *   lasts `retry_after_s` (one hour when the provider gave none), then one trial call decides.
 * - Five `unavailable`, `timeout`, `network` or `outcome_unknown` failures in a row open the
 *   problem at normal severity without pausing. Any answer from the provider breaks the streak.
 * - A success resolves the problem. A person resolving it ends the pause at the next check.
 *
 * Instance-level keys used by a workspace count for that workspace. The state lives in the
 * provider cache (`kernel.providerCache.health`) and in the problem itself, which other
 * processes read when they resolve the provider and again once a minute while it is paused.
 * Brain providers keep `brain_down` (runtime/brain-health.ts); sandbox providers and providers
 * with `health: false` are never tracked.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { Clock } from "../core/clock.js";
import type { OpContext } from "../core/context.js";
import { isOpenOutboundError, type OpenOutboundError } from "../core/errors.js";
import {
  FAILURE_CLASSES,
  FAILURE_SCOPES,
  type Failure,
  type FailureClass,
  failureOf,
  providerFailure,
} from "../core/failures.js";
import type { Logger } from "../core/logger.js";
import type { Db } from "../db/client.js";
import { problems } from "../db/schema/index.js";
import { openProblem, resolveProblemsFor } from "../modules/problems/service.js";
import { BRAIN_REASON_CLASSES, type BrainFailureReason } from "../providers/brain/errors.js";
import type { Slot, SlotInterfaces } from "../providers/types.js";

/** Classes that pause a provider when they reach past one call. */
export const PAUSE_CLASSES: ReadonlySet<FailureClass> = new Set<FailureClass>([
  "auth_invalid",
  "forbidden",
  "quota_exhausted",
]);
/** Classes that count towards a failing streak (the provider did not answer, or not in time). */
export const STREAK_CLASSES: ReadonlySet<FailureClass> = new Set<FailureClass>([
  "unavailable",
  "timeout",
  "network",
  "outcome_unknown",
]);
/** Failures in a row that open a `provider_down` problem at normal severity. */
export const FAILING_STREAK = 5;
/** How long a quota pause lasts when the provider did not say. */
export const QUOTA_PAUSE_S = 3600;
/** While a problem is open, the stored state is read again at most this often. */
export const HEALTH_RECHECK_MS = 60_000;

/** Calls of each slot that reach the provider: only these are paused and counted. */
export const HEALTH_METHODS: {
  [S in Exclude<Slot, "brain">]: ReadonlyArray<keyof SlotInterfaces[S]>;
} = {
  lead_source: ["searchPeople", "searchCompanies", "enrichPeople"],
  email_finder: ["findEmail"],
  email_verifier: ["verify"],
  research: ["search", "fetch", "answer"],
  signals: ["collect"],
  linkedin: [
    "createAuthLink",
    "listAccounts",
    "getProfile",
    "visitProfile",
    "sendInvite",
    "sendMessage",
    "listRecentPosts",
    "reactToPost",
    "commentOnPost",
    "listPendingInvites",
    "withdrawInvite",
    "syncMessages",
    "syncRelations",
  ],
  social: ["publish", "exchangeCode"],
  crm: [
    "upsertContact",
    "upsertDeal",
    "logNote",
    "findContactByEmail",
    "findDealForContact",
    "logActivity",
    "deleteContact",
  ],
};

/** Dedupe key of the `provider_down` problem of a slot and provider. */
export function providerDownKey(slot: Slot, provider: string): string {
  return `provider_down:${slot}:${provider}`;
}

interface Pause {
  failure: Failure;
  message: string;
  since: number;
  /** When one trial call may go through; null until the credentials change or a test passes. */
  until: number | null;
  /** Settings fingerprint at the time; a different one lets a trial call through. */
  settings: string | null;
}

/** One workspace, slot and provider. */
export interface ProviderHealthState {
  loaded: boolean;
  checkedAt: number;
  paused: Pause | null;
  /** The open problem, as this process knows it. */
  problem: "paused" | "failing" | null;
  streak: number;
  /** A trial call is under way. */
  trial: boolean;
  /** Changes when a pause starts, so a call that started before it cannot end it. */
  generation: number;
}

export type ProviderHealthStore = Map<string, ProviderHealthState>;

/** What `trackProviderHealth` needs to know about the instance it wraps. */
export interface HealthBinding {
  store: ProviderHealthStore;
  workspaceId: string;
  slot: Exclude<Slot, "brain">;
  provider: string;
  /** Display name, e.g. "Apollo". */
  name: string;
  /** Where the setting came from (workspace, instance, env, explicit). */
  level: string;
  /** Fingerprint of the credentials and config the instance was built with. */
  settings: string | null;
  clock: Clock;
  log: Logger;
  /** A context of the workspace for problem bookkeeping (system principal). */
  context: () => OpContext;
}

function stateKey(workspaceId: string, slot: Slot, provider: string): string {
  return `${workspaceId}:${slot}:${provider}`;
}

function stateOf(binding: Pick<HealthBinding, "store" | "workspaceId" | "slot" | "provider">) {
  const key = stateKey(binding.workspaceId, binding.slot, binding.provider);
  let state = binding.store.get(key);
  if (!state) {
    state = {
      loaded: false,
      checkedAt: 0,
      paused: null,
      problem: null,
      streak: 0,
      trial: false,
      generation: 0,
    };
    binding.store.set(key, state);
  }
  return state;
}

/**
 * Forgets what this process knows about a provider's health (every workspace when
 * `workspaceId` is null or missing; everything without a filter). The stored problems are left
 * alone: the providers admin resolves them.
 */
export function clearProviderHealth(
  store: { health: ProviderHealthStore },
  filter?: { workspaceId?: string | null; slot: Slot; provider: string },
): void {
  if (!filter) {
    store.health.clear();
    return;
  }
  const suffix = `:${filter.slot}:${filter.provider}`;
  for (const key of store.health.keys()) {
    if (!key.endsWith(suffix)) continue;
    if (filter.workspaceId && !key.startsWith(`${filter.workspaceId}:`)) continue;
    store.health.delete(key);
  }
}

// --- Stored state ----------------------------------------------------------------------------

function isFailure(value: unknown): value is Failure {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Failure>;
  return (
    typeof candidate.class === "string" &&
    (FAILURE_CLASSES as readonly string[]).includes(candidate.class) &&
    typeof candidate.retryable === "boolean" &&
    typeof candidate.scope === "string" &&
    (FAILURE_SCOPES as readonly string[]).includes(candidate.scope)
  );
}

function timeOf(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

/** The pause a stored problem describes, or null. */
function pauseOf(row: { data: unknown; created_at: Date }): Pause | null {
  const data = (row.data ?? {}) as Record<string, unknown>;
  if (data.paused !== true || !isFailure(data.failure)) return null;
  return {
    failure: data.failure,
    message: typeof data.message === "string" ? data.message : "",
    since: timeOf(data.since) ?? row.created_at.getTime(),
    until: timeOf(data.paused_until),
    settings: typeof data.settings_version === "string" ? data.settings_version : null,
  };
}

/**
 * Reads the stored problem of the binding's provider into this process's state: on first use,
 * then at most once a minute while a problem is open (so a problem resolved elsewhere, by a
 * person or another process, ends the pause here too).
 */
export async function loadProviderHealth(db: Db, binding: HealthBinding): Promise<void> {
  const state = stateOf(binding);
  const now = binding.clock.now().getTime();
  const open = state.paused !== null || state.problem !== null;
  if (state.loaded && (!open || now - state.checkedAt < HEALTH_RECHECK_MS)) return;
  const [row] = await db
    .select({ data: problems.data, created_at: problems.created_at })
    .from(problems)
    .where(
      and(
        eq(problems.workspace_id, binding.workspaceId),
        eq(problems.dedupe_key, providerDownKey(binding.slot, binding.provider)),
        ne(problems.status, "resolved"),
      ),
    )
    .limit(1);
  state.loaded = true;
  state.checkedAt = now;
  if (!row) {
    state.paused = null;
    state.problem = null;
    return;
  }
  const pause = pauseOf(row);
  if (pause && !state.paused) state.generation += 1;
  state.paused = pause;
  state.problem = pause ? "paused" : "failing";
}

// --- Deferred bookkeeping --------------------------------------------------------------------

const deferred = new AsyncLocalStorage<Array<() => Promise<void>>>();

/**
 * Runs `fn` and stores the health outcome of provider calls made inside it only after it ends.
 * Wrap code that calls providers inside an open database transaction (the CRM lock): on PGlite
 * the problem write would otherwise wait for that transaction forever. The pause itself takes
 * effect at once either way.
 */
export async function withDeferredHealth<T>(fn: () => Promise<T>): Promise<T> {
  if (deferred.getStore()) return fn();
  const queue: Array<() => Promise<void>> = [];
  try {
    return await deferred.run(queue, fn);
  } finally {
    for (const task of queue.splice(0)) await task();
  }
}

async function write(binding: HealthBinding, task: (ctx: OpContext) => Promise<unknown>) {
  const run = async () => {
    try {
      await task(binding.context());
    } catch (error) {
      binding.log.warn(
        {
          slot: binding.slot,
          provider: binding.provider,
          err: error instanceof Error ? error.message : String(error),
        },
        "provider health: could not update the provider_down problem",
      );
    }
  };
  const queue = deferred.getStore();
  if (queue) queue.push(run);
  else await run();
}

// --- Problems --------------------------------------------------------------------------------

const PAUSE_TITLES: Partial<Record<FailureClass, string>> = {
  auth_invalid: "its credentials were rejected",
  forbidden: "its key may not do this",
  quota_exhausted: "its credits or quota are used up",
};

function where(binding: Pick<HealthBinding, "slot" | "provider">): string {
  return `slot ${binding.slot}, provider ${binding.provider}`;
}

/** The remedy of a `provider_down` problem (and the hint of a paused call). */
export function providerDownRemedy(
  binding: Pick<HealthBinding, "name" | "slot" | "provider">,
  failureClass: FailureClass | null,
  until: number | null = null,
): string {
  const at = `(${where(binding)})`;
  switch (failureClass) {
    case "auth_invalid":
      return `Store working credentials with manage_providers action set ${at}, or fix them at ${binding.name} and run manage_providers action test ${at}: a passing test resumes it.`;
    case "forbidden":
      return `Give the key the permission or plan it lacks at ${binding.name}, then run manage_providers action test ${at} to resume it; manage_providers action set ${at} with another key also resumes it.`;
    case "quota_exhausted":
      return `Add credits or raise the quota at ${binding.name}, then run manage_providers action test ${at} to resume it now; manage_providers action set ${at} with another key also resumes it.${until === null ? "" : ` Otherwise one call tries again at ${new Date(until).toISOString()}.`}`;
    default:
      return `Check ${binding.name}'s status page and the network, then run manage_providers action test ${at}. If it stays down, configure another provider for the slot with manage_providers action set. The problem closes by itself after the next successful call.`;
  }
}

function untilText(pause: Pause): string {
  if (pause.until === null) return "until its credentials change or a provider test passes";
  return `until ${new Date(pause.until).toISOString()}, when one call checks whether it works again`;
}

function short(text: string): string {
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

async function openPause(binding: HealthBinding, pause: Pause): Promise<void> {
  await write(binding, (ctx) =>
    openProblem(ctx, {
      kind: "provider_down",
      severity: "high",
      owner: "person",
      title: `${binding.name} is paused: ${PAUSE_TITLES[pause.failure.class] ?? pause.failure.class}`,
      reason: `${pause.message} Calls to ${binding.name} for this workspace stop at once, without reaching it, ${untilText(pause)}.`,
      remedy: providerDownRemedy(binding, pause.failure.class, pause.until),
      data: {
        slot: binding.slot,
        provider: binding.provider,
        level: binding.level,
        failure: pause.failure,
        message: pause.message,
        paused: true,
        since: new Date(pause.since).toISOString(),
        paused_until: pause.until === null ? null : new Date(pause.until).toISOString(),
        settings_version: pause.settings,
      },
      dedupeKey: providerDownKey(binding.slot, binding.provider),
    }),
  );
}

async function openFailing(
  binding: HealthBinding,
  failure: Failure,
  message: string,
  streak: number,
): Promise<void> {
  await write(binding, (ctx) =>
    openProblem(ctx, {
      kind: "provider_down",
      severity: "normal",
      owner: "person",
      title: `${binding.name} keeps failing`,
      reason: `The last ${streak} calls to ${binding.name} failed (the latest: ${failure.class}): ${message} Calls still go through.`,
      remedy: providerDownRemedy(binding, null),
      data: {
        slot: binding.slot,
        provider: binding.provider,
        level: binding.level,
        failure,
        message,
        paused: false,
        streak,
      },
      dedupeKey: providerDownKey(binding.slot, binding.provider),
    }),
  );
}

// --- Calls -----------------------------------------------------------------------------------

/** The error of a call made while the provider is paused: the stored failure, not retried. */
function pausedError(binding: HealthBinding, pause: Pause, now: number): OpenOutboundError {
  const wait =
    pause.until === null ? undefined : Math.max(1, Math.ceil((pause.until - now) / 1000));
  return providerFailure({
    provider: binding.provider,
    name: binding.name,
    class: pause.failure.class,
    scope: pause.failure.scope,
    retryable: false,
    message: `${binding.name} is paused for this workspace since ${new Date(pause.since).toISOString()}: ${pause.message}`,
    hint: providerDownRemedy(binding, pause.failure.class, pause.until),
    ...(pause.failure.upstream_status === undefined
      ? {}
      : { upstreamStatus: pause.failure.upstream_status }),
    ...(wait === undefined ? {} : { retryAfterSeconds: wait }),
    details: {
      paused: true,
      paused_since: new Date(pause.since).toISOString(),
      ...(pause.until === null ? {} : { paused_until: new Date(pause.until).toISOString() }),
    },
  });
}

/** "go", "trial" (the one call that checks a pause) or the pause that blocks the call. */
function admit(state: ProviderHealthState, binding: HealthBinding, now: number) {
  const pause = state.paused;
  if (!pause) return "go" as const;
  const changed =
    pause.settings !== null && binding.settings !== null && pause.settings !== binding.settings;
  const due = pause.until !== null && now >= pause.until;
  if ((changed || due) && !state.trial) return "trial" as const;
  return pause;
}

async function recordSuccess(
  binding: HealthBinding,
  state: ProviderHealthState,
  generation: number,
): Promise<void> {
  state.streak = 0;
  // A call that started before the pause says nothing about it.
  if (state.paused && generation !== state.generation) return;
  const open = state.problem !== null;
  state.paused = null;
  state.problem = null;
  if (!open) return;
  await write(binding, (ctx) =>
    resolveProblemsFor(
      ctx,
      { dedupeKey: providerDownKey(binding.slot, binding.provider) },
      `${binding.name} answered again.`,
    ),
  );
}

async function recordFailure(
  binding: HealthBinding,
  state: ProviderHealthState,
  error: unknown,
): Promise<void> {
  const failure = failureOf(error);
  if (!failure) return;
  const now = binding.clock.now().getTime();
  const message = short(isOpenOutboundError(error) ? error.message : String(error));
  if (PAUSE_CLASSES.has(failure.class) && failure.scope !== "call") {
    state.streak = 0;
    if (!state.paused) state.generation += 1;
    const pause: Pause = {
      failure: { ...failure, provider: failure.provider ?? binding.provider },
      message,
      since: state.paused?.since ?? now,
      until:
        failure.class === "quota_exhausted"
          ? now + (failure.retry_after_s ?? QUOTA_PAUSE_S) * 1000
          : null,
      settings: binding.settings,
    };
    state.paused = pause;
    state.problem = "paused";
    state.loaded = true;
    state.checkedAt = now;
    await openPause(binding, pause);
    return;
  }
  // `unavailable` about one item (scope call, e.g. one web page) says nothing of the provider.
  const counts =
    STREAK_CLASSES.has(failure.class) &&
    !(failure.class === "unavailable" && failure.scope === "call");
  if (counts) {
    state.streak += 1;
    if (state.streak >= FAILING_STREAK && state.problem === null) {
      state.problem = "failing";
      state.checkedAt = now;
      await openFailing(binding, failure, message, state.streak);
    }
    return;
  }
  // The provider answered (a refusal of this input, a rate limit...): it is reachable.
  state.streak = 0;
}

async function guarded<T>(binding: HealthBinding, call: () => Promise<T>): Promise<T> {
  const state = stateOf(binding);
  const admission = admit(state, binding, binding.clock.now().getTime());
  if (typeof admission === "object") {
    throw pausedError(binding, admission, binding.clock.now().getTime());
  }
  const generation = state.generation;
  if (admission === "trial") state.trial = true;
  try {
    const result = await call();
    await recordSuccess(binding, state, generation);
    return result;
  } catch (error) {
    await recordFailure(binding, state, error);
    throw error;
  } finally {
    if (admission === "trial") state.trial = false;
  }
}

/**
 * The instance with its outside calls (HEALTH_METHODS) guarded: paused calls fail at once, and
 * every outcome feeds the provider's health. Everything else passes through untouched.
 */
export function trackProviderHealth<T extends object>(instance: T, binding: HealthBinding): T {
  const methods = new Set<PropertyKey>(HEALTH_METHODS[binding.slot] as readonly PropertyKey[]);
  const wrapped = new Map<PropertyKey, unknown>();
  return new Proxy(instance, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function" || !methods.has(property)) return value;
      let guard = wrapped.get(property);
      if (!guard) {
        guard = (...args: unknown[]) =>
          guarded(binding, () => Promise.resolve(Reflect.apply(value, target, args)));
        wrapped.set(property, guard);
      }
      return guard;
    },
  });
}

// --- Reading -----------------------------------------------------------------------------------

export type ProviderHealthStatus = "ok" | "paused" | "failing";

/** A provider's health as `get_status` shows it. */
export interface ProviderHealthView {
  slot: string;
  provider: string;
  status: ProviderHealthStatus;
  class: FailureClass | null;
  since: Date | null;
  /** When one trial call goes through (quota pauses). */
  until: Date | null;
  /** What to do, naming the tool and action. */
  fix: string | null;
  title: string | null;
  problemId: string | null;
}

/** The health of a provider with no open problem. */
export function healthyView(slot: string, provider: string): ProviderHealthView {
  return {
    slot,
    provider,
    status: "ok",
    class: null,
    since: null,
    until: null,
    fix: null,
    title: null,
    problemId: null,
  };
}

/**
 * The open `provider_down` problems of a workspace (and its `brain_down` problems, as failing
 * brains) as health views, by `<slot>:<provider>`. Read from the database, so every process
 * (CLI, server) gives the same answer.
 */
export async function readProviderHealth(
  db: Db,
  workspaceId: string,
): Promise<Map<string, ProviderHealthView>> {
  const rows = await db
    .select({
      id: problems.id,
      kind: problems.kind,
      data: problems.data,
      created_at: problems.created_at,
      title: problems.title,
      remedy: problems.remedy,
    })
    .from(problems)
    .where(
      and(
        eq(problems.workspace_id, workspaceId),
        inArray(problems.kind, ["provider_down", "brain_down"]),
        ne(problems.status, "resolved"),
      ),
    )
    .orderBy(asc(problems.created_at), asc(problems.id));
  const out = new Map<string, ProviderHealthView>();
  for (const row of rows) {
    const data = (row.data ?? {}) as Record<string, unknown>;
    if (typeof data.provider !== "string") continue;
    const brain = row.kind === "brain_down";
    const slot = brain ? "brain" : data.slot;
    if (typeof slot !== "string") continue;
    const key = `${slot}:${data.provider}`;
    if (out.has(key)) continue;
    const pause = brain ? null : pauseOf(row);
    const failure = isFailure(data.failure) ? data.failure : null;
    const brainClass =
      brain && typeof data.reason === "string"
        ? (BRAIN_REASON_CLASSES[data.reason as BrainFailureReason] ?? null)
        : null;
    out.set(key, {
      slot,
      provider: data.provider,
      status: pause ? "paused" : "failing",
      class: failure?.class ?? brainClass,
      since: new Date(pause?.since ?? row.created_at.getTime()),
      until: pause?.until === null || pause?.until === undefined ? null : new Date(pause.until),
      fix: row.remedy,
      title: row.title,
      problemId: row.id,
    });
  }
  return out;
}
