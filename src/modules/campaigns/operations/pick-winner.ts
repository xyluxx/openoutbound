/**
 * `campaigns.pick_winner`: ends an A/B test on one email step by keeping only the winning
 * variant. The step is rewritten through the same update path as `campaigns.update` (people
 * mid-sequence keep their place and every update rule applies), and the change log records it
 * under `campaigns.pick_winner` so its results are reviewed like any other change. A pick the
 * campaign report does not back (not enough data yet, or another variant leads) is made with a
 * warning: a person may choose.
 */
import { and, count, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { type OpContext, requireWorkspace } from "../../../core/context.js";
import { OpenOutboundError } from "../../../core/errors.js";
import { idSchema } from "../../../core/ids.js";
import { defineOperation, dryRun, dryRunOutput } from "../../../core/operation.js";
import { type Campaign, messages } from "../../../db/schema/index.js";
import { AB_MIN_SENDS } from "../../reports/builders/ab-ranking.js";
import { buildCampaign } from "../../reports/builders/campaign.js";
import { loadCampaign } from "../repo.js";
import { EXAMPLE_CAMPAIGN_ID, stepOutput, toStepOutput } from "../schemas.js";
import { applyCampaignUpdate, campaignDetail, updateCampaign } from "./campaigns.js";

/** Messages not sent yet: drafts written with a losing variant stay as written. */
const UNSENT = ["draft", "generating", "pending_review", "approved", "scheduled"] as const;

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Why keeping `variantKey` may be premature, judged like the campaign report over the campaign's
 * whole life: the test has not enough data yet, or the report's leader is another variant.
 */
async function abWarnings(
  ctx: OpContext,
  campaign: Campaign,
  step: { id: string; position: number },
  variantKey: string,
): Promise<string[]> {
  const workspace = requireWorkspace(ctx);
  const now = ctx.clock.now();
  const report = campaign.is_template
    ? null
    : await buildCampaign({
        ctx,
        db: ctx.db,
        workspace,
        current: {
          preset: "custom",
          label: "Campaign lifetime",
          from: new Date(0),
          to: new Date(now.getTime() + 1),
          timezone: workspace.timezone,
          partial: true,
        },
        previous: null,
        now,
        campaignId: campaign.id,
      });
  const row = report?.data.campaigns[0]?.steps.find((candidate) => candidate.step_id === step.id);
  if (!row?.enough_data) {
    const sends = (row?.variants ?? []).map((variant) => variant.sent);
    const fewest = sends.length > 0 ? Math.min(...sends) : 0;
    return [
      `The A/B test on step ${step.position + 1} does not have enough data yet: every variant needs ${AB_MIN_SENDS} sends and the fewest so far is ${fewest}. Variant "${variantKey}" is kept anyway, but it is not a proven winner.`,
    ];
  }
  if (row.leader && row.leader !== variantKey) {
    return [
      `The campaign report ranks variant "${row.leader}" first on ${row.ab_metric ?? "its A/B metric"} (confidence ${row.confidence ?? "unknown"}), not "${variantKey}". Variant "${variantKey}" is kept anyway.`,
    ];
  }
  return [];
}

const pickWinnerPlan = z.object({
  campaign_id: z.string(),
  step: stepOutput.describe("The step as it is after the change"),
  winner: z.string(),
  removed_variants: z.array(z.string()),
  pending_other_variants: z
    .number()
    .int()
    .describe(
      "Unsent messages of this step written with another variant; they stay as written (cancel or regenerate them with manage_messages)",
    ),
});

const pickWinnerResult = pickWinnerPlan.extend({
  warnings: z
    .array(z.string())
    .describe(
      "Why the pick may be premature: the test has not enough data yet, or the campaign report ranks another variant first. The pick is made anyway.",
    ),
});

export const pickWinner = defineOperation({
  id: "campaigns.pick_winner",
  summary: "End an A/B test by keeping the winning variant",
  description:
    'Rewrites one email step so only the chosen variant remains: its subject, body and instruction move into the step and the variants list is dropped, so everyone reaching the step from now on gets the winner. Use it when the campaign report shows a leader with enough data (steps show leader, confidence and enough_data), for example { campaign_id, step_id, variant_key: "B" }. Without enough data, or when you keep a variant that is not the leader, it still picks it (a person may choose) and says so in warnings. It changes the step like create_campaign action update does, so people mid-sequence keep their place; messages already written with another variant stay as they are and are counted in pending_other_variants. Run with dry_run: true to see the step and the warnings before changing it.',
  effect: "write",
  input: z.object({
    campaign_id: idSchema("cmp").describe("Campaign id (cmp_...)"),
    step_id: z.string().describe("The email step with the variants (get_campaigns action get)"),
    variant_key: z.string().min(1).max(20).describe("Key of the variant to keep, e.g. B"),
  }),
  output: z.union([pickWinnerResult, dryRunOutput(pickWinnerPlan)]),
  http: { method: "POST", path: "/v1/campaigns/:campaign_id/pick-winner" },
  dryRun: "supported",
  idempotent: false,
  workspace: "required",
  examples: [
    {
      title: "Keep variant B of the first email",
      input: {
        campaign_id: EXAMPLE_CAMPAIGN_ID,
        step_id: "stp_01k6a3v0q8x3m2n4p5r6s7t8v9",
        variant_key: "B",
      },
    },
  ],
  handler: async (ctx, input) => {
    const loaded = await loadCampaign(ctx, input.campaign_id);
    const { campaign } = loaded;
    if (campaign.status === "archived" || campaign.status === "completed") {
      throw new OpenOutboundError("conflict", `Campaign ${campaign.name} is ${campaign.status}.`, {
        hint: "Duplicate it with create_campaign action duplicate and edit the copy.",
        details: { campaign_id: campaign.id, status: campaign.status },
      });
    }
    const step = loaded.steps.find((candidate) => candidate.id === input.step_id);
    if (!step) {
      throw new OpenOutboundError(
        "not_found",
        `Step ${input.step_id} is not in campaign ${campaign.name}.`,
        {
          hint: "Read the step ids with get_campaigns action get.",
          details: { campaign_id: campaign.id, step_id: input.step_id },
        },
      );
    }
    const config: Plain = isPlain(step.config) ? (step.config as Plain) : {};
    const variants = Array.isArray(config.variants) ? config.variants.filter(isPlain) : [];
    const keys = variants.map((variant) => String(variant.key));
    if (step.type !== "email" || variants.length === 0) {
      throw new OpenOutboundError(
        "validation_failed",
        `Step ${step.position + 1} of ${campaign.name} has no variants.`,
        {
          hint: "Pick a winner on an email step with variants (the campaign report lists them).",
          details: { field: "step_id", step_id: step.id },
        },
      );
    }
    const winner = variants.find((variant) => variant.key === input.variant_key);
    if (!winner) {
      throw new OpenOutboundError(
        "validation_failed",
        `Step ${step.position + 1} has no variant "${input.variant_key}".`,
        {
          hint: `Use one of: ${keys.join(", ")}.`,
          details: { field: "variant_key", variants: keys },
        },
      );
    }

    const { type: _type, variants: _variants, ...base } = config;
    const next: Plain = { ...base };
    for (const field of ["subject", "body", "instruction"] as const) {
      const value = winner[field] ?? config[field];
      if (typeof value === "string") next[field] = value;
      else delete next[field];
    }
    const steps = loaded.steps.map((candidate) => {
      const { type: _stepType, ...stepConfig }: Plain = isPlain(candidate.config)
        ? (candidate.config as Plain)
        : {};
      return {
        id: candidate.id,
        type: candidate.type,
        delay_days: candidate.delay_days,
        delay_hours: candidate.delay_hours,
        config: candidate.id === step.id ? next : stepConfig,
      };
    });

    const [pending] = await ctx.db
      .select({ n: count() })
      .from(messages)
      .where(
        and(
          eq(messages.workspace_id, campaign.workspace_id),
          eq(messages.campaign_id, campaign.id),
          eq(messages.step_id, step.id),
          ne(messages.variant, input.variant_key),
          inArray(messages.status, [...UNSENT]),
        ),
      );
    const plan = {
      campaign_id: campaign.id,
      step: toStepOutput({ ...step, config: { ...next, type: step.type } }),
      winner: input.variant_key,
      removed_variants: keys.filter((key) => key !== input.variant_key),
      pending_other_variants: Number(pending?.n ?? 0),
    };
    const warnings = await abWarnings(ctx, campaign, step, input.variant_key);
    if (plan.pending_other_variants > 0) {
      warnings.push(
        `${plan.pending_other_variants} unsent message(s) of this step use another variant and stay as written.`,
      );
    }
    if (ctx.request.dryRun) return dryRun(plan, { warnings });
    const parsed = updateCampaign.input.parse({ campaign_id: campaign.id, steps });
    await applyCampaignUpdate(
      ctx,
      campaign.id,
      { steps: parsed.steps },
      { operation: "campaigns.pick_winner" },
    );
    const updated = await campaignDetail(ctx, campaign.id);
    // Drafts nobody started get fresh step ids from campaigns.update: match by position.
    const saved = updated.steps.find((candidate) => candidate.position === step.position);
    return { ...plan, ...(saved ? { step: saved } : {}), warnings };
  },
});
