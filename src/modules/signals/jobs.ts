/** Background jobs and schedules of the signals module. */
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import type { JobContext } from "../../core/context.js";
import { type BuiltinSchedule, defineJob } from "../../core/operation.js";
import { monitors } from "../../db/schema/index.js";
import { jobWorkspaceContext } from "../../runtime/context.js";
import { runMonitor } from "./monitors/runner.js";
import { nextMonitorRun } from "./monitors/schedule.js";
import { MONITOR_RUN_JOB } from "./operations/monitors.js";
import { recomputeCompanyIntent, recomputeWorkspaceIntent } from "./service.js";

export const MONITORS_TICK_JOB = "monitors.tick";
export const RECOMPUTE_INTENT_JOB = "signals.recompute_intent";

const workspaceIdField = z.string().min(1).optional();

/** Runs one monitor (manual run or due schedule). One attempt: paid calls are never repeated. */
export const monitorRunJob = defineJob({
  name: MONITOR_RUN_JOB,
  payload: z.object({
    workspace_id: workspaceIdField,
    monitor_id: z.string().min(1),
    trigger: z.enum(["manual", "schedule"]).default("manual"),
  }),
  maxAttempts: 1,
  timeoutMs: 30 * 60_000,
  handler: async (jobCtx: JobContext, payload) => {
    const ctx = await jobWorkspaceContext(jobCtx, payload.workspace_id);
    if (!ctx?.workspace) return { skipped: "workspace not found" };
    const [monitor] = await ctx.db
      .select()
      .from(monitors)
      .where(and(eq(monitors.workspace_id, ctx.workspace.id), eq(monitors.id, payload.monitor_id)));
    if (!monitor) return { skipped: "monitor not found" };
    if (payload.trigger === "schedule" && !monitor.enabled) return { skipped: "monitor disabled" };
    await ctx.setProgress({ stage: "collecting", done: 0 });
    const summary = await runMonitor(ctx, monitor, {
      trigger: payload.trigger,
      signal: ctx.job.signal,
      jobId: ctx.job.id,
      onProgress: (done, total) =>
        ctx.setProgress({
          stage: "collecting",
          done,
          total,
          message: `Checked ${done} of ${total} companies`,
        }),
    });
    return {
      monitor_id: monitor.id,
      status: summary.status,
      companies_checked: summary.companies_checked,
      signals_new: summary.signals_new,
      by_key: summary.by_key,
      credits_used: summary.credits_used,
      stopped: summary.stopped,
      failures: summary.failures,
      window_moved: summary.window_moved,
    };
  },
});

/**
 * Every 5 minutes per workspace: enqueues the monitors whose next run is due and moves their
 * next_run_at forward. Paused workspaces collect nothing on schedule.
 */
export const monitorsTickJob = defineJob({
  name: MONITORS_TICK_JOB,
  payload: z.object({ workspace_id: workspaceIdField }),
  maxAttempts: 2,
  handler: async (jobCtx: JobContext, payload) => {
    const ctx = await jobWorkspaceContext(jobCtx, payload.workspace_id);
    if (!ctx?.workspace) return { skipped: "workspace not found" };
    if (ctx.workspace.status !== "active") return { skipped: `workspace ${ctx.workspace.status}` };
    const now = ctx.clock.now();
    const due = await ctx.db
      .select()
      .from(monitors)
      .where(
        and(
          eq(monitors.workspace_id, ctx.workspace.id),
          eq(monitors.enabled, true),
          or(isNull(monitors.next_run_at), lte(monitors.next_run_at, now)),
        ),
      );
    let enqueued = 0;
    for (const monitor of due) {
      const next = nextMonitorRun(monitor.schedule, ctx.workspace.timezone, now);
      // A monitor without a next run was never scheduled: schedule it, do not run it late.
      if (monitor.next_run_at) {
        await ctx.jobs.enqueue(
          MONITOR_RUN_JOB,
          { workspace_id: ctx.workspace.id, monitor_id: monitor.id, trigger: "schedule" },
          { workspaceId: ctx.workspace.id, singletonKey: `${MONITOR_RUN_JOB}:${monitor.id}` },
        );
        enqueued += 1;
      }
      await ctx.db.update(monitors).set({ next_run_at: next }).where(eq(monitors.id, monitor.id));
    }
    return { due: due.length, enqueued };
  },
});

/** Re-scores company intent (nightly decay, definition changes, or a list of companies). */
export const recomputeIntentJob = defineJob({
  name: RECOMPUTE_INTENT_JOB,
  payload: z.object({
    workspace_id: workspaceIdField,
    company_ids: z.array(z.string().min(1)).max(1000).optional(),
  }),
  maxAttempts: 3,
  timeoutMs: 15 * 60_000,
  handler: async (jobCtx: JobContext, payload) => {
    const ctx = await jobWorkspaceContext(jobCtx, payload.workspace_id);
    if (!ctx?.workspace) return { skipped: "workspace not found" };
    if (payload.company_ids?.length) {
      for (const companyId of payload.company_ids) {
        await recomputeCompanyIntent(ctx, ctx.workspace.id, companyId);
      }
      return { companies: payload.company_ids.length };
    }
    return recomputeWorkspaceIntent(ctx, ctx.workspace.id);
  },
});

export const signalJobs = [monitorRunJob, monitorsTickJob, recomputeIntentJob];

export const signalSchedules: BuiltinSchedule[] = [
  {
    name: "signals.monitors_tick",
    cron: "*/5 * * * *",
    job: MONITORS_TICK_JOB,
    perWorkspace: true,
  },
  {
    name: "signals.intent_decay",
    cron: "30 3 * * *",
    job: RECOMPUTE_INTENT_JOB,
    perWorkspace: true,
  },
];
