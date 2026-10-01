/**
 * Sandbox research provider: search and fetch over the world's canned pages (company profile
 * pages and news-style signal evidence pages) instead of a real search API or the open web.
 */
import { OpenOutboundError } from "../../core/errors.js";
import type {
  FetchedPage,
  ProviderRuntime,
  ResearchProvider,
  SearchOptions,
  SearchResult,
} from "../../providers/types.js";
import { allPages } from "../world/index.js";

const PAGES = allPages();
const PAGE_BY_URL = new Map(PAGES.map((page) => [page.url, page]));

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function score(page: (typeof PAGES)[number], words: string[]): number {
  const title = page.title.toLowerCase();
  const text = page.text.toLowerCase();
  let total = 0;
  for (const word of words) {
    if (title.includes(word)) total += 3;
    if (text.includes(word)) total += 1;
  }
  return total;
}

export function createSandboxResearch(ctx: ProviderRuntime): ResearchProvider {
  return {
    id: "sandbox",
    creditsPerCall: { search: 1, fetch: 0 },
    async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
      const words = query
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 1);
      const limit = options.limit ?? 10;
      const scored = PAGES.map((page) => ({
        page,
        score: words.length === 0 ? 1 : score(page, words),
      }))
        .filter((entry) => entry.score > 0)
        .filter((entry) => {
          if (
            options.includeDomains?.length &&
            !options.includeDomains.includes(hostOf(entry.page.url))
          )
            return false;
          if (options.excludeDomains?.includes(hostOf(entry.page.url))) return false;
          if (options.recencyDays !== undefined && entry.page.publishedAt) {
            const ageDays =
              (ctx.clock.now().getTime() - new Date(entry.page.publishedAt).getTime()) / 86_400_000;
            if (ageDays > options.recencyDays) return false;
          }
          return true;
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      return scored.map(({ page, score: relevance }) => ({
        url: page.url,
        title: page.title,
        snippet: page.text.slice(0, 200),
        publishedAt: page.publishedAt,
        score: relevance,
      }));
    },
    async fetch(url: string): Promise<FetchedPage> {
      const page = PAGE_BY_URL.get(url);
      if (!page) {
        throw new OpenOutboundError("provider_error", `No sandbox page for ${url}.`, {
          hint: "Fetch a URL returned by this sandbox's research.search or signals, not an arbitrary one.",
          details: { reason: "not_found" },
        });
      }
      return { url: page.url, title: page.title, text: page.text, publishedAt: page.publishedAt };
    },
  };
}
