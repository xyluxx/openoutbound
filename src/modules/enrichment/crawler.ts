/**
 * Website contact crawler (spec 11.5): fetches a company's home, contact, imprint, team and
 * about pages through the safe fetch with robots.txt respected, and collects published email
 * addresses (mailto links, plain text and obfuscated forms like "name [at] domain [dot] com")
 * with the page they were published on, plus business facts (name, address, phone).
 *
 * Only addresses on the company's own domain, or free-mail addresses the company publishes on
 * its own site, are kept; no-reply, privacy, jobs and similar inboxes are dropped. Page text is
 * untrusted: it is only parsed, and any text handed to the brain is wrapped as untrusted.
 */
import type { OpContext } from "../../core/context.js";
import { OpenOutboundError } from "../../core/errors.js";
import { extractEmails, extractLinks, htmlToText, normalizeDomain } from "../../lib/web/extract.js";
import { isFreeMailDomain } from "../leads/normalize.js";
import { type AddressKind, addressKind } from "./addresses.js";
import {
  type BusinessDetails,
  emptyBusinessDetails,
  extractBusinessDetails,
  mergeBusinessDetails,
} from "./business.js";

export type ContactPageKind = "home" | "contact" | "imprint" | "team" | "about";

export interface CrawledContactPage {
  url: string;
  kind: ContactPageKind;
  title: string | null;
  /** Readable text (untrusted), capped. */
  text: string;
}

export interface PublishedEmail {
  email: string;
  kind: Exclude<AddressKind, "ignored">;
  /** Page where the address is published (used as person.email_source). */
  page_url: string;
}

export interface CrawlSkip {
  url: string;
  reason: "robots_disallowed" | "http_error" | "not_html" | "off_domain" | "fetch_failed";
  status?: number;
}

export interface SiteCrawl {
  domain: string;
  home_url: string;
  pages: CrawledContactPage[];
  emails: PublishedEmail[];
  business: BusinessDetails;
  skipped: CrawlSkip[];
}

interface PageRule {
  kind: Exclude<ContactPageKind, "home">;
  path: RegExp;
  text: RegExp;
  guess: string;
}

// Checked in this order; the crawl also fetches pages in this order.
const PAGE_RULES: PageRule[] = [
  {
    kind: "contact",
    path: /^\/(contact|contact-us|contacts|kontakt|kontaktformular|contacto|contatti|contactez-nous|nous-contacter|get-in-touch)$/,
    text: /^(contact|contact us|kontakt|contacto|contatti|get in touch|nous contacter|contactez-nous)$/,
    guess: "/contact",
  },
  {
    kind: "imprint",
    path: /^\/(impressum|imprint|legal-notice|legal|mentions-legales|aviso-legal|note-legali|colofon|colophon)$/,
    text: /^(impressum|imprint|legal notice|mentions l.gales|aviso legal|note legali|colofon)$/,
    guess: "/impressum",
  },
  {
    kind: "team",
    path: /^\/(team|our-team|the-team|meet-the-team|people|staff|leadership|management|mitarbeiter|unser-team|equipe|equipo|il-team)$/,
    text: /^(team|our team|meet the team|people|staff|leadership|unser team|mitarbeiter|l.?.quipe|equipo)$/,
    guess: "/team",
  },
  {
    kind: "about",
    path: /^\/(about|about-us|company|who-we-are|our-story|ueber-uns|uber-uns|a-propos|chi-siamo|quienes-somos|sobre-nosotros|over-ons)$/,
    text: /^(about|about us|who we are|our story|.ber uns|a propos|chi siamo|qui.nes somos|over ons)$/,
    guess: "/about",
  },
];

/** Pages fetched per company, home included. */
export const MAX_CONTACT_PAGES = 6;
/** Fetch attempts per company, guesses included (guessed paths often 404). */
const MAX_ATTEMPTS = 8;
const MAX_TEXT_CHARS = 12_000;

/** Kind of a same-site link from its path and label, or null. */
export function classifyContactLink(
  url: string,
  label: string,
): Exclude<ContactPageKind, "home"> | null {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase().replace(/\/+$/, "") || "/";
  } catch {
    return null;
  }
  // Drop a leading locale segment (/en/contact, /de-de/impressum) and a file extension.
  path = path.replace(/^\/[a-z]{2}(-[a-z]{2})?(?=\/)/, "").replace(/\.(html?|php|aspx?)$/, "");
  const text = label.trim().toLowerCase().replace(/\s+/g, " ");
  for (const rule of PAGE_RULES) if (rule.path.test(path)) return rule.kind;
  for (const rule of PAGE_RULES) {
    if (text && text.length <= 40 && rule.text.test(text)) return rule.kind;
  }
  return null;
}

/** Home page URL for a website or domain; null when it is not a usable address. */
export function homeUrlOf(website: string): { homeUrl: string; domain: string } | null {
  const trimmed = website.trim();
  const domain = normalizeDomain(trimmed);
  if (!domain) return null;
  try {
    const parsed = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`,
    );
    const protocol = parsed.protocol === "http:" ? "http:" : "https:";
    return { homeUrl: `${protocol}//${parsed.host.toLowerCase()}/`, domain };
  } catch {
    return { homeUrl: `https://${domain}/`, domain };
  }
}

function sameSite(url: string, domain: string): boolean {
  const host = normalizeDomain(url);
  return host === domain || (host?.endsWith(`.${domain}`) ?? false);
}

/** Keeps addresses on the company's domain (or subdomains) and published free-mail inboxes. */
export function keepPublishedEmail(email: string, domain: string): PublishedEmail["kind"] | null {
  const at = email.lastIndexOf("@");
  const host = email.slice(at + 1);
  const kind = addressKind(email);
  if (kind === "ignored") return null;
  if (host === domain || host.endsWith(`.${domain}`) || isFreeMailDomain(host)) return kind;
  return null;
}

type FetchOutcome = { ok: true; html: string; finalUrl: string } | { ok: false; skip: CrawlSkip };

async function fetchHtml(
  ctx: OpContext,
  url: string,
  domain: string | null,
): Promise<FetchOutcome> {
  let response: Response;
  try {
    response = await ctx.fetch(url, {
      respectRobots: true,
      timeoutMs: 10_000,
      maxBytes: 1_500_000,
      headers: { accept: "text/html,application/xhtml+xml" },
    });
  } catch (error) {
    const robots =
      error instanceof OpenOutboundError && error.details?.reason === "robots_disallowed";
    return { ok: false, skip: { url, reason: robots ? "robots_disallowed" : "fetch_failed" } };
  }
  const finalUrl = response.url || url;
  if (domain && !sameSite(finalUrl, domain))
    return { ok: false, skip: { url, reason: "off_domain" } };
  if (!response.ok)
    return { ok: false, skip: { url, reason: "http_error", status: response.status } };
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  if (type && !type.includes("html")) return { ok: false, skip: { url, reason: "not_html" } };
  return { ok: true, html: await response.text(), finalUrl };
}

function pageKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
}

/**
 * Crawls up to `maxPages` pages of the company website (home first, then contact, imprint,
 * team and about pages found in links, else guessed paths). Never throws for single pages;
 * returns what it found plus the pages it skipped and why.
 */
export async function crawlCompanySite(
  ctx: OpContext,
  website: string,
  options: { maxPages?: number } = {},
): Promise<SiteCrawl | null> {
  const home = homeUrlOf(website);
  if (!home) return null;
  const maxPages = Math.min(Math.max(options.maxPages ?? MAX_CONTACT_PAGES, 1), MAX_CONTACT_PAGES);
  const crawl: SiteCrawl = {
    domain: home.domain,
    home_url: home.homeUrl,
    pages: [],
    emails: [],
    business: emptyBusinessDetails(),
    skipped: [],
  };
  const seen = new Set<string>();

  const addPage = (kind: ContactPageKind, url: string, html: string) => {
    const { title, text } = htmlToText(html, { maxChars: MAX_TEXT_CHARS });
    crawl.pages.push({ url, kind, title, text });
    for (const email of extractEmails(html)) {
      const emailKind = keepPublishedEmail(email, crawl.domain);
      if (emailKind && !crawl.emails.some((e) => e.email === email)) {
        crawl.emails.push({ email, kind: emailKind, page_url: url });
      }
    }
    crawl.business = mergeBusinessDetails(crawl.business, extractBusinessDetails(html, url), url);
  };

  const first = await fetchHtml(ctx, home.homeUrl, null);
  seen.add(pageKey(home.homeUrl));
  if (!first.ok) {
    crawl.skipped.push(first.skip);
    return crawl;
  }
  // Follow a redirect to the brand's new domain, then stay on it.
  crawl.domain = normalizeDomain(first.finalUrl) ?? crawl.domain;
  crawl.home_url = first.finalUrl;
  seen.add(pageKey(first.finalUrl));
  addPage("home", first.finalUrl, first.html);

  const found = new Map<ContactPageKind, string>();
  for (const link of extractLinks(first.html, first.finalUrl)) {
    if (!sameSite(link.url, crawl.domain)) continue;
    const kind = classifyContactLink(link.url, link.text);
    if (!kind || found.has(kind)) continue;
    const url = new URL(link.url);
    url.search = "";
    found.set(kind, url.toString());
  }

  let attempts = 0;
  for (const rule of PAGE_RULES) {
    if (crawl.pages.length >= maxPages || attempts >= MAX_ATTEMPTS) break;
    const linked = found.get(rule.kind);
    const url = linked ?? new URL(rule.guess, crawl.home_url).toString();
    if (seen.has(pageKey(url))) continue;
    seen.add(pageKey(url));
    attempts += 1;
    const page = await fetchHtml(ctx, url, crawl.domain);
    if (!page.ok) {
      // A guessed path that does not exist is expected; report everything else.
      if (linked || page.skip.reason !== "http_error") crawl.skipped.push(page.skip);
      continue;
    }
    if (seen.has(pageKey(page.finalUrl)) && page.finalUrl !== url) continue;
    seen.add(pageKey(page.finalUrl));
    addPage(rule.kind, page.finalUrl, page.html);
  }
  return crawl;
}

/** Crawls each site once per run (many people often share one company). */
export class CrawlCache {
  private readonly cache = new Map<string, Promise<SiteCrawl | null>>();

  constructor(private readonly ctx: OpContext) {}

  get(website: string): Promise<SiteCrawl | null> {
    const key = normalizeDomain(website) ?? website;
    let pending = this.cache.get(key);
    if (!pending) {
      pending = crawlCompanySite(this.ctx, website).catch(() => null);
      this.cache.set(key, pending);
    }
    return pending;
  }
}
