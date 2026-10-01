/**
 * Backup brain rules (settings `ai.fallback_provider` and `ai.agent_timeout_minutes`): which
 * failures let the backup brain answer, which prompts may not wait long for the agent brain, and
 * which failures mean a brain is down until someone fixes its settings.
 */
import { isOpenOutboundError, type OpenOutboundError } from "../core/errors.js";
import { type FailureClass, failureOf } from "../core/failures.js";

/** Provider id of the agent brain (the connected agent answers agent tasks). */
export const AGENT_BRAIN_ID = "agent";

/**
 * Prompts that must not wait long for the agent brain: when the agent leaves one open longer
 * than `ai.agent_timeout_minutes` and a backup brain is set, the backup brain answers it.
 */
export const TIME_SENSITIVE_PROMPTS: ReadonlySet<string> = new Set(["inbox.reply.classify"]);

/**
 * Failure classes on the provider's side (after the service's own retries): the main brain
 * could not serve the call, so the backup brain may. Invalid output (`malformed`), refusals
 * (`refused`) and inputs that are too large (`bad_request`) are about the call itself and never
 * fall back; neither does a call the caller cancelled (reason `aborted`). An answer that is not
 * the API's format at all (reason `malformed_response`: a wrong base_url, a proxy page) is the
 * provider's side, so it falls back and marks the brain down.
 */
export const FALLBACK_CLASSES: ReadonlySet<FailureClass> = new Set<FailureClass>([
  "auth_invalid",
  "forbidden",
  "not_found",
  "rate_limited",
  "quota_exhausted",
  "unavailable",
  "timeout",
  "network",
]);

/**
 * Failures retrying cannot fix (classes below, not retryable): the brain stays down until its
 * settings or account are fixed.
 */
export const BRAIN_DOWN_CLASSES: ReadonlySet<FailureClass> = new Set<FailureClass>([
  "auth_invalid",
  "forbidden",
  "quota_exhausted",
  "not_found",
]);

/** Remedy of `brain_down` problems. */
export const BRAIN_DOWN_REMEDY = "Fix the brain settings with manage_providers, then test_brain.";

/** Provider name of the `brain_down` problem when the workspace has no brain configured at all. */
export const NO_BRAIN_PROVIDER = "none";

/** Prefix of the wait key of jobs parked until the workspace has a brain. */
export const BRAIN_WAIT_PREFIX = "brain:configured:";

/**
 * The key a job waits on while its workspace has no usable brain configured; setting a brain
 * provider (`providers.set`, slot brain) wakes it.
 */
export function brainConfiguredWaitKey(workspaceId: string): string {
  return `${BRAIN_WAIT_PREFIX}${workspaceId}`;
}

/** How long a job waits for a brain before it checks again (a missed wake-up). */
export const BRAIN_WAIT_RECHECK_MS = 60 * 60_000;

function reasonOf(error: OpenOutboundError): string | null {
  const reason = error.details?.reason;
  return typeof reason === "string" ? reason : null;
}

/** The failure reason of a brain error for logs and problems (the error code when it has none). */
export function failureReason(error: OpenOutboundError): string {
  return reasonOf(error) ?? error.code;
}

/** True when the backup brain may answer after this failure of the main brain. */
export function isFallbackFailure(error: unknown): error is OpenOutboundError {
  if (!isOpenOutboundError(error)) return false;
  if (error.code === "provider_not_configured") return true;
  if (error.code !== "provider_error" || reasonOf(error) === "aborted") return false;
  if (reasonOf(error) === "malformed_response") return true;
  const failure = failureOf(error);
  return failure !== null && FALLBACK_CLASSES.has(failure.class);
}

/** True when the failure means the provider is down until someone fixes it (opens `brain_down`). */
export function isBrainDownFailure(error: unknown): error is OpenOutboundError {
  if (!isOpenOutboundError(error)) return false;
  if (error.code === "provider_not_configured") return true;
  if (error.code !== "provider_error") return false;
  const failure = failureOf(error);
  if (failure === null || failure.retryable) return false;
  return BRAIN_DOWN_CLASSES.has(failure.class) || reasonOf(error) === "malformed_response";
}

/**
 * Hears about brain health so a person learns when a brain stops working: the runtime opens a
 * `brain_down` problem per provider and model on `down` and resolves it on the next `up` of that
 * provider and model. Calls must never throw into the brain call (the service catches and logs).
 */
export interface BrainHealthReporter {
  /** A provider the workspace relies on failed in a way retrying cannot fix. */
  down(input: {
    workspaceId: string;
    provider: string;
    /** The model called; null when the provider failed before a model was chosen. */
    model: string | null;
    reason: string;
    message: string;
    hint: string | null;
    /** The backup brain that answers meanwhile, if any. */
    fallback: string | null;
  }): Promise<void>;
  /** A call on the provider and model worked. */
  up(input: { workspaceId: string; provider: string; model: string }): Promise<void>;
}
