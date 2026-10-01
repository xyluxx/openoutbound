import type { SafeFetch, SafeFetchInit } from "../core/context.js";

/** A canned response. `json` wins over `body`; status defaults to 200. */
export interface FakeResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  json?: unknown;
}

export interface FakeRequest {
  url: string;
  method: string;
  init: SafeFetchInit | undefined;
}

export interface FetchRoute {
  /** Exact URL (trailing slash ignored) or a RegExp tested against the full URL. */
  match: string | RegExp;
  /** Only match this method (default: any). */
  method?: string;
  response:
    | FakeResponse
    | Response
    | ((request: FakeRequest) => FakeResponse | Response | Promise<FakeResponse | Response>);
}

/** SafeFetch fake driven by a route table; unmatched URLs throw so tests never hit the network. */
export interface FakeSafeFetch extends SafeFetch {
  route(match: string | RegExp, response: FetchRoute["response"], method?: string): void;
  /** Every request, in order. Same array as `ctx.recorded.fetch`. */
  calls: FakeRequest[];
}

const normalize = (url: string) => url.replace(/\/+$/, "");

export function createFakeFetch(
  routes: FetchRoute[] = [],
  calls: FakeRequest[] = [],
): FakeSafeFetch {
  const table = [...routes];

  const fake = (async (input: string | URL, init?: SafeFetchInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const request: FakeRequest = { url, method, init };
    calls.push(request);
    // Later routes win, so tests can override defaults.
    const route = [...table].reverse().find((candidate) => {
      if (candidate.method && candidate.method.toUpperCase() !== method) return false;
      return typeof candidate.match === "string"
        ? normalize(candidate.match) === normalize(url)
        : candidate.match.test(url);
    });
    if (!route) {
      throw new Error(
        `No fake fetch route for ${method} ${url}. Add one: createTestContext({ fetchRoutes: [...] }) or ctx.fetch.route(url, { body }).`,
      );
    }
    const resolved =
      typeof route.response === "function" ? await route.response(request) : route.response;
    return resolved instanceof Response ? resolved : toResponse(resolved);
  }) as FakeSafeFetch;

  fake.route = (match, response, method) => {
    table.push(method === undefined ? { match, response } : { match, response, method });
  };
  fake.calls = calls;
  return fake;
}

function toResponse(fake: FakeResponse): Response {
  const headers = new Headers(fake.headers);
  let body: string | null = fake.body ?? null;
  if (fake.json !== undefined) {
    body = JSON.stringify(fake.json);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  } else if (body !== null && !headers.has("content-type")) {
    headers.set("content-type", "text/html; charset=utf-8");
  }
  const status = fake.status ?? 200;
  return new Response(status === 204 || status === 304 ? null : body, { status, headers });
}
