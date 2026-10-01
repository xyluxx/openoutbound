/**
 * news_gdelt collector: GDELT DOC 2.0 article search (no key) by the quoted company name and
 * domain, in English and the language of the company's country, over the last 30 days at most.
 * The brain keeps articles about this exact company that match a built-in definition.
 *
 * GDELT throttles hard (about one request per 5 seconds per IP, unpublished), so calls are
 * spaced and a 429 pauses the collector for a minute.
 */
import type { Company } from "../../../db/schema/index.js";
import { canonicalEvidenceUrl } from "../evidence.js";
import { builtinDefinitionsFor, type CandidateItem, classifyItemsToSignals } from "./items.js";
import { companyDomain, fetchFailureReason } from "./pages.js";
import { type Collector, type CollectorOutput, type CollectorRun, emptyOutput } from "./types.js";

export const GDELT_DOC_API = "https://api.gdeltproject.org/api/v2/doc/doc";
const MAX_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

/** GDELT `sourcelang` names by ISO country (English is always searched). */
const COUNTRY_LANGUAGE: Record<string, string> = {
  AR: "spanish",
  AT: "german",
  BE: "french",
  BR: "portuguese",
  CH: "german",
  CL: "spanish",
  CN: "chinese",
  CO: "spanish",
  CZ: "czech",
  DE: "german",
  DK: "danish",
  ES: "spanish",
  FI: "finnish",
  FR: "french",
  GR: "greek",
  HU: "hungarian",
  ID: "indonesian",
  IT: "italian",
  JP: "japanese",
  KR: "korean",
  LU: "french",
  MX: "spanish",
  NL: "dutch",
  NO: "norwegian",
  PE: "spanish",
  PL: "polish",
  PT: "portuguese",
  RO: "romanian",
  RU: "russian",
  SE: "swedish",
  TR: "turkish",
  UA: "ukrainian",
  VN: "vietnamese",
};

const LEGAL_SUFFIX =
  /[\s,]+(inc|incorporated|llc|l\.l\.c|ltd|limited|gmbh|ag|sa|s\.a|sas|sarl|bv|b\.v|nv|plc|corp|corporation|co|pty|oy|ab|as|srl|spa|kg)\.?$/i;

/** Company name without quotes and legal suffixes ("Northwind Analytics, Inc." -> "Northwind Analytics"). */
export function searchableName(name: string): string {
  let value = name.replace(/["()]/g, " ").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 2 && LEGAL_SUFFIX.test(value); i++)
    value = value.replace(LEGAL_SUFFIX, "").trim();
  return value;
}

/** GDELT query: quoted name (and domain), English plus the country language. Null when the name is too short. */
export function buildGdeltQuery(
  company: Pick<Company, "name" | "domain" | "website" | "country">,
): string | null {
  const name = searchableName(company.name);
  if (name.length < 3) return null;
  const domain = companyDomain(company);
  const terms = [`"${name}"`];
  if (domain && domain !== name.toLowerCase()) terms.push(`"${domain}"`);
  const languages = ["english"];
  const local = company.country ? COUNTRY_LANGUAGE[company.country.toUpperCase()] : undefined;
  if (local && !languages.includes(local)) languages.push(local);
  const termPart = terms.length > 1 ? `(${terms.join(" OR ")})` : terms[0];
  const languagePart =
    languages.length > 1
      ? `(${languages.map((language) => `sourcelang:${language}`).join(" OR ")})`
      : `sourcelang:${languages[0]}`;
  return `${termPart} ${languagePart}`;
}

/** YYYYMMDDHHMMSS in UTC. */
export function gdeltDateTime(date: Date): string {
  return date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

/** "20260925T120000Z" -> ISO 8601, or null. */
export function parseSeenDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})Z?$/.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function gdeltUrl(query: string, start: Date, end: Date): string {
  const params = new URLSearchParams({
    query,
    mode: "artlist",
    format: "json",
    maxrecords: "50",
    sort: "datedesc",
    startdatetime: gdeltDateTime(start),
    enddatetime: gdeltDateTime(end),
  });
  return `${GDELT_DOC_API}?${params.toString()}`;
}

/** Articles from a GDELT artlist JSON body; syndicated copies (same title) collapse to one. */
export function parseGdeltArticles(body: unknown): CandidateItem[] {
  const articles =
    typeof body === "object" &&
    body !== null &&
    Array.isArray((body as { articles?: unknown }).articles)
      ? (body as { articles: unknown[] }).articles
      : [];
  const items: CandidateItem[] = [];
  const titles = new Set<string>();
  for (const raw of articles) {
    if (typeof raw !== "object" || raw === null) continue;
    const article = raw as Record<string, unknown>;
    const url = typeof article.url === "string" ? canonicalEvidenceUrl(article.url) : null;
    const title =
      typeof article.title === "string" ? article.title.replace(/\s+/g, " ").trim() : "";
    if (!url || url.startsWith("openoutbound:") || !title) continue;
    const titleKey = title.toLowerCase();
    if (titles.has(titleKey)) continue;
    titles.add(titleKey);
    items.push({
      url,
      title,
      date: parseSeenDate(article.seendate),
      snippet: typeof article.domain === "string" ? `source: ${article.domain}` : null,
      author: null,
    });
  }
  return items;
}

export interface GdeltOptions {
  /** Minimum spacing between GDELT calls in this process. Default 5000 ms. */
  minIntervalMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });

export function createNewsGdeltCollector(options: GdeltOptions = {}): Collector {
  const minInterval = options.minIntervalMs ?? 5000;
  const sleep = options.sleep ?? defaultSleep;
  let nextAllowedAt = 0;

  return {
    name: "news_gdelt",
    async collect(run: CollectorRun): Promise<CollectorOutput> {
      const { ctx, company } = run;
      const query = buildGdeltQuery(company);
      if (!query) return emptyOutput(["news_gdelt: company name too short to search"]);
      const now = ctx.clock.now();
      const earliest = new Date(now.getTime() - MAX_WINDOW_DAYS * DAY_MS);
      const start = run.since > earliest ? run.since : earliest;

      const wait = nextAllowedAt - Date.now();
      if (wait > 0) await sleep(wait, run.signal);
      nextAllowedAt = Date.now() + minInterval;

      let body: unknown;
      try {
        const doc = await run.pages.api(gdeltUrl(query, start, now));
        if (doc.status === 429) {
          nextAllowedAt = Date.now() + Math.max(minInterval, 60_000);
          return emptyOutput(["news_gdelt: rate limited by GDELT, skipped"]);
        }
        if (!doc.ok) return emptyOutput([`news_gdelt: GDELT returned ${doc.status}`]);
        body = JSON.parse(doc.body);
      } catch (error) {
        // GDELT answers some bad queries with plain text instead of JSON.
        const reason = error instanceof SyntaxError ? "not_json" : fetchFailureReason(error);
        return emptyOutput([`news_gdelt: unreadable response (${reason})`]);
      }

      const items = parseGdeltArticles(body).filter(
        (item) => !item.date || new Date(item.date).getTime() >= start.getTime(),
      );
      const output = emptyOutput();
      for (const item of items.slice(0, 25)) {
        output.evidence.push({
          url: item.url,
          title: item.title,
          text: [item.title, item.snippet].filter(Boolean).join("\n"),
          published_at: item.date,
          collector: "news_gdelt",
        });
      }
      const classified = await classifyItemsToSignals(run, {
        collector: "news_gdelt",
        source: "news",
        items,
        candidates: builtinDefinitionsFor(run.definitions, "news_gdelt"),
      });
      output.signals.push(...classified.signals);
      output.brainCalls += classified.brainCalls;
      return output;
    },
  };
}
