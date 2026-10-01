/**
 * Shared plumbing for research providers: JSON requests through the runtime fetch and the shared
 * provider helper (a timeout on every request, classified failures that never include API
 * keys), an auth probe for `test()` that spends no credits, and small value helpers. Searches
 * and fetches cost credits, so one whose answer was lost is not retried automatically.
 */
import { OpenOutboundError } from "../../core/errors.js";
import type { FailureClass } from "../../core/failures.js";
import {
  answerFailure,
  classFailure,
  type FailureStyle,
  malformedFailure,
  parseJsonText,
  requestText,
} from "../http.js";
import type { ProviderRuntime, ProviderTestResult, ResearchProvider } from "../types.js";

export const DEFAULT_TIMEOUT_MS = 30_000;

export interface ProviderInfo {
  /** Provider id, e.g. "exa". */
  id: string;
  /** Display name, e.g. "Exa". */
  name: string;
  /** Env var of the API key, for hints. */
  env: string;
}

/** A research provider instance with a credit-free auth check for `test()`. */
export interface ResearchInstance extends ResearchProvider {
  checkAuth(): Promise<ProviderTestResult>;
}

export interface JsonRequest {
  method?: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** Default true: research calls cost credits once the provider receives them. */
  paid?: boolean;
}

/** Research wording: which key to fix and where. */
export function researchStyle(info: ProviderInfo): FailureStyle {
  return {
    message(failureClass: FailureClass) {
      if (failureClass === "auth_invalid" || failureClass === "forbidden") {
        return `${info.name} rejected the API key.`;
      }
      if (failureClass === "quota_exhausted")
        return `${info.name} says the account is out of credits.`;
      return undefined;
    },
    hint(failureClass: FailureClass) {
      if (failureClass === "auth_invalid" || failureClass === "forbidden") {
        return `Check the ${info.name} key (manage_providers action set for slot research, or the ${info.env} env var), then run manage_providers (action test).`;
      }
      if (failureClass === "quota_exhausted") {
        return `Top up the ${info.name} account, or switch research provider with manage_providers (action set).`;
      }
      if (failureClass === "rate_limited") {
        return "It is retried automatically after the wait; lower the research volume if it keeps happening.";
      }
      return undefined;
    },
    details(failureClass: FailureClass) {
      return failureClass === "rate_limited" ? { rateLimited: true } : undefined;
    },
  };
}

/** Sends a JSON request and returns the parsed body; throws classified failures. */
export async function requestJson(
  runtime: Pick<ProviderRuntime, "fetch">,
  info: ProviderInfo,
  request: JsonRequest,
): Promise<unknown> {
  const answer = await requestText(
    runtime.fetch,
    info,
    {
      url: request.url,
      method: request.method ?? "POST",
      headers: {
        accept: "application/json",
        ...(request.body === undefined ? {} : { "content-type": "application/json" }),
        ...request.headers,
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      paid: request.paid ?? true,
    },
    researchStyle(info),
  );
  if (!answer.ok) throw httpError(info, answer.status, answer.headers, answer.text);
  return parseJson(info, answer.text);
}

export function parseJson(info: ProviderInfo, text: string): unknown {
  const parsed = parseJsonText(text);
  if (parsed === undefined) throw malformed(info, "the response is not JSON");
  return parsed;
}

/** The provider answered, but not in the shape we expect. */
export function malformed(info: ProviderInfo, detail: string): OpenOutboundError {
  return malformedFailure(info, detail, {}, researchStyle(info));
}

/** Maps a non-2xx answer to a classified failure. */
export function httpError(
  info: ProviderInfo,
  status: number,
  headers: Headers,
  body: string,
): OpenOutboundError {
  return answerFailure(info, { status, headers, body }, {}, researchStyle(info));
}

/**
 * The provider worked, but the page it was asked to read could not be read. It concerns this
 * one page (scope `call`), so the provider is never paused for it: `not_found` for a page that
 * is gone (404, 410), `rate_limited` for a site that asked to slow down (429), `unavailable`
 * for a site that is down (5xx), `refused` otherwise (private, blocked).
 */
export function pageFailure(
  info: ProviderInfo,
  url: string,
  message: string,
  pageStatus?: number,
  retryAfterSeconds?: number,
): OpenOutboundError {
  const failureClass: FailureClass =
    pageStatus === 404 || pageStatus === 410
      ? "not_found"
      : pageStatus === 429
        ? "rate_limited"
        : pageStatus !== undefined && pageStatus >= 500
          ? "unavailable"
          : "refused";
  const later = failureClass === "rate_limited" || failureClass === "unavailable";
  return classFailure(
    info,
    failureClass,
    {
      message,
      hint: later
        ? "The site is busy or down: read this page again later."
        : "Check that the page is public, or fetch it with the builtin provider.",
      scope: "call",
      ...(later && retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      details: { url, ...(pageStatus === undefined ? {} : { page_status: pageStatus }) },
    },
    researchStyle(info),
  );
}

/**
 * Checks the API key without spending credits: sends a request the provider must reject as
 * invalid. 401/403 means a bad key, 402 a key with no credits left, 429 a limit that came
 * before the key was looked at; any other 4xx (or 2xx) means the key was accepted.
 */
export async function probeAuth(
  runtime: Pick<ProviderRuntime, "fetch">,
  info: ProviderInfo,
  request: JsonRequest,
): Promise<ProviderTestResult> {
  let status: number;
  try {
    ({ status } = await requestText(
      runtime.fetch,
      info,
      {
        url: request.url,
        method: request.method ?? "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...request.headers,
        },
        body: JSON.stringify(request.body ?? {}),
        timeoutMs: 15_000,
      },
      researchStyle(info),
    ));
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : `${info.name} could not be reached.`,
    };
  }
  if (status === 401 || status === 403) {
    return { ok: false, message: `${info.name} rejected the API key (${status}).` };
  }
  if (status === 402) {
    return {
      ok: false,
      message: `${info.name} accepted the API key, but no credits are left (402).`,
    };
  }
  if (status === 429) {
    return {
      ok: false,
      message: `${info.name} is limiting requests (429), so the key could not be checked. Try again in a minute.`,
    };
  }
  if (status >= 500) {
    return { ok: false, message: `${info.name} had a server error (${status}).` };
  }
  return { ok: true, message: `${info.name} accepted the API key.` };
}

/** ISO 8601 from a provider date string (ISO, RFC 2822 or YYYY-MM-DD); undefined when unparseable. */
export function toIsoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
}

/** Drops results published before the recency window (undated results are kept). */
export function withinRecency<T extends { publishedAt?: string }>(
  items: T[],
  recencyDays: number | undefined,
  now: Date,
): T[] {
  if (!recencyDays || recencyDays <= 0) return items;
  const cutoff = now.getTime() - recencyDays * 24 * 60 * 60 * 1000;
  return items.filter((item) => !item.publishedAt || Date.parse(item.publishedAt) >= cutoff);
}

export function clampLimit(limit: number | undefined, max: number, fallback = 10): number {
  return Math.max(1, Math.min(limit ?? fallback, max));
}

/** Short text for snippets: whitespace collapsed, max `max` characters. */
export function snippet(value: string | undefined | null, max = 500): string | undefined {
  if (!value) return undefined;
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  return clean.length > max ? `${clean.slice(0, max - 3).trimEnd()}...` : clean;
}

export function requireKey(info: ProviderInfo, secrets: Record<string, string>): string {
  const key = secrets.api_key?.trim();
  if (!key) {
    throw new OpenOutboundError("provider_not_configured", `${info.name} needs an API key.`, {
      hint: `Set it with manage_providers (slot research, provider ${info.id}) or the ${info.env} env var.`,
      details: { slot: "research", provider: info.id },
    });
  }
  return key;
}

export function baseUrl(value: string | undefined, fallback: string): string {
  return (value?.trim() || fallback).replace(/\/+$/, "");
}
