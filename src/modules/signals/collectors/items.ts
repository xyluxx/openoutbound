/**
 * Shared step for news_gdelt and rss: one brain call picks the items that are about the
 * company and match a built-in definition. Custom definitions are evaluated separately (with
 * these items as evidence), so they are never double-counted here.
 */
import type { SignalDefinition } from "../../../db/schema/index.js";
import type { RawSignal } from "../../../providers/types.js";
import { clip } from "../evidence.js";
import { classifyItems } from "../prompts/classify-items.js";
import { companyDomain } from "./pages.js";
import { type CollectorRun, promptDefinitions } from "./types.js";

export interface CandidateItem {
  url: string;
  title: string;
  /** ISO 8601. */
  date: string | null;
  snippet: string | null;
  author: string | null;
}

/** Built-in definitions that list the collector. */
export function builtinDefinitionsFor(
  definitions: readonly SignalDefinition[],
  collector: string,
): SignalDefinition[] {
  return definitions.filter(
    (definition) =>
      definition.enabled &&
      definition.kind === "builtin" &&
      definition.detection.collectors.includes(collector),
  );
}

export async function classifyItemsToSignals(
  run: CollectorRun,
  input: {
    collector: "news_gdelt" | "rss";
    source: "news" | "feed";
    items: CandidateItem[];
    candidates: SignalDefinition[];
    people?: Array<{ name: string; title: string | null }>;
  },
): Promise<{ signals: RawSignal[]; brainCalls: number }> {
  if (input.items.length === 0 || input.candidates.length === 0) {
    return { signals: [], brainCalls: 0 };
  }
  const items = input.items.slice(0, 25).map((item, index) => ({ ...item, id: `i${index + 1}` }));
  const result = await run.ctx.brain.run(
    classifyItems,
    {
      company: {
        name: run.company.name,
        domain: companyDomain(run.company),
        industry: run.company.industry,
      },
      source: input.source,
      items: items.map((item) => ({
        id: item.id,
        url: item.url,
        title: item.title,
        date: item.date,
        snippet: item.snippet,
        author: item.author,
      })),
      definitions: promptDefinitions(input.candidates),
      people: input.people ?? [],
    },
    { workspaceId: run.company.workspace_id },
  );
  const allowed = new Set(input.candidates.map((definition) => definition.key));
  // One real event counts once: keep the strongest match per item.
  const best = new Map<string, (typeof result.output.matches)[number]>();
  for (const match of result.output.matches) {
    if (!allowed.has(match.definition_key) || match.strength <= 0) continue;
    const current = best.get(match.item_id);
    if (!current || match.strength > current.strength) best.set(match.item_id, match);
  }
  const signals: RawSignal[] = [];
  for (const [itemId, match] of best) {
    const item = items.find((candidate) => candidate.id === itemId);
    if (!item) continue;
    signals.push({
      definition_key: match.definition_key,
      title: clip(match.title, 300) ?? item.title,
      summary: clip(match.summary, 1000),
      evidence_url: item.url,
      evidence_excerpt: clip(match.evidence_excerpt, 300) ?? clip(item.title, 300),
      source: input.collector,
      occurred_at: item.date,
      strength: match.strength,
    });
  }
  return { signals, brainCalls: 1 };
}
