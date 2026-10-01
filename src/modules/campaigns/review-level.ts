/**
 * Lowering a campaign's review level is a gate (spec 2, rule 4): every reviews each message,
 * first the first message of each step, unsure only what the checker is unsure about. Someone
 * who must ask for approval (`mustRequestApproval`) gets an approval of kind `review_level`;
 * raising the level never needs one.
 */
import type { OpContext } from "../../core/context.js";
import type { ReviewLevel } from "../../core/enums.js";
import type { Campaign } from "../../db/schema/index.js";

const REVIEW_RANK: Record<ReviewLevel, number> = { every: 2, first: 1, unsure: 0 };

const REVIEW_WORDS: Record<ReviewLevel, string> = {
  every: "every message is reviewed",
  first: "the first message of each step is reviewed",
  unsure: "only messages the checker is unsure about are reviewed",
};

/** True when `to` reviews fewer messages than `from`. */
export function lowersReviewLevel(from: ReviewLevel, to: ReviewLevel): boolean {
  return REVIEW_RANK[to] < REVIEW_RANK[from];
}

/**
 * Stores the approval for a LinkedIn comment step held at review `always` (every comment
 * reviewed) when someone who must ask set it to `level` (the campaign's review level decides).
 * It names the step; a newer request for the step replaces it.
 */
export async function requestCommentReviewApproval(
  ctx: OpContext,
  campaign: Pick<Campaign, "id" | "name">,
  step: { id: string; position: number },
  level: ReviewLevel,
): Promise<string> {
  const { id } = await ctx.approvals.request({
    kind: "review_level",
    title: `Stop reviewing every comment of step ${step.position + 1} of "${campaign.name}"`,
    summary: `${ctx.principal.name} asked to change LinkedIn comment step ${step.position + 1} (${step.id}) from review always (a person approves every comment) to level (the campaign's review level decides, now ${level}: ${REVIEW_WORDS[level]}). Approve to apply it; reject to keep every comment reviewed.`,
    payload: {
      campaign_id: campaign.id,
      name: campaign.name,
      step_id: step.id,
      step_position: step.position,
      review: "level",
      current: "always",
    },
    target: { type: "campaign_step", id: step.id },
    supersede: true,
  });
  return id;
}

/** Stores the approval for a held review level. A newer request for the campaign replaces it. */
export async function requestReviewLevelApproval(
  ctx: OpContext,
  campaign: Pick<Campaign, "id" | "name">,
  from: ReviewLevel,
  to: ReviewLevel,
): Promise<string> {
  const { id } = await ctx.approvals.request({
    kind: "review_level",
    title: `Lower the review level of "${campaign.name}" to ${to}`,
    summary: `${ctx.principal.name} asked to change the review level from ${from} (${REVIEW_WORDS[from]}) to ${to} (${REVIEW_WORDS[to]}). Approve to apply it (or edit review_level first); reject to keep ${from}.`,
    payload: { campaign_id: campaign.id, name: campaign.name, review_level: to, current: from },
    target: { type: "campaign", id: campaign.id },
    supersede: true,
  });
  return id;
}
