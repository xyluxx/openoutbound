/**
 * PredictLeads (https://docs.predictleads.com/v3): job openings, financing events, technology
 * detections and news events per company domain. JSON:API responses; 1 credit per response.
 * Each endpoint has its own small mapping function so a changed field is a one-line fix.
 */

import { withPartial } from "../http.js";
import type { RawSignal, SignalProvider, SignalTarget } from "../types.js";
import { defineProvider } from "../types.js";
import {
  asArray,
  asIso,
  asNumber,
  asRecord,
  asString,
  formatUsd,
  isoDay,
  malformed,
  type ProviderFetch,
  requestJson,
  type SignalSource,
} from "./http.js";

export const PREDICTLEADS_BASE_URL = "https://predictleads.com/api/v3";
const SOURCE = "predictleads";

/** News event categories -> signal keys (others count as news_mention). */
const NEWS_CATEGORY_KEYS: Record<string, string> = {
  hires: "new_exec_hire",
  promotes: "new_exec_hire",
  expands_offices_in: "expansion_new_location",
  expands_offices_to: "expansion_new_location",
  opens_new_location: "expansion_new_location",
  expands_facilities: "expansion_new_location",
  opens_office_in: "expansion_new_location",
  receives_financing: "funding_round",
  attends_event: "event_attendance",
  participates_in: "event_attendance",
  is_sponsor_of: "event_attendance",
};

type Included = Map<string, Record<string, unknown>>;

function includedIndex(body: unknown): Included {
  const index: Included = new Map();
  for (const item of asArray(asRecord(body).included)) {
    const record = asRecord(item);
    const type = asString(record.type);
    const id = asString(record.id);
    if (type && id) index.set(`${type}:${id}`, asRecord(record.attributes));
  }
  return index;
}

function relatedId(relationships: Record<string, unknown>, name: string): string | null {
  return asString(asRecord(asRecord(relationships[name]).data).id);
}

/** job_openings -> hiring_relevant_roles (one per opening; the monitor filters by keywords). */
export function mapJobOpenings(body: unknown): RawSignal[] {
  const signals: RawSignal[] = [];
  for (const item of asArray(asRecord(body).data)) {
    const record = asRecord(item);
    const attributes = asRecord(record.attributes);
    const id = asString(record.id);
    const title = asString(attributes.title);
    const url = asString(attributes.url);
    if (!id || !title || !url) continue;
    const location = asString(attributes.location);
    signals.push({
      definition_key: "hiring_relevant_roles",
      title: `Hiring: ${title}`,
      summary: [asString(attributes.seniority), location].filter(Boolean).join(", ") || null,
      evidence_url: url,
      evidence_excerpt: location ? `${title} (${location})` : title,
      source: SOURCE,
      occurred_at: asIso(attributes.first_seen_at),
      strength: 0.6,
      dedupe_key: `${SOURCE}:job_opening:${id}`,
    });
  }
  return signals;
}

/** financing_events -> funding_round (needs a source URL). */
export function mapFinancingEvents(body: unknown): RawSignal[] {
  const signals: RawSignal[] = [];
  for (const item of asArray(asRecord(body).data)) {
    const record = asRecord(item);
    const attributes = asRecord(record.attributes);
    const id = asString(record.id);
    const url = asString(asArray(attributes.source_urls)[0]);
    if (!id || !url) continue;
    const amount = formatUsd(asNumber(attributes.amount_normalized));
    const kind =
      asString(attributes.financing_type_normalized)?.replaceAll("_", " ") ?? "financing";
    const title = amount ? `Raised ${amount} (${kind})` : `Announced a ${kind} round`;
    signals.push({
      definition_key: "funding_round",
      title,
      summary: null,
      evidence_url: url,
      evidence_excerpt: title,
      source: SOURCE,
      occurred_at: asIso(attributes.effective_date),
      strength: 1,
      dedupe_key: `${SOURCE}:financing:${id}`,
    });
  }
  return signals;
}

/** technology_detections -> tech_adopted (evidence: the company site where it was seen). */
export function mapTechnologyDetections(body: unknown, companyUrl: string): RawSignal[] {
  const included = includedIndex(body);
  const signals: RawSignal[] = [];
  for (const item of asArray(asRecord(body).data)) {
    const record = asRecord(item);
    const attributes = asRecord(record.attributes);
    const id = asString(record.id);
    const technologyId = relatedId(asRecord(record.relationships), "technology");
    const name = technologyId ? asString(included.get(`technology:${technologyId}`)?.name) : null;
    if (!id || !name) continue;
    const firstSeen = asIso(attributes.first_seen_at);
    signals.push({
      definition_key: "tech_adopted",
      title: `Started using ${name}`,
      summary: null,
      evidence_url: companyUrl,
      evidence_excerpt: `PredictLeads first detected ${name}${firstSeen ? ` on ${firstSeen.slice(0, 10)}` : ""}.`,
      source: SOURCE,
      occurred_at: firstSeen,
      strength: Math.min(1, Math.max(0.3, asNumber(attributes.score) ?? 0.6)),
      dedupe_key: `${SOURCE}:technology:${id}`,
      raw: { technology: name },
    });
  }
  return signals;
}

/** news_events -> new_exec_hire, expansion_new_location, funding_round, event_attendance or news_mention. */
export function mapNewsEvents(body: unknown): RawSignal[] {
  const included = includedIndex(body);
  const signals: RawSignal[] = [];
  for (const item of asArray(asRecord(body).data)) {
    const record = asRecord(item);
    const attributes = asRecord(record.attributes);
    const id = asString(record.id);
    const summary = asString(attributes.summary);
    const articleId = relatedId(asRecord(record.relationships), "most_relevant_source");
    const url = articleId ? asString(included.get(`news_article:${articleId}`)?.url) : null;
    if (!id || !summary || !url) continue;
    const category = asString(attributes.category) ?? "";
    signals.push({
      definition_key: NEWS_CATEGORY_KEYS[category] ?? "news_mention",
      title: summary,
      summary: category ? `PredictLeads news event: ${category.replaceAll("_", " ")}.` : null,
      evidence_url: url,
      evidence_excerpt: summary,
      source: SOURCE,
      occurred_at: asIso(attributes.found_at),
      strength: Math.min(1, Math.max(0.3, asNumber(attributes.confidence) ?? 0.7)),
      dedupe_key: `${SOURCE}:news:${id}`,
    });
  }
  return signals;
}

const NEWS_KEYS = [
  "new_exec_hire",
  "expansion_new_location",
  "news_mention",
  "event_attendance",
  "funding_round",
];

const SUPPORTED = [
  "hiring_relevant_roles",
  "funding_round",
  "tech_adopted",
  "new_exec_hire",
  "expansion_new_location",
  "news_mention",
  "event_attendance",
];

const PREDICTLEADS: SignalSource = {
  id: "predictleads",
  name: "PredictLeads",
  authHint:
    "Check PREDICTLEADS_API_KEY and PREDICTLEADS_API_TOKEN (manage_providers action set, slot signals).",
};

export function createPredictLeads(options: {
  apiKey: string;
  apiToken: string;
  fetch: ProviderFetch;
  baseUrl?: string;
  now?: () => Date;
}): SignalProvider {
  const now = options.now ?? (() => new Date());
  const base = options.baseUrl ?? PREDICTLEADS_BASE_URL;
  /** The answer body, or null for 404 (no data for this company). */
  const get = async (path: string, params: Record<string, string>) => {
    const url = `${base}${path}?${new URLSearchParams(params).toString()}`;
    const answer = await requestJson(options.fetch, PREDICTLEADS, {
      url,
      headers: {
        "X-Api-Key": options.apiKey,
        "X-Api-Token": options.apiToken,
        accept: "application/json",
      },
      answerStatuses: [404],
    });
    if (answer.status === 404) return { body: null, charged: false };
    // Every endpoint answers a JSON:API document with a `data` list (empty when nothing new).
    if (!Array.isArray(asRecord(answer.body).data)) throw malformed(PREDICTLEADS, "no data list");
    return { body: answer.body, charged: true };
  };

  return {
    id: "predictleads",
    supportedSignals: SUPPORTED,
    // Up to four endpoint responses per company, 1 credit each.
    creditsPerCall: 4,
    async collect(target: SignalTarget, collectOptions = {}) {
      const domain = target.company.domain;
      if (!domain) return [];
      const keys = new Set(collectOptions.signalKeys ?? SUPPORTED);
      const since = isoDay(collectOptions.since ?? new Date(now().getTime() - 30 * 86_400_000));
      const company = encodeURIComponent(domain);
      const endpoints: Array<{
        key: string;
        wanted: boolean;
        path: string;
        params: Record<string, string>;
        map: (body: unknown) => RawSignal[];
      }> = [
        {
          key: "job_openings",
          wanted: keys.has("hiring_relevant_roles"),
          path: `/companies/${company}/job_openings`,
          params: { active_only: "true", first_seen_at_from: since, limit: "100" },
          map: mapJobOpenings,
        },
        {
          key: "financing_events",
          wanted: keys.has("funding_round"),
          path: `/companies/${company}/financing_events`,
          params: { first_seen_at_from: since, limit: "50" },
          map: mapFinancingEvents,
        },
        {
          key: "technology_detections",
          wanted: keys.has("tech_adopted"),
          path: `/companies/${company}/technology_detections`,
          params: { first_seen_at_from: since, limit: "100" },
          map: (body) => mapTechnologyDetections(body, `https://${domain}`),
        },
        {
          key: "news_events",
          wanted: NEWS_KEYS.some((key) => keys.has(key)),
          path: `/companies/${company}/news_events`,
          params: { found_at_from: since, limit: "50" },
          map: (body) => mapNewsEvents(body).filter((signal) => keys.has(signal.definition_key)),
        },
      ];
      // A failed call's resume lists the endpoints already answered (and paid for).
      const done = new Set(resumeOf(collectOptions.resume));
      const signals: RawSignal[] = [];
      let credits = 0;
      for (const endpoint of endpoints) {
        if (!endpoint.wanted || done.has(endpoint.key)) continue;
        let answer: { body: unknown; charged: boolean };
        try {
          answer = await get(endpoint.path, endpoint.params);
        } catch (error) {
          if (credits === 0) throw error;
          throw withPartial(error, PREDICTLEADS, {
            items: signals,
            credits,
            resume: { done: [...done] },
          });
        }
        done.add(endpoint.key);
        if (answer.charged) credits += 1;
        if (answer.body) signals.push(...endpoint.map(answer.body));
      }
      return signals;
    },
  };
}

function resumeOf(value: unknown): string[] {
  const done = (value as { done?: unknown } | null | undefined)?.done;
  return Array.isArray(done) ? done.filter((key): key is string => typeof key === "string") : [];
}

export const predictleadsProvider = defineProvider({
  slot: "signals",
  id: "predictleads",
  name: "PredictLeads",
  description:
    "Job openings, financing events, technologies and news events by company domain. Paid: 1 credit per response, up to 4 per company check.",
  docsUrl: "https://docs.predictleads.com/v3",
  secrets: [
    { key: "api_key", label: "API key", env: "PREDICTLEADS_API_KEY", required: true },
    { key: "api_token", label: "API token", env: "PREDICTLEADS_API_TOKEN", required: true },
  ],
  create: ({ secrets, ctx }) =>
    createPredictLeads({
      apiKey: secrets.api_key ?? "",
      apiToken: secrets.api_token ?? "",
      fetch: ctx.fetch,
      now: () => ctx.clock.now(),
    }),
  // Every PredictLeads data call costs a credit, so the check stays offline.
  test: async () => ({
    ok: true,
    checked: false,
    message:
      "Keys are set. PredictLeads has no free check endpoint; the first monitor run verifies them.",
  }),
});
