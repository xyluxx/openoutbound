import { parseRetryAfter } from "../../brain/retry.js";
import { isOpenOutboundError, type OpenOutboundError } from "../../core/errors.js";
import { type FailureClass, isFetchError, providerFailure } from "../../core/failures.js";
import { isDailyQuota, readGoogleError, secondsUntilPacificMidnight } from "../google-errors.js";
import { redact } from "../http.js";
import type { BrainUsage } from "../types.js";

/**
 * How long background jobs wait after a plan usage limit (Claude Code, Codex) when the message
 * gives no reset time. Plan limits reset over hours, so the usual 30-second backoff would spend
 * every retry long before the limit lifts.
 */
export const USAGE_LIMIT_RETRY_SECONDS = 3600;

/** Why a brain call failed, in `details.reason` of provider errors. */
export type BrainFailureReason =
  | "provider_failure"
  | "aborted"
  | "timeout"
  | "network"
  | "auth"
  | "forbidden"
  | "model_not_found"
  | "bad_request"
  | "too_large"
  | "rate_limited"
  | "quota"
  | "overloaded"
  | "server_error"
  | "refusal"
  | "max_tokens"
  | "context_window"
  | "invalid_output"
  | "malformed_response"
  | "cli_error"
  | "cli_not_found"
  | "usage_limit"
  | "declined"
  | "expired";

/**
 * The failure class of each brain reason (see core/failures). `details.reason` keeps the brain
 * reason for logs and problems; `details.failure` carries the class every caller reads.
 */
export const BRAIN_REASON_CLASSES: Record<BrainFailureReason, FailureClass> = {
  // The caller stopped the call (a cancelled job): never retried, never a fallback.
  aborted: "timeout",
  timeout: "timeout",
  network: "network",
  auth: "auth_invalid",
  expired: "auth_invalid",
  forbidden: "forbidden",
  model_not_found: "not_found",
  cli_not_found: "not_found",
  bad_request: "bad_request",
  too_large: "bad_request",
  context_window: "bad_request",
  rate_limited: "rate_limited",
  quota: "quota_exhausted",
  usage_limit: "quota_exhausted",
  overloaded: "unavailable",
  server_error: "unavailable",
  provider_failure: "unavailable",
  cli_error: "unavailable",
  refusal: "refused",
  declined: "refused",
  max_tokens: "malformed",
  invalid_output: "malformed",
  malformed_response: "malformed",
};

export interface BrainErrorContext {
  /** Display name, e.g. "Anthropic". */
  label: string;
  /** Provider id, e.g. "anthropic" (used in hints). */
  providerId: string;
  model?: string;
  /** Env var holding the key, for auth hints. */
  envVar?: string;
  /** Replaces the generic hint for rejected requests (400/422). */
  badRequestHint?: string;
  /** Credentials to cut out of messages, since some servers echo the key in their errors. */
  secrets?: string[];
}

interface SdkErrorLike {
  name?: string;
  message?: string;
  status?: number;
  headers?: Headers | Record<string, string>;
  error?: unknown;
  code?: unknown;
}

/**
 * Builds a brain provider failure (`providerFailure` with the class of `reason`). `details`
 * keeps the brain conventions older readers use: `reason`, `retryable`, `model`,
 * `upstream_status` and `usage`.
 */
export function brainError(
  context: BrainErrorContext,
  message: string,
  options: {
    reason: BrainFailureReason;
    retryable: boolean;
    hint?: string;
    retryAfterSeconds?: number;
    status?: number;
    usage?: BrainUsage;
    extra?: Record<string, unknown>;
    cause?: unknown;
    code?: "provider_error" | "provider_not_configured";
  },
): OpenOutboundError {
  return providerFailure({
    provider: context.providerId,
    name: context.label,
    class: BRAIN_REASON_CLASSES[options.reason] ?? "unavailable",
    message: redact(message, context.secrets ?? []),
    ...(options.hint ? { hint: options.hint } : {}),
    ...(options.status === undefined ? {} : { upstreamStatus: options.status }),
    ...(options.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: options.retryAfterSeconds }),
    retryable: options.retryable,
    details: {
      reason: options.reason,
      ...(context.model ? { model: context.model } : {}),
      ...(options.status !== undefined ? { upstream_status: options.status } : {}),
      ...(options.usage ? { usage: options.usage } : {}),
      ...options.extra,
    },
    ...(options.cause !== undefined ? { cause: options.cause } : {}),
    ...(options.code ? { code: options.code } : {}),
  });
}

/** The API's own error message from an SDK error body, trimmed for display. */
export function upstreamMessage(error: unknown): string {
  const sdk = (error ?? {}) as SdkErrorLike;
  const body = sdk.error as { error?: { message?: unknown }; message?: unknown } | undefined;
  const candidate =
    (typeof body?.error?.message === "string" && body.error.message) ||
    (typeof body?.message === "string" && body.message) ||
    (typeof sdk.message === "string" && sdk.message) ||
    "unknown error";
  return candidate.replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * A 2xx answer that is not the API's response shape (an HTML page from a proxy, a wrong
 * base_url, a server that speaks another API): `malformed`, never an empty reply.
 */
export function malformedBrainAnswer(
  context: BrainErrorContext,
  what: string,
  cause?: unknown,
): OpenOutboundError {
  return brainError(
    context,
    `${context.label} answered in an unexpected format${what ? ` (${what.slice(0, 160)})` : ""}.`,
    {
      reason: "malformed_response",
      retryable: false,
      hint: `Check the ${context.label} base_url with manage_providers (action list): it must point to the provider's API, not a web page.`,
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

/** The JSON part of an SDK message such as `429 [{"error": ...}]`, or undefined. */
function jsonIn(message: string | undefined): unknown {
  const start = message?.search(/[[{]/) ?? -1;
  if (!message || start < 0) return undefined;
  try {
    return JSON.parse(message.slice(start));
  } catch {
    return undefined;
  }
}

function upstreamCode(error: unknown): string | undefined {
  const sdk = (error ?? {}) as SdkErrorLike;
  const body = sdk.error as { code?: unknown; type?: unknown; error?: { type?: unknown } };
  for (const value of [sdk.code, body?.code, body?.type, body?.error?.type]) {
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/**
 * Maps an error thrown by the Anthropic or OpenAI SDK (same Stainless error classes) or by
 * fetch into an actionable provider error. Rate limits, 5xx, overloaded and network errors are
 * marked retryable (with Retry-After when the API sent one).
 */
export function mapBrainApiError(context: BrainErrorContext, error: unknown): OpenOutboundError {
  if (isOpenOutboundError(error)) return error;
  const sdk = (error ?? {}) as SdkErrorLike;
  // SDK error classes do not always set `name`: read the class name too.
  const names = [sdk.name, (error as { constructor?: { name?: string } })?.constructor?.name];
  const named = (...candidates: string[]) =>
    names.some((name) => name !== undefined && candidates.includes(name));
  const { label, providerId } = context;
  const keyHint = `Set a valid key with manage_providers (action set, slot brain, provider ${providerId})${context.envVar ? ` or the ${context.envVar} environment variable` : ""}.`;

  if (named("APIUserAbortError", "AbortError")) {
    return brainError(context, `The request to ${label} was cancelled.`, {
      reason: "aborted",
      retryable: false,
      cause: error,
    });
  }
  if (named("APIConnectionTimeoutError", "TimeoutError")) {
    return brainError(context, `${label} did not answer in time.`, {
      reason: "timeout",
      retryable: true,
      hint: "Retry later or pick a faster model for this task.",
      cause: error,
    });
  }
  const status = typeof sdk.status === "number" ? sdk.status : undefined;
  if (status === undefined && !named("APIConnectionError") && !isFetchError(error)) {
    // The SDK could not read what came back (an HTML page from a proxy, a wrong base_url).
    return malformedBrainAnswer(context, upstreamMessage(error), error);
  }
  if (status === undefined) {
    return brainError(context, `Could not reach ${label}: ${upstreamMessage(error)}`, {
      reason: "network",
      retryable: true,
      hint: "Check the network connection and the provider base_url. For local models, make sure the model server is running.",
      cause: error,
    });
  }

  const detail = redact(upstreamMessage(error), context.secrets ?? []);
  const code = upstreamCode(error);
  const retryAfterSeconds = parseRetryAfter(sdk.headers);
  const google = readGoogleError(sdk.error) ?? readGoogleError(jsonIn(sdk.message));
  const base = { status, cause: error };
  switch (true) {
    case status === 401:
      return brainError(context, `${label} rejected the API key (401): ${detail}`, {
        ...base,
        reason: "auth",
        retryable: false,
        hint: keyHint,
      });
    case status === 403:
      return brainError(context, `${label} refused access (403): ${detail}`, {
        ...base,
        reason: "forbidden",
        retryable: false,
        hint: `Check that the key's account can use this model${context.model ? ` (${context.model})` : ""}. ${keyHint}`,
      });
    case status === 404:
      return brainError(context, `${label} does not know this model or endpoint (404): ${detail}`, {
        ...base,
        reason: "model_not_found",
        retryable: false,
        hint: `Check the model id${context.model ? ` "${context.model}"` : ""} in the provider config (models) or in workspace settings ai.task_models, and the base_url.`,
      });
    case status === 413:
      return brainError(context, `The request is too large for ${label} (413).`, {
        ...base,
        reason: "too_large",
        retryable: false,
        hint: "Shorten the input (fewer sources or a smaller thread) or use a model with a larger context window.",
      });
    case status === 402 || (status === 429 && code === "insufficient_quota"):
      return brainError(context, `${label} has no quota or credits left (${status}): ${detail}`, {
        ...base,
        reason: "quota",
        retryable: false,
        hint: `Add credits or raise the spend limit in the ${label} console, or switch the brain provider.`,
      });
    case status === 429 && google !== null && isDailyQuota(google):
      return brainError(context, `${label} daily quota is used up (429): ${detail}`, {
        ...base,
        reason: "quota",
        retryable: false,
        retryAfterSeconds: secondsUntilPacificMidnight(),
        hint: `The ${label} daily quota resets at midnight Pacific time. Raise the quota or add billing in the Google Cloud console, or switch the brain provider.`,
      });
    case status === 429: {
      const wait = retryAfterSeconds ?? google?.retryDelaySeconds;
      return brainError(context, `${label} rate limit reached (429).`, {
        ...base,
        reason: "rate_limited",
        retryable: true,
        ...(wait !== undefined ? { retryAfterSeconds: wait } : {}),
        hint: "OpenOutbound retries automatically. If this keeps happening, lower the provider's max_concurrency or raise your rate limits.",
      });
    }
    case status === 529 || code === "overloaded_error":
      return brainError(context, `${label} is overloaded right now (${status}).`, {
        ...base,
        reason: "overloaded",
        retryable: true,
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
        hint: "OpenOutbound retries automatically; the job will try again later if it keeps failing.",
      });
    case status === 408 || status === 409 || status >= 500:
      return brainError(context, `${label} had a server error (${status}): ${detail}`, {
        ...base,
        reason: status === 408 ? "timeout" : "server_error",
        retryable: true,
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
        hint: "OpenOutbound retries automatically; check the provider status page if it persists.",
      });
    case /credit balance|billing/i.test(detail):
      return brainError(context, `${label} rejected the request: ${detail}`, {
        ...base,
        reason: "quota",
        retryable: false,
        hint: `Add credits in the ${label} console or switch the brain provider.`,
      });
    default:
      return brainError(context, `${label} rejected the request (${status}): ${detail}`, {
        ...base,
        reason: "bad_request",
        retryable: false,
        hint:
          context.badRequestHint ??
          "Check the model id and the provider settings (manage_providers action list shows them).",
      });
  }
}
