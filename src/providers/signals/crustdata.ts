/**
 * Crustdata (https://docs.crustdata.com, API version 2025-11-01): company enrichment by domain
 * for headcount growth, funding, hiring and news; Watcher webhooks for person job changes.
 * Response shapes beyond the documented examples are read defensively, one mapping function
 * per signal type.
 */
import type { ProviderTestResult, RawSignal, SignalProvider, SignalTarget } from "../types.js";
import { defineProvider } from "../types.js";
import {
  asArray,
  asIso,
  asNumber,
  asRecord,
  asString,
  formatUsd,
  malformed,
  type ProviderFetch,
  requestJson,
  type SignalSource,
} from "./http.js";

export const CRUSTDATA_BASE_URL = "https://api.crustdata.com";
export const CRUSTDATA_API_VERSION = "2025-11-01";
const SOURCE = "crustdata";
/** 20% growth over 6 months is the playbook threshold for headcount_growth. */
const HEADCOUNT_THRESHOLD = 20;
const CRUSTDATA: SignalSource = {
  id: "crustdata",
  name: "Crustdata",
  authHint:
    "Check CRUSTDATA_API_KEY (manage_providers action set, slot signals), then run manage_providers (action test).",
};

export interface CrustdataCompany {
  domain: string;
  data: Record<string, unknown>;
}

/**
 * The best match of a /company/enrich response (confidence 0.8 or more), or null. The answer
 * is documented as an array (one entry per domain); anything else is `malformed`, never "no
 * match".
 */
export function pickCompanyMatch(body: unknown): Record<string, unknown> | null {
  if (!Array.isArray(body)) throw malformed(CRUSTDATA, "company/enrich did not return an array");
  for (const entry of body) {
    for (const match of asArray(asRecord(entry).matches)) {
      const record = asRecord(match);
      const confidence = asNumber(record.confidence_score) ?? 0;
      if (confidence >= 0.8) return asRecord(record.company_data);
    }
  }
  return null;
}

function companyUrl(data: Record<string, unknown>, domain: string): string {
  const basic = asRecord(data.basic_info);
  return (
    asString(basic.professional_network_url) ??
    asString(basic.linkedin_profile_url) ??
    asString(basic.website) ??
    `https://${asString(basic.primary_domain) ?? domain}`
  );
}

/** headcount.growth_percent.six_months >= 20 -> headcount_growth (one per month). */
export function mapHeadcount(
  data: Record<string, unknown>,
  domain: string,
  now: Date,
): RawSignal[] {
  const headcount = asRecord(data.headcount);
  const growth = asNumber(asRecord(headcount.growth_percent).six_months);
  if (growth === null || growth < HEADCOUNT_THRESHOLD) return [];
  const total = asNumber(headcount.total);
  const excerpt = `Headcount ${total ?? "unknown"}, up ${Math.round(growth)}% in 6 months (Crustdata).`;
  return [
    {
      definition_key: "headcount_growth",
      title: `Headcount up ${Math.round(growth)}% in 6 months${total ? ` (${total} people)` : ""}`,
      summary: null,
      evidence_url: companyUrl(data, domain),
      evidence_excerpt: excerpt,
      source: SOURCE,
      occurred_at: now.toISOString(),
      strength: Math.min(1, Math.round((0.5 + (growth - HEADCOUNT_THRESHOLD) / 40) * 100) / 100),
      dedupe_key: `${SOURCE}:headcount:${domain}:${now.toISOString().slice(0, 7)}`,
    },
  ];
}

/** funding.last_fundraise_date after `since` -> funding_round. */
export function mapFunding(
  data: Record<string, unknown>,
  domain: string,
  since: Date,
): RawSignal[] {
  const funding = asRecord(data.funding);
  const date = asIso(funding.last_fundraise_date);
  if (!date || new Date(date).getTime() < since.getTime()) return [];
  const amount = formatUsd(asNumber(funding.last_round_amount_usd));
  const round = asString(funding.last_round_type)?.replaceAll("_", " ") ?? "funding";
  const title = amount ? `Raised ${amount} (${round})` : `Raised a ${round} round`;
  return [
    {
      definition_key: "funding_round",
      title,
      summary: null,
      evidence_url: asString(funding.source_url) ?? companyUrl(data, domain),
      evidence_excerpt: `${title} on ${date.slice(0, 10)} (Crustdata funding data).`,
      source: SOURCE,
      occurred_at: date,
      strength: asString(funding.source_url) ? 1 : 0.8,
      dedupe_key: `${SOURCE}:funding:${domain}:${date.slice(0, 10)}`,
    },
  ];
}

/** hiring.* job lists (title + url) -> hiring_relevant_roles; the monitor filters by keywords. */
export function mapHiring(data: Record<string, unknown>): RawSignal[] {
  const hiring = asRecord(data.hiring);
  const lists = [hiring.job_openings, hiring.recent_job_openings, hiring.openings, hiring.jobs];
  const signals: RawSignal[] = [];
  for (const item of lists.flatMap(asArray)) {
    const job = asRecord(item);
    const title = asString(job.title) ?? asString(job.job_title);
    const url = asString(job.url) ?? asString(job.job_url);
    if (!title || !url) continue;
    signals.push({
      definition_key: "hiring_relevant_roles",
      title: `Hiring: ${title}`,
      evidence_url: url,
      evidence_excerpt: title,
      source: SOURCE,
      occurred_at: asIso(job.date_posted ?? job.posted_at ?? job.first_seen_at),
      strength: 0.6,
      dedupe_key: `${SOURCE}:job:${url}`,
    });
  }
  return signals;
}

/** news / news_articles lists (url + title) -> news_mention. */
export function mapNews(data: Record<string, unknown>, since: Date): RawSignal[] {
  const signals: RawSignal[] = [];
  for (const item of [data.news, data.news_articles].flatMap(asArray)) {
    const article = asRecord(item);
    const url = asString(article.url) ?? asString(article.article_url);
    const title = asString(article.title);
    const date = asIso(article.published_at ?? article.date);
    if (!url || !title) continue;
    if (date && new Date(date).getTime() < since.getTime()) continue;
    signals.push({
      definition_key: "news_mention",
      title,
      evidence_url: url,
      evidence_excerpt: title,
      source: SOURCE,
      occurred_at: date,
      strength: 0.5,
    });
  }
  return signals;
}

/**
 * Watcher webhook -> job_change for people whose current employment gained an entry. Needs the
 * person's public profile URL as evidence.
 */
export function mapWatcherPayload(body: unknown): RawSignal[] {
  const payload = asRecord(body);
  const runId = asString(String(asRecord(payload.metadata).run_id ?? "")) ?? "run";
  const signals: RawSignal[] = [];
  for (const item of asArray(payload.results)) {
    const result = asRecord(item);
    const record = asRecord(result.record);
    const basic = asRecord(record.basic_profile);
    const profileUrl =
      asString(record.professional_network_profile_url) ??
      asString(record.linkedin_profile_url) ??
      asString(basic.professional_network_profile_url) ??
      asString(basic.linkedin_profile_url);
    const name = asString(basic.name);
    for (const change of asArray(result.changes)) {
      const entry = asRecord(change);
      if (
        asString(entry.field) !== "experience.employment_details.current" ||
        entry.type !== "added"
      ) {
        continue;
      }
      const role = asRecord(asArray(entry.new_elements)[0]);
      const company = asString(role.name) ?? asString(role.company_name);
      const title = asString(role.title);
      if (!profileUrl || !company) continue;
      signals.push({
        definition_key: "job_change",
        title: `${name ?? "A contact"} started${title ? ` as ${title}` : ""} at ${company}`,
        summary: "Crustdata watcher: new current employment.",
        evidence_url: profileUrl,
        evidence_excerpt: [title, company].filter(Boolean).join(" at "),
        source: SOURCE,
        occurred_at: asIso(role.start_date) ?? asIso(asRecord(payload.metadata).delivered_at),
        strength: 0.6,
        person: { full_name: name, linkedin_url: profileUrl },
        company: { name: company },
        dedupe_key: `${SOURCE}:job_change:${profileUrl}:${company.toLowerCase()}:${runId}`,
      });
    }
  }
  return signals;
}

/** The Crustdata signal provider plus a free credential check. */
export type CrustdataProvider = SignalProvider & {
  checkCredentials(): Promise<ProviderTestResult>;
};

export function createCrustdata(options: {
  apiKey: string;
  fetch: ProviderFetch;
  baseUrl?: string;
  now?: () => Date;
}): CrustdataProvider {
  const base = options.baseUrl ?? CRUSTDATA_BASE_URL;
  const now = options.now ?? (() => new Date());
  const request = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const answer = await requestJson(options.fetch, CRUSTDATA, {
      url: `${base}${path}`,
      method,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "x-api-version": CRUSTDATA_API_VERSION,
        "content-type": "application/json",
        accept: "application/json",
      },
      ...(body === undefined ? {} : { body }),
    });
    return answer.body;
  };

  const supported = [
    "headcount_growth",
    "funding_round",
    "hiring_relevant_roles",
    "news_mention",
    "job_change",
  ];
  return {
    id: "crustdata",
    supportedSignals: supported,
    creditsPerCall: 1,
    async collect(target: SignalTarget, collectOptions = {}) {
      const domain = target.company.domain;
      if (!domain) return [];
      const keys = new Set(collectOptions.signalKeys ?? supported);
      const fields = ["basic_info"];
      if (keys.has("headcount_growth")) fields.push("headcount");
      if (keys.has("funding_round")) fields.push("funding");
      if (keys.has("hiring_relevant_roles")) fields.push("hiring");
      if (fields.length === 1 && !keys.has("news_mention")) return [];
      const body = await request("POST", "/company/enrich", {
        domains: [domain],
        fields,
        exact_match: true,
      });
      const data = pickCompanyMatch(body);
      if (!data) return [];
      const since = collectOptions.since ?? new Date(now().getTime() - 30 * 86_400_000);
      const signals = [
        ...mapHeadcount(data, domain, now()),
        ...mapFunding(data, domain, since),
        ...mapHiring(data),
        ...mapNews(data, since),
      ];
      return signals.filter((signal) => keys.has(signal.definition_key));
    },
    async parseWebhook(body: unknown) {
      return mapWatcherPayload(body);
    },
    checkCredentials: () =>
      testCrustdata({
        apiKey: options.apiKey,
        fetch: options.fetch,
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      }),
  };
}

export const crustdataProvider = defineProvider({
  slot: "signals",
  id: "crustdata",
  name: "Crustdata",
  description:
    "Headcount growth, funding, hiring and news by company domain; Watcher webhooks for job changes. Paid: credits per enrichment.",
  docsUrl: "https://docs.crustdata.com/openapi-specs/2025-11-01/introduction",
  secrets: [{ key: "api_key", label: "API key", env: "CRUSTDATA_API_KEY", required: true }],
  create: ({ secrets, ctx }) =>
    createCrustdata({
      apiKey: secrets.api_key ?? "",
      fetch: ctx.fetch,
      now: () => ctx.clock.now(),
    }),
  test: async (instance) => {
    const check = (instance as Partial<CrustdataProvider>).checkCredentials;
    return check ? check() : { ok: false, message: "Not a Crustdata instance." };
  },
});

/** Free credential check: GET /account/credits (no credits spent). */
export async function testCrustdata(options: {
  apiKey: string;
  fetch: ProviderFetch;
  baseUrl?: string;
}): Promise<{ ok: boolean; message: string }> {
  try {
    const answer = await requestJson(options.fetch, CRUSTDATA, {
      url: `${options.baseUrl ?? CRUSTDATA_BASE_URL}/account/credits`,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "x-api-version": CRUSTDATA_API_VERSION,
        accept: "application/json",
      },
      paid: false,
      timeoutMs: 15_000,
      answerStatuses: [400, 401, 402, 403, 404, 429, 500, 502, 503, 504],
    });
    if (answer.status >= 400) {
      return { ok: false, message: `Crustdata returned HTTP ${answer.status}.` };
    }
    const body = asRecord(answer.body);
    const credits =
      asNumber(body.credits) ?? asNumber(body.balance) ?? asNumber(body.remaining_credits);
    return {
      ok: true,
      message: credits === null ? "Connected." : `Connected, ${credits} credits left.`,
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
