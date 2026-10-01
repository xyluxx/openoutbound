import type { PromptDefinition } from "../brain/prompt.js";
import type { Db } from "../db/client.js";
import type { Approval, Job, Workspace } from "../db/schema/index.js";
import type { Slot, SlotInterfaces } from "../providers/types.js";
import type { Clock } from "./clock.js";
import type { EngineConfig } from "./config.js";
import {
  type ApprovalKind,
  type AuditStatus,
  type Effect,
  type JobStatus,
  type ModelTier,
  type PrincipalType,
  SCOPES,
  type Scope,
  type Via,
} from "./enums.js";
import { type ErrorCode, OpenOutboundError } from "./errors.js";
import type { EventData, EventSubject, EventType } from "./events.js";
import type { Logger } from "./logger.js";

export type { Clock } from "./clock.js";
export type { EngineConfig } from "./config.js";
export type { Effect, PrincipalType, Scope, Via } from "./enums.js";
export type { Logger } from "./logger.js";

/** Every scope, for local admins and system principals. */
export const ALL_SCOPES: readonly Scope[] = SCOPES;

// --- Principal -------------------------------------------------------------------------------

/** Who is calling (spec 5.2). */
export interface Principal {
  type: PrincipalType;
  /** API key id, `local-admin`, `local-agent` or `system`. */
  id: string;
  name: string;
  scopes: Scope[];
  /** Workspace the principal is bound to; null for instance-level keys and local principals. */
  workspaceId: string | null;
  via: Via;
  /**
   * Set only by the engine, when it applies a change that a person holding `approve` already
   * approved as a whole (an agent's strategy proposal): the operation's own approval gate lets
   * it through instead of asking that person a second time. Doors never set it.
   */
  approvedBy?: ActorRef;
  /**
   * Who holds this API key, set at authenticate: the key itself when a person created it, else
   * the one controlling its creator (an agent or service holds every key it mints, directly or
   * further down, so they all answer to the first key a person created, or to `local-agent`).
   * Principals with the same controller count as one requester for approvals. Absent: the id.
   */
  controller?: string;
}

/** Compact principal reference stored in jsonb columns (`requested_by`, `created_by`, ...). */
export interface ActorRef {
  type: PrincipalType;
  id: string;
  name: string;
  via?: Via;
}

/** The engine itself (worker, scheduler, maintenance). Has every scope. */
export const SYSTEM_PRINCIPAL: Principal = Object.freeze({
  type: "system",
  id: "system",
  name: "OpenOutbound",
  scopes: [...SCOPES],
  workspaceId: null,
  via: "system",
}) as Principal;

export function actorRef(principal: Principal): ActorRef {
  return { type: principal.type, id: principal.id, name: principal.name, via: principal.via };
}

// --- Jobs ------------------------------------------------------------------------------------

export interface EnqueueOptions {
  /** Owning workspace. Defaults to the calling context's workspace (null for instance jobs). */
  workspaceId?: string | null;
  /** Earliest run time. Default: now. */
  runAt?: Date;
  /** Alternative to runAt: run after this many milliseconds. */
  delayMs?: number;
  /** Higher runs first. Default 0. */
  priority?: number;
  /** Overrides the job definition's maxAttempts. */
  maxAttempts?: number;
  /**
   * At most one queued/running/waiting job per key. Enqueueing a duplicate returns the existing
   * job with `deduplicated: true` instead of failing.
   */
  singletonKey?: string;
}

/** Returned by `enqueue`. Matches `jobHandleOutput`, so handlers can return it directly. */
export interface JobHandle {
  job_id: string;
  status: JobStatus;
  /** True when an existing job with the same singleton key was returned. */
  deduplicated?: boolean;
}

/** Progress reported by long jobs; shown by `jobs.get`. */
export interface JobProgress {
  done?: number;
  total?: number;
  /** Short machine label, e.g. "fetching", "scoring". */
  stage?: string;
  /** Human-readable status line. */
  message?: string;
  data?: Record<string, unknown>;
}

/** Durable job queue backed by the `jobs` table. */
export interface JobQueue {
  enqueue(name: string, payload?: unknown, options?: EnqueueOptions): Promise<JobHandle>;
  get(jobId: string): Promise<Job | null>;
  /** Cancels a queued or waiting job. Returns false when it already ran or does not exist. */
  cancel(jobId: string): Promise<boolean>;
  /** Re-queues every `waiting` job whose `wait_for` equals the key. Returns how many woke. */
  wake(waitFor: string): Promise<number>;
}

// --- Events ----------------------------------------------------------------------------------

export interface EmitInput<T extends EventType> {
  /** The record the event is about, e.g. `{ type: "person", id }`. */
  subject?: EventSubject | null;
  data: EventData[T];
  /** Defaults to the calling context's workspace. Events always belong to a workspace. */
  workspaceId?: string;
}

/**
 * Typed event bus (spec 5.5). `emit` writes an `events` row, enqueues a durable job per
 * in-process subscriber (`onEvent`) and enqueues webhook deliveries.
 */
export interface EventBus {
  emit<T extends EventType>(type: T, input: EmitInput<T>): Promise<{ id: string }>;
}

// --- Audit -----------------------------------------------------------------------------------

export interface AuditTarget {
  type: string;
  id: string;
}

/**
 * One audit line. The context-bound log fills `workspaceId`, `actor` and `via` from the
 * current context when omitted. `input` is redacted by the log (secrets removed, long message
 * bodies truncated to 500 chars).
 */
export interface AuditEntry {
  operation: string;
  effect: Effect;
  status: AuditStatus;
  target?: AuditTarget | null;
  reason?: string | null;
  summary?: string | null;
  input?: unknown;
  errorCode?: ErrorCode | null;
  workspaceId?: string | null;
  actor?: ActorRef;
  via?: Via;
  occurredAt?: Date;
}

export interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
}

// --- Approvals -------------------------------------------------------------------------------

export interface ApprovalRequest {
  kind: ApprovalKind;
  /** One line, e.g. "Send email to Dana Reyes (Harbor Dental)". */
  title: string;
  /** What will happen if approved; shown to reviewers and returned to agents. */
  summary: string;
  /** Everything the resolver needs to apply the decision (and fields reviewers may edit). */
  payload: Record<string, unknown>;
  target?: AuditTarget | null;
  /** Default: now + settings.approvals.expire_days (7). */
  expiresAt?: Date;
  /** Defaults to the calling context's workspace. */
  workspaceId?: string;
  /**
   * Replace older pending approvals of the same kind and target (e.g. a newer launch request
   * with fresh numbers). An identical pending request is always reused, with or without this.
   */
  supersede?: boolean;
}

export interface ApprovalCancelFilter {
  id?: string;
  target?: AuditTarget;
  kind?: ApprovalKind;
}

/**
 * Creates pending approvals (and emits `approval.requested`). Decisions are made through the
 * approvals operations, which call the kind's registered `ApprovalResolver`.
 */
export interface ApprovalService {
  /**
   * Stores a pending approval. When a pending approval of the same kind and target with the same
   * payload exists, returns it (`deduplicated: true`) instead of creating another.
   */
  request(request: ApprovalRequest): Promise<{ id: string; deduplicated?: boolean }>;
  /** Cancels matching pending approvals (e.g. when an enrollment stops). Returns the count. */
  cancel(filter: ApprovalCancelFilter, reason?: string): Promise<number>;
}

/** A decision being applied by a resolver. */
export interface ApprovalDecision {
  decision: "approve" | "reject" | "edit";
  /** For `edit`: payload fields the reviewer changed (for messages: subject/body). */
  edits?: Record<string, unknown>;
  note?: string;
  decidedBy: ActorRef;
}

export type { Approval };

// --- Usage and budgets -----------------------------------------------------------------------

export interface UsageRecordInput {
  /** Defaults to the calling context's workspace. */
  workspaceId?: string | null;
  slot: Slot;
  provider: string;
  /** Operation id, prompt id or job name that caused the spend. */
  operation: string;
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  credits?: number;
  costUsd?: number | null;
  jobId?: string | null;
}

export interface UsageTotals {
  /** Sum of cost_usd for slot `brain` this calendar month (UTC). */
  aiCostUsd: number;
  /** Sum of credits for every other slot this month. */
  dataCredits: number;
  /** Sum of cost_usd for every other slot this month (when providers report it). */
  dataCostUsd: number;
}

export type BudgetKind = "ai" | "data";

/** A workspace's monthly budget of one kind, with what is used and left this month. */
export interface BudgetStatus {
  kind: BudgetKind;
  /** Monthly budget (USD for ai, credits for data); null means no limit. */
  budget: number | null;
  used: number;
  /** What is left this month (never below 0); null when there is no budget. */
  remaining: number | null;
  unit: "USD" | "credits";
  /** The setting that holds the budget, e.g. settings.data.monthly_credit_budget. */
  setting: string;
}

export interface UsageMeter {
  record(entry: UsageRecordInput): Promise<void>;
  monthToDate(workspaceId: string): Promise<UsageTotals>;
  /**
   * Throws `budget_exceeded` (with a hint naming the setting) when the workspace is over its
   * monthly budget: `ai` checks settings.ai.monthly_budget_usd, `data` checks
   * settings.data.monthly_credit_budget. Null budgets never block.
   */
  assertBudget(workspaceId: string, kind: BudgetKind): Promise<void>;
  /** The monthly budget with what is used and left, for dry runs and pre-spend checks. */
  budgetStatus(workspaceId: string, kind: BudgetKind): Promise<BudgetStatus>;
  /**
   * Pre-spend check for a cost known up front: throws `budget_exceeded` with the numbers
   * ("needs 10 credits, 8 left this month") when `needed` is more than what is left. Null
   * budgets and costs of 0 never block.
   */
  assertCanSpend(
    workspaceId: string,
    kind: BudgetKind,
    needed: number,
    options?: SpendCheckOptions,
  ): Promise<void>;
}

export interface SpendCheckOptions {
  /** Replaces the default hint (lower the count, or raise the budget). */
  hint?: string | ((status: BudgetStatus) => string);
  /**
   * The most the spend can cost, when that is more than `needed` (a Google Maps search needs one
   * request to start and can take more). The check still compares `needed`; the refusal says
   * "needs at least".
   */
  most?: number;
}

// --- Vault -----------------------------------------------------------------------------------

/** AES-256-GCM ciphertext as stored in the `secrets` table (base64 fields). */
export interface EncryptedValue {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

export interface Vault {
  /** `aad` binds the ciphertext to a context (e.g. the secret name) so it cannot be moved. */
  encrypt(plaintext: string, aad?: string): EncryptedValue;
  decrypt(value: EncryptedValue, aad?: string): string;
  /** Creates or replaces the secret `(workspaceId, name)`; returns its id (stable on replace). */
  putSecret(workspaceId: string | null, name: string, value: string): Promise<string>;
  /**
   * Plaintext of a secret, or null when missing. Pass `workspaceId` whenever the id came from
   * user input: the secret must then belong to that workspace (null = instance secret).
   */
  getSecret(secretId: string, workspaceId?: string | null): Promise<string | null>;
  deleteSecret(secretId: string): Promise<void>;
}

// --- Safe fetch ------------------------------------------------------------------------------

export interface SafeFetchInit extends RequestInit {
  /** Check robots.txt (cached 24h) before fetching. Use for crawling websites. Default false. */
  respectRobots?: boolean;
  /** Default 15000. */
  timeoutMs?: number;
  /** Response body cap. Default 5 MB. Larger bodies fail with details.reason "too_large". */
  maxBytes?: number;
  /** Allow private/loopback/link-local targets. Default: config.allowPrivateNetwork. */
  allowPrivate?: boolean;
  /** Default 5. */
  maxRedirects?: number;
}

/**
 * Failure reasons, in `OpenOutboundError.details.reason`. `blocked_address` and
 * `robots_disallowed` use code `forbidden`; `invalid_url` uses `validation_failed`; the rest
 * use `provider_error` (with `retryAfterSeconds` when a host asked us to back off).
 */
export type SafeFetchFailure =
  | "invalid_url"
  | "blocked_address"
  | "robots_disallowed"
  | "timeout"
  | "too_large"
  | "too_many_redirects"
  | "network";

/**
 * fetch for URLs that come from data (websites, feeds, user input): blocks private and metadata
 * IPs after DNS resolution (re-checked on redirects), caps time and size, sends the
 * OpenOutbound user agent. Non-2xx responses are returned, not thrown.
 */
export type SafeFetch = (input: string | URL, init?: SafeFetchInit) => Promise<Response>;

// --- DNS -------------------------------------------------------------------------------------

/**
 * DNS record lookups for code that reads records itself (tech detection reads MX and TXT, the
 * mailbox DNS check reads MX, SPF, DKIM and DMARC). Fetching does not need it: ctx.fetch
 * resolves and checks hosts on its own. Failures reject with Node's DNS errors (code
 * ENOTFOUND, ENODATA, ETIMEOUT...). Tests use a fake.
 */
export interface DnsResolver {
  resolveMx(domain: string): Promise<Array<{ exchange: string; priority: number }>>;
  resolveTxt(name: string): Promise<string[][]>;
}

// --- Providers -------------------------------------------------------------------------------

export interface ProviderGetOptions {
  /** A specific provider id; default: the highest-priority enabled provider for the slot. */
  id?: string;
}

/**
 * Resolves configured provider instances for the current workspace (workspace setting ->
 * instance setting -> env var). Sandbox workspaces always get sandbox providers.
 */
export interface ProviderResolver {
  /** Throws `provider_not_configured` with a hint naming the command that fixes it. */
  get<S extends Slot>(slot: S, options?: ProviderGetOptions): Promise<SlotInterfaces[S]>;
  tryGet<S extends Slot>(slot: S, options?: ProviderGetOptions): Promise<SlotInterfaces[S] | null>;
  /** Every enabled provider for the slot, highest priority first. */
  list<S extends Slot>(slot: S): Promise<Array<SlotInterfaces[S]>>;
}

// --- Brain -----------------------------------------------------------------------------------

export interface BrainRunOptions {
  /** Overrides the prompt's tier. */
  tier?: ModelTier;
  /** Forces a model id (skips tier and task_models resolution). */
  model?: string;
  /** Forces a brain provider id. */
  provider?: string;
  /** Never answer from the backup brain (`ai.fallback_provider`), for example in a brain test. */
  noFallback?: boolean;
  /** Stable key for agent-brain tasks and retries (e.g. `write:msg_...`). */
  taskKey?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Defaults to the calling context's workspace. */
  workspaceId?: string | null;
  jobId?: string;
}

export interface BrainResult<T> {
  /** Schema-validated output. */
  output: T;
  /** Raw model text. */
  text: string;
  provider: string;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    /** Null when the provider cannot price the call (e.g. CLI brains). */
    costUsd: number | null;
  };
  /** True when the first output failed validation and the repair retry fixed it. */
  repaired: boolean;
  durationMs: number;
}

/**
 * Runs versioned prompts (spec 11.2): resolves provider + model by tier, validates output
 * (one repair retry), meters usage, enforces the AI budget. Throws `JobWaitError` in agent-brain
 * mode while the agent has not answered yet.
 */
export interface BrainService {
  run<V, T>(
    prompt: PromptDefinition<V, T>,
    vars: V,
    options?: BrainRunOptions,
  ): Promise<BrainResult<T>>;
}

// --- Context ---------------------------------------------------------------------------------

/** Per-call request flags (spec 5.2). */
export interface OpRequest {
  idempotencyKey?: string;
  dryRun: boolean;
  /** Free text from the caller, recorded in audit. */
  reason?: string;
  responseFormat: "concise" | "detailed";
}

/** Everything an operation handler gets (spec 5.2). */
export interface OpContext {
  db: Db;
  /** Resolved workspace; null only for operations with `workspace: 'none' | 'optional'`. */
  workspace: Workspace | null;
  principal: Principal;
  config: EngineConfig;
  providers: ProviderResolver;
  brain: BrainService;
  jobs: JobQueue;
  events: EventBus;
  audit: AuditLog;
  approvals: ApprovalService;
  usage: UsageMeter;
  vault: Vault;
  fetch: SafeFetch;
  dns: DnsResolver;
  clock: Clock;
  log: Logger;
  request: OpRequest;
}

/** The job being run. */
export interface RunningJob {
  id: string;
  name: string;
  /** 1-based attempt number. */
  attempt: number;
  maxAttempts: number;
  workspaceId: string | null;
  singletonKey: string | null;
  /** Aborted when the job times out or the worker shuts down. */
  signal: AbortSignal;
}

/** Context for job and event handlers: an OpContext with the system principal plus job info. */
export interface JobContext extends OpContext {
  job: RunningJob;
  /** Saves progress on the job row (visible through `jobs.get`). */
  setProgress(progress: JobProgress): Promise<void>;
}

/** The context workspace, or a `validation_failed` error when there is none. */
export function requireWorkspace(ctx: Pick<OpContext, "workspace">): Workspace {
  if (!ctx.workspace) {
    throw new OpenOutboundError("validation_failed", "This operation needs a workspace.", {
      hint: "Pass `workspace` (id or slug), use a workspace API key, or set a default workspace.",
    });
  }
  return ctx.workspace;
}
