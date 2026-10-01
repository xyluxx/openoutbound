/**
 * Small same-domain website crawler used by `knowledge.bootstrap` and research. Fetches the
 * home page, classifies its links (about, product, pricing, customers, blog, ...) and fetches
 * the best link per wanted category through `ctx.fetch` with robots.txt respected.
 */
import type { OpContext } from "../../core/context.js";
import { OpenOutboundError } from "../../core/errors.js";
import { extractLinks, extractMeta, normalizeDomain } from "../../lib/web/extract.js";
import { htmlToMarkdownText } from "./chunk.js";

export const PAGE_CATEGORIES = [
  "home",
  "about",
  "product",
  "pricing",
  "customers",
  "blog",
  "careers",
  "team",
  "contact",
] as const;
export type PageCategory = (typeof PAGE_CATEGORIES)[number];

export interface CrawledPage {
  url: string;
  category: PageCategory;
  title: string | null;
  description: string | null;
  /** Readable text with markdown headings (untrusted: it comes from the web). */
  text: string;
}

export type CrawlSkipReason =
  | "robots_disallowed"
  | "http_error"
  | "not_html"
  | "off_domain"
  | "fetch_failed"
  | "empty";

export interface CrawlSkip {
  url: string;
  reason: CrawlSkipReason;
  status?: number;
}

export interface CrawlResult {
  /** Normalized domain of the site (after a home page redirect). */
  domain: string;
  homeUrl: string;
  pages: CrawledPage[];
  skipped: CrawlSkip[];
}

export interface CrawlOptions {
  /** Pages to keep, home included (1-8, default 8). */
  maxPages?: number;
  /** Categories to look for and how many pages of each, in priority order. */
  plan?: Array<[Exclude<PageCategory, "home">, number]>;
  /** Characters of text kept per page (default 6,000). */
  maxCharsPerPage?: number;
  /** Try common paths (/about, /pricing, ...) for categories without a link. Default true. */
  guessPaths?: boolean;
}

export const MAX_CRAWL_PAGES = 8;

/** Bootstrap plan: about, product/services, pricing, customers/case studies, blog index. */
export const BOOTSTRAP_PLAN: NonNullable<CrawlOptions["plan"]> = [
  ["about", 1],
  ["product", 2],
  ["pricing", 1],
  ["customers", 2],
  ["blog", 1],
];

interface CategoryRule {
  category: Exclude<PageCategory, "home">;
  path: RegExp;
  text: RegExp;
  guess: string;
}

const CATEGORY_RULES: CategoryRule[] = [
  {
    category: "about",
    path: /^\/(about|about-us|company|who-we-are|our-story|ueber-uns|uber-uns|a-propos)$/,
    text: /^(about|about us|company|who we are|our story)$/,
    guess: "/about",
  },
  {
    category: "pricing",
    path: /^\/(pricing|plans|prices|preise|tarifs)$/,
    text: /^(pricing|plans|prices|plans and pricing)$/,
    guess: "/pricing",
  },
  {
    category: "customers",
    path: /^\/(customers?|case-stud(y|ies)|success-stories|testimonials|clients|results|references|kunden)(\/[^/]+)?$/,
    text: /(customers|case stud|success stor|testimonials|clients)/,
    guess: "/customers",
  },
  {
    category: "product",
    path: /^\/(products?|services?|solutions?|features|platform|what-we-do|how-it-works|leistungen)(\/[^/]+)?$/,
    text: /(product|services|solutions|features|platform|what we do|how it works)/,
    guess: "/products",
  },
  {
    category: "blog",
    path: /^\/(blog|news|insights|resources|articles|journal|updates|newsroom|press)$/,
    text: /^(blog|news|insights|resources|articles|newsroom|press)$/,
    guess: "/blog",
  },
  {
    category: "careers",
    path: /^\/(careers|jobs|join-us|work-with-us|karriere)$/,
    text: /^(careers|jobs|join us|we are hiring|work with us)$/,
    guess: "/careers",
  },
  {
    category: "team",
    path: /^\/(team|our-team|people|leadership|management)$/,
    text: /^(team|our team|people|leadership)$/,
    guess: "/team",
  },
  {
    category: "contact",
    path: /^\/(contact|contact-us|kontakt|impressum|imprint)$/,
    text: /^(contact|contact us|imprint)$/,
    guess: "/contact",
  },
];

/** Normalizes user input ("example.com", "https://www.example.com/x") to a home page URL. */
export function homeUrlFor(website: string): { homeUrl: string; domain: string } {
  const trimmed = website.trim();
  const domain = normalizeDomain(trimmed);
  if (!domain) {
    throw new OpenOutboundError("validation_failed", `"${website}" is not a website address.`, {
      hint: 'Pass a domain or URL like "example.com" or "https://www.example.com".',
    });
  }
  let protocol = "https:";
  let host = domain;
  try {
    const parsed = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`,
    );
    if (parsed.protocol === "http:" || parsed.protocol === "https:") protocol = parsed.protocol;
    host = parsed.host.toLowerCase();
  } catch {
    // keep defaults
  }
  return { homeUrl: `${protocol}//${host}/`, domain };
}

/** Category of a same-site URL from its path and link text, or null. */
export function classifyLink(url: string, text: string): Exclude<PageCategory, "home"> | null {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase().replace(/\/+$/, "") || "/";
  } catch {
    return null;
  }
  // Drop a leading locale segment: /en/about, /de-de/pricing.
  path = path.replace(/^\/[a-z]{2}(-[a-z]{2})?(?=\/)/, "");
  const label = text.trim().toLowerCase().replace(/\s+/g, " ");
  for (const rule of CATEGORY_RULES) {
    if (rule.path.test(path)) return rule.category;
  }
  for (const rule of CATEGORY_RULES) {
    if (label && label.length <= 40 && rule.text.test(label) && path.split("/").length <= 3) {
      return rule.category;
    }
  }
  return null;
}

/** Crawls up to `maxPages` same-domain pages starting at the home page. Never throws for pages. */
export async function crawlSite(
  ctx: OpContext,
  website: string,
  options: CrawlOptions = {},
): Promise<CrawlResult> {
  const maxPages = Math.max(1, Math.min(options.maxPages ?? MAX_CRAWL_PAGES, MAX_CRAWL_PAGES));
  const plan = options.plan ?? BOOTSTRAP_PLAN;
  const maxChars = options.maxCharsPerPage ?? 6_000;
  const { homeUrl, domain: inputDomain } = homeUrlFor(website);
  const result: CrawlResult = { domain: inputDomain, homeUrl, pages: [], skipped: [] };
  const fetched = new Set<string>();

  const home = await fetchPage(ctx, homeUrl, null, maxChars);
  fetched.add(key(homeUrl));
  if (!home.ok) {
    result.skipped.push(home.skip);
    return result;
  }
  // Follow a home page redirect to another domain (the brand moved), then stay on it.
  result.domain = normalizeDomain(home.finalUrl) ?? inputDomain;
  result.homeUrl = home.finalUrl;
  fetched.add(key(home.finalUrl));
  result.pages.push({ ...home.page, category: "home" });

  const links = extractLinks(home.html, home.finalUrl).filter(
    (link) => normalizeDomain(link.url) === result.domain,
  );
  const byCategory = new Map<PageCategory, string[]>();
  for (const link of links) {
    const category = classifyLink(link.url, link.text);
    if (!category) continue;
    const list = byCategory.get(category) ?? [];
    const canonical = stripQuery(link.url);
    if (!list.includes(canonical) && !fetched.has(key(canonical))) list.push(canonical);
    byCategory.set(category, list);
  }
  for (const list of byCategory.values()) {
    list.sort((a, b) => new URL(a).pathname.length - new URL(b).pathname.length);
  }

  const queue: Array<{ url: string; category: PageCategory; guessed: boolean }> = [];
  for (const [category, count] of plan) {
    const found = byCategory.get(category) ?? [];
    for (const url of found.slice(0, count)) queue.push({ url, category, guessed: false });
    if (found.length === 0 && options.guessPaths !== false) {
      const rule = CATEGORY_RULES.find((candidate) => candidate.category === category);
      if (rule)
        queue.push({
          url: new URL(rule.guess, result.homeUrl).toString(),
          category,
          guessed: true,
        });
    }
  }

  let attempts = 0;
  const maxAttempts = maxPages + 4;
  for (const next of queue) {
    if (result.pages.length >= maxPages || attempts >= maxAttempts) break;
    if (fetched.has(key(next.url))) continue;
    fetched.add(key(next.url));
    attempts++;
    const page = await fetchPage(ctx, next.url, result.domain, maxChars);
    if (!page.ok) {
      // A guessed path that does not exist is expected; only report real problems.
      if (!(next.guessed && page.skip.reason === "http_error")) result.skipped.push(page.skip);
      continue;
    }
    if (fetched.has(key(page.finalUrl)) && page.finalUrl !== next.url) continue;
    fetched.add(key(page.finalUrl));
    result.pages.push({ ...page.page, category: next.category });
  }
  return result;
}

type FetchOutcome =
  | { ok: true; page: Omit<CrawledPage, "category">; html: string; finalUrl: string }
  | { ok: false; skip: CrawlSkip };

async function fetchPage(
  ctx: OpContext,
  url: string,
  domain: string | null,
  maxChars: number,
): Promise<FetchOutcome> {
  let response: Response;
  try {
    response = await ctx.fetch(url, {
      respectRobots: true,
      maxBytes: 2 * 1024 * 1024,
      headers: { accept: "text/html,application/xhtml+xml" },
    });
  } catch (error) {
    const reason =
      error instanceof OpenOutboundError && error.details?.reason === "robots_disallowed"
        ? "robots_disallowed"
        : "fetch_failed";
    return { ok: false, skip: { url, reason } };
  }
  const finalUrl = response.url || url;
  if (domain && normalizeDomain(finalUrl) !== domain) {
    return { ok: false, skip: { url, reason: "off_domain" } };
  }
  if (!response.ok) {
    return { ok: false, skip: { url, reason: "http_error", status: response.status } };
  }
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (contentType && !contentType.includes("html")) {
    return { ok: false, skip: { url, reason: "not_html" } };
  }
  const html = await response.text();
  const { title, text } = htmlToMarkdownText(html, { maxChars });
  if (!text.trim()) return { ok: false, skip: { url, reason: "empty" } };
  const meta = extractMeta(html, finalUrl);
  return {
    ok: true,
    html,
    finalUrl,
    page: { url: finalUrl, title: title ?? meta.title, description: meta.description, text },
  };
}

function stripQuery(url: string): string {
  const parsed = new URL(url);
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

/** Dedupe key: host without www, path without trailing slash. */
function key(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
}
