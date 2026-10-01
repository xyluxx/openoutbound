import { and, count, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { stableHash } from "../../../brain/hash.js";
import { type OpContext, requireWorkspace } from "../../../core/context.js";
import { CAMPAIGN_STATUSES } from "../../../core/enums.js";
import { OpenOutboundError } from "../../../core/errors.js";
import { idSchema } from "../../../core/ids.js";
import {
  awaitingApproval,
  awaitingApprovalOutput,
  defineOperation,
  dryRun,
  dryRunOutput,
  isoDateTime,
} from "../../../core/operation.js";
import { parseWorkspaceSettings } from "../../../core/settings.js";
import { campaigns, enrollments } from "../../../db/schema/index.js";
import { mustRequestApproval } from "../../../runtime/approval-rule.js";
import { usesSandboxProviders } from "../../../runtime/providers.js";
import { IN_PROGRESS, stopEnrollments } from "../control.js";
import { activateCampaign, dailyAiCostUsd, launchChecklist } from "../launch.js";
import { type LoadedCampaign, loadCampaign } from "../repo.js";
import { EXAMPLE_CAMPAIGN_ID } from "../schemas.js";

/**
 * What a launch request covers: the campaign's settings (senders included), steps and offer,
 * and how many people are enrolled. The launch approval applies only while this is unchanged.
 */
export async function launchFingerprint(ctx: OpContext, loaded: LoadedCampaign): Promise<string> {
  const [row] = await ctx.db
    .select({ enrolled: count() })
    .from(enrollments)
    .where(
      and(
        eq(enrollments.campaign_id, loaded.campaign.id),
        inArray(enrollments.status, IN_PROGRESS),
      ),
    );
  return stableHash({
    settings: loaded.settings,
    steps: loaded.steps.map((step) => ({
      id: step.id,
      position: step.position,
      type: step.type,
      delay_days: step.delay_days,
      delay_hours: step.delay_hours,
      config: step.config,
    })),
    offer_id: loaded.campaign.offer_id,
    enrolled: row?.enrolled ?? 0,
  });
}

const campaignId = idSchema("cmp").describe("Campaign id (cmp_...)");

const checklistOutput = z.object({
  campaign_id: z.string(),
  ready: z.boolean(),
  items: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      status: z.enum(["pass", "fail", "warn"]),
      detail: z.string(),
      fix: z.string().optional(),
    }),
  ),
  estimates: z.object({
    queued: z.number(),
    in_progress: z.number(),
    daily_new_leads: z.number(),
    email_steps: z.number(),
    linkedin_steps: z.number(),
    ai_steps: z.number(),
    est_daily_emails: z.number(),
    mailbox_daily_capacity: z.number(),
    est_ai_cost_usd_per_lead: z.number(),
  }),
});

const statusOutput = z.object({
  campaign_id: z.string(),
  status: z.enum(CAMPAIGN_STATUSES),
  launched_at: isoDateTime().nullable().optional(),
  stopped_enrollments: z.number().optional(),
});

export const launchCampaign = defineOperation({
  id: "campaigns.launch",
  summary: "Launch a campaign (dry run shows the pre-launch checklist)",
  description:
    "Starts a draft or paused campaign: queued leads are activated up to daily_new_leads per day and messages follow the review level. Always run it with dry_run: true first to get the checklist (steps, senders and capacity, offer or instructions, leads, compliance, volume and AI cost estimates) with a fix for each problem. Unless the caller is a person holding the approve scope, the launch needs an approval when the workspace requires it (settings.approvals.agent_launch_requires_approval, on by default), and the caller gets an approval id instead of a launch; it launches the campaign only as the request showed it (a change to its settings, steps, offer, senders or enrolled people answers conflict: ask again). Launch fails while any checklist item fails.",
  effect: "send",
  input: z.object({ campaign_id: campaignId }),
  output: z.union([
    checklistOutput.extend({
      status: z.enum(CAMPAIGN_STATUSES),
      launched_at: isoDateTime().nullable(),
    }),
    dryRunOutput(checklistOutput),
    awaitingApprovalOutput,
  ]),
  http: { method: "POST", path: "/v1/campaigns/:campaign_id/launch" },
  dryRun: "supported",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Checklist first", input: { campaign_id: EXAMPLE_CAMPAIGN_ID } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const loaded = await loadCampaign(ctx, input.campaign_id);
    const { campaign } = loaded;
    if (campaign.status === "completed" || campaign.status === "archived") {
      throw new OpenOutboundError(
        "conflict",
        `Campaign ${campaign.name} is ${campaign.status} and cannot be launched.`,
        {
          hint: "Duplicate it with create_campaign action duplicate, then launch the copy.",
          details: { campaign_id: campaign.id, status: campaign.status },
        },
      );
    }
    const checklist = await launchChecklist(ctx, loaded);
    const summary = { campaign_id: campaign.id, ...checklist };
    if (ctx.request.dryRun) {
      const warnings = checklist.items
        .filter((item) => item.status !== "pass")
        .map((item) => `${item.label}: ${item.detail}${item.fix ? ` Fix: ${item.fix}` : ""}`);
      const daily = dailyAiCostUsd(checklist.estimates);
      return dryRun(summary, {
        warnings,
        // A sandbox's fake AI brain costs nothing: show zero, and what it would cost for real.
        estimatedCost: usesSandboxProviders(workspace, "brain")
          ? {
              usd: 0,
              note: `Sandbox: the fake AI brain costs nothing. With a real AI brain this would cost about $${daily.toFixed(2)} a day at the daily_new_leads pace (writing and checking).`,
            }
          : {
              usd: daily,
              note: "Rough AI cost per day at the daily_new_leads pace (writing and checking).",
            },
      });
    }
    if (campaign.status === "active") {
      return { ...summary, status: campaign.status, launched_at: campaign.launched_at };
    }
    if (!checklist.ready) {
      const failures = checklist.items.filter((item) => item.status === "fail");
      throw new OpenOutboundError(
        "validation_failed",
        `Not ready to launch: ${failures.map((item) => `${item.label} (${item.detail})`).join("; ")}`,
        {
          hint:
            failures[0]?.fix ??
            "Run launch_campaign with dry_run: true to see the checklist and fixes.",
          details: { checklist: checklist.items },
        },
      );
    }
    const settings = parseWorkspaceSettings(workspace.settings);
    if (mustRequestApproval(ctx.principal) && settings.approvals.agent_launch_requires_approval) {
      const { id } = await ctx.approvals.request({
        kind: "campaign_launch",
        title: `Launch campaign "${campaign.name}"`,
        summary: `${checklist.estimates.in_progress} lead(s) enrolled, up to ${checklist.estimates.daily_new_leads} new leads a day, ${checklist.estimates.email_steps} email step(s) and ${checklist.estimates.linkedin_steps} LinkedIn step(s). Review level: ${loaded.settings.review_level}.`,
        payload: {
          campaign_id: campaign.id,
          name: campaign.name,
          checklist: checklist.items,
          estimates: checklist.estimates,
          fingerprint: await launchFingerprint(ctx, loaded),
        },
        target: { type: "campaign", id: campaign.id },
        supersede: true,
      });
      return awaitingApproval(
        id,
        `A person with the approve scope must approve launching "${campaign.name}" (review_items). Nothing is sent until then.`,
      );
    }
    const result = await activateCampaign(ctx, campaign.id);
    if (!result.launched) {
      throw new OpenOutboundError("conflict", `Not launched: ${result.reason ?? "unknown"}`, {
        hint: "Run launch_campaign with dry_run: true to see the checklist.",
      });
    }
    const [row] = await ctx.db
      .select({ launched_at: campaigns.launched_at })
      .from(campaigns)
      .where(eq(campaigns.id, campaign.id));
    return { ...summary, status: "active" as const, launched_at: row?.launched_at ?? null };
  },
});

export const pauseCampaign = defineOperation({
  id: "campaigns.pause",
  summary: "Pause a campaign (nothing new is sent until it resumes)",
  description:
    "Pauses an active campaign: the sequencer stops activating leads and running steps for it; enrollments keep their place. Use it to fix copy or targeting without losing progress. Emails and LinkedIn actions already queued wait until the campaign resumes; answers to prospects in the inbox still go out. To stop everything in the workspace use manage_workspaces action pause. Resume with launch_campaign action resume.",
  effect: "write",
  input: z.object({ campaign_id: campaignId }),
  output: statusOutput,
  http: { method: "POST", path: "/v1/campaigns/:campaign_id/pause" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Pause", input: { campaign_id: EXAMPLE_CAMPAIGN_ID } }],
  handler: async (ctx, input) => {
    const loaded = await loadCampaign(ctx, input.campaign_id);
    const { campaign } = loaded;
    if (campaign.status === "paused") return { campaign_id: campaign.id, status: campaign.status };
    if (campaign.status !== "active") {
      throw new OpenOutboundError(
        "conflict",
        `Only active campaigns can be paused (this one is ${campaign.status}).`,
        {
          hint: "Check the status with get_campaigns action get.",
        },
      );
    }
    await ctx.db.update(campaigns).set({ status: "paused" }).where(eq(campaigns.id, campaign.id));
    await ctx.events.emit("campaign.paused", {
      subject: { type: "campaign", id: campaign.id },
      data: { campaign_id: campaign.id, reason: ctx.request.reason ?? null },
    });
    return { campaign_id: campaign.id, status: "paused" as const };
  },
});

export const resumeCampaign = defineOperation({
  id: "campaigns.resume",
  summary: "Resume a paused campaign",
  description:
    "Resumes a paused campaign; due steps run on the next sequencer tick (within a minute) and leads keep their place. Use it after pause_campaign. For a draft campaign use launch instead (it runs the checklist). The workspace itself must not be paused for anything to send.",
  effect: "send",
  input: z.object({ campaign_id: campaignId }),
  output: statusOutput,
  http: { method: "POST", path: "/v1/campaigns/:campaign_id/resume" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Resume", input: { campaign_id: EXAMPLE_CAMPAIGN_ID } }],
  handler: async (ctx, input) => {
    const loaded = await loadCampaign(ctx, input.campaign_id);
    const { campaign } = loaded;
    if (campaign.status === "active") return { campaign_id: campaign.id, status: campaign.status };
    if (campaign.status !== "paused") {
      throw new OpenOutboundError(
        "conflict",
        `Only paused campaigns can be resumed (this one is ${campaign.status}).`,
        {
          hint: "Launch drafts with launch_campaign action launch.",
        },
      );
    }
    await ctx.db.update(campaigns).set({ status: "active" }).where(eq(campaigns.id, campaign.id));
    await ctx.jobs.wake(`campaign_active:${campaign.id}`);
    return { campaign_id: campaign.id, status: "active" as const };
  },
});

async function endCampaign(
  ctx: Parameters<typeof pauseCampaign.handler>[0],
  id: string,
  status: "completed" | "archived",
  reason: string,
) {
  const loaded = await loadCampaign(ctx, id);
  const { campaign } = loaded;
  const running = await ctx.db
    .select({ id: enrollments.id })
    .from(enrollments)
    .where(and(eq(enrollments.campaign_id, campaign.id), inArray(enrollments.status, IN_PROGRESS)));
  const stopped = await stopEnrollments(ctx, running, reason);
  if (campaign.status !== status) {
    await ctx.db
      .update(campaigns)
      .set({ status, completed_at: campaign.completed_at ?? ctx.clock.now() })
      .where(eq(campaigns.id, campaign.id));
    if (status === "completed") {
      await ctx.events.emit("campaign.completed", {
        subject: { type: "campaign", id: campaign.id },
        data: { campaign_id: campaign.id },
      });
    }
  }
  return { campaign_id: campaign.id, status, stopped_enrollments: stopped };
}

export const stopCampaign = defineOperation({
  id: "campaigns.stop",
  summary: "Stop a campaign for good (every running enrollment ends)",
  description:
    "Ends the campaign: every queued, active, paused or waiting enrollment stops, pending drafts and approvals are cancelled, and the campaign is marked completed. Use it when a campaign is finished or harmful (bounces, complaints). To only hold sending, use pause instead. Stopped enrollments start the rest period (rest_days_after_campaign) before these people can join another campaign.",
  effect: "destructive",
  input: z.object({ campaign_id: campaignId }),
  output: statusOutput,
  http: { method: "POST", path: "/v1/campaigns/:campaign_id/stop" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Stop", input: { campaign_id: EXAMPLE_CAMPAIGN_ID } }],
  handler: (ctx, input) => endCampaign(ctx, input.campaign_id, "completed", "campaign_stopped"),
});

export const archiveCampaign = defineOperation({
  id: "campaigns.archive",
  summary: "Archive a campaign (stops it and hides it from active lists)",
  description:
    "Archives the campaign: running enrollments stop, pending drafts are cancelled, and history and stats stay for reports. Use it to tidy up finished or abandoned campaigns. Archived campaigns cannot be edited or launched; duplicate one to reuse it. Use stop instead when you still want it counted as completed.",
  effect: "destructive",
  input: z.object({ campaign_id: campaignId }),
  output: statusOutput,
  http: { method: "POST", path: "/v1/campaigns/:campaign_id/archive" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Archive", input: { campaign_id: EXAMPLE_CAMPAIGN_ID } }],
  handler: (ctx, input) => endCampaign(ctx, input.campaign_id, "archived", "campaign_archived"),
});
