import { and, count, desc, eq, ilike, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { actorRef, type OpContext, requireWorkspace } from "../../../core/context.js";
import {
  CAMPAIGN_GOALS,
  CAMPAIGN_STATUSES,
  type CampaignGoal,
  ENROLLMENT_STATUSES,
  type ReviewLevel,
} from "../../../core/enums.js";
import { invalid, OpenOutboundError } from "../../../core/errors.js";
import { idSchema } from "../../../core/ids.js";
import {
  awaitingApproval,
  awaitingApprovalOutput,
  defineOperation,
  paginated,
  paginationInput,
} from "../../../core/operation.js";
import { decodeCursor, toPage } from "../../../core/pagination.js";
import {
  type CampaignSettingsInput,
  campaignSettingsSchema,
  mergeSettings,
  parseCampaignSettings,
  parseWorkspaceSettings,
} from "../../../core/settings.js";
import {
  type Campaign,
  type CampaignStep,
  campaign_steps,
  campaigns,
  enrollments,
  icps,
  linkedin_accounts,
  mailboxes,
  messages,
  offers,
  people,
  templates,
} from "../../../db/schema/index.js";
import { mustRequestApproval } from "../../../runtime/approval-rule.js";
import { campaignSnapshot, recordChange, withStableSteps } from "../../strategy/service.js";
import { IN_PROGRESS, stopEnrollments } from "../control.js";
import { displayName } from "../people.js";
import { getSteps, loadCampaign } from "../repo.js";
import {
  lowersReviewLevel,
  requestCommentReviewApproval,
  requestReviewLevelApproval,
} from "../review-level.js";
import {
  campaignDetailOutput,
  campaignSummaryOutput,
  EXAMPLE_CAMPAIGN_ID,
  EXAMPLE_MAILBOX_ID,
  EXAMPLE_OFFER_ID,
  enrollmentOutput,
  toCampaignSummary,
  toEnrollmentOutput,
  toStepOutput,
} from "../schemas.js";
import { computeCampaignStats } from "../stats.js";
import { type NormalizedStep, type StepInput, stepInput, validateSteps } from "../steps.js";
import { BUILTIN_TEMPLATES, type CampaignTemplate, findBuiltinTemplate } from "../templates.js";

const campaignId = idSchema("cmp").describe("Campaign id (cmp_...)");

const settingsInput = z
  .record(z.string(), z.unknown())
  .describe(
    "Campaign settings (only what you want to change; the rest keeps its default): review_level (every|first|unsure), schedule { days, start_hour, end_hour, timezone_mode lead|fixed, timezone, start_at, end_at }, daily_new_leads, senders { mailbox_ids, linkedin_account_ids }, priority 0-100, writing { language, length short|medium, style_notes, instructions, rules }, missing_data (skip_step|skip_lead), end_action { type none|tag|list, value }, stop { on_reply, on_company_reply, on_meeting }, tracking { opens, clicks }, ab_test { enabled, metric }.",
  );

/** Validates merged settings; errors point at `settings.<field>`. */
function validateSettings(merged: Record<string, unknown>): CampaignSettingsInput {
  const result = campaignSettingsSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: `settings.${issue.path.map(String).join(".")}`,
      message: issue.message,
    }));
    throw new OpenOutboundError(
      "validation_failed",
      `Invalid settings: ${issues
        .slice(0, 5)
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`,
      { hint: "Fix the listed settings fields and try again.", details: { issues } },
    );
  }
  return merged as CampaignSettingsInput;
}

/** Checks that referenced mailboxes, LinkedIn accounts, offer and ICP belong to the workspace. */
async function validateReferences(
  ctx: OpContext,
  settings: CampaignSettingsInput,
  refs: { offerId?: string | null; icpId?: string | null },
): Promise<void> {
  const workspace = requireWorkspace(ctx);
  const parsed = campaignSettingsSchema.parse(settings);
  const problems: string[] = [];
  const mailboxIds = parsed.senders.mailbox_ids;
  if (mailboxIds.length > 0) {
    const rows = await ctx.db
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(and(eq(mailboxes.workspace_id, workspace.id), inArray(mailboxes.id, mailboxIds)));
    const known = new Set(rows.map((row) => row.id));
    for (const id of mailboxIds) if (!known.has(id)) problems.push(`unknown mailbox ${id}`);
  }
  const accountIds = parsed.senders.linkedin_account_ids;
  if (accountIds.length > 0) {
    const rows = await ctx.db
      .select({ id: linkedin_accounts.id })
      .from(linkedin_accounts)
      .where(
        and(
          eq(linkedin_accounts.workspace_id, workspace.id),
          inArray(linkedin_accounts.id, accountIds),
        ),
      );
    const known = new Set(rows.map((row) => row.id));
    for (const id of accountIds)
      if (!known.has(id)) problems.push(`unknown LinkedIn account ${id}`);
  }
  if (refs.offerId) {
    const [offer] = await ctx.db
      .select({ id: offers.id })
      .from(offers)
      .where(and(eq(offers.id, refs.offerId), eq(offers.workspace_id, workspace.id)));
    if (!offer) problems.push(`unknown offer ${refs.offerId}`);
  }
  if (refs.icpId) {
    const [icp] = await ctx.db
      .select({ id: icps.id })
      .from(icps)
      .where(and(eq(icps.id, refs.icpId), eq(icps.workspace_id, workspace.id)));
    if (!icp) problems.push(`unknown ICP ${refs.icpId}`);
  }
  if (problems.length > 0) {
    throw new OpenOutboundError(
      "validation_failed",
      `Invalid references: ${problems.join("; ")}.`,
      {
        hint: "List mailboxes with manage_mailboxes, LinkedIn accounts with manage_linkedin, offers with manage_knowledge action list_offers and ICPs with manage_icp.",
        details: { problems },
      },
    );
  }
}

async function insertSteps(
  ctx: OpContext,
  campaign: Campaign,
  steps: NormalizedStep[],
): Promise<void> {
  if (steps.length === 0) return;
  await ctx.db.insert(campaign_steps).values(
    steps.map((step, position) => ({
      campaign_id: campaign.id,
      workspace_id: campaign.workspace_id,
      position,
      type: step.type,
      delay_days: step.delay_days,
      delay_hours: step.delay_hours,
      config: step.config,
    })),
  );
}

async function enrollmentCounts(ctx: OpContext, id: string): Promise<Record<string, number>> {
  const rows = await ctx.db
    .select({ status: enrollments.status, n: count() })
    .from(enrollments)
    .where(eq(enrollments.campaign_id, id))
    .groupBy(enrollments.status);
  const out: Record<string, number> = {};
  for (const status of ENROLLMENT_STATUSES) out[status] = 0;
  for (const row of rows) out[row.status] = Number(row.n);
  return out;
}

/** Full campaign view (fresh stats and counts). */
export async function campaignDetail(ctx: OpContext, id: string) {
  const loaded = await loadCampaign(ctx, id);
  const stats = await computeCampaignStats(ctx, id);
  return {
    ...toCampaignSummary(loaded.campaign, loaded.steps.length, stats),
    settings: loaded.settings as unknown as Record<string, unknown>,
    steps: loaded.steps.map(toStepOutput),
    step_stats: stats.by_step ?? [],
    enrollment_counts: await enrollmentCounts(ctx, id),
  };
}

async function resolveTemplate(
  ctx: OpContext,
  key: string,
): Promise<CampaignTemplate & { template_key: string | null }> {
  const builtin = findBuiltinTemplate(key);
  if (builtin) return { ...builtin, template_key: builtin.key };
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select()
    .from(templates)
    .where(
      and(
        eq(templates.id, key),
        eq(templates.kind, "campaign"),
        or(eq(templates.workspace_id, workspace.id), isNull(templates.workspace_id)),
      ),
    );
  if (!row) {
    throw new OpenOutboundError("not_found", `Template ${key} not found.`, {
      hint: `Use a built-in key (${BUILTIN_TEMPLATES.map((t) => t.key).join(", ")}) or a saved template id from get_campaigns action templates.`,
      details: { template: key },
    });
  }
  const content = row.content as Partial<CampaignTemplate>;
  return {
    key: row.id,
    name: row.name,
    description: row.description ?? "",
    goal: content.goal ?? "meeting",
    why: content.why ?? "",
    settings: content.settings ?? {},
    steps: content.steps ?? [],
    template_key: null,
  };
}

export const listCampaigns = defineOperation({
  id: "campaigns.list",
  summary: "List campaigns with status and headline stats",
  description:
    "Lists the workspace's campaigns, newest first, with status, priority, review level and cached counters (enrolled, sent, replies, meetings). Use it to find a campaign id or compare campaigns at a glance. For one campaign's steps, settings and fresh per-step stats use campaigns.get (get_campaigns action get). Counters are cached and refreshed within about a minute of activity.",
  effect: "read",
  input: paginationInput.extend({
    status: z.array(z.enum(CAMPAIGN_STATUSES)).optional().describe("Only these statuses"),
    query: z.string().max(200).optional().describe("Text in the campaign name"),
  }),
  output: paginated(campaignSummaryOutput),
  http: { method: "GET", path: "/v1/campaigns" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Active campaigns", input: { status: ["active"] } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const conditions = [eq(campaigns.workspace_id, workspace.id)];
    if (input.status?.length) conditions.push(inArray(campaigns.status, input.status));
    if (input.query) conditions.push(ilike(campaigns.name, `%${input.query}%`));
    if (input.cursor) {
      const cursor = decodeCursor<{ id: string }>(input.cursor);
      conditions.push(lt(campaigns.id, String(cursor.id)));
    }
    const rows = await ctx.db
      .select({
        campaign: campaigns,
        // Qualified by hand: drizzle leaves single-table column references unqualified.
        step_count: sql<number>`(select count(*)::int from ${campaign_steps} where ${campaign_steps}.campaign_id = ${campaigns}.id)`,
      })
      .from(campaigns)
      .where(and(...conditions))
      .orderBy(desc(campaigns.id))
      .limit(input.limit + 1);
    return toPage(
      rows,
      input.limit,
      (row) => ({ id: row.campaign.id }),
      (row) => toCampaignSummary(row.campaign, Number(row.step_count)),
    );
  },
});

export const getCampaign = defineOperation({
  id: "campaigns.get",
  summary: "Get a campaign with steps, settings and stats",
  description:
    "Returns one campaign with its effective settings (defaults filled), ordered steps with configs, enrollment counts by status and fresh counters overall and per step and A/B variant. Use it before editing a campaign or to judge how a sequence performs. To see the individual people use campaigns.enrollments; to see drafts and sent messages use manage_messages. Stats are computed on each call, so avoid calling it in tight loops.",
  effect: "read",
  input: z.object({ campaign_id: campaignId }),
  output: campaignDetailOutput,
  http: { method: "GET", path: "/v1/campaigns/:campaign_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "One campaign", input: { campaign_id: EXAMPLE_CAMPAIGN_ID } }],
  handler: (ctx, input) => campaignDetail(ctx, input.campaign_id),
});

export const createCampaign = defineOperation({
  id: "campaigns.create",
  summary: "Create a campaign from a template or from steps",
  description:
    "Creates a draft campaign with its own settings, offer and steps, from a built-in template (signal_based_email_4, email_linkedin_6, local_business_3, event_follow_up, re_engage_lost), a saved template id, or explicit steps. Use it to start any new sequence; then enroll leads, preview drafts and launch. Do not use it to change an existing campaign (use campaigns.update). Nothing is sent until the campaign is launched, and the review level defaults to the workspace default.",
  effect: "write",
  input: z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    goal: z.enum(CAMPAIGN_GOALS).optional().describe("Default meeting (or the template's goal)"),
    template: z
      .string()
      .optional()
      .describe(
        "Built-in template key or a saved template id (tpl_...); steps and settings start from it",
      ),
    offer_id: z.string().optional().describe("Offer the messages sell (off_...)"),
    icp_id: z.string().optional(),
    settings: settingsInput.optional(),
    steps: z
      .array(stepInput)
      .max(30)
      .optional()
      .describe("Steps in order (replace the template's steps when both are given)"),
  }),
  output: campaignDetailOutput,
  http: { method: "POST", path: "/v1/campaigns" },
  dryRun: "none",
  idempotent: false,
  workspace: "required",
  examples: [
    {
      title: "From the email template",
      input: {
        name: "Dental groups, Q4",
        template: "signal_based_email_4",
        offer_id: EXAMPLE_OFFER_ID,
        settings: { senders: { mailbox_ids: [EXAMPLE_MAILBOX_ID] }, daily_new_leads: 15 },
      },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const template = input.template ? await resolveTemplate(ctx, input.template) : null;
    const rawSteps: StepInput[] | undefined = input.steps ?? template?.steps;
    if (!rawSteps || rawSteps.length === 0) {
      throw new OpenOutboundError("validation_failed", "A campaign needs steps or a template.", {
        hint: "Pass template (for example signal_based_email_4) or steps. See get_campaigns action templates.",
      });
    }
    const steps = validateSteps(z.array(stepInput).parse(rawSteps));
    const workspaceSettings = parseWorkspaceSettings(workspace.settings);
    let merged = mergeSettings(
      (template?.settings ?? {}) as Record<string, unknown>,
      input.settings ?? {},
    );
    if (merged.review_level === undefined) {
      merged = { ...merged, review_level: workspaceSettings.approvals.default_review_level };
    }
    const settings = validateSettings(merged);
    await validateReferences(ctx, settings, {
      offerId: input.offer_id ?? null,
      icpId: input.icp_id ?? null,
    });
    const [campaign] = await ctx.db
      .insert(campaigns)
      .values({
        workspace_id: workspace.id,
        name: input.name,
        description: input.description ?? template?.description ?? null,
        status: "draft",
        goal: input.goal ?? template?.goal ?? "meeting",
        offer_id: input.offer_id ?? null,
        icp_id: input.icp_id ?? null,
        settings,
        template_key: template?.template_key ?? null,
        created_by: actorRef(ctx.principal),
      })
      .returning();
    if (!campaign) throw new Error("campaign insert returned no row");
    await insertSteps(ctx, campaign, steps);
    return campaignDetail(ctx, campaign.id);
  },
});

/**
 * Replaces the steps of a campaign that may have enrollments mid-sequence: steps passed with an
 * `id` keep their identity (their runs and messages), others are new, missing ones are removed.
 * In-progress enrollments move to the new position of the step they were on (or to the step
 * after the last surviving step they passed), so edits only affect future steps.
 */
async function replaceStepsKeepingProgress(
  ctx: OpContext,
  campaign: Campaign,
  current: CampaignStep[],
  next: NormalizedStep[],
): Promise<void> {
  const byId = new Map(current.map((step) => [step.id, step]));
  for (const step of next) {
    if (step.id && !byId.has(step.id)) {
      throw invalid(`Step ${step.id} does not belong to campaign ${campaign.id}.`, {
        step_id: step.id,
      });
    }
  }
  const newPosition = new Map<string, number>();
  next.forEach((step, position) => {
    if (step.id) newPosition.set(step.id, position);
  });
  const mapPosition = (old: number): number => {
    const oldStep = current[old];
    if (oldStep && newPosition.has(oldStep.id)) return newPosition.get(oldStep.id) ?? 0;
    let after = 0;
    for (const step of current) {
      if (step.position < old && newPosition.has(step.id)) {
        after = Math.max(after, (newPosition.get(step.id) ?? 0) + 1);
      }
    }
    return after;
  };
  const inProgress = await ctx.db
    .select({
      id: enrollments.id,
      current_step: enrollments.current_step,
      status: enrollments.status,
    })
    .from(enrollments)
    .where(and(eq(enrollments.campaign_id, campaign.id), inArray(enrollments.status, IN_PROGRESS)));

  await ctx.db.transaction(async (tx) => {
    await tx
      .update(campaign_steps)
      .set({ position: sql`-1 - ${campaign_steps.position}` })
      .where(eq(campaign_steps.campaign_id, campaign.id));
    const keep = new Set<string>();
    for (const [position, step] of next.entries()) {
      if (step.id) {
        keep.add(step.id);
        await tx
          .update(campaign_steps)
          .set({
            position,
            type: step.type,
            delay_days: step.delay_days,
            delay_hours: step.delay_hours,
            config: step.config,
          })
          .where(eq(campaign_steps.id, step.id));
      } else {
        await tx.insert(campaign_steps).values({
          campaign_id: campaign.id,
          workspace_id: campaign.workspace_id,
          position,
          type: step.type,
          delay_days: step.delay_days,
          delay_hours: step.delay_hours,
          config: step.config,
        });
      }
    }
    const removed = current.filter((step) => !keep.has(step.id)).map((step) => step.id);
    if (removed.length > 0)
      await tx.delete(campaign_steps).where(inArray(campaign_steps.id, removed));
    for (const enrollment of inProgress) {
      if (enrollment.status === "queued") continue;
      const mapped = mapPosition(enrollment.current_step);
      if (mapped !== enrollment.current_step) {
        await tx
          .update(enrollments)
          .set({ current_step: mapped })
          .where(eq(enrollments.id, enrollment.id));
      }
    }
  });
}

/** What a campaign update changes (the campaigns.update input without the id). */
export interface CampaignUpdate {
  name?: string;
  description?: string | null;
  goal?: CampaignGoal;
  offer_id?: string | null;
  icp_id?: string | null;
  /** Deep-merged into the stored settings. */
  settings?: Record<string, unknown>;
  /** Stored as the whole settings instead of merging (an undo restores earlier settings). */
  replace_settings?: Record<string, unknown>;
  /** The full new step list; kept steps carry their id so people keep their place. */
  steps?: Array<z.output<typeof stepInput>>;
}

/** A review level change that waits for a person (see review-level.ts). */
export interface HeldReviewLevel {
  approval_id: string;
  from: ReviewLevel;
  to: ReviewLevel;
}

/** A LinkedIn comment step kept at review `always` until a person approves `level`. */
export interface HeldCommentReview {
  approval_id: string;
  step_id: string;
  position: number;
}

function commentReview(config: unknown): "always" | "level" {
  return (config as { review?: unknown } | null)?.review === "level" ? "level" : "always";
}

/**
 * Comment steps of a new step list that would follow the campaign's review level although they
 * did not before (`review: "always"` is the default): set back to `always`. Returns their
 * positions. A step keeps `level` only when the same step already had it.
 */
function holdCommentReviews(steps: NormalizedStep[], before: readonly CampaignStep[]): number[] {
  const held: number[] = [];
  for (const [position, step] of steps.entries()) {
    if (step.type !== "linkedin_comment" || commentReview(step.config) !== "level") continue;
    const same = before.find((old) => old.id === step.id);
    if (same && commentReview(same.config) === "level") continue;
    step.config = { ...step.config, review: "always" } as typeof step.config;
    held.push(position);
  }
  return held;
}

/**
 * Applies an approved `review_level` request for a comment step: its comments follow the
 * campaign's review level from now on. Recorded in the change log like any campaign update.
 */
export async function lowerCommentReview(ctx: OpContext, stepId: string): Promise<string> {
  const workspace = requireWorkspace(ctx);
  const [step] = await ctx.db
    .select()
    .from(campaign_steps)
    .where(and(eq(campaign_steps.workspace_id, workspace.id), eq(campaign_steps.id, stepId)));
  if (!step) return "The step no longer exists; nothing changed.";
  if (step.type !== "linkedin_comment") {
    return "The step is no longer a LinkedIn comment step; nothing changed.";
  }
  const loaded = await loadCampaign(ctx, step.campaign_id);
  const { campaign } = loaded;
  if (campaign.status === "archived" || campaign.status === "completed") {
    return `The campaign is ${campaign.status}; nothing changed.`;
  }
  const before = campaignSnapshot(campaign, loaded.steps);
  await ctx.db
    .update(campaign_steps)
    .set({ config: { ...step.config, review: "level" } as typeof step.config })
    .where(eq(campaign_steps.id, step.id));
  const after = campaignSnapshot(campaign, await getSteps(ctx.db, campaign.id));
  await recordChange(ctx, {
    area: "campaign",
    targetId: campaign.id,
    operation: "campaigns.update",
    before,
    after: withStableSteps(before, after),
  });
  return `The comments of step ${step.position + 1} of "${campaign.name}" now follow the campaign's review level (${loaded.settings.review_level}).`;
}

/**
 * Applies a campaign update: validates settings and references, replaces the steps (keeping
 * progress on campaigns with enrollments) and records the change in the change log under
 * `operation` (default "campaigns.update"). campaigns.update, undo and A/B winners use it.
 * Lowering the review level is a gate: unless the caller is a person holding approve (or
 * `approved` says an approval is being applied), the campaign keeps its level, an approval of
 * kind review_level is requested and returned as `held`, and the rest applies at once. A
 * LinkedIn comment step going from review `always` to `level` is lowered review too: the step
 * keeps `always` and a review_level approval naming it is returned in `heldSteps`.
 */
export async function applyCampaignUpdate(
  ctx: OpContext,
  campaignId: string,
  input: CampaignUpdate,
  options: { operation?: string; approved?: boolean } = {},
): Promise<{ held: HeldReviewLevel | null; heldSteps: HeldCommentReview[] }> {
  const loaded = await loadCampaign(ctx, campaignId);
  const { campaign } = loaded;
  if (campaign.status === "archived" || campaign.status === "completed") {
    throw new OpenOutboundError("conflict", `Campaign ${campaign.name} is ${campaign.status}.`, {
      hint: "Duplicate it with create_campaign action duplicate and edit the copy.",
      details: { campaign_id: campaign.id, status: campaign.status },
    });
  }
  let settings = input.replace_settings
    ? validateSettings(input.replace_settings)
    : input.settings
      ? validateSettings(
          mergeSettings(campaign.settings as Record<string, unknown>, input.settings),
        )
      : (campaign.settings as CampaignSettingsInput);
  const fromLevel = loaded.settings.review_level;
  const toLevel = parseCampaignSettings(settings).review_level;
  const ask = !options.approved && mustRequestApproval(ctx.principal);
  const holdLevel = ask && lowersReviewLevel(fromLevel, toLevel);
  if (holdLevel) settings = { ...settings, review_level: fromLevel };
  let heldPositions: number[] = [];
  const offerId = input.offer_id === undefined ? campaign.offer_id : input.offer_id;
  const icpId = input.icp_id === undefined ? campaign.icp_id : input.icp_id;
  await validateReferences(ctx, settings, {
    offerId: input.offer_id === undefined ? null : offerId,
    icpId: input.icp_id === undefined ? null : icpId,
  });
  if (input.steps) {
    const steps = validateSteps(input.steps);
    if (ask) heldPositions = holdCommentReviews(steps, loaded.steps);
    const [started] = await ctx.db
      .select({ n: count() })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.campaign_id, campaign.id),
          inArray(enrollments.status, [
            "active",
            "paused",
            "waiting_review",
            "completed",
            "stopped",
            "failed",
          ]),
        ),
      );
    if (campaign.status === "draft" && Number(started?.n ?? 0) === 0) {
      await ctx.db.delete(campaign_steps).where(eq(campaign_steps.campaign_id, campaign.id));
      await insertSteps(ctx, campaign, steps);
    } else {
      await replaceStepsKeepingProgress(ctx, campaign, loaded.steps, steps);
    }
  }
  const [updated] = await ctx.db
    .update(campaigns)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.goal !== undefined ? { goal: input.goal } : {}),
      offer_id: offerId,
      icp_id: icpId,
      settings,
    })
    .where(eq(campaigns.id, campaign.id))
    .returning();
  if (!updated) return { held: null, heldSteps: [] };
  const stored = input.steps ? await getSteps(ctx.db, campaign.id) : loaded.steps;
  const before = campaignSnapshot(campaign, loaded.steps);
  const after = campaignSnapshot(updated, stored);
  await recordChange(ctx, {
    area: "campaign",
    targetId: campaign.id,
    operation: options.operation ?? "campaigns.update",
    before,
    after: withStableSteps(before, after),
  });
  const heldSteps: HeldCommentReview[] = [];
  for (const position of heldPositions) {
    const step = stored.find((row) => row.position === position);
    if (!step) continue;
    const level = parseCampaignSettings(settings).review_level;
    const approvalId = await requestCommentReviewApproval(ctx, updated, step, level);
    heldSteps.push({ approval_id: approvalId, step_id: step.id, position });
  }
  if (!holdLevel) return { held: null, heldSteps };
  const approvalId = await requestReviewLevelApproval(ctx, updated, fromLevel, toLevel);
  return { held: { approval_id: approvalId, from: fromLevel, to: toLevel }, heldSteps };
}

export const updateCampaign = defineOperation({
  id: "campaigns.update",
  summary: "Change a campaign's settings, offer or steps",
  description:
    "Updates name, goal, offer, ICP, settings (deep-merged: pass only what changes) and/or the whole step list; use it to tune review level, senders, schedule, daily volume, writing instructions or stop rules. On campaigns with enrollments, pass each kept step's id so people mid-sequence keep their place; edits only affect steps they have not reached yet. Lowering the review level (every, then first, then unsure), or switching a LinkedIn comment step from review always to level, needs a person holding the approve scope: anyone else gets an approval of kind review_level (awaiting_approval; a step's names the step, which keeps always meanwhile) while the rest of the update applies at once. Archived and completed campaigns cannot be edited (duplicate them instead).",
  effect: "write",
  input: z.object({
    campaign_id: campaignId,
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    goal: z.enum(CAMPAIGN_GOALS).optional(),
    offer_id: z.string().nullable().optional(),
    icp_id: z.string().nullable().optional(),
    settings: settingsInput.optional(),
    steps: z
      .array(stepInput)
      .max(30)
      .optional()
      .describe("The full new step list (include ids of steps to keep)"),
  }),
  output: z.union([campaignDetailOutput, awaitingApprovalOutput]),
  http: { method: "PATCH", path: "/v1/campaigns/:campaign_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Review every message and slow down",
      input: {
        campaign_id: EXAMPLE_CAMPAIGN_ID,
        settings: { review_level: "every", daily_new_leads: 10 },
      },
    },
  ],
  handler: async (ctx, input) => {
    const { campaign_id, ...update } = input;
    const { held, heldSteps } = await applyCampaignUpdate(ctx, campaign_id, update);
    const waits = [
      ...(held
        ? [
            `Lowering the review level from ${held.from} to ${held.to} waits for a person with the approve scope (review_items); the campaign keeps ${held.from} until then.`,
          ]
        : []),
      ...heldSteps.map(
        (step) =>
          `Switching LinkedIn comment step ${step.position + 1} (${step.step_id}) to review level waits for a person with the approve scope (approval ${step.approval_id}); every comment of it is still reviewed until then.`,
      ),
    ];
    const first = held?.approval_id ?? heldSteps[0]?.approval_id;
    if (first) {
      return awaitingApproval(first, `${waits.join(" ")} The rest of this update is applied.`);
    }
    return campaignDetail(ctx, campaign_id);
  },
});

export const duplicateCampaign = defineOperation({
  id: "campaigns.duplicate",
  summary: "Copy a campaign (settings and steps) as a new draft",
  description:
    "Creates a new draft campaign with the same goal, offer, ICP, settings and steps, without enrollments, messages or stats. Use it to iterate on a live campaign (A/B a whole sequence) or to reuse a finished one. To reuse across workspaces or later, save_as_template is better. The copy is a draft: enroll and launch it separately.",
  effect: "write",
  input: z.object({
    campaign_id: campaignId,
    name: z.string().min(1).max(200).optional().describe("Default: 'Copy of <name>'"),
  }),
  output: campaignDetailOutput,
  http: { method: "POST", path: "/v1/campaigns/:campaign_id/duplicate" },
  dryRun: "none",
  idempotent: false,
  workspace: "required",
  examples: [
    { title: "Copy", input: { campaign_id: EXAMPLE_CAMPAIGN_ID, name: "Dental groups, Q1" } },
  ],
  handler: async (ctx, input) => {
    const loaded = await loadCampaign(ctx, input.campaign_id);
    const source = loaded.campaign;
    const [copy] = await ctx.db
      .insert(campaigns)
      .values({
        workspace_id: source.workspace_id,
        name: input.name ?? `Copy of ${source.name}`,
        description: source.description,
        status: "draft",
        goal: source.goal,
        offer_id: source.offer_id,
        icp_id: source.icp_id,
        settings: source.settings,
        template_key: source.template_key,
        created_by: actorRef(ctx.principal),
      })
      .returning();
    if (!copy) throw new Error("campaign insert returned no row");
    await insertSteps(
      ctx,
      copy,
      loaded.steps.map((step) => ({
        type: step.type,
        delay_days: step.delay_days,
        delay_hours: step.delay_hours,
        config: step.config,
      })),
    );
    return campaignDetail(ctx, copy.id);
  },
});

export const deleteCampaign = defineOperation({
  id: "campaigns.delete",
  summary: "Delete a draft campaign, or archive one that has history",
  description:
    "Deletes a draft campaign that never sent anything; any other campaign is archived instead (its running enrollments stop, history and stats stay for reports). Use it to clean up. To only halt sending, use launch_campaign action pause or stop instead. Deletion cannot be undone.",
  effect: "destructive",
  input: z.object({ campaign_id: campaignId }),
  output: z.object({
    campaign_id: z.string(),
    result: z.enum(["deleted", "archived"]),
    stopped_enrollments: z.number(),
  }),
  http: { method: "DELETE", path: "/v1/campaigns/:campaign_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Delete a draft", input: { campaign_id: EXAMPLE_CAMPAIGN_ID } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const loaded = await loadCampaign(ctx, input.campaign_id);
    const { campaign } = loaded;
    const [sent] = await ctx.db
      .select({ n: count() })
      .from(messages)
      .where(
        and(
          eq(messages.workspace_id, workspace.id),
          eq(messages.campaign_id, campaign.id),
          inArray(messages.status, ["scheduled", "sending", "unknown", "sent", "bounced"]),
        ),
      );
    if (campaign.status === "draft" && Number(sent?.n ?? 0) === 0) {
      await ctx.db.delete(campaigns).where(eq(campaigns.id, campaign.id));
      return { campaign_id: campaign.id, result: "deleted" as const, stopped_enrollments: 0 };
    }
    const running = await ctx.db
      .select({ id: enrollments.id })
      .from(enrollments)
      .where(
        and(eq(enrollments.campaign_id, campaign.id), inArray(enrollments.status, IN_PROGRESS)),
      );
    const stopped = await stopEnrollments(ctx, running, "campaign_archived");
    await ctx.db
      .update(campaigns)
      .set({ status: "archived", completed_at: campaign.completed_at ?? ctx.clock.now() })
      .where(eq(campaigns.id, campaign.id));
    return { campaign_id: campaign.id, result: "archived" as const, stopped_enrollments: stopped };
  },
});

const templateOutput = z.object({
  key: z.string().describe("Pass as `template` to campaigns.create"),
  name: z.string(),
  description: z.string(),
  source: z.enum(["builtin", "saved"]),
  goal: z.enum(CAMPAIGN_GOALS),
  why: z.string(),
  steps: z.array(
    z.object({
      position: z.number(),
      type: z.string(),
      delay_days: z.number(),
      delay_hours: z.number(),
      config: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});

export const listTemplates = defineOperation({
  id: "campaigns.templates",
  summary: "List campaign templates (built-in and saved)",
  description:
    "Lists the five built-in sequences from the playbook (signal-based email, email plus LinkedIn, local business, event follow-up, re-engage lost) and templates saved in this workspace, with their steps and timing. Use it before creating a campaign to pick a starting point. Pass the key as `template` to campaigns.create. Detailed format includes each step's full config.",
  effect: "read",
  input: paginationInput,
  output: paginated(templateOutput),
  http: { method: "GET", path: "/v1/campaign-templates" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "All templates", input: {} }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const detailed = ctx.request.responseFormat === "detailed";
    const saved = await ctx.db
      .select()
      .from(templates)
      .where(
        and(
          eq(templates.kind, "campaign"),
          or(eq(templates.workspace_id, workspace.id), isNull(templates.workspace_id)),
        ),
      )
      .orderBy(desc(templates.created_at));
    const all: Array<z.input<typeof templateOutput>> = [
      ...BUILTIN_TEMPLATES.map((template) => ({ ...template, source: "builtin" as const })),
      ...saved.map((row) => {
        const content = row.content as Partial<CampaignTemplate>;
        return {
          key: row.id,
          name: row.name,
          description: row.description ?? "",
          source: "saved" as const,
          goal: content.goal ?? "meeting",
          why: content.why ?? "",
          steps: content.steps ?? [],
          settings: content.settings ?? {},
        };
      }),
    ].map((template) => ({
      key: template.key,
      name: template.name,
      description: template.description,
      source: template.source,
      goal: template.goal,
      why: template.why,
      steps: (template.steps as StepInput[]).map((step, position) => ({
        position,
        type: step.type,
        delay_days: step.delay_days ?? 0,
        delay_hours: step.delay_hours ?? 0,
        ...(detailed ? { config: step.config ?? {} } : {}),
      })),
    }));
    const offset = input.cursor ? Number(decodeCursor<{ offset: number }>(input.cursor).offset) : 0;
    const rows = all.slice(offset, offset + input.limit + 1);
    return toPage(rows, input.limit, () => ({ offset: offset + input.limit }));
  },
});

export const saveAsTemplate = defineOperation({
  id: "campaigns.save_as_template",
  summary: "Save a campaign's steps and settings as a reusable template",
  description:
    "Stores the campaign's goal, steps and writing settings as a workspace template (senders are left out, so the template works with any mailbox). Use it when a sequence works and you want to reuse it for another segment. Create campaigns from it with campaigns.create (template = the returned id). Later edits to the campaign do not change the template.",
  effect: "write",
  input: z.object({
    campaign_id: campaignId,
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
  }),
  output: z.object({ template_id: z.string(), name: z.string(), step_count: z.number() }),
  http: { method: "POST", path: "/v1/campaigns/:campaign_id/save-as-template" },
  dryRun: "none",
  idempotent: false,
  workspace: "required",
  examples: [
    {
      title: "Save",
      input: { campaign_id: EXAMPLE_CAMPAIGN_ID, name: "Clinic owners, 3 touches" },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const loaded = await loadCampaign(ctx, input.campaign_id);
    const { senders: _senders, ...settings } = loaded.campaign.settings as Record<string, unknown>;
    const [row] = await ctx.db
      .insert(templates)
      .values({
        workspace_id: workspace.id,
        kind: "campaign",
        name: input.name,
        description: input.description ?? loaded.campaign.description,
        content: {
          goal: loaded.campaign.goal,
          why: "",
          settings,
          steps: loaded.steps.map((step) => {
            const { type: _type, ...config } = step.config as Record<string, unknown>;
            return {
              type: step.type,
              delay_days: step.delay_days,
              delay_hours: step.delay_hours,
              config,
            };
          }),
        },
      })
      .returning({ id: templates.id, name: templates.name });
    if (!row) throw new Error("template insert returned no row");
    return { template_id: row.id, name: row.name, step_count: loaded.steps.length };
  },
});

export const listEnrollments = defineOperation({
  id: "campaigns.enrollments",
  summary: "List the people in a campaign and where each one is",
  description:
    "Lists a campaign's enrollments with status (queued, active, paused, waiting_review, completed, stopped, failed), current step, next run time and stop or pause reason. Use it to see who is mid-sequence, who waits for review and why someone stopped. For the messages themselves use manage_messages action list. Newest enrollments first.",
  effect: "read",
  input: paginationInput.extend({
    campaign_id: campaignId,
    status: z.array(z.enum(ENROLLMENT_STATUSES)).optional(),
  }),
  output: paginated(enrollmentOutput),
  http: { method: "GET", path: "/v1/campaigns/:campaign_id/enrollments" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Waiting for review",
      input: { campaign_id: EXAMPLE_CAMPAIGN_ID, status: ["waiting_review"] },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    await loadCampaign(ctx, input.campaign_id);
    const conditions = [
      eq(enrollments.workspace_id, workspace.id),
      eq(enrollments.campaign_id, input.campaign_id),
    ];
    if (input.status?.length) conditions.push(inArray(enrollments.status, input.status));
    if (input.cursor) {
      conditions.push(lt(enrollments.id, String(decodeCursor<{ id: string }>(input.cursor).id)));
    }
    const rows = await ctx.db
      .select({ enrollment: enrollments, person: people })
      .from(enrollments)
      .leftJoin(people, eq(people.id, enrollments.person_id))
      .where(and(...conditions))
      .orderBy(desc(enrollments.id))
      .limit(input.limit + 1);
    return toPage(
      rows,
      input.limit,
      (row) => ({ id: row.enrollment.id }),
      (row) => toEnrollmentOutput(row.enrollment, row.person ? displayName(row.person) : null),
    );
  },
});
