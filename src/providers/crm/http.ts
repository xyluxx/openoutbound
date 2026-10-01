/**
 * Shared plumbing for CRM providers: JSON requests through the runtime fetch and the shared
 * provider helper (a timeout on every request, classified failures that never include tokens),
 * a credit-free auth probe for `test()` and small value helpers.
 *
 * Writes and lost answers: updating by id, upserting by email and linking records can be
 * repeated safely, and so can creating a contact, company or deal, because the engine looks the
 * record up first (contact by email, company by domain or name, deal by contact and title; see
 * inbox/crm-sync). A timeout or server error on those stays `timeout` / `unavailable` and the
 * sync retries. A note cannot be found again, so a note whose answer was lost is
 * `outcome_unknown` and is not written twice.
 */
import { OpenOutboundError } from "../../core/errors.js";
import type { FailureClass } from "../../core/failures.js";
import {
  answerFailure,
  type CallKind,
  type FailureStyle,
  malformedFailure,
  parseJsonText,
  requestText,
  thrownFailure,
} from "../http.js";
import type { ProviderRuntime, ProviderTestResult } from "../types.js";

export const DEFAULT_TIMEOUT_MS = 20_000;

export interface CrmInfo {
  /** Provider id, e.g. "hubspot". */
  id: string;
  /** Display name, e.g. "HubSpot". */
  name: string;
  /** Secret key in `create({ secrets })`, e.g. "access_token". */
  secret: string;
  /** Env var of the secret, for hints. */
  env: string;
}

export interface CrmRequest extends CallKind {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

type Fetcher = Pick<ProviderRuntime, "fetch">;

/** A write the engine can repeat safely (update by id, upsert by key, link, create after a lookup). */
export const SAFE_WRITE: CallKind = { write: true, idempotent: true };
/** A write that cannot be found again (a note): never repeated after a lost answer. */
export const ONE_TIME_WRITE: CallKind = { write: true };

/** CRM wording: which credentials to fix, and that the sync retries by itself. */
export function crmStyle(info: CrmInfo): FailureStyle {
  const setHint = `manage_providers (action set, slot crm, provider ${info.id}) or the ${info.env} env var`;
  return {
    message(failureClass: FailureClass) {
      if (failureClass === "auth_invalid" || failureClass === "forbidden") {
        return `${info.name} rejected the credentials.`;
      }
      return undefined;
    },
    hint(failureClass: FailureClass) {
      if (failureClass === "auth_invalid" || failureClass === "forbidden") {
        return `Check the ${info.name} credentials and their access to contacts, companies and deals with ${setHint}, then run manage_providers (action test).`;
      }
      if (failureClass === "rate_limited") return "The sync retries automatically after the wait.";
      if (failureClass === "unavailable" || failureClass === "timeout") {
        return "The sync retries automatically; check the CRM status page if it keeps failing.";
      }
      if (failureClass === "bad_request") {
        return "Check the CRM provider config (pipeline and stage ids) and required fields in your CRM.";
      }
      return undefined;
    },
    details(failureClass: FailureClass) {
      return failureClass === "rate_limited" ? { rateLimited: true } : undefined;
    },
  };
}

async function send(
  runtime: Fetcher,
  info: CrmInfo,
  request: CrmRequest,
): Promise<{ status: number; ok: boolean; headers: Headers; text: string }> {
  return requestText(
    runtime.fetch,
    info,
    {
      url: request.url,
      method: request.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(request.body === undefined ? {} : { "content-type": "application/json" }),
        ...request.headers,
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(request.write ? { write: true } : {}),
      ...(request.idempotent ? { idempotent: true } : {}),
    },
    crmStyle(info),
  );
}

function parse(info: CrmInfo, text: string, kind: CallKind): unknown {
  if (!text.trim()) return null;
  const parsed = parseJsonText(text);
  if (parsed === undefined) throw malformed(info, "the response is not JSON", kind);
  return parsed;
}

/** Sends a JSON request and returns the parsed body (null when empty); throws on failures. */
export async function requestJson(
  runtime: Fetcher,
  info: CrmInfo,
  request: CrmRequest,
): Promise<unknown> {
  const answer = await send(runtime, info, request);
  if (!answer.ok) throw httpError(info, answer.status, answer.headers, answer.text, request);
  return parse(info, answer.text, request);
}

/**
 * Like requestJson, but a 404 returns `undefined`: the record was deleted in the CRM, so the
 * caller can look it up again, recreate it, or report it as already gone.
 */
export async function requestJsonOrMissing(
  runtime: Fetcher,
  info: CrmInfo,
  request: CrmRequest,
): Promise<unknown> {
  const answer = await send(runtime, info, request);
  if (answer.status === 404) return undefined;
  if (!answer.ok) throw httpError(info, answer.status, answer.headers, answer.text, request);
  return parse(info, answer.text, request);
}

/** The CRM answered, but not in the shape we expect (for a write: it took the request). */
export function malformed(info: CrmInfo, detail: string, kind: CallKind = {}): OpenOutboundError {
  return malformedFailure(info, detail, kind, crmStyle(info));
}

/** Maps a non-2xx answer to a classified failure. A 429 without Retry-After waits 10 s. */
export function httpError(
  info: CrmInfo,
  status: number,
  headers: Headers,
  body: string,
  kind: CallKind = {},
): OpenOutboundError {
  const wait = status === 429 && !headers.get("retry-after") ? { retryAfterSeconds: 10 } : {};
  return answerFailure(info, { status, headers, body, ...wait }, kind, crmStyle(info));
}

/** A thrown error from a request the provider sent itself (safe fetch), classified. */
export function sendFailure(info: CrmInfo, error: unknown, kind: CallKind = {}): OpenOutboundError {
  return thrownFailure(info, error, kind, crmStyle(info));
}

/** Checks the credentials with a cheap read: 401/403 means bad credentials. */
export async function probeAuth(
  runtime: Fetcher,
  info: CrmInfo,
  request: CrmRequest,
): Promise<ProviderTestResult> {
  let status: number;
  try {
    ({ status } = await send(runtime, info, { ...request, timeoutMs: 15_000 }));
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : `${info.name} could not be reached.`,
    };
  }
  if (status === 401 || status === 403) {
    return { ok: false, message: `${info.name} rejected the credentials (${status}).` };
  }
  if (status < 200 || status >= 300) {
    return { ok: false, message: `${info.name} answered with status ${status}.` };
  }
  return { ok: true, message: `${info.name} accepted the credentials.` };
}

export function requireSecret(info: CrmInfo, secrets: Record<string, string>): string {
  const value = secrets[info.secret]?.trim();
  if (!value) {
    throw new OpenOutboundError(
      "provider_not_configured",
      `${info.name} is missing the ${info.secret} secret.`,
      {
        hint: `Set it with manage_providers (action set, slot crm, provider ${info.id}) or the ${info.env} env var.`,
        details: { slot: "crm", provider: info.id },
      },
    );
  }
  return value;
}

export function baseUrl(value: string | undefined, fallback: string): string {
  return (value?.trim() || fallback).replace(/\/+$/, "");
}

/** Drops null, undefined and blank-string values (CRMs would otherwise clear those fields). */
export function compact<T extends Record<string, unknown>>(values: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && !value.trim()) continue;
    (out as Record<string, unknown>)[key] = typeof value === "string" ? value.trim() : value;
  }
  return out;
}

/** Record id as a string (CRMs return numbers or strings). */
export function idOf(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** First name + last name, else the full name, else the email. */
export function displayName(person: {
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  email: string | null;
}): string {
  const joined = [person.first_name, person.last_name].filter(Boolean).join(" ").trim();
  return joined || person.full_name?.trim() || person.email || "Unknown contact";
}

/** Plain-text deal description from our record (notes, meeting, lost reason, attribution). */
export function dealDescription(opportunity: {
  id: string;
  notes: string | null;
  meeting_at: Date | null;
  lost_reason: string | null;
  source_signal_keys: string[];
}): string {
  const lines = [
    opportunity.notes?.trim() || null,
    opportunity.meeting_at ? `Meeting: ${opportunity.meeting_at.toISOString()}` : null,
    opportunity.lost_reason ? `Lost reason: ${opportunity.lost_reason}` : null,
    opportunity.source_signal_keys.length > 0
      ? `Signals: ${opportunity.source_signal_keys.join(", ")}`
      : null,
    `OpenOutbound opportunity ${opportunity.id}`,
  ];
  return lines.filter(Boolean).join("\n");
}
