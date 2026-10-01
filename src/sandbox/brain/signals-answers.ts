/**
 * Realistic sandbox answers for the three signal-detection prompts: signals.items.classify,
 * signals.website_change.classify, signals.custom.evaluate. All three match conservatively, by
 * a plain keyword overlap between a definition's own keywords and the item or change text, and
 * every excerpt is copied straight from the vars, never invented.
 */
import type { ClassifyItemsVars } from "../../modules/signals/prompts/classify-items.js";
import type {
  PromptDefinition,
  WebsiteChangeVars,
} from "../../modules/signals/prompts/classify-website-change.js";
import type { EvaluateCustomVars } from "../../modules/signals/prompts/evaluate-custom.js";

function matchDefinition(
  text: string,
  definitions: readonly PromptDefinition[],
): PromptDefinition | null {
  const lower = text.toLowerCase();
  for (const definition of definitions) {
    if (definition.keywords.some((keyword) => keyword && lower.includes(keyword.toLowerCase()))) {
      return definition;
    }
  }
  return null;
}

export interface ItemMatch {
  item_id: string;
  definition_key: string;
  strength: number;
  title: string;
  summary: string;
  evidence_excerpt: string;
}

/** Builds the `signals.items.classify` output. */
export function buildClassifyItemsAnswer(
  vars: ClassifyItemsVars,
  _call: unknown,
): { matches: ItemMatch[] } {
  const matches: ItemMatch[] = [];
  for (const item of vars.items) {
    const definition = matchDefinition(`${item.title} ${item.snippet ?? ""}`, vars.definitions);
    if (!definition) continue;
    matches.push({
      item_id: item.id,
      definition_key: definition.key,
      strength: 0.6,
      title: item.title.slice(0, 200),
      summary: `The item's own title or snippet matches ${definition.name}.`,
      evidence_excerpt: (item.snippet ?? item.title).slice(0, 300),
    });
  }
  return { matches };
}

export interface WebsiteChangeMatch {
  change: number;
  definition_key: string;
  strength: number;
  title: string;
  summary: string;
  evidence_excerpt: string;
}

/** Builds the `signals.website_change.classify` output. */
export function buildClassifyWebsiteChangeAnswer(
  vars: WebsiteChangeVars,
  _call: unknown,
): { matches: WebsiteChangeMatch[] } {
  const matches: WebsiteChangeMatch[] = [];
  for (const change of vars.changes) {
    if (change.added.length === 0) continue;
    const definition = matchDefinition(change.added.join(" "), vars.definitions);
    if (!definition) continue;
    const line = change.added[0] ?? definition.name;
    matches.push({
      change: change.index,
      definition_key: definition.key,
      strength: 0.6,
      title: line.slice(0, 200),
      summary: `Added content on this page matches ${definition.name}.`,
      evidence_excerpt: line.slice(0, 300),
    });
  }
  return { matches };
}

export interface CustomSignalResult {
  matched: boolean;
  strength: number;
  evidence_url: string;
  evidence_excerpt: string;
  summary: string;
}

/** Builds the `signals.custom.evaluate` output. */
export function buildEvaluateCustomAnswer(
  vars: EvaluateCustomVars,
  _call: unknown,
): CustomSignalResult {
  for (const source of vars.sources) {
    const definition = matchDefinition(`${source.title ?? ""} ${source.text}`, [vars.definition]);
    if (!definition) continue;
    return {
      matched: true,
      strength: 0.6,
      evidence_url: source.url,
      evidence_excerpt: (source.title ?? source.text).slice(0, 300),
      summary: `A ${source.collector} source appears to match: ${vars.definition.name}.`,
    };
  }
  return { matched: false, strength: 0, evidence_url: "", evidence_excerpt: "", summary: "" };
}
