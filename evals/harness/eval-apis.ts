/**
 * Provider APIs as the eval engine sees them: the engine's provider fetch answers only from
 * handlers that scenarios register (a fake Apollo, for example). Any other request fails, so an
 * eval never reaches a real provider or spends real credits.
 */

export interface ApiRequest {
  method: string;
  url: URL;
  headers: Headers;
  /** The JSON body, the raw text when it is not JSON, or null when empty. */
  body: unknown;
}

export interface ApiResponse {
  status?: number;
  /** Sent as JSON. */
  body: unknown;
  headers?: Record<string, string>;
}

export type ApiHandler = (request: ApiRequest) => ApiResponse | Promise<ApiResponse>;

export interface EvalApis {
  /** The engine's provider fetch. */
  fetch: typeof globalThis.fetch;
  /** Answers every request to this URL (origin and path; the query string is ignored). */
  route(url: string, handler: ApiHandler): void;
  /** Every request that reached a handler, in order. */
  requests: Array<{ method: string; url: string }>;
}

function routeKey(url: string | URL): string {
  const parsed = new URL(String(url));
  return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}`;
}

async function bodyText(input: string | URL | Request, init?: RequestInit): Promise<string> {
  const body = init?.body ?? (input instanceof Request ? await input.text() : null);
  if (body === null || body === undefined) return "";
  if (typeof body === "string") return body;
  return new Response(body).text();
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createEvalApis(): EvalApis {
  const handlers = new Map<string, ApiHandler>();
  const requests: EvalApis["requests"] = [];

  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const handler = handlers.get(routeKey(url));
    if (!handler) throw new Error(`Eval engines never call real providers (${url}).`);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    requests.push({ method, url });
    const response = await handler({
      method,
      url: new URL(url),
      headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
      body: parseBody(await bodyText(input, init)),
    });
    return new Response(JSON.stringify(response.body ?? null), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json", ...response.headers },
    });
  };

  return {
    fetch: fetcher as typeof globalThis.fetch,
    route(url, handler) {
      handlers.set(routeKey(url), handler);
    },
    requests,
  };
}
