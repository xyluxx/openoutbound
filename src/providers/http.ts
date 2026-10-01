/**
 * HTTP plumbing every provider shares. Each request carries a timeout joined with the caller's
 * signal (`providerSignal`), and each failure becomes a classified provider error
 * (`providerFailure` in src/core/failures.ts):
 *
 * - A thrown fetch error is `timeout` or `network`. For a write (a call that changes something
 *   outside: an invitation, a message, a post), a timeout or a connection that dropped after the
 *   request may have been sent is `outcome_unknown`: only a connection that never opened is a
 *   plain `network` failure. A write the provider documents as idempotent stays retryable.
 * - A non-2xx answer is classified with `classifyHttpStatus` (or the family's override). A server
 *   error answering a write is `outcome_unknown`; a 429 or a refusal stays what it is, since the
 *   provider answered before acting.
 * - An answer whose body breaks off is read by what the call was (`requestText`): a non-2xx one
 *   from its status, as if its body were empty; a 2xx one to a write that can be repeated as
 *   done; a 2xx one to any other write as `outcome_unknown` (something in between can answer 2xx
 *   too), unless the provider's id for what it made already came in the headers (`idHeaders`);
 *   a read's as a lost connection, retried.
 * - A paid call (credits are spent once the provider receives it) that lost its answer is not
 *   retried automatically (`retryable: false`): the first try may have been charged.
 * - Safe fetch refusals (blocked address, robots.txt, invalid URL) keep their meaning (`refused`,
 *   `bad_request`), so they are never retried as network errors.
 *
 * Messages never contain URLs (some providers take the key in the query string), headers, or
 * more of a response body than a short provider message. Credentials the request carried (auth
 * headers, key-like query parameters) are cut out of the body text before anything reads it,
 * since some providers echo the key in their error messages.
 */
import { isOpenOutboundError, OpenOutboundError } from "../core/errors.js";
import {
  classifyFetchError,
  classifyHttpStatus,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  type FailureClass,
  type FailureScope,
  failureOf,
  isFetchError,
  type PartialResult,
  parseRetryAfter,
  providerFailure,
  providerSignal,
} from "../core/failures.js";

/** Which provider a failure belongs to. */
export interface ProviderIdentity {
  /** Provider id, e.g. "apollo". */
  id: string;
  /** Display name for messages, e.g. "Apollo". */
  name: string;
}

/** What a call does, which decides how its failures are classified. */
export interface CallKind {
  /** Changes something outside the engine (an invitation, a message, a post, a record). */
  write?: boolean;
  /** Repeating it cannot do the change twice (an upsert by key, a delete). */
  idempotent?: boolean;
  /** Costs credits once the provider receives it, even when the answer is lost. */
  paid?: boolean;
}

/** A provider family's wording: messages and hints per class, and flags older readers check. */
export interface FailureStyle {
  /** Replaces the class's default message (an upstream message may follow it). */
  message?(failureClass: FailureClass, status: number | undefined): string | undefined;
  /** Replaces the class's default hint. Name the tool and action that fixes it. */
  hint?(failureClass: FailureClass): string | undefined;
  /** Extra details for a class, e.g. `{ auth: true }` that enrichment reads. */
  details?(failureClass: FailureClass): Record<string, unknown> | undefined;
}

export interface ProviderRequest extends CallKind {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: RequestInit["body"];
  /** Default {@link DEFAULT_PROVIDER_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** The caller's signal: a job that is cancelled or out of time. */
  signal?: AbortSignal;
  /**
   * Headers that carry the provider's id for what a write made (LinkedIn's `x-restli-id`): when
   * one arrived, a 2xx answer whose body broke off still counts as done (see `requestText`).
   */
  idHeaders?: string[];
}

let timeoutCap: number | null = null;

/**
 * Lowers every provider request timeout to `ms` (null restores them). For tests that need a
 * request that never answers to end quickly.
 */
export function capProviderTimeouts(ms: number | null): void {
  timeoutCap = ms;
}

/** The signal for one provider request: its timeout (capped in tests) and the caller's signal. */
export function requestSignal(timeoutMs?: number, parent?: AbortSignal): AbortSignal {
  const wanted = timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  return providerSignal(timeoutCap === null ? wanted : Math.min(wanted, timeoutCap), parent);
}

/**
 * Sends one request through the provider runtime's fetch with a timeout and the caller's
 * signal. Any status comes back as a Response; a thrown error becomes a classified failure.
 */
export async function sendRequest(
  fetchFn: typeof globalThis.fetch,
  provider: ProviderIdentity,
  request: ProviderRequest,
  style?: FailureStyle,
): Promise<Response> {
  return (await exchange(fetchFn, provider, request, style, false)).response;
}

/** An answer read in full: status, headers and the body as text. */
export interface ProviderAnswer {
  status: number;
  ok: boolean;
  headers: Headers;
  text: string;
}

/**
 * Sends one request and reads the whole body as text, under the same timeout. A body that breaks
 * off is read by what the call was (see the module doc): a non-2xx answer comes back with an empty
 * body, to be classified from its status; a 2xx answer to a write that can be repeated is
 * `malformed` (it went through); one to any other write is `outcome_unknown`, unless one of the
 * request's `idHeaders` arrived, and then it comes back with an empty body; a read's is a timeout
 * or network failure.
 */
export async function requestText(
  fetchFn: typeof globalThis.fetch,
  provider: ProviderIdentity,
  request: ProviderRequest,
  style?: FailureStyle,
): Promise<ProviderAnswer> {
  const { response, text } = await exchange(fetchFn, provider, request, style, true);
  return { status: response.status, ok: response.ok, headers: response.headers, text };
}

async function exchange(
  fetchFn: typeof globalThis.fetch,
  provider: ProviderIdentity,
  request: ProviderRequest,
  style: FailureStyle | undefined,
  readBody: boolean,
): Promise<{ response: Response; text: string }> {
  if (request.signal?.aborted) {
    // Nothing was sent (`details.not_sent`): whatever the call is, it can run again.
    throw failure(provider, "timeout", {
      message: `The call to ${provider.name} was stopped before it was sent.`,
      details: { not_sent: true },
      cause: request.signal.reason,
      style,
    });
  }
  const signal = requestSignal(request.timeoutMs, request.signal);
  let response: Response;
  try {
    response = await fetchFn(request.url, {
      method: request.method ?? "GET",
      ...(request.headers ? { headers: request.headers } : {}),
      ...(request.body === undefined || request.body === null ? {} : { body: request.body }),
      signal,
    });
  } catch (error) {
    // Out of time, or the caller stopped it (whatever reason the signal carries).
    if (signal.aborted) throw lostAnswer(provider, "timeout", error, request, style, error);
    throw thrownFailure(provider, error, request, style);
  }
  if (!readBody) return { response, text: "" };
  try {
    return { response, text: redact(await response.text(), credentialsOf(request)) };
  } catch (error) {
    // The body broke off. Any other status says what happened, as if the body were empty.
    if (!response.ok) return { response, text: "" };
    if (request.write && request.idempotent) {
      throw malformedFailure(provider, "the answer broke off", request, style, error);
    }
    if (request.write) {
      // The provider's own id for what it made came first: it did it.
      if (request.idHeaders?.some((name) => response.headers.has(name))) {
        return { response, text: "" };
      }
      // A 2xx alone may come from something in between: it may not have reached the provider.
      throw failure(provider, "outcome_unknown", {
        message: `${provider.name} answered ${response.status}, but the answer broke off, so it is not known whether it acted.`,
        upstreamStatus: response.status,
        cause: error,
        style,
      });
    }
    const read: CallKind = { ...request, write: false };
    if (signal.aborted) throw lostAnswer(provider, "timeout", error, read, style, error);
    throw thrownFailure(provider, error, read, style);
  }
}

/** Headers that never carry a credential. */
const PLAIN_HEADERS = new Set([
  "accept",
  "accept-language",
  "anthropic-version",
  "cache-control",
  "content-type",
  "linkedin-version",
  "user-agent",
  "x-goog-fieldmask",
  "x-restli-protocol-version",
]);
const CREDENTIAL_PARAM = /(^|_)(api|key|apikey|token|secret|password|auth|signature|sig)($|_)/i;
/** OAuth fields kept secret although their names do not say so (the app's client id too). */
const CREDENTIAL_FIELDS = new Set(["code", "code_verifier", "client_id"]);

function isCredentialField(name: string): boolean {
  return CREDENTIAL_PARAM.test(name) || CREDENTIAL_FIELDS.has(name.toLowerCase());
}

/** Name and value pairs of a form or flat JSON body (nothing for other bodies). */
function bodyFields(body: ProviderRequest["body"]): [string, string][] {
  if (body instanceof URLSearchParams) return [...body];
  if (typeof body !== "string") return [];
  const text = body.trim();
  if (text.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") return [];
      return Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      );
    } catch {
      return [];
    }
  }
  return text.includes("=") ? [...new URLSearchParams(text)] : [];
}

/**
 * Credential values a request carries: auth headers, and key-like fields of its query string
 * (also when the address does not parse) and of a form or JSON body (OAuth secrets and codes).
 */
export function credentialsOf(
  request: Pick<ProviderRequest, "url" | "headers" | "body">,
): string[] {
  const values = new Set<string>();
  const add = (value: string | null | undefined) => {
    const trimmed = value?.trim() ?? "";
    const token = trimmed.replace(/^(bearer|basic|token)\s+/i, "");
    for (const candidate of [trimmed, token]) if (candidate.length >= 8) values.add(candidate);
  };
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (!PLAIN_HEADERS.has(name.toLowerCase())) add(value);
  }
  const query = request.url.includes("?") ? request.url.slice(request.url.indexOf("?") + 1) : "";
  for (const [name, value] of new URLSearchParams(query.split("#")[0])) {
    if (isCredentialField(name)) add(value);
  }
  for (const [name, value] of bodyFields(request.body)) {
    if (isCredentialField(name)) add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/** The text with every credential replaced by "[redacted]". */
export function redact(text: string, credentials: string[]): string {
  let out = text;
  for (const credential of credentials) {
    if (out.includes(credential)) out = out.split(credential).join("[redacted]");
  }
  return out;
}

const NEVER_CONNECTED = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EHOSTDOWN",
  "ENETDOWN",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** True when a network error (or one of its causes) shows the connection never opened. */
export function neverConnected(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const { code, syscall } = current as { code?: unknown; syscall?: unknown };
    if (typeof code === "string" && NEVER_CONNECTED.has(code)) return true;
    if (syscall === "connect" || syscall === "getaddrinfo") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Safe fetch reasons that mean the request was refused before anything was sent. */
const SAFE_FETCH_CLASSES: Record<string, FailureClass> = {
  blocked_address: "refused",
  robots_disallowed: "refused",
  invalid_url: "bad_request",
  too_large: "malformed",
  too_many_redirects: "malformed",
  rate_limited: "rate_limited",
};

/** The failure for an error thrown while calling the provider. */
export function thrownFailure(
  provider: ProviderIdentity,
  error: unknown,
  kind: CallKind = {},
  style?: FailureStyle,
): OpenOutboundError {
  if (isOpenOutboundError(error)) {
    // Already a provider failure (a nested provider call): keep it as it is.
    if (error.details?.failure !== undefined && typeof error.details.provider === "string") {
      return error;
    }
    const reason = typeof error.details?.reason === "string" ? error.details.reason : "";
    if (reason === "invalid_url") return invalidAddress(provider, error, style);
    const known = SAFE_FETCH_CLASSES[reason];
    if (known) {
      const request = kind as Partial<ProviderRequest>;
      const secrets =
        typeof request.url === "string" ? credentialsOf({ ...request, url: request.url }) : [];
      return failure(provider, known, {
        message: redact(`${provider.name}: ${error.message}`, secrets),
        ...(error.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: error.retryAfterSeconds }),
        details: { reason },
        cause: error,
        style,
      });
    }
    if (reason === "timeout" || reason === "network") {
      return lostAnswer(provider, reason, error.cause ?? error, kind, style, error);
    }
    // Some other engine error (a validation failure, a missing setting): already actionable.
    return error;
  }
  if (isFetchError(error)) {
    return lostAnswer(provider, classifyFetchError(error), error, kind, style, error);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/invalid url|parse url/i.test(message)) return invalidAddress(provider, error, style);
  return lostAnswer(provider, "network", error, kind, style, error);
}

/** An address the fetch could not use. Never quotes it: providers put keys in query strings. */
function invalidAddress(
  provider: ProviderIdentity,
  cause: unknown,
  style: FailureStyle | undefined,
): OpenOutboundError {
  return failure(provider, "bad_request", {
    message: `${provider.name} could not be called: the configured address is not a valid URL.`,
    hint: `Check the ${provider.name} base_url with manage_providers (action list), then fix it with manage_providers (action set).`,
    details: { reason: "invalid_url" },
    cause,
    style,
  });
}

/** A timeout or a network error: what it means depends on the call and on when it happened. */
function lostAnswer(
  provider: ProviderIdentity,
  failureClass: "timeout" | "network",
  inspect: unknown,
  kind: CallKind,
  style: FailureStyle | undefined,
  cause: unknown,
): OpenOutboundError {
  const notSent = neverConnected(inspect);
  if (kind.write && !kind.idempotent && !notSent) {
    return failure(provider, "outcome_unknown", {
      message:
        failureClass === "timeout"
          ? `${provider.name} did not answer in time, so it is not known whether it acted.`
          : `The connection to ${provider.name} broke, so it is not known whether it acted.`,
      cause,
      style,
    });
  }
  if (kind.paid && !notSent) {
    return failure(provider, failureClass, {
      message:
        failureClass === "timeout"
          ? `${provider.name} did not answer in time.`
          : `The connection to ${provider.name} broke before the answer arrived.`,
      hint: `The call may already have used ${provider.name} credits, so it is not repeated automatically. Run it again when you need the result.`,
      retryable: false,
      cause,
      style,
      keepHint: true,
    });
  }
  return failure(provider, failureClass, { cause, style });
}

export interface AnswerInput {
  status: number;
  headers?: Headers;
  /** Parsed JSON or text; used for a short provider message. */
  body?: unknown;
  /** Replaces the class from the status (a provider-specific rule). */
  class?: FailureClass;
  /** Replaces the default message. */
  message?: string;
  hint?: string;
  scope?: FailureScope;
  retryable?: boolean;
  retryAfterSeconds?: number;
  details?: Record<string, unknown>;
}

/** The failure for a non-2xx answer (or a 2xx whose body reports an error). */
export function answerFailure(
  provider: ProviderIdentity,
  input: AnswerInput,
  kind: CallKind = {},
  style?: FailureStyle,
): OpenOutboundError {
  let failureClass = input.class ?? classifyHttpStatus(input.status);
  if (
    input.class === undefined &&
    kind.write &&
    !kind.idempotent &&
    input.status >= 500 &&
    (failureClass === "unavailable" || failureClass === "timeout")
  ) {
    failureClass = "outcome_unknown";
  }
  // A rate limit, an outage or a used-up quota may say when to come back.
  const retryAfter =
    input.retryAfterSeconds ??
    (failureClass === "rate_limited" ||
    failureClass === "unavailable" ||
    failureClass === "quota_exhausted"
      ? parseRetryAfter(input.headers?.get("retry-after") ?? null)
      : undefined);
  const upstream = upstreamMessage(input.body);
  const unknown = failureClass === "outcome_unknown" && input.class === undefined;
  const base =
    input.message === undefined
      ? unknown
        ? `${provider.name} had a server error (${input.status}), so it is not known whether it acted.`
        : undefined
      : unknown
        ? `${input.message.replace(/\.$/, "")}, so it is not known whether it acted.`
        : input.message;
  return failure(provider, failureClass, {
    ...(base === undefined ? {} : { message: base }),
    upstream,
    upstreamStatus: input.status,
    ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
    ...(input.hint === undefined ? {} : { hint: input.hint, keepHint: true }),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    ...(input.retryable === undefined ? {} : { retryable: input.retryable }),
    ...(input.details === undefined ? {} : { details: input.details }),
    style,
  });
}

/**
 * A 2xx answer whose body cannot be read or lacks what the call needs. For a write the provider
 * accepted the request, so the message says so (`details.accepted`): the action happened.
 */
export function malformedFailure(
  provider: ProviderIdentity,
  what: string,
  kind: CallKind = {},
  style?: FailureStyle,
  cause?: unknown,
): OpenOutboundError {
  return failure(provider, "malformed", {
    message: kind.write
      ? `${provider.name} accepted the request, but its answer could not be read (${what}).`
      : `${provider.name} returned an unexpected response (${what}).`,
    ...(kind.write
      ? {
          hint: "It went through: do not send it again, or it will be duplicated. If the provider API changed, report it with this message.",
          keepHint: true,
        }
      : {}),
    details: kind.write ? { accepted: true } : {},
    cause,
    style,
  });
}

/** What a failure says beyond its class. */
export interface FailureParts {
  message?: string;
  hint?: string;
  /** Use `hint` even when the family has its own hint for the class. */
  keepHint?: boolean;
  upstream?: string | null;
  upstreamStatus?: number;
  retryAfterSeconds?: number;
  retryable?: boolean;
  scope?: FailureScope;
  details?: Record<string, unknown>;
  cause?: unknown;
  style?: FailureStyle | undefined;
}

/**
 * A failure of a given class that no HTTP status or thrown error describes, such as an error a
 * provider reports inside a successful answer (`status: "INSUFFICIENT_FUNDS"`). A `hint` given
 * here wins over the family's hint.
 */
export function classFailure(
  provider: ProviderIdentity,
  failureClass: FailureClass,
  parts: Omit<FailureParts, "style" | "keepHint"> = {},
  style?: FailureStyle,
): OpenOutboundError {
  return failure(provider, failureClass, {
    ...parts,
    style,
    keepHint: parts.hint !== undefined,
  });
}

/** Builds the error with the family's hint and legacy details. */
function failure(
  provider: ProviderIdentity,
  failureClass: FailureClass,
  parts: FailureParts,
): OpenOutboundError {
  const styleHint = parts.style?.hint?.(failureClass);
  const hint = parts.keepHint ? parts.hint : (styleHint ?? parts.hint);
  const base =
    parts.message ??
    parts.style?.message?.(failureClass, parts.upstreamStatus) ??
    defaultMessage(provider, failureClass, parts.upstreamStatus);
  const message = parts.upstream ? `${base.replace(/\.$/, "")}: ${parts.upstream}` : base;
  return providerFailure({
    provider: provider.id,
    name: provider.name,
    class: failureClass,
    message: message.endsWith(".") ? message : `${message}.`,
    ...(hint === undefined ? {} : { hint }),
    ...(parts.upstreamStatus === undefined ? {} : { upstreamStatus: parts.upstreamStatus }),
    ...(parts.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: parts.retryAfterSeconds }),
    ...(parts.retryable === undefined ? {} : { retryable: parts.retryable }),
    ...(parts.scope === undefined ? {} : { scope: parts.scope }),
    details: { ...parts.style?.details?.(failureClass), ...parts.details },
    ...(parts.cause === undefined ? {} : { cause: parts.cause }),
  });
}

function defaultMessage(
  provider: ProviderIdentity,
  failureClass: FailureClass,
  status: number | undefined,
): string {
  // The class messages from core/failures, built once here so an upstream message can follow.
  const sample = providerFailure({
    provider: provider.id,
    name: provider.name,
    class: failureClass,
    ...(status === undefined ? {} : { upstreamStatus: status }),
  });
  return sample.message;
}

/**
 * A short message from common JSON error shapes (`{ error }`, `{ error: { message } }`,
 * `{ message }`, `{ errors: [{ message | details }] }`, problem+json `title` and `detail`), at
 * most 200 characters. HTML and other non-JSON text give null.
 */
export function upstreamMessage(body: unknown): string | null {
  const clean = (value: string): string | null => {
    const text = value.replace(/\s+/g, " ").trim();
    if (!text || /^<!?[a-z]/i.test(text)) return null;
    return text.length > 200 ? `${text.slice(0, 197).trimEnd()}...` : text;
  };
  if (typeof body === "string") {
    try {
      return upstreamMessage(JSON.parse(body));
    } catch {
      return null;
    }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const nested = record.error;
  if (typeof nested === "string" && nested) {
    // OAuth errors: a code in `error`, the words in `error_description`.
    const description = record.error_description;
    return typeof description === "string" && description.trim()
      ? clean(`${nested}: ${description}`)
      : clean(nested);
  }
  if (nested && typeof nested === "object") {
    const message = (nested as Record<string, unknown>).message;
    if (typeof message === "string") return clean(message);
  }
  for (const key of ["message", "detail", "error_description", "reason", "error_message"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return clean(value);
  }
  if (typeof record.title === "string" && record.title.trim()) return clean(record.title);
  const errors = record.errors;
  if (Array.isArray(errors) && errors[0] && typeof errors[0] === "object") {
    const first = errors[0] as Record<string, unknown>;
    const text = first.details ?? first.message ?? first.detail;
    if (typeof text === "string") return clean(text);
  }
  return null;
}

/** JSON from a body text, or undefined when it is not JSON. */
export function parseJsonText(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Adds what a multi-page or multi-chunk call got before it failed (`details.partial`, read with
 * `partialOf`). When that work already cost credits, the call is not retried automatically
 * (starting again would pay twice) and the hint says how to go on (`next`, e.g. "Pass
 * details.partial.resume as the cursor"). Errors that are not engine errors (a bug) pass
 * through unchanged.
 */
export function withPartial<T>(
  error: unknown,
  provider: ProviderIdentity,
  partial: PartialResult<T>,
  next = "Continue from details.partial instead of starting again.",
): unknown {
  if (!isOpenOutboundError(error)) return error;
  const charged = (partial.credits ?? 0) > 0;
  const details: Record<string, unknown> = { ...error.details, partial };
  const known = failureOf(error);
  if (charged && known?.retryable) {
    details.retryable = false;
    details.failure = { ...known, retryable: false };
  }
  const kept = `${provider.name} already returned ${partial.items.length} ${partial.items.length === 1 ? "result" : "results"} for ${partial.credits ?? 0} credits (details.partial). ${next}`;
  return new OpenOutboundError(error.code, error.message, {
    hint: charged ? `${kept} ${error.hint ?? ""}`.trim() : error.hint,
    details,
    status: error.status,
    ...(error.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: error.retryAfterSeconds }),
    ...(error.cause === undefined ? {} : { cause: error.cause }),
  });
}

/** True when an error is a classified provider failure of one of the classes. */
export function hasClass(error: unknown, ...classes: FailureClass[]): boolean {
  const failureClass = failureOf(error)?.class;
  return failureClass !== undefined && classes.includes(failureClass);
}
