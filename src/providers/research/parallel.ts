/**
 * Parallel Web Systems (https://parallel.ai): Search API for web search, Extract API for
 * fetching pages. Auth: `x-api-key` header (see provider API notes, section 5).
 */
import { z } from "zod";
import {
  defineProvider,
  type FetchedPage,
  type ProviderRuntime,
  type SearchOptions,
  type SearchResult,
} from "../types.js";
import {
  clampLimit,
  malformed,
  type ProviderInfo,
  pageFailure,
  probeAuth,
  type ResearchInstance,
  requestJson,
  requireKey,
  snippet,
  toIsoDate,
  withinRecency,
} from "./http.js";

const INFO: ProviderInfo = { id: "parallel", name: "Parallel", env: "PARALLEL_API_KEY" };

const configSchema = z.object({
  mode: z
    .enum(["turbo", "fast", "basic", "advanced"])
    .default("basic")
    .describe("Search mode: faster modes cost less, advanced digs deeper"),
});
export type ParallelConfig = z.infer<typeof configSchema>;

const resultSchema = z.object({
  url: z.string(),
  title: z.string().nullish(),
  publish_date: z.string().nullish(),
  excerpts: z.array(z.string()).nullish(),
  full_content: z.string().nullish(),
});
const searchResponse = z.object({ results: z.array(resultSchema) });
const extractResponse = z.object({
  results: z.array(resultSchema),
  errors: z.array(z.unknown()).nullish(),
});

/** Request body for POST /v1/search. */
export function parallelSearchBody(query: string, options: SearchOptions, mode: string) {
  const sourcePolicy: Record<string, string[]> = {};
  if (options.includeDomains?.length) sourcePolicy.include_domains = options.includeDomains;
  if (options.excludeDomains?.length) sourcePolicy.exclude_domains = options.excludeDomains;
  return {
    objective: query,
    search_queries: [query],
    mode,
    advanced_settings: {
      max_results: clampLimit(options.limit, 20),
      ...(Object.keys(sourcePolicy).length > 0 ? { source_policy: sourcePolicy } : {}),
    },
  };
}

/** Maps a /v1/search response to search results. */
export function mapParallelSearch(json: unknown): SearchResult[] {
  const parsed = searchResponse.safeParse(json);
  if (!parsed.success) throw malformed(INFO, "search results missing");
  return parsed.data.results
    .filter((result) => /^https?:\/\//.test(result.url))
    .map((result) => {
      const item: SearchResult = { url: result.url, title: result.title?.trim() || result.url };
      const text = snippet(result.excerpts?.join(" ... "));
      if (text) item.snippet = text;
      const date = toIsoDate(result.publish_date);
      if (date) item.publishedAt = date;
      return item;
    });
}

/** Maps a /v1/extract response to the fetched page. */
export function mapParallelExtract(json: unknown, url: string): FetchedPage {
  const parsed = extractResponse.safeParse(json);
  if (!parsed.success) throw malformed(INFO, "extract results missing");
  const [result] = parsed.data.results;
  if (!result) throw pageFailure(INFO, url, `Parallel could not read ${url}.`);
  const text = (result.full_content ?? result.excerpts?.join("\n\n") ?? "").trim();
  const page: FetchedPage = { url: result.url || url, text };
  if (result.title) page.title = result.title;
  const date = toIsoDate(result.publish_date);
  if (date) page.publishedAt = date;
  return page;
}

export function createParallel(
  config: ParallelConfig,
  secrets: Record<string, string>,
  runtime: Pick<ProviderRuntime, "fetch" | "clock">,
): ResearchInstance {
  const key = requireKey(INFO, secrets);
  const base = "https://api.parallel.ai";
  const headers = { "x-api-key": key };
  return {
    id: INFO.id,
    creditsPerCall: { search: 1, fetch: 1 },
    async search(query, options = {}) {
      const json = await requestJson(runtime, INFO, {
        url: `${base}/v1/search`,
        headers,
        body: parallelSearchBody(query, options, config.mode),
      });
      const results = withinRecency(
        mapParallelSearch(json),
        options.recencyDays,
        runtime.clock.now(),
      );
      return results.slice(0, clampLimit(options.limit, 20));
    },
    async fetch(url) {
      const json = await requestJson(runtime, INFO, {
        url: `${base}/v1/extract`,
        headers,
        body: { urls: [url], full_content: true },
        timeoutMs: 60_000,
      });
      return mapParallelExtract(json, url);
    },
    checkAuth: () => probeAuth(runtime, INFO, { url: `${base}/v1/search`, headers, body: {} }),
  };
}

export const parallelProvider = defineProvider({
  slot: "research",
  id: INFO.id,
  name: "Parallel",
  description:
    "Web search and page extraction built for AI agents (Search and Extract APIs). Paid per request; see parallel.ai pricing.",
  docsUrl: "https://docs.parallel.ai/getting-started/overview",
  configSchema,
  secrets: [{ key: "api_key", label: "API key", env: INFO.env, required: true }],
  create: ({ config, secrets, ctx }) => createParallel(config, secrets, ctx),
  test: (instance) => (instance as ResearchInstance).checkAuth(),
});
