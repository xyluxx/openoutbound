/**
 * Firecrawl (https://firecrawl.dev): /v2/scrape for page markdown, /v2/search for web search.
 * Auth: `Authorization: Bearer <key>` (see provider API notes, section 7). The search mapping
 * accepts both the v2 shape (`data.web[]`) and the older v1 shape (`data[]`).
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
  baseUrl,
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

const INFO: ProviderInfo = { id: "firecrawl", name: "Firecrawl", env: "FIRECRAWL_API_KEY" };

const configSchema = z.object({
  base_url: z
    .url({ protocol: /^https?$/ })
    .optional()
    .describe(
      "Only for self-hosted Firecrawl: its API base URL (default https://api.firecrawl.dev)",
    ),
});
export type FirecrawlConfig = z.infer<typeof configSchema>;

const webResult = z.object({
  url: z.string(),
  title: z.string().nullish(),
  description: z.string().nullish(),
  publishedDate: z.string().nullish(),
  date: z.string().nullish(),
});
const searchResponse = z.object({
  success: z.boolean().optional(),
  data: z.union([z.array(webResult), z.object({ web: z.array(webResult).nullish() })]),
});
const scrapeResponse = z.object({
  success: z.boolean().optional(),
  data: z.object({
    markdown: z.string().nullish(),
    metadata: z
      .object({
        title: z.string().nullish(),
        sourceURL: z.string().nullish(),
        url: z.string().nullish(),
        statusCode: z.number().nullish(),
        publishedTime: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
  }),
});

/** Google-style `tbs` value for a recency window. */
export function firecrawlTbs(days: number | undefined): string | undefined {
  if (!days || days <= 0) return undefined;
  if (days <= 1) return "qdr:d";
  if (days <= 7) return "qdr:w";
  if (days <= 31) return "qdr:m";
  return "qdr:y";
}

export function firecrawlSearchBody(
  query: string,
  options: SearchOptions,
): Record<string, unknown> {
  const sites = (options.includeDomains ?? []).map((domain) => `site:${domain}`).join(" OR ");
  const excluded = (options.excludeDomains ?? []).map((domain) => `-site:${domain}`).join(" ");
  const body: Record<string, unknown> = {
    query: [query, sites ? `(${sites})` : "", excluded].filter(Boolean).join(" "),
    limit: clampLimit(options.limit, 20),
  };
  const tbs = firecrawlTbs(options.recencyDays);
  if (tbs) body.tbs = tbs;
  return body;
}

export function mapFirecrawlSearch(json: unknown): SearchResult[] {
  const parsed = searchResponse.safeParse(json);
  if (!parsed.success || parsed.data.success === false) {
    throw malformed(INFO, "search results missing");
  }
  const rows = Array.isArray(parsed.data.data) ? parsed.data.data : (parsed.data.data.web ?? []);
  return rows
    .filter((row) => /^https?:\/\//.test(row.url))
    .map((row) => {
      const item: SearchResult = { url: row.url, title: row.title?.trim() || row.url };
      const text = snippet(row.description);
      if (text) item.snippet = text;
      const date = toIsoDate(row.publishedDate ?? row.date);
      if (date) item.publishedAt = date;
      return item;
    });
}

export function mapFirecrawlScrape(json: unknown, url: string): FetchedPage {
  const parsed = scrapeResponse.safeParse(json);
  if (!parsed.success || parsed.data.success === false) {
    throw malformed(INFO, "scrape data missing");
  }
  const { markdown, metadata } = parsed.data.data;
  if (metadata?.statusCode && metadata.statusCode >= 400) {
    throw pageFailure(
      INFO,
      url,
      `Firecrawl fetched ${url} but the site answered ${metadata.statusCode}.`,
      metadata.statusCode,
    );
  }
  const page: FetchedPage = {
    url: metadata?.sourceURL ?? metadata?.url ?? url,
    text: (markdown ?? "").trim(),
  };
  if (metadata?.title) page.title = metadata.title;
  const date = toIsoDate(metadata?.publishedTime);
  if (date) page.publishedAt = date;
  return page;
}

export function createFirecrawl(
  config: FirecrawlConfig,
  secrets: Record<string, string>,
  runtime: Pick<ProviderRuntime, "fetch" | "clock">,
): ResearchInstance {
  const key = requireKey(INFO, secrets);
  const base = baseUrl(config.base_url, "https://api.firecrawl.dev");
  const headers = { authorization: `Bearer ${key}` };
  return {
    id: INFO.id,
    creditsPerCall: { search: 2, fetch: 1 },
    async search(query, options = {}) {
      const json = await requestJson(runtime, INFO, {
        url: `${base}/v2/search`,
        headers,
        body: firecrawlSearchBody(query, options),
        timeoutMs: 60_000,
      });
      return withinRecency(
        mapFirecrawlSearch(json),
        options.recencyDays,
        runtime.clock.now(),
      ).slice(0, clampLimit(options.limit, 20));
    },
    async fetch(url) {
      const json = await requestJson(runtime, INFO, {
        url: `${base}/v2/scrape`,
        headers,
        body: { url, formats: ["markdown"], onlyMainContent: true },
        timeoutMs: 90_000,
      });
      return mapFirecrawlScrape(json, url);
    },
    checkAuth: () => probeAuth(runtime, INFO, { url: `${base}/v2/scrape`, headers, body: {} }),
  };
}

export const firecrawlProvider = defineProvider({
  slot: "research",
  id: INFO.id,
  name: "Firecrawl",
  description:
    "Scrapes pages to clean markdown (renders JavaScript sites) and searches the web. Credit based (scrape 1 credit per page); see firecrawl.dev pricing.",
  docsUrl: "https://docs.firecrawl.dev/api-reference/endpoint/scrape",
  configSchema,
  secrets: [{ key: "api_key", label: "API key", env: INFO.env, required: true }],
  create: ({ config, secrets, ctx }) => createFirecrawl(config, secrets, ctx),
  test: (instance) => (instance as ResearchInstance).checkAuth(),
});
