/**
 * Provider failures: one description of what went wrong when the engine called an outside
 * service, so every caller (the job runner, operations, sync jobs, MCP, the CLI) reacts the
 * same way: whether a later retry can help, when, and whether a person has to act.
 *
 * A provider error is an `OpenOutboundError` with code `provider_error` (or
 * `provider_not_configured`) whose `details.failure` is a {@link Failure}. Build them with
 * {@link providerFailure}. Read any error with {@link failureOf}, {@link isRetryable} and
 * {@link retryAfterOf} instead of checking `details.reason` or `details.retryable` by hand:
 * errors built before this module existed are understood too.
 */
import { z } from "zod";
import {
  type ErrorCode,
  isJobWaitError,
  isOpenOutboundError,
  OpenOutboundError,
} from "./errors.js";

export const FAILURE_CLASSES = [
  "timeout",
  "network",
  "unavailable",
  "rate_limited",
  "quota_exhausted",
  "auth_invalid",
  "forbidden",
  "not_found",
  "bad_request",
  "malformed",
  "refused",
  "outcome_unknown",
] as const;
/**
 * What went wrong, from the engine's point of view:
 * - `timeout`: no answer in time. `network`: could not connect. `unavailable`: server error or
 *   overloaded. `rate_limited`: a short limit, wait `retry_after_s`. These four are retryable.
 * - `quota_exhausted`: credits or quota used up. `auth_invalid`: credentials rejected, revoked
 *   or expired. `forbidden`: the credentials work but lack a permission or plan feature.
 * - `not_found`: the thing asked for does not exist. `bad_request`: the provider rejected the
 *   input. `malformed`: the answer cannot be read or has the wrong shape. `refused`: the
 *   provider declined on policy (limits, restrictions, blocked address).
 * - `outcome_unknown`: a write that may or may not have happened. Never retried blindly.
 */
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export const FAILURE_SCOPES = ["call", "account", "provider"] as const;
/** How far a failure reaches: this call only, the credentials or account, or the whole provider. */
export type FailureScope = (typeof FAILURE_SCOPES)[number];

/** Stored in `details.failure` of a provider error, in job errors and in per-item results. */
export interface Failure {
  class: FailureClass;
  /**
   * Whether the engine may repeat the call by itself. False also for a paid call that may
   * already have used credits (`timeout`, `network`), where asking again later can still help.
   */
  retryable: boolean;
  scope: FailureScope;
  /** Provider id, e.g. "apollo". */
  provider?: string;
  /** Seconds the provider asked to wait (Retry-After, quota reset). */
  retry_after_s?: number;
  /** What the provider answered with: an HTTP status or an SMTP reply code. */
  upstream_status?: number;
}

/** Output schema for a {@link Failure}, for operations that return one. */
export const failureSchema = z.object({
  class: z.enum(FAILURE_CLASSES),
  retryable: z
    .boolean()
    .describe(
      "Whether the engine may repeat the call by itself; when false, the class says why (a provider to fix, a call that would fail again, or a paid call that may already have used credits)",
    ),
  scope: z.enum(FAILURE_SCOPES).describe("call | account | provider"),
  provider: z.string().optional(),
  retry_after_s: z.number().optional().describe("Seconds to wait before a retry"),
  upstream_status: z.number().optional().describe("HTTP status or SMTP code the provider sent"),
});

/** Timeout for one provider request when the provider does not set its own. */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;

/** Longest wait taken from a provider's Retry-After (longer values are cut to this). */
export const MAX_RETRY_AFTER_S = 86_400;

/** Error codes that retrying cannot fix. */
export const PERMANENT_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "validation_failed",
  "unauthorized",
  "forbidden",
  "not_found",
  "unsupported",
  "suppressed",
  "provider_not_configured",
  "budget_exceeded",
  "idempotency_mismatch",
  "approval_required",
  "workspace_paused",
]);

interface ClassInfo {
  retryable: boolean;
  scope: FailureScope;
  message(name: string, status: number | undefined): string;
  hint(name: string): string;
}

const CLASS_INFO: Record<FailureClass, ClassInfo> = {
  timeout: {
    retryable: true,
    scope: "call",
    message: (name) => `${name} did not answer in time.`,
    hint: () =>
      "It is retried automatically. If it keeps happening, check the provider's status page.",
  },
  network: {
    retryable: true,
    scope: "call",
    message: (name) => `${name} could not be reached.`,
    hint: () =>
      "It is retried automatically. If it keeps failing, check the network and the provider's status page.",
  },
  unavailable: {
    retryable: true,
    scope: "provider",
    message: (name, status) =>
      `${name} is having trouble${status === undefined ? "" : ` (server error ${status})`}.`,
    hint: () => "It is retried automatically in a few minutes.",
  },
  rate_limited: {
    retryable: true,
    scope: "account",
    message: (name) => `${name} rate limit reached.`,
    hint: () =>
      "It is retried automatically after the wait. Lower the volume if it keeps happening.",
  },
  quota_exhausted: {
    retryable: false,
    scope: "account",
    message: (name) => `${name} is out of credits or over its quota.`,
    hint: (name) =>
      `Top up or raise the quota in the ${name} account, or switch provider with manage_providers (action set).`,
  },
  auth_invalid: {
    retryable: false,
    scope: "account",
    message: (name) => `${name} rejected the credentials.`,
    hint: (name) =>
      `Check the ${name} credentials with manage_providers (action set), then run manage_providers (action test).`,
  },
  forbidden: {
    retryable: false,
    scope: "account",
    message: (name) => `${name} refused access with these credentials.`,
    hint: (name) =>
      `The credentials work but lack a permission or plan feature this needs. Check the ${name} account.`,
  },
  not_found: {
    retryable: false,
    scope: "call",
    message: (name) => `${name} did not find it.`,
    hint: () => "Check the id or the input. Retrying will not help.",
  },
  bad_request: {
    retryable: false,
    scope: "call",
    message: (name, status) =>
      `${name} rejected the request${status === undefined ? "" : ` (${status})`}.`,
    hint: () =>
      "Check the input. If it looks right, the provider API may have changed: report it with this message.",
  },
  malformed: {
    retryable: false,
    scope: "call",
    message: (name) => `${name} returned an unexpected response.`,
    hint: () =>
      "Try again later. If it persists, the provider API may have changed: report it with this message.",
  },
  refused: {
    retryable: false,
    scope: "call",
    message: (name) => `${name} refused the action.`,
    hint: () => "Read the reason in the message. Retrying will not help.",
  },
  outcome_unknown: {
    retryable: false,
    scope: "call",
    message: (name) => `${name} did not confirm whether it happened.`,
    hint: () =>
      "The engine does not repeat it blindly: it checks the result, or asks a person when it cannot.",
  },
};

/** Whether a class is worth a retry when nothing else is known. */
export function isRetryableClass(failureClass: FailureClass): boolean {
  return CLASS_INFO[failureClass].retryable;
}

/** Default scope of a class. */
export function scopeOfClass(failureClass: FailureClass): FailureScope {
  return CLASS_INFO[failureClass].scope;
}

export interface ProviderFailureInput {
  /** Provider id, e.g. "apollo". */
  provider: string;
  /** Display name for the message, e.g. "Apollo". Defaults to the id. */
  name?: string;
  class: FailureClass;
  /** Replaces the class's default message. */
  message?: string;
  /** Replaces the class's default hint. Say what to do next, naming the tool and action. */
  hint?: string;
  /** HTTP status or SMTP reply code the provider answered with. */
  upstreamStatus?: number;
  /** Wait the provider asked for, in seconds (cut to {@link MAX_RETRY_AFTER_S}). */
  retryAfterSeconds?: number;
  /**
   * Overrides the class default, e.g. a server error on a paid call that must not repeat.
   * Ignored for `outcome_unknown`, which is never retryable.
   */
  retryable?: boolean;
  /** Overrides the class default. */
  scope?: FailureScope;
  /** Extra context kept in `details` next to `failure`. Never put secrets here. */
  details?: Record<string, unknown>;
  cause?: unknown;
  /** Default `provider_error`. */
  code?: "provider_error" | "provider_not_configured";
}

/**
 * Builds a provider error with `details.failure`. `details` also keeps `provider`, `reason`
 * (the class unless `details.reason` is given, for older readers), `retryable` and `status`.
 */
export function providerFailure(input: ProviderFailureInput): OpenOutboundError {
  const info = CLASS_INFO[input.class];
  const retryable = input.class === "outcome_unknown" ? false : (input.retryable ?? info.retryable);
  const retryAfter =
    input.retryAfterSeconds === undefined
      ? undefined
      : Math.min(Math.max(0, Math.ceil(input.retryAfterSeconds)), MAX_RETRY_AFTER_S);
  const failure: Failure = {
    class: input.class,
    retryable,
    scope: input.scope ?? info.scope,
    provider: input.provider,
    ...(retryAfter === undefined ? {} : { retry_after_s: retryAfter }),
    ...(input.upstreamStatus === undefined ? {} : { upstream_status: input.upstreamStatus }),
  };
  const name = input.name ?? input.provider;
  return new OpenOutboundError(
    input.code ?? "provider_error",
    input.message ?? info.message(name, input.upstreamStatus),
    {
      hint: input.hint ?? info.hint(name),
      details: {
        reason: input.class,
        ...(input.upstreamStatus === undefined ? {} : { status: input.upstreamStatus }),
        ...input.details,
        provider: input.provider,
        retryable,
        failure,
      },
      ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
      ...(input.cause === undefined ? {} : { cause: input.cause }),
    },
  );
}

/** `details.reason` values used before this module, mapped to their class. */
const LEGACY_REASONS: Record<string, FailureClass> = {
  timeout: "timeout",
  network: "network",
  server_error: "unavailable",
  overloaded: "unavailable",
  rate_limited: "rate_limited",
  unauthorized: "auth_invalid",
  auth: "auth_invalid",
  expired: "auth_invalid",
  forbidden: "forbidden",
  payment_required: "quota_exhausted",
  quota: "quota_exhausted",
  usage_limit: "quota_exhausted",
  not_found: "not_found",
  model_not_found: "not_found",
  bad_request: "bad_request",
  too_large: "bad_request",
  context_window: "bad_request",
  malformed_response: "malformed",
  invalid_output: "malformed",
  refusal: "refused",
  declined: "refused",
  blocked_address: "refused",
  robots_disallowed: "refused",
  invalid_url: "bad_request",
};

function isFailure(value: unknown): value is Failure {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Failure>;
  return (
    typeof candidate.class === "string" &&
    (FAILURE_CLASSES as readonly string[]).includes(candidate.class) &&
    typeof candidate.retryable === "boolean" &&
    typeof candidate.scope === "string" &&
    (FAILURE_SCOPES as readonly string[]).includes(candidate.scope)
  );
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The failure an error describes, or null when it is not a provider failure. Reads
 * `details.failure`; for provider errors built without it, infers the class from
 * `details.reason`, then the upstream status, then `details.retryable` (a provider error that
 * says nothing counts as `unavailable`, retryable). Raw fetch errors (timeouts, refused or
 * reset connections, DNS lookups that failed) are `timeout` or `network`.
 */
export function failureOf(error: unknown): Failure | null {
  if (isOpenOutboundError(error)) {
    const details = error.details ?? {};
    if (isFailure(details.failure)) return details.failure;
    if (error.code !== "provider_error") return null;
    const status = numberOrUndefined(details.status) ?? numberOrUndefined(details.upstream_status);
    const reason = typeof details.reason === "string" ? LEGACY_REASONS[details.reason] : undefined;
    const explicit = typeof details.retryable === "boolean" ? details.retryable : undefined;
    const failureClass: FailureClass =
      reason ??
      (status === undefined ? undefined : classifyHttpStatus(status)) ??
      (explicit === false ? "refused" : "unavailable");
    const retryable =
      failureClass === "outcome_unknown" ? false : (explicit ?? isRetryableClass(failureClass));
    return {
      class: failureClass,
      retryable,
      scope: scopeOfClass(failureClass),
      ...(typeof details.provider === "string" ? { provider: details.provider } : {}),
      ...(error.retryAfterSeconds === undefined ? {} : { retry_after_s: error.retryAfterSeconds }),
      ...(status === undefined ? {} : { upstream_status: status }),
    };
  }
  if (isFetchError(error)) {
    const failureClass = classifyFetchError(error);
    return { class: failureClass, retryable: true, scope: "call" };
  }
  return null;
}

/**
 * The one answer to "is this worth trying again later?", for every caller: waits and
 * permanent error codes no, provider failures their own `retryable`, other engine errors unless
 * they say `details.retryable: false`, and anything unexpected yes (bounded by the caller's
 * attempts).
 */
export function isRetryable(error: unknown): boolean {
  if (isJobWaitError(error)) return false;
  if (isOpenOutboundError(error)) {
    if (PERMANENT_CODES.has(error.code)) return false;
    const failure = failureOf(error);
    if (failure) return failure.retryable;
    return error.details?.retryable !== false;
  }
  return failureOf(error)?.retryable ?? true;
}

/** Seconds to wait before retrying, when the error says. */
export function retryAfterOf(error: unknown): number | undefined {
  if (isOpenOutboundError(error) && error.retryAfterSeconds !== undefined) {
    return error.retryAfterSeconds;
  }
  return failureOf(error)?.retry_after_s;
}

/** Class for an HTTP status a provider answered with when the call did not succeed. */
export function classifyHttpStatus(status: number): FailureClass {
  if (status === 401) return "auth_invalid";
  if (status === 402) return "quota_exhausted";
  if (status === 403) return "forbidden";
  if (status === 404 || status === 410) return "not_found";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  if (status >= 400) return "bad_request";
  // A success or redirect where the call expected something else: not what was asked for.
  return "malformed";
}

const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  ...TIMEOUT_CODES,
]);

function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 3 && typeof current === "object" && current !== null; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") codes.push(code);
    current = (current as { cause?: unknown }).cause;
  }
  return codes;
}

function errorName(error: unknown): string | undefined {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name : undefined;
}

/** Whether an error comes from the network layer (fetch, sockets, DNS), not from an answer. */
export function isFetchError(error: unknown): boolean {
  if (isOpenOutboundError(error)) return false;
  const name = errorName(error);
  if (name === "TimeoutError" || name === "AbortError") return true;
  if (error instanceof TypeError && error.message === "fetch failed") return true;
  return errorCodes(error).some((code) => NETWORK_CODES.has(code));
}

/** `timeout` for timeouts and aborts, `network` for everything else that failed to connect. */
export function classifyFetchError(error: unknown): "timeout" | "network" {
  const name = errorName(error);
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  return errorCodes(error).some((code) => TIMEOUT_CODES.has(code)) ? "timeout" : "network";
}

/**
 * Seconds from a Retry-After header: a number of seconds or an HTTP date. Undefined when
 * missing or unreadable; cut to {@link MAX_RETRY_AFTER_S}.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (value === null || value === undefined) return undefined;
  const text = value.trim();
  if (!text) return undefined;
  const seconds = Number(text);
  if (Number.isFinite(seconds)) {
    return seconds < 0 ? undefined : Math.min(Math.ceil(seconds), MAX_RETRY_AFTER_S);
  }
  const date = Date.parse(text);
  if (Number.isNaN(date)) return undefined;
  return Math.min(Math.max(0, Math.ceil((date - now) / 1000)), MAX_RETRY_AFTER_S);
}

/**
 * The signal every provider request carries: a timeout, joined with the caller's signal (a job
 * that is cancelled or timed out) when there is one.
 */
export function providerSignal(
  timeoutMs: number = DEFAULT_PROVIDER_TIMEOUT_MS,
  parent?: AbortSignal,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

/** One line for notes, logs and lists, e.g. "apollo: rate_limited (429), retry after 30 s". */
export function describeFailure(failure: Failure): string {
  const status = failure.upstream_status === undefined ? "" : ` (${failure.upstream_status})`;
  const wait =
    failure.retry_after_s === undefined ? "" : `, retry after ${failure.retry_after_s} s`;
  const prefix = failure.provider ? `${failure.provider}: ` : "";
  return `${prefix}${failure.class}${status}${wait}`;
}

/**
 * What a call that gathers several pages or chunks got before it failed, carried in
 * `details.partial` of its failure: the items received (typed like the call's normal result
 * items), the credits spent when known, and an opaque value to pass back to continue.
 */
export interface PartialResult<T> {
  items: T[];
  credits?: number;
  resume?: unknown;
}

/** The partial result an error carries, or null. The caller knows the item type. */
export function partialOf<T>(error: unknown): PartialResult<T> | null {
  if (!isOpenOutboundError(error)) return null;
  const partial = error.details?.partial as Partial<PartialResult<T>> | undefined;
  if (typeof partial !== "object" || partial === null || !Array.isArray(partial.items)) return null;
  return {
    items: partial.items,
    ...(typeof partial.credits === "number" ? { credits: partial.credits } : {}),
    ...(partial.resume === undefined ? {} : { resume: partial.resume }),
  };
}
