/**
 * Pure HTML and identity helpers shared by knowledge ingest, research, enrichment, signals and
 * imports. No network, no state; cheerio is the only dependency.
 */
import { load } from "cheerio";

const DROP_SELECTORS =
  "script, style, noscript, svg, nav, footer, header, aside, form, template, iframe, head";

const BLOCK_SELECTORS = [
  "address",
  "article",
  "blockquote",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "main",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "td",
  "th",
  "tr",
  "ul",
].join(", ");

export const DEFAULT_MAX_TEXT_CHARS = 50_000;

/**
 * Readable text from an HTML page: drops scripts, styles and chrome (nav, header, footer, aside,
 * forms), keeps headings, paragraphs and list items on their own lines, collapses whitespace
 * and truncates to `maxChars` (default 50,000). `title` is the <title> (or first h1).
 * `baseUrl` is accepted for symmetry with the other helpers; the text never contains URLs.
 */
export function htmlToText(
  html: string,
  options: { baseUrl?: string; maxChars?: number } = {},
): { title: string | null; text: string } {
  const $ = load(html);
  const title = clean($("title").first().text()) || clean($("h1").first().text()) || null;
  $(DROP_SELECTORS).remove();
  // Source newlines are only whitespace; <br> and block elements are what break lines.
  collapseTextNodes(($.root().get(0) as DomNode | undefined)?.children ?? [], false);
  $("br").replaceWith("\n");
  $(BLOCK_SELECTORS).each((_, element) => {
    $(element).prepend("\n").append("\n");
  });
  const raw = $("body").length > 0 ? $("body").text() : $.root().text();
  const lines = raw
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[\s ]+/g, " ").trim())
    .filter(Boolean);
  const maxChars = options.maxChars ?? DEFAULT_MAX_TEXT_CHARS;
  let text = lines.join("\n");
  if (text.length > maxChars) text = text.slice(0, maxChars).trimEnd();
  return { title, text };
}

export interface ExtractedLink {
  /** Absolute http(s) URL without the #fragment. */
  url: string;
  text: string;
  rel?: string;
}

/** Absolute, deduplicated http(s) links (honors <base href>); first occurrence wins. */
export function extractLinks(html: string, baseUrl: string): ExtractedLink[] {
  const $ = load(html);
  const base = resolveBase($("base[href]").attr("href"), baseUrl);
  const seen = new Set<string>();
  const links: ExtractedLink[] = [];
  $("a[href]").each((_, element) => {
    const anchor = $(element);
    const url = absoluteHttpUrl(anchor.attr("href") ?? "", base);
    if (!url || seen.has(url)) return;
    seen.add(url);
    const text =
      clean(anchor.text()) ||
      clean(anchor.attr("aria-label") ?? "") ||
      clean(anchor.attr("title") ?? "");
    const rel = clean(anchor.attr("rel") ?? "");
    links.push(rel ? { url, text, rel } : { url, text });
  });
  return links;
}

export interface PageMeta {
  title: string | null;
  description: string | null;
  /** Absolute canonical URL. */
  canonical: string | null;
  /** Absolute RSS / Atom / JSON feed URLs from <link rel="alternate">. */
  feeds: string[];
  ogSiteName: string | null;
  /** From <html lang>, content-language or og:locale, e.g. "en-US". */
  language: string | null;
}

export function extractMeta(html: string, baseUrl: string): PageMeta {
  const $ = load(html);
  const base = resolveBase($("base[href]").attr("href"), baseUrl);
  const meta = (selector: string) => clean($(selector).first().attr("content") ?? "") || null;

  const feeds: string[] = [];
  $('link[rel~="alternate"][href]').each((_, element) => {
    const type = ($(element).attr("type") ?? "").toLowerCase();
    if (!/(rss|atom|feed\+json)/.test(type)) return;
    const url = absoluteHttpUrl($(element).attr("href") ?? "", base, false);
    if (url && !feeds.includes(url)) feeds.push(url);
  });

  const canonicalHref = $('link[rel~="canonical"][href]').first().attr("href");
  return {
    title: clean($("title").first().text()) || meta('meta[property="og:title"]'),
    description: meta('meta[name="description"]') ?? meta('meta[property="og:description"]'),
    canonical: canonicalHref ? absoluteHttpUrl(canonicalHref, base, false) : null,
    feeds,
    ogSiteName: meta('meta[property="og:site_name"]'),
    language:
      clean($("html").attr("lang") ?? "") ||
      meta('meta[http-equiv="content-language" i]') ||
      meta('meta[property="og:locale"]')?.replace("_", "-") ||
      null,
  };
}

const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}/gi;
const IMAGE_SUFFIX = /\.(png|jpe?g|gif|svg|webp|bmp|ico|tiff?|avif)$/i;
/** Placeholder and telemetry domains that are never real contacts. */
const IGNORED_EMAIL_DOMAINS = [
  "domain.com",
  "yourdomain.com",
  "yoursite.com",
  "sentry.io",
  "wixpress.com",
];

/**
 * Email addresses in HTML or text: mailto: links, plain text and common obfuscations
 * ("name [at] domain [dot] com", "name(at)domain.com", "&#64;"). Lowercased, deduplicated, in
 * order of appearance. Drops image file names ("logo@2x.png"), example.* and placeholder domains.
 */
export function extractEmails(input: string): string[] {
  const found: string[] = [];
  for (const match of input.matchAll(/mailto:([^"'<>\s]+)/gi)) {
    const target = safeDecode(match[1] ?? "").split("?")[0] ?? "";
    found.push(...target.split(/[,;]/));
  }
  const text = deobfuscate(input.includes("<") ? `${input}\n${load(input).root().text()}` : input);
  for (const match of text.matchAll(EMAIL_PATTERN)) found.push(match[0]);

  const out: string[] = [];
  for (const raw of found) {
    const email = raw.trim().toLowerCase().replace(/\.+$/, "");
    if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}$/.test(email)) continue;
    if (IMAGE_SUFFIX.test(email)) continue;
    const domain = email.slice(email.lastIndexOf("@") + 1);
    if (/(^|\.)example\.[a-z.]+$/.test(domain)) continue;
    if (IGNORED_EMAIL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) continue;
    if (!out.includes(email)) out.push(email);
  }
  return out;
}

function deobfuscate(text: string): string {
  return (
    text
      .replace(/&#0*64;|&#x0*40;|&commat;/gi, "@")
      .replace(/&#0*46;|&#x0*2e;|&period;/gi, ".")
      // name [at] domain [dot] com, name(at)domain.com, name {at} domain
      .replace(/\s*[[({<]\s*at\s*[\])}>]\s*/gi, "@")
      .replace(/\s*[[({<]\s*dot\s*[\])}>]\s*/gi, ".")
      // name at domain dot com (plain words, needs at least one "dot")
      .replace(
        /\b([a-z0-9._%+-]+)\s+at\s+([a-z0-9-]+(?:\s+dot\s+[a-z0-9-]+)+)\b/gi,
        (_, local: string, rest: string) => `${local}@${rest.replace(/\s+dot\s+/gi, ".")}`,
      )
  );
}

/**
 * Bare lowercase domain from a URL, domain or email ("https://www.Example.com:8080/x" ->
 * "example.com"). Null for IPs, single labels and garbage.
 */
export function normalizeDomain(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (!value) return null;
  if (!value.includes("://") && value.includes("@"))
    value = value.slice(value.lastIndexOf("@") + 1);
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(value)) value = `http://${value}`;
  let hostname: string;
  try {
    hostname = new URL(value).hostname;
  } catch {
    return null;
  }
  hostname = hostname.replace(/\.$/, "").replace(/^www\d*\./, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith("[")) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(hostname))
    return null;
  return hostname;
}

/**
 * Canonical LinkedIn URL: `https://www.linkedin.com/in/<slug>` for people and
 * `https://www.linkedin.com/company/<slug>` for companies. Drops query, fragment, sub-pages,
 * trailing slashes and locale subdomains (de.linkedin.com). Null for anything else.
 */
export function normalizeLinkedinUrl(input: string): string | null {
  let value = input.trim();
  if (!value) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
  const [kind, slug] = url.pathname.split("/").filter(Boolean);
  if ((kind !== "in" && kind !== "company") || !slug) return null;
  const normalizedSlug = encodeURIComponent(safeDecode(slug).toLowerCase());
  if (!normalizedSlug) return null;
  return `https://www.linkedin.com/${kind}/${normalizedSlug}`;
}

const HONORIFICS = new Set(["dr", "mr", "mrs", "ms", "mx", "prof", "sir", "dame"]);
const SUFFIXES = new Set([
  "jr",
  "sr",
  "ii",
  "iii",
  "iv",
  "phd",
  "md",
  "dds",
  "dmd",
  "mba",
  "esq",
  "cpa",
  "rn",
]);

/**
 * Splits a person's name: "Dr. Dana Reyes, DDS" -> Dana / Reyes; "Reyes, Dana" -> Dana /
 * Reyes; "Maria de la Cruz" -> Maria / "de la Cruz"; "Cher" -> Cher / null.
 */
export function splitName(full: string): { first_name: string | null; last_name: string | null } {
  let value = full.replace(/\s+/g, " ").trim();
  if (!value) return { first_name: null, last_name: null };

  const commaParts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (commaParts.length > 1) {
    const rest = commaParts.slice(1).filter((part) => !isSuffix(part));
    const first = commaParts[0] ?? "";
    // "Reyes, Dana" (last, first) unless the remainder was only credentials.
    value = rest.length > 0 ? `${rest.join(" ")} ${first}` : first;
  }

  const tokens = value.split(" ").filter((token) => token.length > 0);
  while (tokens.length > 1 && HONORIFICS.has(stripDots(tokens[0] ?? ""))) tokens.shift();
  while (tokens.length > 1 && isSuffix(tokens.at(-1) ?? "")) tokens.pop();

  const [first, ...rest] = tokens;
  return { first_name: first ?? null, last_name: rest.length > 0 ? rest.join(" ") : null };
}

// --- internals -------------------------------------------------------------------------------

/** Structural view of domhandler nodes (cheerio's DOM), to avoid importing domhandler. */
interface DomNode {
  type: string;
  name?: string;
  data?: string;
  children?: DomNode[];
}

function collapseTextNodes(nodes: readonly DomNode[], inPre: boolean): void {
  for (const node of nodes) {
    if (node.type === "text" && node.data !== undefined) {
      if (!inPre) node.data = node.data.replace(/[\s ]+/g, " ");
    } else if (node.children) {
      collapseTextNodes(node.children, inPre || node.name === "pre");
    }
  }
}

function clean(value: string): string {
  return value.replace(/[\s ]+/g, " ").trim();
}

function stripDots(value: string): string {
  return value.toLowerCase().replace(/\./g, "");
}

function isSuffix(value: string): boolean {
  return SUFFIXES.has(stripDots(value));
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function resolveBase(baseHref: string | undefined, pageUrl: string): string {
  if (!baseHref) return pageUrl;
  try {
    return new URL(baseHref, pageUrl).toString();
  } catch {
    return pageUrl;
  }
}

function absoluteHttpUrl(href: string, base: string, stripHash = true): string | null {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  let url: URL;
  try {
    url = new URL(trimmed, base);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (stripHash) url.hash = "";
  return url.toString();
}
