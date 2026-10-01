import { and, asc, count, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import { z } from "zod";
import type { OpContext } from "../../../core/context.js";
import { defineJob } from "../../../core/operation.js";
import { parseCampaignSettings } from "../../../core/settings.js";
import { campaigns, type Enrollment, enrollments, workspaces } from "../../../db/schema/index.js";
import {
  IN_PROGRESS,
  PENDING_CLASSIFICATION,
  resumeEnrollments,
  stopAllowed,
  stopEnrollments,
} from "../control.js";
import { loadPeople } from "../people.js";
import { getSteps, type LoadedCampaign } from "../repo.js";
import { isChannelStep, stepDelayMs } from "../steps.js";
import { isValidTimeZone, startOfLocalDay } from "../timezones.js";
import { executeChannelStep } from "./channel-step.js";
import { executeFlowStep } from "./flow-steps.js";
import { advance, completePastLastStep, ensureRun, reschedule, type StepState } from "./state.js";

export const TICK_JOB = "campaigns.tick";
/** Enrollments processed per tick (the rest run on the next tick, priority first). */
export const TICK_BATCH = 200;
const ERROR_BACKOFF_MS = 15 * 60_000;

export interface TickResult {
  skipped?: string;
  resumed: number;
  activated: number;
  processed: number;
  errors: number;
  completed_campaigns: number;
}

function toLoaded(
  campaign: typeof campaigns.$inferSelect,
  steps: LoadedCampaign["steps"],
): LoadedCampaign {
  return { campaign, settings: parseCampaignSettings(campaign.settings), steps };
}

/** Paused enrollments whose pause ended: resume, or stop when a reply was never classified. */
async function resumeDuePauses(ctx: OpContext, workspaceId: string, now: Date): Promise<number> {
  const due = await ctx.db
    .select({ enrollment: enrollments, settings: campaigns.settings })
    .from(enrollments)
    .innerJoin(campaigns, eq(campaigns.id, enrollments.campaign_id))
    .where(
      and(
        eq(enrollments.workspace_id, workspaceId),
        eq(enrollments.status, "paused"),
        isNotNull(enrollments.paused_until),
        lte(enrollments.paused_until, now),
      ),
    );
  const toResume: Enrollment[] = [];
  const toStop: Enrollment[] = [];
  for (const row of due) {
    const settings = parseCampaignSettings(row.settings);
    if (
      row.enrollment.stop_reason === PENDING_CLASSIFICATION &&
      stopAllowed(settings, "replied", false)
    ) {
      toStop.push(row.enrollment);
    } else {
      toResume.push(row.enrollment);
    }
  }
  await stopEnrollments(ctx, toStop, "replied");
  return resumeEnrollments(ctx, toResume);
}

/** Moves queued enrollments to active, up to `daily_new_leads` per day in the campaign zone. */
async function activateQueued(ctx: OpContext, loaded: LoadedCampaign, now: Date): Promise<number> {
  const { campaign, settings, steps } = loaded;
  const first = steps[0];
  if (!first || settings.daily_new_leads <= 0) return 0;
  if (settings.schedule.start_at && new Date(settings.schedule.start_at) > now) return 0;
  if (settings.schedule.end_at && new Date(settings.schedule.end_at) < now) return 0;
  const zone = isValidTimeZone(settings.schedule.timezone) ? settings.schedule.timezone : "UTC";
  const dayStart = startOfLocalDay(now, zone);
  const [row] = await ctx.db
    .select({ n: count() })
    .from(enrollments)
    .where(and(eq(enrollments.campaign_id, campaign.id), gte(enrollments.activated_at, dayStart)));
  const quota = settings.daily_new_leads - Number(row?.n ?? 0);
  if (quota <= 0) return 0;
  const queued = await ctx.db
    .select({ id: enrollments.id })
    .from(enrollments)
    .where(and(eq(enrollments.campaign_id, campaign.id), eq(enrollments.status, "queued")))
    .orderBy(asc(enrollments.enrolled_at), asc(enrollments.id))
    .limit(quota);
  if (queued.length === 0) return 0;
  const activated = await ctx.db
    .update(enrollments)
    .set({
      status: "active",
      activated_at: now,
      current_step: 0,
      next_run_at: new Date(now.getTime() + stepDelayMs(first)),
    })
    .where(
      and(
        inArray(
          enrollments.id,
          queued.map((q) => q.id),
        ),
        eq(enrollments.status, "queued"),
      ),
    )
    .returning({ id: enrollments.id });
  return activated.length;
}

/**
 * Runs the enrollment's current step. Completes enrollments past the last step, waits for the
 * campaign start date, and dispatches by step type.
 */
export async function processEnrollment(
  ctx: OpContext,
  loaded: LoadedCampaign,
  enrollment: Enrollment,
  people: Awaited<ReturnType<typeof loadPeople>>,
): Promise<void> {
  const now = ctx.clock.now();
  const startAt = loaded.settings.schedule.start_at;
  if (startAt && new Date(startAt) > now) {
    await reschedule(
      ctx,
      { enrollment },
      new Date(startAt),
      enrollment.status === "waiting_review" ? "waiting_review" : "active",
    );
    return;
  }
  const record = people.get(enrollment.person_id);
  if (!record) {
    await stopEnrollments(ctx, [enrollment], "person_removed");
    return;
  }
  const step = loaded.steps[enrollment.current_step];
  if (!step) {
    // A step edit removed the steps it had left: it ends like any finished sequence.
    await completePastLastStep(ctx, loaded, enrollment, record.person.id);
    return;
  }
  const run = await ensureRun(ctx, enrollment, step);
  const state: StepState = {
    loaded,
    enrollment,
    step,
    run,
    person: record.person,
    company: record.company,
    now,
  };
  if (run.status === "done" || run.status === "skipped") {
    // Only after a step edit moved an executed step forward: never run a step twice.
    await advance(ctx, state, { anchor: now, outcome: run.status });
    return;
  }
  if (isChannelStep(step.type)) await executeChannelStep(ctx, state);
  else await executeFlowStep(ctx, state);
}

async function completeEndedCampaigns(
  ctx: OpContext,
  active: LoadedCampaign[],
  now: Date,
): Promise<number> {
  let completed = 0;
  for (const loaded of active) {
    const endAt = loaded.settings.schedule.end_at;
    if (!endAt || new Date(endAt) > now) continue;
    const [row] = await ctx.db
      .select({ n: count() })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.campaign_id, loaded.campaign.id),
          inArray(enrollments.status, IN_PROGRESS),
        ),
      );
    if (Number(row?.n ?? 0) > 0) continue;
    const updated = await ctx.db
      .update(campaigns)
      .set({ status: "completed", completed_at: now })
      .where(and(eq(campaigns.id, loaded.campaign.id), eq(campaigns.status, "active")))
      .returning({ id: campaigns.id });
    if (updated.length > 0) {
      completed += 1;
      await ctx.events.emit("campaign.completed", {
        subject: { type: "campaign", id: loaded.campaign.id },
        data: { campaign_id: loaded.campaign.id },
      });
    }
  }
  return completed;
}

/**
 * One sequencer pass for the context workspace: resume ended pauses, activate queued
 * enrollments per campaign (highest priority first), run due steps ordered by campaign priority
 * then due time, and complete campaigns past their end date. Paused workspaces and
 * paused/archived campaigns are skipped. Safe to run twice (every step is idempotent).
 */
export async function runTick(ctx: OpContext): Promise<TickResult> {
  const result: TickResult = {
    resumed: 0,
    activated: 0,
    processed: 0,
    errors: 0,
    completed_campaigns: 0,
  };
  const workspaceId = ctx.workspace?.id;
  if (!workspaceId) return { ...result, skipped: "no_workspace" };
  const [workspace] = await ctx.db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (workspace?.status !== "active") {
    return { ...result, skipped: "workspace_paused" };
  }
  const now = ctx.clock.now();
  result.resumed = await resumeDuePauses(ctx, workspace.id, now);

  const rows = await ctx.db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.workspace_id, workspace.id), eq(campaigns.status, "active")));
  const active: LoadedCampaign[] = [];
  for (const campaign of rows) active.push(toLoaded(campaign, await getSteps(ctx.db, campaign.id)));
  active.sort(
    (a, b) =>
      b.settings.priority - a.settings.priority ||
      a.campaign.created_at.getTime() - b.campaign.created_at.getTime(),
  );
  const byId = new Map(active.map((loaded) => [loaded.campaign.id, loaded]));

  for (const loaded of active) result.activated += await activateQueued(ctx, loaded, now);

  if (active.length > 0) {
    const due = await ctx.db
      .select()
      .from(enrollments)
      .where(
        and(
          eq(enrollments.workspace_id, workspace.id),
          inArray(enrollments.status, ["active", "waiting_review"]),
          inArray(
            enrollments.campaign_id,
            active.map((loaded) => loaded.campaign.id),
          ),
          isNotNull(enrollments.next_run_at),
          lte(enrollments.next_run_at, now),
        ),
      )
      .orderBy(asc(enrollments.next_run_at))
      .limit(TICK_BATCH * 3);
    due.sort((a, b) => {
      const pa = byId.get(a.campaign_id)?.settings.priority ?? 0;
      const pb = byId.get(b.campaign_id)?.settings.priority ?? 0;
      return pb - pa || (a.next_run_at?.getTime() ?? 0) - (b.next_run_at?.getTime() ?? 0);
    });
    const batch = due.slice(0, TICK_BATCH);
    const people = await loadPeople(
      ctx,
      batch.map((enrollment) => enrollment.person_id),
    );
    for (const enrollment of batch) {
      const loaded = byId.get(enrollment.campaign_id);
      if (!loaded) continue;
      try {
        await processEnrollment(ctx, loaded, enrollment, people);
        result.processed += 1;
      } catch (error) {
        result.errors += 1;
        ctx.log.error(
          {
            enrollment_id: enrollment.id,
            campaign_id: enrollment.campaign_id,
            error: error instanceof Error ? error.message : String(error),
          },
          "sequencer step failed",
        );
        await ctx.db
          .update(enrollments)
          .set({ next_run_at: new Date(now.getTime() + ERROR_BACKOFF_MS) })
          .where(eq(enrollments.id, enrollment.id));
      }
    }
  }
  result.completed_campaigns = await completeEndedCampaigns(ctx, active, now);
  return result;
}

export const tickJob = defineJob({
  name: TICK_JOB,
  payload: z.object({ workspace_id: z.string().optional() }).passthrough(),
  maxAttempts: 1,
  timeoutMs: 5 * 60_000,
  handler: async (ctx, payload) => {
    if (!ctx.workspace && payload.workspace_id) {
      const [workspace] = await ctx.db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, payload.workspace_id));
      if (!workspace) return { skipped: "no_workspace" };
      return runTick({ ...ctx, workspace });
    }
    return runTick(ctx);
  },
});
