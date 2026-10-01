/**
 * Exa (https://exa.ai): /search with highlights for web search, /contents for page text.
 * Auth: `x-api-key` header (see provider API notes, section 6).
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

const INFO: ProviderInfo = { id: "exa", name: "Exa", env: "EXA_API_KEY" };

const configSchema = z.object({
  search_type: z
    .enum(["auto", "fast", "instant", "deep-lite", "deep", "deep-reasoning"])
    .default("auto"),
});
export type ExaConfig = z.infer<typeof configSchema>;

const resultSchema = z.object({
  url: z.string(),
  title: z.string().nullish(),
  publishedDate: z.string().nullish(),
  highlights: z.array(z.string()).nullish(),
  summary: z.string().nullish(),
  text: z.string().nullish(),
});
const searchResponse = z.object({ results: z.array(resultSchema) });
const contentsResponse = z.object({
  results: z.array(resultSchema),
  statuses: z
    .array(z.object({ id: z.string().nullish(), status: z.string(), error: z.unknown().nullish() }))
    .nullish(),
});

/** Request body for POST /search. */
export function exaSearchBody(
  query: string,
  options: SearchOptions,
  type: string,
  now: Date,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query,
    type,
    numResults: clampLimit(options.limit, 25),
    contents: { highlights: true },
  };
  if (options.includeDomains?.length) body.includeDomains = options.includeDomains;
  if (options.excludeDomains?.length) body.excludeDomains = options.excludeDomains;
  if (options.recencyDays && options.recencyDays > 0) {
    body.startPublishedDate = new Date(
      now.getTime() - options.recencyDays * 24 * 60 * 60 * 1000,
    ).toISOString();
  }
  return body;
}

export function mapExaSearch(json: unknown): SearchResult[] {
  const parsed = searchResponse.safeParse(json);
  if (!parsed.success) throw malformed(INFO, "search results missing");
  return parsed.data.results
    .filter((result) => /^https?:\/\//.test(result.url))
    .map((result) => {
      const item: SearchResult = { url: result.url, title: result.title?.trim() || result.url };
      const text = snippet(result.highlights?.join(" ... ") || result.summary || result.text);
      if (text) item.snippet = text;
      const date = toIsoDate(result.publishedDate);
      if (date) item.publishedAt = date;
      return item;
    });
}

export function mapExaContents(json: unknown, url: string): FetchedPage {
  const parsed = contentsResponse.safeParse(json);
  if (!parsed.success) throw malformed(INFO, "contents results missing");
  const [result] = parsed.data.results;
  const failed = parsed.data.statuses?.find((status) => status.status !== "success");
  if (!result || (failed && !result.text)) {
    const error = failed?.error as { httpStatusCode?: unknown } | null | undefined;
    const status = typeof error?.httpStatusCode === "number" ? error.httpStatusCode : undefined;
    throw pageFailure(INFO, url, `Exa could not read ${url}.`, status);
  }
  const page: FetchedPage = { url: result.url || url, text: (result.text ?? "").trim() };
  if (result.title) page.title = result.title;
  const date = toIsoDate(result.publishedDate);
  if (date) page.publishedAt = date;
  return page;
}

export function createExa(
  config: ExaConfig,
  secrets: Record<string, string>,
  runtime: Pick<ProviderRuntime, "fetch" | "clock">,
): ResearchInstance {
  const key = requireKey(INFO, secrets);
  const base = "https://api.exa.ai";
  const headers = { "x-api-key": key };
  return {
    id: INFO.id,
    creditsPerCall: { search: 1, fetch: 1 },
    async search(query, options = {}) {
      const now = runtime.clock.now();
      const json = await requestJson(runtime, INFO, {
        url: `${base}/search`,
        headers,
        body: exaSearchBody(query, options, config.search_type, now),
      });
      return withinRecency(mapExaSearch(json), options.recencyDays, now).slice(
        0,
        clampLimit(options.limit, 25),
      );
    },
    async fetch(url) {
      const json = await requestJson(runtime, INFO, {
        url: `${base}/contents`,
        headers,
        body: { ids: [url], text: { maxCharacters: 20_000 } },
        timeoutMs: 60_000,
      });
      return mapExaContents(json, url);
    },
    checkAuth: () => probeAuth(runtime, INFO, { url: `${base}/search`, headers, body: {} }),
  };
}

export const exaProvider = defineProvider({
  slot: "research",
  id: INFO.id,
  name: "Exa",
  description:
    "Neural web search with highlights and page contents, good for company news and people mentions. Paid per request; see exa.ai pricing.",
  docsUrl: "https://docs.exa.ai/reference/search",
  configSchema,
  secrets: [{ key: "api_key", label: "API key", env: INFO.env, required: true }],
  create: ({ config, secrets, ctx }) => createExa(config, secrets, ctx),
  test: (instance) => (instance as ResearchInstance).checkAuth(),
});
