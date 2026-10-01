import type { OpContext } from "../../../core/context.js";
import type { Company, SignalDefinition } from "../../../db/schema/index.js";
import type { RawSignal } from "../../../providers/types.js";
import type { BuiltinCollector } from "../catalog.js";
import type { PageCache } from "./pages.js";

/** Something a collector saw, kept as evidence for custom signal evaluation. */
export interface EvidenceItem {
  /** Public URL (or openoutbound:// reference for first-party records). */
  url: string;
  title?: string | null;
  /** Untrusted text from the source; prompts wrap it before use. */
  text: string;
  /** ISO 8601 date of the source, when known. */
  published_at?: string | null;
  collector: string;
}

/** Keyword lists derived once per run from definitions and ICPs. */
export interface RunKeywords {
  /** Role keywords for hiring_relevant_roles (definition keywords + ICP personas). */
  hiring: string[];
  /** Relevant tools for tech_adopted / tech_removed. */
  tech: string[];
  /** Competitor names for competitor_mention. */
  competitors: string[];
}

/** One collector pass over one company. */
export interface CollectorRun {
  ctx: OpContext;
  company: Company;
  /** Enabled definitions this run may report (built-in and custom). */
  definitions: SignalDefinition[];
  /** Report only events after this moment. */
  since: Date;
  keywords: RunKeywords;
  /** Per-company fetch cache shared by collectors (the homepage is fetched once). */
  pages: PageCache;
  /** Abort (job timeout or shutdown). */
  signal?: AbortSignal;
}

export interface CollectorOutput {
  signals: RawSignal[];
  evidence: EvidenceItem[];
  /** Short notes for the monitor result (skips, soft errors). */
  notes: string[];
  brainCalls: number;
}

export interface Collector {
  name: BuiltinCollector;
  collect(run: CollectorRun): Promise<CollectorOutput>;
}

export function emptyOutput(notes: string[] = []): CollectorOutput {
  return { signals: [], evidence: [], notes, brainCalls: 0 };
}

/** Enabled definitions that list this collector (or provider id) in detection.collectors. */
export function definitionsFor(
  definitions: readonly SignalDefinition[],
  collector: string,
): SignalDefinition[] {
  return definitions.filter(
    (definition) => definition.enabled && definition.detection.collectors.includes(collector),
  );
}

/** Compact definition view for prompts. */
export function promptDefinitions(definitions: readonly SignalDefinition[]) {
  return definitions.map((definition) => ({
    key: definition.key,
    name: definition.name,
    description: definition.description,
    instructions: definition.detection.instructions,
    keywords: definition.detection.keywords,
  }));
}
