/**
 * Evidence check for briefs: every fact must cite a URL that was among the gathered sources,
 * pain and angle evidence URLs are filtered the same way, and angles may only reference
 * active offers. Pure function, no I/O.
 */
import type { ResearchBrief, ResearchFact } from "../../db/schema/index.js";
import type { BriefOutput } from "./prompts/brief.js";

export const BRIEF_LIMITS = { now: 8, pains: 5, angles: 4, evidence: 5 } as const;

export interface BriefValidationStats {
  /** `now` facts removed because their source_url was not gathered. */
  dropped_facts: number;
  /** Pain and angle evidence URLs removed because they were not gathered. */
  dropped_urls: number;
  /** Angle offer ids removed because they are not active offers. */
  dropped_offer_refs: number;
}

/** Comparable form of a URL: lowercase host without www, no fragment, no trailing slash. */
export function urlKey(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${host}${path}${parsed.search}`;
  } catch {
    return null;
  }
}

function normalizeDate(value: string | null | undefined, today: Date): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(value.trim());
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3] ?? "01"}`;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  // A date more than a day in the future is a model mistake.
  if (ms > today.getTime() + 24 * 60 * 60 * 1000) return null;
  return iso;
}

const normalizeText = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();

export function validateBrief(
  raw: BriefOutput,
  input: { sourceUrls: string[]; activeOfferIds: Iterable<string>; today: Date },
): { brief: ResearchBrief; stats: BriefValidationStats } {
  const allowed = new Map<string, string>();
  for (const url of input.sourceUrls) {
    const key = urlKey(url);
    if (key && !allowed.has(key)) allowed.set(key, url);
  }
  const offerIds = new Set(input.activeOfferIds);
  const stats: BriefValidationStats = { dropped_facts: 0, dropped_urls: 0, dropped_offer_refs: 0 };
  const canonical = (url: string) => {
    const key = urlKey(url);
    return key ? allowed.get(key) : undefined;
  };
  const filterUrls = (urls: string[]) => {
    const out: string[] = [];
    for (const url of urls) {
      const found = canonical(url);
      if (!found) {
        stats.dropped_urls++;
        continue;
      }
      if (!out.includes(found)) out.push(found);
    }
    return out.slice(0, BRIEF_LIMITS.evidence);
  };

  const now: ResearchFact[] = [];
  for (const fact of raw.now) {
    const source = canonical(fact.source_url);
    const text = fact.fact.trim();
    if (!source || !text) {
      stats.dropped_facts++;
      continue;
    }
    now.push({ fact: text, source_url: source, date: normalizeDate(fact.date, input.today) });
  }
  now.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

  const pains = raw.pains
    .filter((pain) => pain.hypothesis.trim())
    .slice(0, BRIEF_LIMITS.pains)
    .map((pain) => ({
      hypothesis: pain.hypothesis.trim(),
      evidence_urls: filterUrls(pain.evidence_urls),
    }));

  const angles = raw.angles
    .filter((angle) => angle.angle.trim())
    .slice(0, BRIEF_LIMITS.angles)
    .map((angle) => {
      let offerId = angle.offer_id?.trim() || null;
      if (offerId && !offerIds.has(offerId)) {
        stats.dropped_offer_refs++;
        offerId = null;
      }
      return {
        angle: angle.angle.trim(),
        why: angle.why.trim(),
        offer_id: offerId,
        evidence_urls: filterUrls(angle.evidence_urls),
      };
    });

  const wanted = raw.recommended_angle ? normalizeText(raw.recommended_angle) : null;
  const recommended =
    angles.find((angle) => wanted !== null && normalizeText(angle.angle) === wanted)?.angle ??
    angles[0]?.angle ??
    null;

  let confidence = raw.confidence;
  const hadFacts = raw.now.length > 0;
  if ((hadFacts && now.length === 0) || allowed.size === 0) confidence = "low";
  else if (confidence === "high" && stats.dropped_facts > now.length) confidence = "medium";

  return {
    brief: {
      who: { summary: raw.who.summary.trim(), role: raw.who.role?.trim() || null },
      company: { summary: raw.company.summary.trim() },
      now: now.slice(0, BRIEF_LIMITS.now),
      pains,
      angles,
      recommended_angle: recommended,
      confidence,
    },
    stats,
  };
}
