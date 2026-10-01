import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { fixedClock } from "../../core/clock.js";
import { OpenOutboundError } from "../../core/errors.js";
import type { ProviderRuntime, ResearchProvider } from "../types.js";
import { createBuiltinResearch } from "./builtin.js";
import { createExa } from "./exa.js";
import { createFirecrawl } from "./firecrawl.js";
import type { ResearchInstance } from "./http.js";
import { providers } from "./index.js";
import { createParallel } from "./parallel.js";
import { createTavily } from "./tavily.js";

const KEY = "test-key-123";
const clock = fixedClock("2026-09-19T12:00:00Z");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
}

type Reply = { status?: number; json?: unknown; body?: string; headers?: Record<string, string> };

/** A runtime whose fetch answers from a queue of canned replies and records requests. */
function runtime(...replies: Reply[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const reply = replies.shift() ?? { status: 500, body: "no reply queued" };
    const body = reply.json !== undefined ? JSON.stringify(reply.json) : (reply.body ?? "");
    return new Response(body, {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  });
  return { rt: { fetch: fetch as unknown as typeof globalThis.fetch, clock }, calls };
}

const bodyOf = (call: { init: RequestInit } | undefined) =>
  JSON.parse(String(call?.init.body ?? "{}")) as Record<string, unknown>;
const headersOf = (call: { init: RequestInit } | undefined) =>
  (call?.init.headers ?? {}) as Record<string, string>;

interface Case {
  id: string;
  create: (
    rt: Pick<ProviderRuntime, "fetch" | "clock">,
    secrets?: Record<string, string>,
  ) => ResearchInstance;
  searchFixture: string;
  fetchFixture: string;
  authHeader: (headers: Record<string, string>) => string | undefined;
  searchPath: string;
  emptySearch: unknown;
}

const CASES: Case[] = [
  {
    id: "parallel",
    create: (rt, secrets = { api_key: KEY }) => createParallel({ mode: "basic" }, secrets, rt),
    searchFixture: "parallel-search",
    fetchFixture: "parallel-extract",
    authHeader: (h) => h["x-api-key"],
    searchPath: "https://api.parallel.ai/v1/search",
    emptySearch: { search_id: "s", results: [] },
  },
  {
    id: "exa",
    create: (rt, secrets = { api_key: KEY }) => createExa({ search_type: "auto" }, secrets, rt),
    searchFixture: "exa-search",
    fetchFixture: "exa-contents",
    authHeader: (h) => h["x-api-key"],
    searchPath: "https://api.exa.ai/search",
    emptySearch: { requestId: "r", results: [] },
  },
  {
    id: "tavily",
    create: (rt, secrets = { api_key: KEY }) =>
      createTavily({ search_depth: "basic" }, secrets, rt),
    searchFixture: "tavily-search",
    fetchFixture: "tavily-extract",
    authHeader: (h) => h.authorization,
    searchPath: "https://api.tavily.com/search",
    emptySearch: { query: "q", results: [] },
  },
  {
    id: "firecrawl",
    create: (rt, secrets = { api_key: KEY }) => createFirecrawl({}, secrets, rt),
    searchFixture: "firecrawl-search-v2",
    fetchFixture: "firecrawl-scrape",
    authHeader: (h) => h.authorization,
    searchPath: "https://api.firecrawl.dev/v2/search",
    emptySearch: { success: true, data: { web: [] } },
  },
];

describe.each(CASES)("$id provider", (testCase) => {
  it("maps search results and sends the key only in the auth header", async () => {
    const { rt, calls } = runtime({ json: fixture(testCase.searchFixture) });
    const provider = testCase.create(rt);
    const results = await provider.search("Lumen Home news", { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.url).toMatch(/^https:\/\//);
      expect(result.title.length).toBeGreaterThan(0);
      if (result.publishedAt) expect(Number.isNaN(Date.parse(result.publishedAt))).toBe(false);
    }
    expect(calls[0]?.url).toBe(testCase.searchPath);
    expect(testCase.authHeader(headersOf(calls[0]))).toContain(KEY);
    expect(JSON.stringify(bodyOf(calls[0]))).not.toContain(KEY);
  });

  it("returns an empty list for empty results", async () => {
    const { rt } = runtime({ json: testCase.emptySearch });
    expect(await testCase.create(rt).search("nothing here")).toEqual([]);
  });

  it("maps page fetches", async () => {
    const { rt } = runtime({ json: fixture(testCase.fetchFixture) });
    const provider = testCase.create(rt);
    const page = await provider.fetch?.("https://lumenhome.example.com/about");
    expect(page?.url).toBe("https://lumenhome.example.com/about");
    expect(page?.text).toContain("Lumen Home");
  });

  it("maps HTTP errors to actionable provider errors without leaking the key", async () => {
    const unauthorized = runtime({ status: 401, json: { error: `bad key ${KEY}` } });
    const error = await testCase
      .create(unauthorized.rt)
      .search("q")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenOutboundError);
    expect(error).toMatchObject({
      code: "provider_error",
      details: {
        provider: testCase.id,
        status: 401,
        failure: { class: "auth_invalid", retryable: false },
      },
    });
    expect(JSON.stringify((error as OpenOutboundError).toJSON())).not.toContain(KEY);
    expect((error as OpenOutboundError).hint).toContain(
      testCase.id === "exa" ? "EXA_API_KEY" : "_API_KEY",
    );

    const limited = runtime({ status: 429, body: "slow down", headers: { "retry-after": "12" } });
    await expect(testCase.create(limited.rt).search("q")).rejects.toMatchObject({
      retryAfterSeconds: 12,
      details: { rateLimited: true, failure: { class: "rate_limited", retry_after_s: 12 } },
    });
    const broken = runtime({ status: 503, body: "<html>down</html>" });
    await expect(testCase.create(broken.rt).search("q")).rejects.toMatchObject({
      details: { retryable: true, failure: { class: "unavailable", upstream_status: 503 } },
    });
    const invalid = runtime({ status: 400, json: { message: "query is required" } });
    await expect(testCase.create(invalid.rt).search("q")).rejects.toThrow(/query is required/);
  });

  it("rejects malformed responses", async () => {
    const notJson = runtime({ body: "<html>not json</html>" });
    await expect(testCase.create(notJson.rt).search("q")).rejects.toMatchObject({
      details: { failure: { class: "malformed" } },
    });
    const wrongShape = runtime({ json: { unexpected: true } });
    await expect(testCase.create(wrongShape.rt).search("q")).rejects.toMatchObject({
      details: { failure: { class: "malformed" } },
    });
    const wrongPage = runtime({ json: { nope: 1 } });
    await expect(
      testCase.create(wrongPage.rt).fetch?.("https://a.example.com"),
    ).rejects.toMatchObject({ details: { failure: { class: "malformed" } } });
  });

  it("checks the key without spending credits and needs a key", async () => {
    const accepted = runtime({ status: 400, json: { error: "missing query" } });
    expect(await testCase.create(accepted.rt).checkAuth()).toMatchObject({ ok: true });
    const rejected = runtime({ status: 401, json: {} });
    expect(await testCase.create(rejected.rt).checkAuth()).toMatchObject({ ok: false });
    // A key with no credits left, or a limit before the key was looked at, does not pass:
    // a passing test ends a pause of the provider.
    const noCredits = runtime({ status: 402, json: { error: "payment required" } });
    expect(await testCase.create(noCredits.rt).checkAuth()).toMatchObject({
      ok: false,
      message: expect.stringMatching(/no credits/),
    });
    const limited = runtime({ status: 429, json: { error: "slow down" } });
    expect(await testCase.create(limited.rt).checkAuth()).toMatchObject({
      ok: false,
      message: expect.stringMatching(/could not be checked/),
    });
    expect(() => testCase.create(runtime().rt, {})).toThrow(
      expect.objectContaining({ code: "provider_not_configured" }),
    );
  });
});

describe("provider specifics", () => {
  it("parallel: sends queries, limits and domain policy; drops non-web urls and old results", async () => {
    const { rt, calls } = runtime({ json: fixture("parallel-search") });
    const results = await createParallel({ mode: "fast" }, { api_key: KEY }, rt).search(
      "Lumen Home",
      { limit: 3, includeDomains: ["news.example.com"], recencyDays: 30 },
    );
    expect(bodyOf(calls[0])).toEqual({
      objective: "Lumen Home",
      search_queries: ["Lumen Home"],
      mode: "fast",
      advanced_settings: {
        max_results: 3,
        source_policy: { include_domains: ["news.example.com"] },
      },
    });
    expect(results.map((r) => r.url)).toEqual([
      "https://news.example.com/lumen-home-raises-series-b",
      "https://lumenhome.example.com/careers/demand-planner",
    ]);
    expect(results[0]).toMatchObject({
      publishedAt: "2026-09-02T00:00:00.000Z",
      snippet: expect.stringContaining("Series B"),
    });
  });

  it("exa: passes a start date for recency and uses summaries when highlights are missing", async () => {
    const { rt, calls } = runtime({ json: fixture("exa-search") });
    const results = await createExa({ search_type: "auto" }, { api_key: KEY }, rt).search("q", {
      recencyDays: 14,
    });
    expect(bodyOf(calls[0])).toMatchObject({
      type: "auto",
      startPublishedDate: "2026-09-05T12:00:00.000Z",
      contents: { highlights: true },
    });
    expect(results[1]?.snippet).toContain("VP Operations");
  });

  it("tavily: maps recency to time_range and drops results outside the window", async () => {
    const { rt, calls } = runtime({ json: fixture("tavily-search") });
    const results = await createTavily({ search_depth: "advanced" }, { api_key: KEY }, rt).search(
      "q",
      { recencyDays: 30 },
    );
    expect(bodyOf(calls[0])).toMatchObject({ time_range: "month", search_depth: "advanced" });
    expect(results.map((r) => r.url)).toEqual([
      "https://news.example.com/lumen-home-vp-operations",
    ]);
    expect(results[0]).toMatchObject({
      publishedAt: "2026-09-08T17:00:00.000Z",
      score: 0.81025416,
    });
  });

  it("firecrawl: accepts the v1 search shape and reports site errors on scrape", async () => {
    const { rt } = runtime(
      { json: fixture("firecrawl-search-v1") },
      { json: { success: true, data: { markdown: "", metadata: { statusCode: 404 } } } },
    );
    const provider = createFirecrawl({}, { api_key: KEY }, rt);
    expect((await provider.search("q"))[0]?.title).toBe("Lumen Home Series B");
    // The page is gone: a failure of this call only, never a reason to pause Firecrawl.
    await expect(provider.fetch?.("https://gone.example.com/x")).rejects.toMatchObject({
      details: { page_status: 404, failure: { class: "not_found", scope: "call" } },
    });
  });

  it("builtin: fetch only, through safe fetch with robots respected", async () => {
    const safeFetch = vi.fn(
      async () =>
        new Response("<html><title>About</title><body><p>Lighting.</p></body></html>", {
          headers: { "content-type": "text/html" },
        }),
    );
    const provider: ResearchProvider = createBuiltinResearch({ safeFetch });
    await expect(provider.search("anything")).rejects.toMatchObject({ code: "unsupported" });
    const page = await provider.fetch?.("https://lumenhome.example.com/about");
    expect(page).toEqual({
      url: "https://lumenhome.example.com/about",
      title: "About",
      text: "Lighting.",
    });
    expect(safeFetch).toHaveBeenCalledWith(
      "https://lumenhome.example.com/about",
      expect.objectContaining({ respectRobots: true }),
    );
    safeFetch.mockResolvedValueOnce(new Response("nope", { status: 404 }));
    await expect(provider.fetch?.("https://lumenhome.example.com/x")).rejects.toMatchObject({
      details: { page_status: 404, failure: { class: "not_found", scope: "call" } },
    });
    safeFetch.mockResolvedValueOnce(new Response("login", { status: 403 }));
    await expect(provider.fetch?.("https://lumenhome.example.com/y")).rejects.toMatchObject({
      details: { failure: { class: "refused", scope: "call" } },
    });
    // A busy or broken site: read the page again later.
    safeFetch.mockResolvedValueOnce(
      new Response("slow down", { status: 429, headers: { "retry-after": "30" } }),
    );
    await expect(provider.fetch?.("https://lumenhome.example.com/z")).rejects.toMatchObject({
      details: {
        failure: { class: "rate_limited", scope: "call", retryable: true, retry_after_s: 30 },
      },
    });
    safeFetch.mockResolvedValueOnce(new Response("down", { status: 503 }));
    await expect(provider.fetch?.("https://lumenhome.example.com/w")).rejects.toMatchObject({
      details: { failure: { class: "unavailable", scope: "call", retryable: true } },
    });
  });

  it("registers every provider with env names and a test", () => {
    expect(providers.map((p) => [p.id, p.secrets[0]?.env ?? null])).toEqual([
      ["parallel", "PARALLEL_API_KEY"],
      ["exa", "EXA_API_KEY"],
      ["tavily", "TAVILY_API_KEY"],
      ["firecrawl", "FIRECRAWL_API_KEY"],
      ["builtin", null],
    ]);
    expect(providers.every((p) => p.slot === "research" && typeof p.test === "function")).toBe(
      true,
    );
  });
});
