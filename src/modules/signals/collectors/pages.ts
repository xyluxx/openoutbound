/**
 * Shared web helpers for collectors: a per-company fetch cache over SafeFetch, the company's
 * home URL, key page discovery (pricing, careers, locations, team) and diff normalization.
 */
import { createHash } from "node:crypto";
import type { SafeFetch } from "../../../core/context.js";
import { isOpenOutboundError } from "../../../core/errors.js";
import type { Company } from "../../../db/schema/index.js";
import { extractLinks, normalizeDomain } from "../../../lib/web/extract.js";

export interface FetchedDoc {
  url: string;
  status: number;
  ok: boolean;
  body: string;
  headers: Headers;
}

/** Why a fetch did not produce a document (robots, blocked address, timeout, network). */
export function fetchFailureReason(error: unknown): string {
  if (isOpenOutboundError(error)) {
    const reason = error.details?.reason;
    return typeof reason === "string" ? reason : error.code;
  }
  return "network";
}

/** Caches fetches for one company pass so collectors share the homepage. */
export class PageCache {
  private readonly cache = new Map<string, Promise<FetchedDoc>>();
  /** Number of network requests made (cache misses). */
  requests = 0;

  constructor(
    private readonly fetch: SafeFetch,
    private readonly signal?: AbortSignal,
  ) {}

  /** GET with robots.txt respected (crawling). Rejects on robots, SSRF and network failures. */
  page(url: string): Promise<FetchedDoc> {
    return this.get(url, true);
  }

  /** GET for public APIs (job boards, GDELT): no robots check. */
  api(url: string): Promise<FetchedDoc> {
    return this.get(url, false);
  }

  private get(url: string, respectRobots: boolean): Promise<FetchedDoc> {
    const key = `${respectRobots ? "page" : "api"}:${url}`;
    let pending = this.cache.get(key);
    if (!pending) {
      this.requests += 1;
      pending = this.load(url, respectRobots);
      this.cache.set(key, pending);
    }
    return pending;
  }

  private async load(url: string, respectRobots: boolean): Promise<FetchedDoc> {
    const init: Parameters<SafeFetch>[1] = {
      respectRobots,
      timeoutMs: 15_000,
      maxBytes: 3_000_000,
      headers: {
        accept: respectRobots ? "text/html,application/xhtml+xml,*/*" : "application/json",
      },
    };
    if (this.signal) init.signal = this.signal;
    const response = await this.fetch(url, init);
    const body = await response.text();
    return {
      url: response.url || url,
      status: response.status,
      ok: response.ok,
      body,
      headers: response.headers,
    };
  }
}

/** The company's home page URL, or null without a website or domain. */
export function companyHomeUrl(company: Pick<Company, "website" | "domain">): string | null {
  const candidates = [company.website, company.domain].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const withScheme = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
    try {
      const url = new URL(withScheme);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      if (!normalizeDomain(url.hostname)) continue;
      return `${url.protocol}//${url.host}/`;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Bare domain of the company (from domain or website). */
export function companyDomain(company: Pick<Company, "website" | "domain">): string | null {
  return (
    (company.domain ? normalizeDomain(company.domain) : null) ??
    (company.website ? normalizeDomain(company.website) : null)
  );
}

/** True when the URL is on the domain or one of its subdomains. */
export function isSameSite(url: string, domain: string): boolean {
  const host = normalizeDomain(url);
  return host !== null && (host === domain || host.endsWith(`.${domain}`));
}

export type PageKind = "home" | "pricing" | "careers" | "locations" | "team";

const PAGE_PATTERNS: Array<{ kind: Exclude<PageKind, "home">; path: RegExp; text: RegExp }> = [
  {
    kind: "pricing",
    path: /\/(pricing|plans|prices|preise|tarifs|precios)(\/|$|\.)/i,
    text: /^(pricing|plans|prices|plans (&|and) pricing)$/i,
  },
  {
    kind: "careers",
    path: /\/(careers?|jobs|join-us|join|work-with-us|karriere|stellenangebote|vacancies|hiring)(\/|$|\.)/i,
    text: /^(careers?|jobs|join us|we'?re hiring|work (with|for) us|open positions)$/i,
  },
  {
    kind: "locations",
    path: /\/(locations?|offices?|clinics?|stores?|standorte|find-us|our-locations)(\/|$|\.)/i,
    text: /^(locations?|offices?|our (locations|offices|clinics)|find us)$/i,
  },
  {
    kind: "team",
    path: /\/(team|our-team|leadership|management|people|meet-the-team|about\/team|about-us\/team|our-dentists|doctors)(\/|$|\.)/i,
    text: /^(team|our team|leadership|meet the team|our people|management)$/i,
  },
];

/** Key pages linked from the home page, one per kind, same site only. */
export function discoverKeyPages(
  html: string,
  homeUrl: string,
  domain: string,
): Array<{ kind: Exclude<PageKind, "home">; url: string }> {
  const links = extractLinks(html, homeUrl).filter((link) => isSameSite(link.url, domain));
  const found: Array<{ kind: Exclude<PageKind, "home">; url: string }> = [];
  for (const pattern of PAGE_PATTERNS) {
    const byPath = links.find((link) => {
      try {
        return pattern.path.test(new URL(link.url).pathname);
      } catch {
        return false;
      }
    });
    const byText = byPath ?? links.find((link) => pattern.text.test(link.text.trim()));
    if (byText) {
      const url = byText.url.replace(/\?.*$/, "");
      if (!found.some((page) => page.url === url)) found.push({ kind: pattern.kind, url });
    }
  }
  return found;
}

// --- Diff normalization ------------------------------------------------------------------------

const MONTHS =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const NOISE_LINE =
  /(©|\(c\)\s*\d{4}|copyright|all rights reserved|cookie|last updated|last modified|page generated)/i;
const VOLATILE: Array<[RegExp, string]> = [
  [
    /\b\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?)?\b/gi,
    "<date>",
  ],
  [/\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/g, "<date>"],
  [new RegExp(`\\b(?:${MONTHS})\\.? \\d{1,2}(?:st|nd|rd|th)?,? \\d{4}\\b`, "gi"), "<date>"],
  [new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)? (?:${MONTHS})\\.?,? \\d{4}\\b`, "gi"), "<date>"],
  [/\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:am|pm)?\b/gi, "<time>"],
  [/\b\d+\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?)\s+ago\b/gi, "<ago>"],
];

/**
 * Page text reduced to the lines that matter for change detection: whitespace collapsed,
 * copyright, cookie and "last updated" lines dropped, dates and times replaced by
 * placeholders, duplicates removed.
 */
export function normalizeForDiff(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.replace(/\s+/g, " ").trim();
    if (!line || NOISE_LINE.test(line)) continue;
    for (const [pattern, replacement] of VOLATILE) line = line.replace(pattern, replacement);
    if (/^(<date>|<time>|<ago>|[\s|,.:-])*$/.test(line)) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Lines added and removed between two normalized texts (order changes are not changes). */
export function diffLines(
  previous: readonly string[],
  next: readonly string[],
  maxLines = 60,
): { added: string[]; removed: string[] } {
  const before = new Set(previous);
  const after = new Set(next);
  return {
    added: next.filter((line) => !before.has(line)).slice(0, maxLines),
    removed: previous.filter((line) => !after.has(line)).slice(0, maxLines),
  };
}

/** Case-insensitive whole-word match (plural "s"/"es" allowed), for titles and keywords. */
export function matchesKeyword(text: string, keyword: string): boolean {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}+#]+/gu, " ")
      .trim();
  const needle = normalize(keyword);
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${escaped}(s|es)?(\\s|$)`, "u").test(normalize(text));
}

/** Keywords from `list` that match `text`. */
export function matchingKeywords(text: string, list: readonly string[]): string[] {
  return list.filter((keyword) => matchesKeyword(text, keyword));
}
