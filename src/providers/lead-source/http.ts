/**
 * JSON over HTTP for the lead-source, email-finder and email-verifier adapters. Requests go
 * through the shared provider helper (src/providers/http.ts): a timeout joined with the caller's
 * signal, and classified failures (`details.failure`, see core/failures). This family adds its
 * wording and the detail flags enrichment reads (`auth`, `insufficient_credits`, `rateLimited`,
 * `malformed`). URLs are never put in messages because some vendors take the API key as a query
 * parameter.
 */
import type { OpenOutboundError } from "../../core/errors.js";
import type { FailureClass } from "../../core/failures.js";
import {
  type AnswerInput,
  answerFailure,
  type CallKind,
  classFailure,
  type FailureParts,
  type FailureStyle,
  malformedFailure,
  type ProviderIdentity,
  parseJsonText,
  requestText,
} from "../http.js";

export interface JsonRequest {
  /** Display name for messages, e.g. "Apollo". */
  provider: string;
  /** Slot and id for the hint, e.g. ["lead_source", "apollo"]. */
  slot: string;
  providerId: string;
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** Non-2xx statuses that are answers rather than errors (e.g. 404 = no match). */
  answerStatuses?: number[];
  /** The caller's signal (a job that is cancelled or out of time). */
  signal?: AbortSignal;
  /**
   * The call costs credits once the provider receives it. A lost answer (timeout, broken
   * connection) is then not retried automatically: the first try may have been charged.
   */
  paid?: boolean;
  /**
   * Refines the failure for a non-2xx answer from the provider's documented error body (for
   * example a daily quota behind a 429). Return nothing to keep the status rule.
   */
  classify?(status: number, body: unknown, headers: Headers): Partial<AnswerInput> | undefined;
}

export interface JsonResponse {
  status: number;
  body: unknown;
  headers: Headers;
}

type Target = Pick<JsonRequest, "provider" | "slot" | "providerId">;

/** The fix for a rejected API key: test the provider, then store a new key. */
export function keyHint(request: Pick<JsonRequest, "slot" | "providerId">): string {
  const { slot, providerId } = request;
  return `Check the key with \`openoutbound providers test --slot ${slot} --provider ${providerId}\` (MCP: manage_providers action test) and replace it with \`openoutbound providers set --slot ${slot} --provider ${providerId} --secrets '{"api_key":"..."}'\` (action set).`;
}

function identity(target: Target): ProviderIdentity {
  return { id: target.providerId, name: target.provider };
}

/** This family's messages, hints and the flags enrichment reads. */
export function leadStyle(target: Target): FailureStyle {
  const name = target.provider;
  const enrichment = target.slot === "email_finder" || target.slot === "email_verifier";
  return {
    message(failureClass: FailureClass, status: number | undefined) {
      const http = status === undefined ? "" : ` (HTTP ${status})`;
      if (failureClass === "auth_invalid") return `${name} rejected the API key${http}.`;
      if (failureClass === "forbidden") return `${name} rejected the API key for this call${http}.`;
      if (failureClass === "quota_exhausted") return `${name} has no credits left${http}.`;
      return undefined;
    },
    hint(failureClass: FailureClass) {
      if (failureClass === "auth_invalid") return keyHint(target);
      if (failureClass === "forbidden") {
        return `The key works but its ${name} plan does not include this. Upgrade the plan, or ${keyHint(target).replace(/^Check/, "check")}`;
      }
      if (failureClass === "quota_exhausted") {
        return enrichment
          ? `Top up credits in your ${name} account, or change the order in settings.data.enrichment.`
          : `Top up credits in your ${name} account, or switch provider with manage_providers (action set).`;
      }
      return undefined;
    },
    details(failureClass: FailureClass) {
      if (failureClass === "auth_invalid" || failureClass === "forbidden") return { auth: true };
      if (failureClass === "quota_exhausted") return { insufficient_credits: true };
      if (failureClass === "rate_limited") return { rateLimited: true };
      if (failureClass === "malformed") return { malformed: true };
      return undefined;
    },
  };
}

/** The classified failure for a non-2xx answer (or a 2xx whose body reports an error). */
export function statusFailure(
  target: Target,
  input: AnswerInput,
  kind: CallKind = {},
): OpenOutboundError {
  return answerFailure(identity(target), input, kind, leadStyle(target));
}

/** A failure the provider reported in a successful answer, e.g. a status field. */
export function reportedFailure(
  target: Target,
  failureClass: FailureClass,
  parts: Omit<FailureParts, "style" | "keepHint"> = {},
): OpenOutboundError {
  return classFailure(identity(target), failureClass, parts, leadStyle(target));
}

/** Throws the classified failure for a failed response. */
export function throwForStatus(
  request: JsonRequest,
  status: number,
  body: unknown,
  headers: Headers,
): never {
  const refined = request.classify?.(status, body, headers);
  throw statusFailure(request, { ...refined, status, body, headers }, request);
}

/** Sends a JSON request and returns the parsed body; throws a classified failure otherwise. */
export async function requestJson(
  fetchFn: typeof fetch,
  request: JsonRequest,
): Promise<JsonResponse> {
  const headers: Record<string, string> = { accept: "application/json", ...request.headers };
  if (request.body !== undefined) headers["content-type"] = "application/json";
  const answer = await requestText(
    fetchFn,
    identity(request),
    {
      url: request.url,
      method: request.method ?? (request.body === undefined ? "GET" : "POST"),
      headers,
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.paid ? { paid: true } : {}),
    },
    leadStyle(request),
  );
  const parsed = parseJsonText(answer.text);
  if (answer.ok && answer.text.trim() && parsed === undefined) {
    throw malformed(request.provider, request.providerId, "not JSON");
  }
  const body = parsed ?? (answer.text ? answer.text.slice(0, 200) : null);
  if (!answer.ok && !(request.answerStatuses ?? []).includes(answer.status)) {
    throwForStatus(request, answer.status, body, answer.headers);
  }
  return { status: answer.status, body, headers: answer.headers };
}

/** The failure for a body that does not have the documented shape. */
export function malformed(provider: string, providerId: string, what: string): OpenOutboundError {
  return malformedFailure(
    { id: providerId, name: provider },
    what,
    {},
    leadStyle({ provider, providerId, slot: "" }),
  );
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)))
    return Number(value);
  return null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
