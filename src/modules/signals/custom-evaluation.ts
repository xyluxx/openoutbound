/**
 * Custom signals: plain-English rules evaluated by the brain over evidence gathered by the
 * definition's collectors and URLs. The answer must cite one of the given sources (by URL),
 * otherwise it is discarded. Unchanged evidence is not evaluated twice. In sandbox workspaces
 * the URLs are read from the sandbox's pages instead of the web.
 */
import type { OpContext } from "../../core/context.js";
import type { Company, SignalDefinition } from "../../db/schema/index.js";
import { htmlToText } from "../../lib/web/extract.js";
import type { RawSignal } from "../../providers/types.js";
import {
  companyDomain,
  companyHomeUrl,
  fetchFailureReason,
  type PageCache,
  sha256,
} from "./collectors/pages.js";
import { readSnapshot, writeSnapshot } from "./collectors/snapshots.js";
import type { EvidenceItem } from "./collectors/types.js";
import { canonicalEvidenceUrl, clip, internalEvidenceUrl } from "./evidence.js";
import { evaluateCustomSignal } from "./prompts/evaluate-custom.js";

const MAX_SOURCES = 15;
const SOURCE_CHARS = 1500;
const MAX_URLS = 5;

export type CustomEvaluationStatus =
  | "matched"
  | "no_match"
  | "discarded"
  | "no_evidence"
  | "unchanged";

export interface CustomEvaluationResult {
  key: string;
  status: CustomEvaluationStatus;
  signal?: RawSignal;
  reason?: string;
  brainCalls: number;
}

/** Definition URLs resolved for a company: "/path", "{domain}" templates or absolute URLs. */
export function resolveDefinitionUrls(definition: SignalDefinition, company: Company): string[] {
  const home = companyHomeUrl(company);
  const domain = companyDomain(company);
  const out: string[] = [];
  for (const raw of definition.detection.urls.slice(0, MAX_URLS)) {
    let value = raw.trim();
    if (!value) continue;
    if (value.includes("{domain}")) {
      if (!domain) continue;
      value = value.replaceAll("{domain}", domain);
    }
    try {
      const url = value.startsWith("/") ? (home ? new URL(value, home) : null) : new URL(value);
      if (
        url &&
        (url.protocol === "https:" || url.protocol === "http:") &&
        !out.includes(url.href)
      ) {
        out.push(url.href);
      }
    } catch {
      // not a URL
    }
  }
  return out;
}

/** Fetches the definition's URLs (robots respected) as evidence items. */
export async function gatherUrlEvidence(
  pages: PageCache,
  definition: SignalDefinition,
  company: Company,
  notes: string[] = [],
): Promise<EvidenceItem[]> {
  const items: EvidenceItem[] = [];
  for (const url of resolveDefinitionUrls(definition, company)) {
    try {
      const doc = await pages.page(url);
      if (!doc.ok) {
        notes.push(`${definition.key}: ${url} returned ${doc.status}`);
        continue;
      }
      const { title, text } = htmlToText(doc.body, { maxChars: 6000 });
      items.push({ url, title, text, collector: "url" });
    } catch (error) {
      notes.push(`${definition.key}: ${url} skipped (${fetchFailureReason(error)})`);
    }
  }
  return items;
}

/**
 * Sandbox workspaces never read the real web: the definition's URLs come from the sandbox's
 * pages (the sandbox research provider's fetch: a home and an about page for every sandbox
 * company, plus its news pages). URLs it has no page for are skipped with a note.
 */
export async function gatherSandboxUrlEvidence(
  ctx: Pick<OpContext, "providers">,
  definition: SignalDefinition,
  company: Company,
  notes: string[] = [],
): Promise<EvidenceItem[]> {
  const urls = resolveDefinitionUrls(definition, company);
  if (urls.length === 0) return [];
  const research = await ctx.providers.tryGet("research").catch(() => null);
  if (!research?.fetch) {
    notes.push(`${definition.key}: urls skipped (no sandbox pages to read)`);
    return [];
  }
  const items: EvidenceItem[] = [];
  for (const url of urls) {
    try {
      const page = await research.fetch(url);
      items.push({
        url: page.url,
        title: page.title ?? null,
        text: page.text,
        published_at: page.publishedAt ?? null,
        collector: "url",
      });
    } catch {
      notes.push(`${definition.key}: ${url} is not a sandbox page`);
    }
  }
  return items;
}

/** Evidence the definition may use: its collectors' items plus its URL items. */
export function evidenceForDefinition(
  definition: SignalDefinition,
  evidence: readonly EvidenceItem[],
): EvidenceItem[] {
  const collectors = definition.detection.collectors;
  const seen = new Set<string>();
  const out: EvidenceItem[] = [];
  for (const item of evidence) {
    if (item.collector !== "url" && collectors.length > 0 && !collectors.includes(item.collector)) {
      continue;
    }
    const key = `${canonicalEvidenceUrl(item.url) ?? item.url}|${item.title ?? ""}`;
    if (seen.has(key) || !item.text.trim()) continue;
    seen.add(key);
    out.push({ ...item, text: clip(item.text, SOURCE_CHARS) ?? "" });
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

/** Runs one custom definition for one company. */
export async function evaluateCustomDefinition(
  ctx: OpContext,
  input: {
    company: Company;
    definition: SignalDefinition;
    evidence: readonly EvidenceItem[];
    /** Evaluate even when the evidence did not change since the last evaluation. */
    force?: boolean;
  },
): Promise<CustomEvaluationResult> {
  const { company, definition } = input;
  const key = definition.key;
  const sources = evidenceForDefinition(definition, input.evidence);
  if (sources.length === 0) return { key, status: "no_evidence", brainCalls: 0 };

  const fingerprint = sha256(
    JSON.stringify({
      instructions: definition.detection.instructions,
      description: definition.description,
      keywords: definition.detection.keywords,
      sources: sources.map((source) => [source.url, source.text]),
    }),
  );
  const stateUrl = internalEvidenceUrl("custom", `${key}/${company.id}`);
  const previous = await readSnapshot(ctx, company.workspace_id, stateUrl);
  if (!input.force && previous?.text === fingerprint) {
    return { key, status: "unchanged", brainCalls: 0 };
  }

  const now = ctx.clock.now();
  const result = await ctx.brain.run(
    evaluateCustomSignal,
    {
      company: { name: company.name, domain: companyDomain(company), industry: company.industry },
      definition: {
        key,
        name: definition.name,
        description: definition.description,
        instructions: definition.detection.instructions,
        keywords: definition.detection.keywords,
      },
      today: now.toISOString().slice(0, 10),
      sources: sources.map((source) => ({
        url: source.url,
        title: source.title ?? null,
        text: source.text,
        published_at: source.published_at ?? null,
        collector: source.collector,
      })),
    },
    { tier: definition.detection.tier ?? "fast", workspaceId: company.workspace_id },
  );
  await writeSnapshot(ctx, {
    workspaceId: company.workspace_id,
    companyId: company.id,
    url: stateUrl,
    text: fingerprint,
    previous,
  });

  const answer = result.output;
  if (!answer.matched || answer.strength <= 0) return { key, status: "no_match", brainCalls: 1 };
  const cited = canonicalEvidenceUrl(answer.evidence_url);
  const source = cited
    ? sources.find((candidate) => canonicalEvidenceUrl(candidate.url) === cited)
    : undefined;
  if (!source) {
    return {
      key,
      status: "discarded",
      reason: "evidence_url is not one of the collected sources",
      brainCalls: 1,
    };
  }
  return {
    key,
    status: "matched",
    brainCalls: 1,
    signal: {
      definition_key: key,
      title: definition.name,
      summary: clip(answer.summary, 1000),
      evidence_url: source.url,
      evidence_excerpt: clip(answer.evidence_excerpt, 300) ?? clip(source.title, 300),
      source: source.collector === "url" ? "custom_url" : source.collector,
      occurred_at: source.published_at ?? now.toISOString(),
      strength: answer.strength,
      raw: { evaluated_by: "brain", model: result.model },
    },
  };
}
