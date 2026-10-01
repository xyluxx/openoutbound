/**
 * Realistic sandbox answers for the remaining prompts: reports.summary, content.post.draft,
 * leads.import_map_columns, leads.icp_refine, enrichment.extract_team.
 */

import type { DraftPostVars } from "../../modules/content/prompts/draft-post.js";
import type { TeamExtractionVars } from "../../modules/enrichment/prompts/team.js";
import type { IcpRefineVars } from "../../modules/leads/prompts/icp-refine.js";
import type { ImportMappingVars } from "../../modules/leads/prompts/import-mapping.js";
import type { ReportSummary, ReportSummaryVars } from "../../modules/reports/prompts/summary.js";
import { pickOne, pickVariant } from "./text.js";

// ---------------------------------------------------------------------------
// reports.summary
// ---------------------------------------------------------------------------

function flattenNumbers(
  obj: Record<string, unknown>,
  prefix = "",
  depth = 0,
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "number") {
      out.push([path, String(value)]);
    } else if (typeof value === "string" && /^-?\d+(\.\d+)?%?$/.test(value)) {
      out.push([path, value]);
    } else if (value && typeof value === "object" && !Array.isArray(value) && depth < 2) {
      out.push(...flattenNumbers(value as Record<string, unknown>, path, depth + 1));
    }
  }
  return out;
}

function humanizeKey(key: string): string {
  return (key.split(".").pop() ?? key).replace(/_/g, " ");
}

/** Builds the `reports.summary` output using only numbers found in `vars.report_json`. */
export function buildReportSummaryAnswer(vars: ReportSummaryVars, _call: unknown): ReportSummary {
  let data: unknown = null;
  try {
    data = JSON.parse(vars.report_json);
  } catch {
    data = null;
  }
  const pairs =
    data && typeof data === "object" && !Array.isArray(data)
      ? flattenNumbers(data as Record<string, unknown>)
      : [];
  const top = pairs.slice(0, 3);
  const highlights = top.map(([key, value]) => `${humanizeKey(key)}: ${value}`.slice(0, 200));
  const first = top[0];
  const second = top[1];
  const summary = first
    ? [
        `${vars.report_type} for ${vars.period}: ${humanizeKey(first[0])} is ${first[1]}.`,
        second ? `${humanizeKey(second[0])} is ${second[1]}.` : "",
        "See the numbers below for anything that needs a closer look.",
      ]
        .filter(Boolean)
        .join(" ")
        .slice(0, 700)
    : `${vars.report_type} for ${vars.period} has too little data yet to draw conclusions.`;
  return {
    summary,
    highlights:
      highlights.length > 0 ? highlights : ["No numeric highlights found in this report."],
  };
}

// ---------------------------------------------------------------------------
// content.post.draft
// ---------------------------------------------------------------------------

const LENGTH_RANGES: Record<DraftPostVars["length"], readonly [number, number]> = {
  short: [60, 120],
  medium: [120, 220],
  long: [220, 350],
};

const POST_OPENERS: ReadonlyArray<(topic: string) => string> = [
  (topic) => `Most teams do not notice ${topic} until it is already costing them time every week.`,
  (topic) =>
    `Here is something we keep seeing with ${topic}: it looks small right up until it is not.`,
];

const POST_BODY_PARAGRAPHS: readonly string[] = [
  "The pattern is almost always the same. Someone builds a manual workaround, it works fine for a while, and the team quietly outgrows it. Nobody notices until the cost shows up somewhere else entirely.",
  "What actually helps is naming the problem plainly, then finding the smallest change that removes it. Not a full rebuild, just the one step that keeps causing friction for the people doing the work.",
  "The teams that get ahead of this usually do one simple thing: they write down where time actually goes for a week, then fix the biggest single item on that list first.",
];

const POST_CLOSERS: readonly string[] = [
  "Curious how other teams are handling this right now.",
  "Would be interested to hear how you are thinking about this one.",
];

function wordsIn(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function buildPostBody(key: string, topic: string, minWords: number, maxWords: number): string {
  const opener = pickOne(`${key}:opener`, POST_OPENERS)(topic);
  const closer = pickOne(`${key}:closer`, POST_CLOSERS);
  const paragraphs = [opener];
  let total = wordsIn(opener) + wordsIn(closer);
  const start = pickVariant(`${key}:start`, POST_BODY_PARAGRAPHS.length);
  for (let i = 0; i < POST_BODY_PARAGRAPHS.length && total < minWords; i++) {
    const paragraph = POST_BODY_PARAGRAPHS[(start + i) % POST_BODY_PARAGRAPHS.length];
    if (!paragraph) continue;
    paragraphs.push(paragraph);
    total += wordsIn(paragraph);
    if (total >= maxWords) break;
  }
  paragraphs.push(closer);
  return paragraphs.join("\n\n");
}

/** Builds the `content.post.draft` output: `vars.count` distinct, on-topic posts. */
export function buildDraftPostAnswer(
  vars: DraftPostVars,
  _call: unknown,
): { posts: Array<{ body: string; pillar: string; angle: string; knowledge_item_ids: string[] }> } {
  const factIds = vars.fact_index
    .map((line) => /^\[(\S+)\]/.exec(line)?.[1])
    .filter((id): id is string => Boolean(id));
  const [minWords, maxWords] = LENGTH_RANGES[vars.length];
  const posts = [];
  const count = Math.max(1, Math.min(5, vars.count));
  for (let index = 0; index < count; index++) {
    const pillar =
      vars.pillar ?? vars.pillars[index % Math.max(vars.pillars.length, 1)] ?? "operations";
    const topic = vars.topic ?? pillar;
    const key = `content.post.draft:${vars.company_name}:${topic}:${index}`;
    posts.push({
      body: buildPostBody(key, topic, minWords, maxWords),
      pillar: pillar.slice(0, 80),
      angle: `One practical observation about ${topic}, written like a practitioner.`.slice(0, 300),
      knowledge_item_ids: factIds.slice(0, 2),
    });
  }
  return { posts };
}

// ---------------------------------------------------------------------------
// leads.import_map_columns
// ---------------------------------------------------------------------------

const IGNORABLE_HEADER = /^(row.?number|index|id|internal.?id|record.?id|uuid)$/i;

/** Builds the `leads.import_map_columns` output: field, "custom" or "ignore" per column. */
export function buildImportMappingAnswer(
  vars: ImportMappingVars,
  _call: unknown,
): { mappings: Array<{ header: string; field: string }> } {
  const used = new Set<string>();
  const mappings = vars.columns.map((column) => {
    const norm = column.header
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    const allEmpty = column.samples.every((sample) => !sample.trim());
    let field: string;
    if (IGNORABLE_HEADER.test(norm) || allEmpty) {
      field = "ignore";
    } else {
      const match = vars.fields.find((candidate) => {
        if (used.has(candidate.field)) return false;
        const target = candidate.field.toLowerCase();
        return norm === target || norm.includes(target) || target.includes(norm);
      });
      if (match) {
        field = match.field;
        used.add(match.field);
      } else {
        field = "custom";
      }
    }
    return { header: column.header, field };
  });
  return { mappings };
}

// ---------------------------------------------------------------------------
// leads.icp_refine
// ---------------------------------------------------------------------------

/** Builds the `leads.icp_refine` output: no adjustment without clear evidence (rule: use 0 when unsure). */
export function buildIcpRefineAnswer(
  vars: IcpRefineVars,
  _call: unknown,
): { adjustments: Array<{ id: string; delta: number; reason: string }> } {
  return {
    adjustments: vars.candidates.map((candidate) => ({
      id: candidate.id,
      delta: 0,
      reason: "No clear evidence in the facts to move this score.",
    })),
  };
}

// ---------------------------------------------------------------------------
// enrichment.extract_team
// ---------------------------------------------------------------------------

const NAME_TITLE =
  /([A-ZÀ-Ý][a-zà-ÿ]+(?:\s+[A-ZÀ-Ý][a-zà-ÿ]+){1,2})\s*[,\-–:]?\s*(CEO|Founder|Co-Founder|Managing Director|Geschäftsführer|Owner|Practice Owner|Manager|Director|Head of [A-Za-zÀ-ÿ]+|Partner|Doctor|Dr\.)/g;
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const DECISION_TITLES = /CEO|Founder|Managing Director|Geschäftsführer|Owner|Partner|Head of/i;

/**
 * Builds the `enrichment.extract_team` output: only people whose name and title appear
 * adjacent, verbatim, on a crawled page (never invented), with an email only when one is
 * printed in the same short window of text.
 */
export function buildTeamExtractionAnswer(
  vars: TeamExtractionVars,
  _call: unknown,
): {
  people: Array<{
    full_name: string;
    title: string | null;
    email: string | null;
    decision_maker: boolean;
  }>;
} {
  const people: Array<{
    full_name: string;
    title: string | null;
    email: string | null;
    decision_maker: boolean;
  }> = [];
  const seen = new Set<string>();
  for (const page of vars.pages) {
    for (const match of page.text.matchAll(NAME_TITLE)) {
      if (people.length >= 15) break;
      const name = match[1]?.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const title = match[2]?.trim() ?? null;
      const start = Math.max(0, (match.index ?? 0) - 20);
      const end = (match.index ?? 0) + match[0].length + 60;
      const email = EMAIL_PATTERN.exec(page.text.slice(start, end))?.[0] ?? null;
      people.push({
        full_name: name,
        title,
        email,
        decision_maker: title ? DECISION_TITLES.test(title) : false,
      });
    }
    if (people.length >= 15) break;
  }
  return { people: people.slice(0, 15) };
}
