/**
 * Tavily (https://tavily.com): /search for web search, /extract for page text.
 * Auth: `Authorization: Bearer <key>` (see provider API notes, section 7). The /extract
 * mapping follows Tavily's public docs (not in the notes): results[].raw_content.
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

const INFO: ProviderInfo = { id: "tavily", name: "Tavily", env: "TAVILY_API_KEY" };

const configSchema = z.object({
  search_depth: z
    .enum(["basic", "advanced", "fast", "ultra-fast"])
    .default("basic")
    .describe("advanced costs 2 credits per search"),
});
export type TavilyConfig = z.infer<typeof configSchema>;

const searchResponse = z.object({
  results: z.array(
    z.object({
      url: z.string(),
      title: z.string().nullish(),
      content: z.string().nullish(),
      score: z.number().nullish(),
      published_date: z.string().nullish(),
    }),
  ),
});
const extractResponse = z.object({
  results: z.array(
    z.object({ url: z.string(), raw_content: z.string().nullish(), title: z.string().nullish() }),
  ),
  failed_results: z.array(z.unknown()).nullish(),
});

/** Tavily time_range for a recency window in days. */
export function tavilyTimeRange(days: number | undefined): string | undefined {
  if (!days || days <= 0) return undefined;
  if (days <= 1) return "day";
  if (days <= 7) return "week";
  if (days <= 31) return "month";
  return "year";
}

export function tavilySearchBody(
  query: string,
  options: SearchOptions,
  depth: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query,
    search_depth: depth,
    max_results: clampLimit(options.limit, 20),
    include_answer: false,
    include_raw_content: false,
  };
  const timeRange = tavilyTimeRange(options.recencyDays);
  if (timeRange) body.time_range = timeRange;
  if (options.includeDomains?.length) body.include_domains = options.includeDomains;
  if (options.excludeDomains?.length) body.exclude_domains = options.excludeDomains;
  return body;
}

export function mapTavilySearch(json: unknown): SearchResult[] {
  const parsed = searchResponse.safeParse(json);
  if (!parsed.success) throw malformed(INFO, "search results missing");
  return parsed.data.results
    .filter((result) => /^https?:\/\//.test(result.url))
    .map((result) => {
      const item: SearchResult = { url: result.url, title: result.title?.trim() || result.url };
      const text = snippet(result.content);
      if (text) item.snippet = text;
      const date = toIsoDate(result.published_date);
      if (date) item.publishedAt = date;
      if (typeof result.score === "number") item.score = result.score;
      return item;
    });
}

export function mapTavilyExtract(json: unknown, url: string): FetchedPage {
  const parsed = extractResponse.safeParse(json);
  if (!parsed.success) throw malformed(INFO, "extract results missing");
  const [result] = parsed.data.results;
  if (!result?.raw_content) throw pageFailure(INFO, url, `Tavily could not read ${url}.`);
  const page: FetchedPage = { url: result.url || url, text: result.raw_content.trim() };
  if (result.title) page.title = result.title;
  return page;
}

export function createTavily(
  config: TavilyConfig,
  secrets: Record<string, string>,
  runtime: Pick<ProviderRuntime, "fetch" | "clock">,
): ResearchInstance {
  const key = requireKey(INFO, secrets);
  const base = "https://api.tavily.com";
  const headers = { authorization: `Bearer ${key}` };
  return {
    id: INFO.id,
    creditsPerCall: { search: config.search_depth === "advanced" ? 2 : 1, fetch: 1 },
    async search(query, options = {}) {
      const json = await requestJson(runtime, INFO, {
        url: `${base}/search`,
        headers,
        body: tavilySearchBody(query, options, config.search_depth),
      });
      return withinRecency(mapTavilySearch(json), options.recencyDays, runtime.clock.now()).slice(
        0,
        clampLimit(options.limit, 20),
      );
    },
    async fetch(url) {
      const json = await requestJson(runtime, INFO, {
        url: `${base}/extract`,
        headers,
        body: { urls: [url], extract_depth: "basic", format: "markdown" },
        timeoutMs: 60_000,
      });
      return mapTavilyExtract(json, url);
    },
    checkAuth: () => probeAuth(runtime, INFO, { url: `${base}/search`, headers, body: {} }),
  };
}

export const tavilyProvider = defineProvider({
  slot: "research",
  id: INFO.id,
  name: "Tavily",
  description:
    "Web search API for agents with recency filters and page extraction. Credit based (basic search 1 credit, advanced 2); see tavily.com pricing.",
  docsUrl: "https://docs.tavily.com/documentation/api-reference/endpoint/search",
  configSchema,
  secrets: [{ key: "api_key", label: "API key", env: INFO.env, required: true }],
  create: ({ config, secrets, ctx }) => createTavily(config, secrets, ctx),
  test: (instance) => (instance as ResearchInstance).checkAuth(),
});
