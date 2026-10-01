import { type ErrorCode, toOpenOutboundError } from "../core/errors.js";
import { retryAfterOf } from "../core/failures.js";

/** The error object doors return: MCP structuredContent, CLI --json and bridge payloads. */
export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  hint?: string;
  details?: Record<string, unknown>;
  /** Seconds to wait before trying again, when the error says (rate limits, provider waits). */
  retry_after_seconds?: number;
}

export function errorPayload(error: unknown): ErrorPayload {
  const normalized = toOpenOutboundError(error);
  const payload: ErrorPayload = { code: normalized.code, message: normalized.message };
  if (normalized.hint) payload.hint = normalized.hint;
  if (normalized.details) payload.details = normalized.details;
  const wait = retryAfterOf(normalized);
  if (wait !== undefined) payload.retry_after_seconds = wait;
  return payload;
}

/** `Error (code): message`, a `Hint:` line when there is one and the wait when there is one. */
export function errorText(payload: ErrorPayload): string {
  const lines = [`Error (${payload.code}): ${payload.message}`];
  if (payload.hint) lines.push(`Hint: ${payload.hint}`);
  if (payload.retry_after_seconds !== undefined) {
    lines.push(`Retry after ${payload.retry_after_seconds} s.`);
  }
  return lines.join("\n");
}

/** MCP tool result for a failed call (spec 5.3): isError + text + structured error. */
export function toolErrorResult(error: unknown) {
  const payload = errorPayload(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: errorText(payload) }],
    structuredContent: { error: payload },
  };
}
