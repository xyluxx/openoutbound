/**
 * Safe fetch (spec 6) for URLs that come from data: websites, feeds, webhook targets.
 *
 * - Only http(s). Every hop is DNS-resolved and each address checked against the IP policy;
 *   the connection is pinned to the checked addresses, so DNS rebinding cannot swap them.
 * - At most 5 redirects (re-checked, credentials dropped across origins), 15 s overall timeout,
 *   5 MB body cap (after decompression), the OpenOutbound user agent.
 * - robots.txt (cached 24 h) when `respectRobots` is set.
 * - A 429 response is returned to the caller and the host is backed off until its Retry-After;
 *   calls during the backoff fail fast with `provider_error` and `retryAfterSeconds`.
 * - Non-2xx responses are returned, not thrown.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import robotsParserImport from "robots-parser";
import type { Clock } from "../core/clock.js";
import type { SafeFetch, SafeFetchFailure, SafeFetchInit } from "../core/context.js";
import { OpenOutboundError } from "../core/errors.js";
import { type Failure, type FailureClass, isRetryableClass } from "../core/failures.js";
import type { Logger } from "../core/logger.js";
import { isAddressAllowed } from "./ip-policy.js";

export const SAFE_FETCH_DEFAULTS = {
  timeoutMs: 15_000,
  maxBytes: 5 * 1024 * 1024,
  maxRedirects: 5,
} as const;

const ROBOTS_AGENT = "OpenOutboundBot";
const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;
const ROBOTS_ERROR_TTL_MS = 60 * 60 * 1000;
const ROBOTS_MAX_BYTES = 512 * 1024;
const CACHE_LIMIT = 2000;
const DEFAULT_BACKOFF_SECONDS = 60;
const MAX_BACKOFF_SECONDS = 3600;

/** Resolves a hostname to IP addresses. */
export type HostResolver = (hostname: string) => Promise<string[]>;

export interface TransportRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
  /** Checked addresses the connection must use. */
  addresses: string[];
  signal: AbortSignal;
}

export interface TransportResponse {
  status: number;
  statusText: string;
  headers: Headers;
  body: AsyncIterable<Uint8Array> | null;
  /** Stops the download (called when the caller will not read the body). */
  destroy?(): void;
}

/** Performs one HTTP exchange without following redirects. */
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export interface SafeFetchDeps {
  allowPrivateNetwork: boolean;
  userAgent: string;
  clock: Clock;
  log?: Logger;
  resolveHost?: HostResolver;
  transport?: Transport;
}

interface RobotRules {
  isAllowed(url: string, ua?: string): boolean | undefined;
}
type RobotsParser = (url: string, contents: string) => RobotRules;
// robots-parser is CommonJS (module.exports = fn); its types declare a default export.
const robotsParser: RobotsParser =
  typeof robotsParserImport === "function"
    ? (robotsParserImport as unknown as RobotsParser)
    : (robotsParserImport as unknown as { default: RobotsParser }).default;

const defaultResolveHost: HostResolver = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((result) => result.address);
};

/** Node http(s) transport that connects only to the pre-checked addresses. */
export const nodeTransport: Transport = (request) =>
  new Promise((resolve, reject) => {
    const client = request.url.protocol === "https:" ? https : http;
    const pinned = request.addresses.map((address) => ({ address, family: isIP(address) || 4 }));
    const lookup = ((_hostname, options, callback) => {
      const first = pinned[0];
      if (!first) {
        callback(new Error("no address"), "", 4);
        return;
      }
      if ((options as { all?: boolean } | undefined)?.all) callback(null, pinned);
      else callback(null, first.address, first.family);
    }) as LookupFunction;
    const outgoing = client.request(
      request.url,
      {
        method: request.method,
        headers: request.headers,
        lookup,
        agent: false,
        signal: request.signal,
      },
      (incoming) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) for (const item of value) headers.append(name, item);
          else if (value !== undefined) headers.set(name, value);
        }
        resolve({
          status: incoming.statusCode ?? 0,
          statusText: incoming.statusMessage ?? "",
          headers,
          body: incoming,
          destroy: () => incoming.destroy(),
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end(request.body ?? undefined);
  });

/**
 * The failure class of each refusal (core/failures): an address or path the engine will not
 * fetch is `refused` and an unusable URL `bad_request`, never a network error worth retrying.
 */
export const SAFE_FETCH_CLASSES: Record<SafeFetchFailure | "rate_limited", FailureClass> = {
  invalid_url: "bad_request",
  blocked_address: "refused",
  robots_disallowed: "refused",
  timeout: "timeout",
  too_large: "malformed",
  too_many_redirects: "malformed",
  network: "network",
  rate_limited: "rate_limited",
};

function failure(
  reason: SafeFetchFailure | "rate_limited",
  message: string,
  extra: {
    hint?: string;
    details?: Record<string, unknown>;
    retryAfterSeconds?: number;
    /** The underlying error: callers tell a connection that never opened from a dropped one. */
    cause?: unknown;
  } = {},
): OpenOutboundError {
  const code =
    reason === "blocked_address" || reason === "robots_disallowed"
      ? "forbidden"
      : reason === "invalid_url"
        ? "validation_failed"
        : "provider_error";
  const failureClass = SAFE_FETCH_CLASSES[reason];
  const classified: Failure = {
    class: failureClass,
    retryable: isRetryableClass(failureClass),
    scope: "call",
    ...(extra.retryAfterSeconds === undefined ? {} : { retry_after_s: extra.retryAfterSeconds }),
  };
  const options: ConstructorParameters<typeof OpenOutboundError>[2] = {
    details: { reason, ...extra.details, failure: classified },
  };
  if (extra.hint) options.hint = extra.hint;
  if (extra.retryAfterSeconds !== undefined) options.retryAfterSeconds = extra.retryAfterSeconds;
  if (extra.cause !== undefined) options.cause = extra.cause;
  return new OpenOutboundError(code, message, options);
}

function parseUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = new URL(String(input));
  } catch {
    // Quoted without its query string: providers put keys there.
    const shown = String(input).split(/[?#]/)[0]?.slice(0, 200) ?? "";
    throw failure("invalid_url", `Invalid URL "${shown}".`, {
      hint: "Pass an absolute http:// or https:// URL.",
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw failure("invalid_url", `Unsupported URL scheme "${url.protocol}".`, {
      hint: "Only http:// and https:// URLs can be fetched.",
    });
  }
  return url;
}

function parseRetryAfter(value: string | null, now: number): number {
  if (!value) return DEFAULT_BACKOFF_SECONDS;
  const seconds = Number(value);
  let result = DEFAULT_BACKOFF_SECONDS;
  if (Number.isFinite(seconds)) result = seconds;
  else {
    const date = Date.parse(value);
    if (!Number.isNaN(date)) result = Math.ceil((date - now) / 1000);
  }
  return Math.min(Math.max(result, 1), MAX_BACKOFF_SECONDS);
}

async function encodeBody(
  body: RequestInit["body"],
  headers: Record<string, string>,
): Promise<Uint8Array | null> {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  const request = new Request("http://localhost/", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit);
  const type = request.headers.get("content-type");
  if (type && !headers["content-type"]) headers["content-type"] = type;
  return new Uint8Array(await request.arrayBuffer());
}

function decoderFor(encoding: string) {
  if (encoding === "gzip" || encoding === "x-gzip") return createGunzip();
  if (encoding === "deflate") return createInflate();
  if (encoding === "br") return createBrotliDecompress();
  return null;
}

function setCapped<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > CACHE_LIMIT) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
}

export function createSafeFetch(deps: SafeFetchDeps): SafeFetch {
  const resolveHost = deps.resolveHost ?? defaultResolveHost;
  const transport = deps.transport ?? nodeTransport;
  const robotsCache = new Map<
    string,
    { rules: RobotRules | "allow" | "deny"; expiresAt: number }
  >();
  const backoffUntil = new Map<string, number>();

  const resolveAllowed = async (url: URL, allowPrivate: boolean): Promise<string[]> => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    let addresses: string[];
    if (isIP(host)) addresses = [host];
    else {
      try {
        addresses = await resolveHost(host);
      } catch (error) {
        throw failure("network", `Could not resolve ${host}.`, {
          hint: "Check the domain name; the site may not exist anymore.",
          details: { host, cause: (error as Error).message },
          cause: error,
        });
      }
    }
    if (addresses.length === 0) throw failure("network", `Could not resolve ${host}.`);
    if (addresses.some((address) => !isAddressAllowed(address, allowPrivate))) {
      throw failure(
        "blocked_address",
        `Refused to fetch ${host}: it resolves to a private or internal address.`,
        {
          hint: "Only public addresses can be fetched. Self-hosters can allow private networks with OPENOUTBOUND_ALLOW_PRIVATE_NETWORK=true.",
          details: { host },
        },
      );
    }
    return addresses;
  };

  const readBody = async (response: TransportResponse, maxBytes: number): Promise<Buffer> => {
    const encoding = (response.headers.get("content-encoding") ?? "").trim().toLowerCase();
    const decoder = decoderFor(encoding);
    const declared = Number(response.headers.get("content-length"));
    if (!decoder && Number.isFinite(declared) && declared > maxBytes) {
      response.destroy?.();
      throw failure("too_large", `The response is larger than ${maxBytes} bytes.`, {
        details: { max_bytes: maxBytes },
      });
    }
    if (!response.body) return Buffer.alloc(0);
    let source: AsyncIterable<Uint8Array> = response.body;
    if (decoder) {
      const input = Readable.from(response.body);
      input.on("error", (error) => decoder.destroy(error));
      source = input.pipe(decoder);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of source) {
      total += chunk.length;
      if (total > maxBytes) {
        response.destroy?.();
        decoder?.destroy();
        throw failure("too_large", `The response is larger than ${maxBytes} bytes.`, {
          details: { max_bytes: maxBytes },
        });
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  };

  interface Options {
    method: string;
    headers: Record<string, string>;
    body: Uint8Array | null;
    redirect: NonNullable<RequestInit["redirect"]>;
    maxRedirects: number;
    maxBytes: number;
    allowPrivate: boolean;
    respectRobots: boolean;
    signal: AbortSignal;
  }

  const robotsAllows = async (target: URL, options: Options): Promise<boolean> => {
    const now = deps.clock.now().getTime();
    let entry = robotsCache.get(target.origin);
    if (!entry || entry.expiresAt <= now) {
      entry = await loadRobots(target, options, now);
      setCapped(robotsCache, target.origin, entry);
    }
    if (entry.rules === "allow") return true;
    if (entry.rules === "deny") return false;
    return entry.rules.isAllowed(target.toString(), ROBOTS_AGENT) !== false;
  };

  const loadRobots = async (target: URL, options: Options, now: number) => {
    const robotsUrl = new URL("/robots.txt", target.origin);
    try {
      const response = await run(robotsUrl, {
        ...options,
        method: "GET",
        body: null,
        headers: { "user-agent": options.headers["user-agent"] ?? deps.userAgent },
        redirect: "follow",
        maxBytes: ROBOTS_MAX_BYTES,
        respectRobots: false,
      });
      if (response.status >= 200 && response.status < 300) {
        return {
          rules: robotsParser(robotsUrl.toString(), await response.text()),
          expiresAt: now + ROBOTS_TTL_MS,
        };
      }
      if (response.status >= 500) {
        return { rules: "deny" as const, expiresAt: now + ROBOTS_ERROR_TTL_MS };
      }
      return { rules: "allow" as const, expiresAt: now + ROBOTS_TTL_MS };
    } catch (error) {
      if (error instanceof OpenOutboundError && error.code === "forbidden") throw error;
      deps.log?.debug({ origin: target.origin }, "robots.txt unavailable; allowing");
      return { rules: "allow" as const, expiresAt: now + ROBOTS_ERROR_TTL_MS };
    }
  };

  const run = async (start: URL, options: Options): Promise<Response> => {
    let url = start;
    let method = options.method;
    let body = options.body;
    const headers = { ...options.headers };
    for (let redirects = 0; ; redirects++) {
      options.signal.throwIfAborted();
      const until = backoffUntil.get(url.host);
      const now = deps.clock.now().getTime();
      if (until !== undefined && until > now) {
        const retryAfterSeconds = Math.ceil((until - now) / 1000);
        throw failure("rate_limited", `${url.host} asked us to slow down.`, {
          hint: `Retry after ${retryAfterSeconds} seconds.`,
          details: { host: url.host },
          retryAfterSeconds,
        });
      }
      if (options.respectRobots && !(await robotsAllows(url, options))) {
        throw failure("robots_disallowed", `robots.txt of ${url.host} disallows ${url.pathname}.`, {
          hint: "Skip this page; the site does not allow crawlers there.",
          details: { url: url.toString() },
        });
      }
      const addresses = await resolveAllowed(url, options.allowPrivate);
      if (body) headers["content-length"] = String(body.byteLength);
      else delete headers["content-length"];
      const response = await transport({
        url,
        method,
        headers,
        body,
        addresses,
        signal: options.signal,
      });

      const location = response.headers.get("location");
      if (
        [301, 302, 303, 307, 308].includes(response.status) &&
        location &&
        options.redirect !== "manual"
      ) {
        response.destroy?.();
        if (options.redirect === "error") {
          throw failure("network", `Unexpected redirect from ${url.host}.`, {
            details: { status: response.status },
          });
        }
        if (redirects >= options.maxRedirects) {
          throw failure("too_many_redirects", `More than ${options.maxRedirects} redirects.`, {
            details: { url: start.toString() },
          });
        }
        const next = parseUrl(new URL(location, url).toString());
        if (
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) && method === "POST")
        ) {
          method = "GET";
          body = null;
          delete headers["content-type"];
        }
        if (next.origin !== url.origin) {
          delete headers.authorization;
          delete headers.cookie;
        }
        url = next;
        continue;
      }

      if (response.status === 429) {
        const seconds = parseRetryAfter(response.headers.get("retry-after"), now);
        setCapped(backoffUntil, url.host, now + seconds * 1000);
      }
      if (response.status < 200 || response.status > 599) {
        response.destroy?.();
        throw failure("network", `Unsupported HTTP status ${response.status} from ${url.host}.`);
      }
      const bytes = await readBody(response, options.maxBytes);
      const responseHeaders = new Headers(response.headers);
      if (decoderFor((responseHeaders.get("content-encoding") ?? "").trim().toLowerCase())) {
        responseHeaders.delete("content-encoding");
        responseHeaders.delete("content-length");
      }
      const nullBody = [204, 205, 304].includes(response.status);
      const result = new Response(nullBody ? null : bytes, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
      Object.defineProperty(result, "url", { value: url.toString() });
      Object.defineProperty(result, "redirected", { value: redirects > 0 });
      return result;
    }
  };

  return async (input, init: SafeFetchInit = {}) => {
    const {
      respectRobots = false,
      timeoutMs = SAFE_FETCH_DEFAULTS.timeoutMs,
      maxBytes = SAFE_FETCH_DEFAULTS.maxBytes,
      allowPrivate = deps.allowPrivateNetwork,
      maxRedirects = SAFE_FETCH_DEFAULTS.maxRedirects,
      signal: callerSignal,
      ...requestInit
    } = init;
    const url = parseUrl(input);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onCallerAbort = () => controller.abort(callerSignal?.reason);
    if (callerSignal?.aborted) controller.abort(callerSignal.reason);
    else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

    const headers: Record<string, string> = {};
    new Headers(requestInit.headers).forEach((value, name) => {
      headers[name] = value;
    });
    headers["user-agent"] ??= deps.userAgent;
    headers["accept-encoding"] ??= "gzip, deflate, br";
    try {
      const body = await encodeBody(requestInit.body, headers);
      return await run(url, {
        method: (requestInit.method ?? "GET").toUpperCase(),
        headers,
        body,
        redirect: requestInit.redirect ?? "follow",
        maxRedirects,
        maxBytes,
        allowPrivate,
        respectRobots,
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) {
        throw failure("timeout", `Fetching ${url.host} timed out after ${timeoutMs} ms.`, {
          hint: "The site is slow or unreachable; try again later.",
          details: { host: url.host, timeout_ms: timeoutMs },
        });
      }
      if (error instanceof OpenOutboundError) throw error;
      if (callerSignal?.aborted) throw callerSignal.reason ?? error;
      throw failure("network", `Request to ${url.host} failed: ${(error as Error).message}`, {
        details: { host: url.host },
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  };
}
