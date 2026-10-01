/**
 * Small HTTP helpers shared by the signal providers. Requests go through the shared provider
 * helper (a timeout on every request, classified failures that never include keys). Signal
 * calls cost credits, so one whose answer was lost is not retried automatically.
 */
import type { OpenOutboundError } from "../../core/errors.js";
import type { FailureClass } from "../../core/failures.js";
import {
  answerFailure,
  type FailureStyle,
  malformedFailure,
  parseJsonText,
  requestText,
} from "../http.js";

export type ProviderFetch = typeof globalThis.fetch;

/** A signal provider as failures name it, with the fix for its credentials. */
export interface SignalSource {
  /** Provider id, e.g. "crustdata". */
  id: string;
  /** Display name, e.g. "Crustdata". */
  name: string;
  /** What to do about rejected credentials (env vars and the manage_providers action). */
  authHint: string;
  creditsHint?: string;
}

/** Signal provider wording and the `rateLimited` flag older readers check. */
export function signalStyle(source: SignalSource): FailureStyle {
  return {
    message(failureClass: FailureClass, status: number | undefined) {
      if (failureClass === "auth_invalid" || failureClass === "forbidden") {
        return `${source.name} rejected the credentials${status === undefined ? "" : ` (${status})`}.`;
      }
      if (failureClass === "quota_exhausted")
        return `${source.name} says the account is out of credits.`;
      return undefined;
    },
    hint(failureClass: FailureClass) {
      if (failureClass === "auth_invalid" || failureClass === "forbidden") return source.authHint;
      if (failureClass === "quota_exhausted") {
        return (
          source.creditsHint ??
          `Top up the ${source.name} plan or remove it from the monitor's collectors.`
        );
      }
      if (failureClass === "rate_limited") {
        return "It is retried automatically after the wait; lower max_companies if it keeps happening.";
      }
      return undefined;
    },
    details(failureClass: FailureClass) {
      return failureClass === "rate_limited" ? { rateLimited: true } : undefined;
    },
  };
}

export interface SignalRequest {
  url: string;
  method?: "GET" | "POST";
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** Default true: the call costs credits once the provider receives it. */
  paid?: boolean;
  /** Non-2xx statuses that are answers, returned with a null body (e.g. 404 = no data). */
  answerStatuses?: number[];
}

/** Sends a request and parses the JSON answer; throws classified failures. */
export async function requestJson(
  fetchFn: ProviderFetch,
  source: SignalSource,
  request: SignalRequest,
): Promise<{ status: number; body: unknown }> {
  const answer = await requestText(
    fetchFn,
    source,
    {
      url: request.url,
      method: request.method ?? "GET",
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      paid: request.paid ?? true,
    },
    signalStyle(source),
  );
  if (!answer.ok) {
    if ((request.answerStatuses ?? []).includes(answer.status)) {
      return { status: answer.status, body: null };
    }
    throw answerFailure(
      source,
      { status: answer.status, headers: answer.headers, body: answer.text },
      {},
      signalStyle(source),
    );
  }
  const body = parseJsonText(answer.text);
  if (body === undefined) throw malformed(source, "not JSON");
  return { status: answer.status, body };
}

/** The answer does not have the documented shape. */
export function malformed(source: SignalSource, what: string): OpenOutboundError {
  return malformedFailure(source, what, {}, signalStyle(source));
}

export const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

export const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** ISO 8601 or null. */
export function asIso(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** "$12M", "$150K", "$2.5B" (USD amounts), or null. */
export function formatUsd(amount: number | null): string | null {
  if (amount === null || amount <= 0) return null;
  if (amount >= 1e9) return `$${Number((amount / 1e9).toFixed(1))}B`;
  if (amount >= 1e6) return `$${Number((amount / 1e6).toFixed(1))}M`;
  if (amount >= 1e3) return `$${Math.round(amount / 1e3)}K`;
  return `$${Math.round(amount)}`;
}

/** YYYY-MM-DD */
export const isoDay = (date: Date) => date.toISOString().slice(0, 10);
