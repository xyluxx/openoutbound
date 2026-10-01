/**
 * Built-in research provider: no key, no web search. Fetches public pages through the engine's
 * safe fetch (SSRF guard, size cap, robots.txt respected) and returns their readable text. It
 * calls no service of its own, so it is never paused for provider health: a page that cannot
 * be read is a failure of that one call.
 */
import { OpenOutboundError } from "../../core/errors.js";
import { parseRetryAfter } from "../../core/failures.js";
import { htmlToText } from "../../lib/web/extract.js";
import { thrownFailure } from "../http.js";
import { defineProvider, type FetchedPage, type ProviderRuntime } from "../types.js";
import { pageFailure, type ResearchInstance } from "./http.js";

const INFO = { id: "builtin", name: "Built-in fetch", env: "" };

const MAX_TEXT_CHARS = 30_000;

export function createBuiltinResearch(
  runtime: Pick<ProviderRuntime, "safeFetch">,
): ResearchInstance {
  return {
    id: "builtin",
    creditsPerCall: { search: 0, fetch: 0 },
    async search() {
      throw new OpenOutboundError(
        "unsupported",
        "The builtin research provider cannot search the web; it only fetches pages.",
        {
          hint: "Configure a research provider with web search (parallel, exa, tavily or firecrawl) with manage_providers, or set PARALLEL_API_KEY, EXA_API_KEY, TAVILY_API_KEY or FIRECRAWL_API_KEY.",
          details: { provider: "builtin", capability: "search" },
        },
      );
    },
    async fetch(url): Promise<FetchedPage> {
      let response: Awaited<ReturnType<ProviderRuntime["safeFetch"]>>;
      let body: string;
      try {
        response = await runtime.safeFetch(url, {
          respectRobots: true,
          headers: { accept: "text/html,application/xhtml+xml,text/plain" },
        });
        body = response.ok ? await response.text() : "";
      } catch (error) {
        throw thrownFailure(INFO, error);
      }
      if (!response.ok) {
        throw pageFailure(
          INFO,
          url,
          `${url} answered HTTP ${response.status}.`,
          response.status,
          parseRetryAfter(response.headers.get("retry-after")),
        );
      }
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      const finalUrl = response.url || url;
      if (contentType.includes("html") || /<(html|body|p|div)[\s>]/i.test(body)) {
        const { title, text } = htmlToText(body, { maxChars: MAX_TEXT_CHARS });
        return title ? { url: finalUrl, title, text } : { url: finalUrl, text };
      }
      if (contentType.startsWith("text/") || contentType === "") {
        return { url: finalUrl, text: body.slice(0, MAX_TEXT_CHARS).trim() };
      }
      throw new OpenOutboundError("unsupported", `Cannot read content of type ${contentType}.`, {
        hint: "The builtin provider reads HTML and text pages only.",
        details: { provider: "builtin", content_type: contentType },
      });
    },
    async checkAuth() {
      return { ok: true, message: "Builtin fetch needs no key (web search is not available)." };
    },
  };
}

export const builtinResearchProvider = defineProvider({
  slot: "research",
  id: "builtin",
  name: "Built-in fetch",
  description:
    "Free, no key: reads public web pages (robots.txt respected) but cannot search the web. Configure parallel, exa, tavily or firecrawl for news, hiring and people search.",
  secrets: [],
  health: false,
  create: ({ ctx }) => createBuiltinResearch(ctx),
  test: (instance) => (instance as ResearchInstance).checkAuth(),
});
