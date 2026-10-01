import type { Scope } from "./enums.js";

/**
 * Stable error codes (spec 5.3). Doors map them to HTTP status (problem+json), MCP `isError`
 * results (`Error (code): message Hint: ...`) and CLI exit codes (2 for validation, else 1).
 */
export type ErrorCode =
  | "validation_failed"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "idempotency_mismatch"
  | "limit_reached"
  | "budget_exceeded"
  | "approval_required"
  | "provider_not_configured"
  | "provider_error"
  | "suppressed"
  | "workspace_paused"
  | "unsupported"
  | "internal";

/**
 * Default HTTP status per code. `validation_failed` is 422 (the HTTP door uses 400 for bodies
 * that are not valid JSON). `approval_required` is normally returned as an `awaiting_approval`
 * result, not thrown; 202 is only used if it ever is.
 */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  validation_failed: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  idempotency_mismatch: 409,
  limit_reached: 429,
  budget_exceeded: 402,
  approval_required: 202,
  provider_not_configured: 424,
  provider_error: 502,
  suppressed: 409,
  workspace_paused: 423,
  unsupported: 400,
  internal: 500,
};

export interface OpenOutboundErrorOptions {
  /** What the caller should do next, e.g. "Run `openoutbound providers set --slot brain --provider anthropic`". */
  hint?: string;
  /** Machine-readable context (field errors, limits, provider flags like `restricted`). */
  details?: Record<string, unknown>;
  /** Overrides the default HTTP status for the code. */
  status?: number;
  /** For `limit_reached` and rate limits: when to retry. */
  retryAfterSeconds?: number;
  cause?: unknown;
}

/** JSON shape of an error, used in MCP structured errors, job errors and audit. */
export interface SerializedError {
  code: ErrorCode;
  message: string;
  hint?: string;
  details?: Record<string, unknown>;
  status: number;
  retry_after_seconds?: number;
}

/**
 * The only error type operations should throw on purpose. Messages say what happened;
 * hints say what to do next (errors must be actionable).
 */
export class OpenOutboundError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly details: Record<string, unknown> | undefined;
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: ErrorCode, message: string, options: OpenOutboundErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OpenOutboundError";
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
    this.status = options.status ?? ERROR_STATUS[code];
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  toJSON(): SerializedError {
    const out: SerializedError = { code: this.code, message: this.message, status: this.status };
    if (this.hint !== undefined) out.hint = this.hint;
    if (this.details !== undefined) out.details = this.details;
    if (this.retryAfterSeconds !== undefined) out.retry_after_seconds = this.retryAfterSeconds;
    return out;
  }
}

export function isOpenOutboundError(error: unknown): error is OpenOutboundError {
  return error instanceof OpenOutboundError;
}

/** `throw notFound("Person", id)` -> "Person pe_... not found." */
export function notFound(what: string, id: string): OpenOutboundError {
  return new OpenOutboundError("not_found", `${what} ${id} not found.`, {
    hint: `Check the id, or list ${what.toLowerCase()} records to find the right one.`,
    details: { what, id },
  });
}

/**
 * Missing scope. The message names the scope so the caller knows which key to use; `next` adds
 * what else the caller can do (for example suggest the change with a proposal).
 */
export function forbidden(scope: Scope, next?: string): OpenOutboundError {
  return new OpenOutboundError(
    "forbidden",
    `This action needs the "${scope}" scope, which the current key or principal does not have.`,
    {
      hint: `Use an API key that includes the "${scope}" scope, or ask a human with that scope to run it.${next ? ` ${next}` : ""}`,
      details: { missing_scope: scope },
    },
  );
}

/** Input that parsed but makes no sense (the executor handles schema errors itself). */
export function invalid(message: string, details?: Record<string, unknown>): OpenOutboundError {
  return new OpenOutboundError(
    "validation_failed",
    message,
    details === undefined ? {} : { details },
  );
}

/**
 * Normalizes anything thrown into an OpenOutboundError: passes OpenOutboundErrors through,
 * turns zod errors into `validation_failed` (with `details.issues`), everything else into
 * `internal` (original error kept as `cause`, message not leaked to callers).
 */
export function toOpenOutboundError(error: unknown): OpenOutboundError {
  if (error instanceof OpenOutboundError) return error;
  if (isZodErrorLike(error)) {
    return new OpenOutboundError("validation_failed", summarizeIssues(error.issues), {
      hint: "Fix the listed fields and try again.",
      details: {
        issues: error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
        })),
      },
      cause: error,
    });
  }
  return new OpenOutboundError("internal", "Unexpected internal error.", {
    hint: "Check the server logs (stderr). If it keeps happening, report it with the log line.",
    cause: error,
  });
}

interface ZodErrorLike {
  name: string;
  issues: Array<{ path: PropertyKey[]; message: string }>;
}

function isZodErrorLike(error: unknown): error is ZodErrorLike {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "ZodError" &&
    Array.isArray((error as { issues?: unknown }).issues)
  );
}

function summarizeIssues(issues: ZodErrorLike["issues"]): string {
  const parts = issues.slice(0, 5).map((issue) => {
    const path = issue.path.map(String).join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  const more = issues.length > 5 ? ` (and ${issues.length - 5} more)` : "";
  return `Invalid input. ${parts.join("; ")}${more}`;
}

/**
 * Thrown by a job handler (or a provider it calls) to park the job in status `waiting` until
 * the awaited thing completes (`jobs.wake(waitFor)`) or `retryAt` passes. Not a failure:
 * attempts are not consumed. Used by the agent brain (waitFor = agent task key).
 */
export class JobWaitError extends Error {
  readonly waitFor: string;
  readonly retryAt: Date | undefined;

  constructor(waitFor: string, retryAt?: Date) {
    super(`Job is waiting for ${waitFor}`);
    this.name = "JobWaitError";
    this.waitFor = waitFor;
    this.retryAt = retryAt;
  }
}

export function isJobWaitError(error: unknown): error is JobWaitError {
  return error instanceof JobWaitError;
}
