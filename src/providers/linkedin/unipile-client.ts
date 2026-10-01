/**
 * Minimal Unipile REST client shared by the linkedin and social providers.
 * Base URL: `https://{DSN}/api/v1`; auth header `X-API-KEY` (provider API notes, section 3).
 * Requests go through the shared provider helper: a timeout joined with the caller's signal,
 * classified failures (`details.failure`), and the API key cut out of any answer.
 *
 * Errors are RFC 7807 problem JSON; `toUnipileError` classifies them and keeps the LinkedIn
 * slot flags (`restricted`, `rateLimited`, `disconnected`):
 * - `disconnected_account`, `invalid_credentials`, `expired_credentials`: the LinkedIn account
 *   needs reconnecting (`auth_invalid`, scope call, `disconnected`). Any other 401 means the
 *   Unipile API key itself was rejected (`auth_invalid`, scope account).
 * - 429, `cannot_resend_yet`, `too_many_requests`, `limit_exceeded`: `rate_limited`.
 * - `checkpoint_error`, `account_restricted` or a restriction in the text: `refused`,
 *   `restricted`. Other 403s: `forbidden` for this call. 422: `refused`.
 * - A write (invitation, message, comment, post) whose answer was lost, or that got a 5xx, is
 *   `outcome_unknown`. Likes, visits and withdrawals change nothing more when repeated. A 5xx is
 *   read by its status alone: a rate-limit type or words like "verification" in a server error
 *   do not prove that LinkedIn refused before acting.
 */
import type { OpenOutboundError } from "../../core/errors.js";
import type { FailureClass, FailureScope } from "../../core/failures.js";
import {
  answerFailure,
  type CallKind,
  classFailure,
  type FailureStyle,
  malformedFailure,
  type ProviderIdentity,
  parseJsonText,
  requestText,
} from "../http.js";

export interface UnipileClientOptions {
  /** Tenant DSN, e.g. `api1.unipile.com:13111` (a full https URL is accepted too). */
  dsn: string;
  apiKey: string;
  fetch: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface UnipileRequest extends CallKind {
  query?: Record<string, string | number | boolean | null | undefined>;
  json?: unknown;
  form?: Record<string, string | string[] | undefined>;
  /** The caller's signal (a job that is cancelled or out of time). */
  signal?: AbortSignal | undefined;
}

export interface UnipileClient {
  baseUrl: string;
  /**
   * Returns parsed JSON (or null for empty bodies, and for a write whose 2xx answer cannot be
   * read: it went through); throws a classified provider failure otherwise.
   */
  request(method: string, path: string, request?: UnipileRequest): Promise<unknown>;
}

export const UNIPILE: ProviderIdentity = { id: "unipile", name: "Unipile" };

/** `api1.unipile.com:13111` -> `https://api1.unipile.com:13111/api/v1`. */
export function unipileBaseUrl(dsn: string): string {
  let value = dsn.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  value = value.replace(/\/api\/v1$/i, "");
  return `${value}/api/v1`;
}

const RESTRICTED_SLUGS = new Set(["checkpoint_error", "account_restricted", "restricted"]);
const DISCONNECTED_SLUGS = new Set([
  "disconnected_account",
  "invalid_credentials",
  "expired_credentials",
]);
const RATE_LIMIT_SLUGS = new Set(["cannot_resend_yet", "too_many_requests", "limit_exceeded"]);

/** Unipile wording for failures that did not come from an answer (timeouts, network). */
const UNIPILE_STYLE: FailureStyle = {
  hint(failureClass: FailureClass) {
    if (failureClass === "timeout" || failureClass === "network") {
      return "Check UNIPILE_DSN and the network; the engine retries automatically.";
    }
    return undefined;
  },
};

interface Classified {
  class: FailureClass;
  scope?: FailureScope;
  hint?: string;
  retryAfterSeconds?: number;
  details: Record<string, unknown>;
}

function classify(status: number, slug: string, text: string, headers: Headers): Classified | null {
  // A server error may come after LinkedIn acted, whatever it says: only an answer below 500
  // is read as a rate limit or a restriction from its type or its words.
  const answered = status < 500;
  if (status === 429 || (answered && RATE_LIMIT_SLUGS.has(slug))) {
    const header = Number(headers.get("retry-after"));
    return {
      class: "rate_limited",
      retryAfterSeconds:
        Number.isFinite(header) && header > 0
          ? header
          : slug === "cannot_resend_yet"
            ? 86_400
            : 3_600,
      hint: "LinkedIn is limiting this account; the engine backs off and retries later.",
      details: { rateLimited: true },
    };
  }
  if (RESTRICTED_SLUGS.has(slug) || (answered && /restrict|captcha|verification/i.test(text))) {
    return {
      class: "refused",
      hint: "Log in to LinkedIn manually, complete any check, then resume the account.",
      details: { restricted: true },
    };
  }
  if (DISCONNECTED_SLUGS.has(slug)) {
    return {
      class: "auth_invalid",
      // The LinkedIn account, not the Unipile key: the provider keeps working for the others.
      scope: "call",
      hint: "Reconnect the account with `manage_linkedin` action `connect`.",
      details: { disconnected: true },
    };
  }
  if (status === 401) {
    return {
      class: "auth_invalid",
      scope: "account",
      hint: "Check the Unipile API key and DSN with manage_providers (action set, slot linkedin, provider unipile), then run manage_providers (action test).",
      details: {},
    };
  }
  if (slug === "insufficient_credits") {
    return { class: "quota_exhausted", scope: "call", details: {} };
  }
  if (status === 403) return { class: "forbidden", scope: "call", details: {} };
  if (status === 422) return { class: "refused", details: {} };
  return null;
}

/** Maps a non-2xx answer to a classified failure with the LinkedIn slot flags. */
export function toUnipileError(
  status: number,
  body: unknown,
  headers: Headers,
  context: string,
  kind: CallKind = {},
): OpenOutboundError {
  const problem =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const type = typeof problem.type === "string" ? problem.type : "";
  const slug = type.replace(/^errors\//, "");
  const title = typeof problem.title === "string" ? problem.title : "";
  const detail = typeof problem.detail === "string" ? problem.detail : "";
  const text = `${title} ${detail}`.replace(/\s+/g, " ").trim();
  const known = classify(status, slug, text, headers);
  const failure = answerFailure(
    UNIPILE,
    {
      status,
      headers,
      message: `Unipile ${context} failed (${status}${slug ? ` ${slug}` : ""})${text ? `: ${text.slice(0, 200)}` : ""}.`,
      details: { type: slug || null, ...known?.details },
      ...(known
        ? {
            class: known.class,
            ...(known.scope ? { scope: known.scope } : {}),
            ...(known.hint ? { hint: known.hint } : {}),
            ...(known.retryAfterSeconds === undefined
              ? {}
              : { retryAfterSeconds: known.retryAfterSeconds }),
          }
        : {}),
    },
    kind,
    UNIPILE_STYLE,
  );
  return failure;
}

function buildUrl(base: string, path: string, query: UnipileRequest["query"]): string {
  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export function createUnipileClient(options: UnipileClientOptions): UnipileClient {
  const baseUrl = unipileBaseUrl(options.dsn);
  return {
    baseUrl,
    async request(method, path, request = {}) {
      const headers: Record<string, string> = {
        "X-API-KEY": options.apiKey,
        accept: "application/json",
      };
      let body: RequestInit["body"];
      if (request.form) {
        const form = new FormData();
        for (const [key, value] of Object.entries(request.form)) {
          if (value === undefined) continue;
          for (const item of Array.isArray(value) ? value : [value]) form.append(key, item);
        }
        body = form;
      } else if (request.json !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(request.json);
      }
      const kind: CallKind = {
        ...(request.write ? { write: true } : {}),
        ...(request.idempotent ? { idempotent: true } : {}),
      };
      const context = `${method} ${path.replace(/\/[A-Za-z0-9_-]{16,}(?=\/|$)/g, "/:id")}`;
      const answer = await requestText(
        options.fetch,
        UNIPILE,
        {
          url: buildUrl(baseUrl, path, request.query),
          method,
          headers,
          ...(body === undefined ? {} : { body }),
          timeoutMs: options.timeoutMs ?? 30_000,
          ...(request.signal ? { signal: request.signal } : {}),
          ...kind,
        },
        UNIPILE_STYLE,
      );
      const parsed = answer.text.trim() ? parseJsonText(answer.text) : null;
      if (!answer.ok) {
        throw toUnipileError(answer.status, parsed ?? null, answer.headers, context, kind);
      }
      if (parsed === undefined) {
        // An answer that cannot be read. A write that is safe to repeat (a like, a visit, a
        // withdrawal) counts as done. Any other write may or may not have reached LinkedIn
        // (a page in between can answer 2xx too): an unknown outcome, checked before anything
        // is sent again (docs/concepts/delivery-guarantees.md).
        if (kind.write && kind.idempotent) return null;
        if (kind.write) {
          throw classFailure(
            UNIPILE,
            "outcome_unknown",
            {
              message: `Unipile answered ${context} with something that is not JSON, so it is unknown whether it acted.`,
              hint: "The engine does not send it again blindly: it checks the conversation or the profile, or asks a person (manage_messages action resolve_unknown).",
            },
            UNIPILE_STYLE,
          );
        }
        throw malformedFailure(UNIPILE, `${context} answered with malformed JSON`, kind);
      }
      return parsed;
    },
  };
}
