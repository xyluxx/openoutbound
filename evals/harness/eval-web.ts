/**
 * The web as the eval engine sees it: a route table behind the engine's safe fetch. Scenarios
 * publish invented company sites (example.com subdomains); every other URL answers 404, so
 * crawlers and collectors skip it and nothing ever reaches the real network.
 */
import type { SafeFetch, SafeFetchInit } from "../../src/core/context.js";

export interface WebResponse {
  status?: number;
  body: string;
  contentType?: string;
  headers?: Record<string, string>;
}

export interface EvalWeb extends SafeFetch {
  /** Serves one URL (trailing slash ignored). A string body is served as HTML. */
  page(url: string, response: string | WebResponse): void;
  /** Serves several paths of one site: `site("https://acme.example.com", { "/": html })`. */
  site(origin: string, pages: Record<string, string | WebResponse>): void;
  /** Every requested URL, in order. */
  requests: string[];
}

function normalize(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
  } catch {
    return url.replace(/\/+$/, "");
  }
}

export function createEvalWeb(): EvalWeb {
  const routes = new Map<string, WebResponse>();
  const requests: string[] = [];

  const fetcher = (async (input: string | URL, _init?: SafeFetchInit) => {
    const url = String(input);
    requests.push(url);
    const route = routes.get(normalize(url));
    if (!route) {
      return new Response("Not found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response(route.body, {
      status: route.status ?? 200,
      headers: {
        "content-type": route.contentType ?? "text/html; charset=utf-8",
        ...route.headers,
      },
    });
  }) as EvalWeb;

  fetcher.page = (url, response) => {
    routes.set(normalize(url), typeof response === "string" ? { body: response } : response);
  };
  fetcher.site = (origin, pages) => {
    const base = origin.replace(/\/+$/, "");
    for (const [path, response] of Object.entries(pages)) {
      fetcher.page(`${base}${path.startsWith("/") ? path : `/${path}`}`, response);
    }
  };
  fetcher.requests = requests;
  return fetcher;
}
