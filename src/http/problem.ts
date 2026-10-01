import { ERROR_STATUS, type ErrorCode, toOpenOutboundError } from "../core/errors.js";

export const PROBLEM_CONTENT_TYPE = "application/problem+json";
const PROBLEM_TYPE_BASE =
  "https://github.com/xyluxx/openoutbound/blob/main/docs/reference/rest-api.md#error-";

const TITLES: Record<ErrorCode, string> = {
  validation_failed: "Validation failed",
  unauthorized: "Unauthorized",
  forbidden: "Forbidden",
  not_found: "Not found",
  conflict: "Conflict",
  idempotency_mismatch: "Idempotency key reused with a different request",
  limit_reached: "Limit reached",
  budget_exceeded: "Budget exceeded",
  approval_required: "Approval required",
  provider_not_configured: "Provider not configured",
  provider_error: "Provider error",
  suppressed: "Suppressed",
  workspace_paused: "Workspace paused",
  unsupported: "Unsupported",
  internal: "Internal error",
};

/** RFC 9457 problem details plus OpenOutbound's `code`, `hint` and `details` members. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: ErrorCode;
  hint?: string;
  details?: Record<string, unknown>;
  instance?: string;
  request_id?: string;
  retry_after_seconds?: number;
}

export function problemDetails(
  error: unknown,
  extras: { instance?: string; requestId?: string } = {},
): ProblemDetails {
  const normalized = toOpenOutboundError(error);
  const body: ProblemDetails = {
    type: `${PROBLEM_TYPE_BASE}${normalized.code.replaceAll("_", "-")}`,
    title: TITLES[normalized.code] ?? "Error",
    status: normalized.status,
    detail: normalized.message,
    code: normalized.code,
  };
  if (normalized.hint) body.hint = normalized.hint;
  if (normalized.details) body.details = normalized.details;
  if (extras.instance) body.instance = extras.instance;
  if (extras.requestId) body.request_id = extras.requestId;
  if (normalized.retryAfterSeconds !== undefined) {
    body.retry_after_seconds = normalized.retryAfterSeconds;
  }
  return body;
}

/** A problem+json Response (with Retry-After when the error carries one). */
export function problemResponse(
  error: unknown,
  extras: { instance?: string; requestId?: string } = {},
): Response {
  const body = problemDetails(error, extras);
  const headers = new Headers({ "Content-Type": PROBLEM_CONTENT_TYPE });
  if (body.retry_after_seconds !== undefined) {
    headers.set("Retry-After", String(Math.max(1, Math.ceil(body.retry_after_seconds))));
  }
  if (extras.requestId) headers.set("X-Request-Id", extras.requestId);
  return new Response(JSON.stringify(body), { status: body.status, headers });
}

/** Maps an HTTP status back to an error code (for problem bodies without `code`). */
export function codeForStatus(status: number): ErrorCode {
  const match = (Object.entries(ERROR_STATUS) as Array<[ErrorCode, number]>).find(
    ([code, value]) => value === status && code !== "approval_required",
  );
  if (match) return match[0];
  if (status === 400) return "validation_failed";
  if (status === 413) return "validation_failed";
  return status >= 500 ? "internal" : "validation_failed";
}
