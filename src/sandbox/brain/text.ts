/**
 * Small, pure text helpers shared by the sandbox's fake-brain answers (./answers.ts and its
 * per-prompt-group modules): deterministic variant picking and parsing of the rendered blocks
 * the writing pipeline builds (src/modules/campaigns/writing/context.ts).
 */
import { countWords } from "../../modules/campaigns/writing/checks.js";
import { hashRatio } from "../world/rng.js";

export { countWords };

/** Deterministically picks an index in [0, n) for a stable key (n must be >= 1). */
export function pickVariant(key: string, n: number): number {
  if (n <= 1) return 0;
  return Math.min(n - 1, Math.floor(hashRatio(key) * n));
}

/** Picks one item from a non-empty list deterministically by key. */
export function pickOne<T>(key: string, items: readonly T[]): T {
  const item = items[pickVariant(key, items.length)];
  if (item === undefined) throw new Error("pickOne: empty list");
  return item;
}

export interface ParsedProspect {
  firstName: string;
  fullName: string | null;
  company: string | null;
  companyShort: string;
  title: string | null;
}

function matchLine(block: string, label: string): string | null {
  const pattern = new RegExp(`^${label}: (.+)$`, "m");
  const match = pattern.exec(block);
  return match?.[1]?.trim() || null;
}

/**
 * Reads the `Label: value` lines `renderProspect()` produces (writing/context.ts), wrapped in
 * an `<untrusted_content>` block. Falls back to generic, safe words when a field is missing so
 * generated copy never shows a literal "undefined" or an empty slot.
 */
export function parseProspect(prospectBlock: string): ParsedProspect {
  const name = matchLine(prospectBlock, "Name");
  const company = matchLine(prospectBlock, "Company");
  const title = matchLine(prospectBlock, "Title");
  const firstName = name?.split(/\s+/).find((part) => part.length > 0) ?? "there";
  const companyShort = company?.split(/\s+/)[0] ?? "your team";
  return { firstName, fullName: name, company, companyShort, title };
}

export interface ParsedSignal {
  id: string;
  type: string;
  title: string;
}

/** Reads the `id: ...; type: ...; title: ...; ...` lines `renderSignals()` produces. */
export function parseSignals(signalsBlock: string | null): ParsedSignal[] {
  if (!signalsBlock) return [];
  const out: ParsedSignal[] = [];
  for (const line of signalsBlock.split("\n")) {
    const id = /(?:^|; )id: ([^;]+)/.exec(line)?.[1]?.trim();
    const type = /(?:^|; )type: ([^;]+)/.exec(line)?.[1]?.trim();
    const title = /(?:^|; )title: ([^;]+)/.exec(line)?.[1]?.trim();
    if (id && type && title) out.push({ id, type, title });
  }
  return out;
}

const SIGNAL_PHRASES: Record<string, string> = {
  hiring_relevant_roles: "hiring for operations roles",
  new_exec_hire: "bringing on new leadership",
  leadership_change: "bringing on new leadership",
  funding_round: "raising a new funding round",
  tech_adopted: "adopting new tools",
  technology_adopted: "adopting new tools",
  website_change: "updating their site",
  pricing_change: "updating their pricing",
  job_posting: "posting new roles",
  news_mention: "getting some press",
  expansion: "expanding into new markets",
};

/** A short, length-controlled phrase for a signal type, safe to interpolate into copy. */
export function signalPhrase(type: string): string {
  return SIGNAL_PHRASES[type] ?? "showing renewed activity";
}

/** Extracts the first `YYYY-MM-DD` date in text, or null. */
export function firstIsoDate(text: string): string | null {
  return /\b(\d{4}-\d{2}-\d{2})\b/.exec(text)?.[1] ?? null;
}

/** Trims a body to at most `maxWords` words by dropping whole trailing sentences first. */
export function fitWords(body: string, maxWords: number | null): string {
  if (maxWords === null || countWords(body) <= maxWords) return body;
  const sentences = body.split(/(?<=[.?])\s+/);
  let text = body;
  while (sentences.length > 1 && countWords(text) > maxWords) {
    sentences.pop();
    text = sentences.join(" ");
  }
  return text;
}
