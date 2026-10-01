/** Optional AI refinement of fit scores (fast tier) for the top candidates of a preview. */
import type { OpContext } from "../../../core/context.js";
import type { FitReason } from "../../../db/schema/index.js";
import { icpRefinePrompt } from "../prompts/icp-refine.js";
import { describeCriteria, type ParsedIcp } from "./criteria.js";

export interface RefineCandidate {
  id: string;
  score: number | null;
  disqualified: boolean;
  /** Plain facts about the candidate (untrusted provider data). */
  facts: string;
}

export interface Refinement {
  score: number;
  reason: FitReason;
}

/**
 * Asks the brain to adjust the scores of the top `ai_refinement.top_n` candidates by at most
 * `max_adjust` points. Disqualified and unscored candidates are never sent or changed.
 * Returns id -> refined score and the reason line to append to fit_reasons.
 */
export async function refineScores(
  ctx: OpContext,
  icp: ParsedIcp,
  candidates: RefineCandidate[],
): Promise<Map<string, Refinement>> {
  const settings = icp.scoring.ai_refinement;
  const out = new Map<string, Refinement>();
  if (!settings.enabled) return out;
  const top = candidates
    .filter((c): c is RefineCandidate & { score: number } => c.score !== null && !c.disqualified)
    .sort((a, b) => b.score - a.score)
    .slice(0, settings.top_n);
  if (top.length === 0) return out;
  const result = await ctx.brain.run(icpRefinePrompt, {
    icpName: icp.name,
    icpDescription: icp.description,
    criteria: describeCriteria(icp.criteria),
    maxAdjust: settings.max_adjust,
    candidates: top.map((c) => ({ id: c.id, score: c.score, facts: c.facts.slice(0, 1500) })),
  });
  const byId = new Map(top.map((c) => [c.id, c]));
  for (const adjustment of result.output.adjustments) {
    const candidate = byId.get(adjustment.id);
    if (!candidate || out.has(candidate.id)) continue;
    const delta = Math.max(-settings.max_adjust, Math.min(settings.max_adjust, adjustment.delta));
    if (delta === 0) continue;
    out.set(candidate.id, {
      score: Math.max(0, Math.min(100, candidate.score + delta)),
      reason: {
        rule: "ai_refinement",
        points: delta,
        matched: delta > 0,
        detail: adjustment.reason.slice(0, 300),
      },
    });
  }
  return out;
}
