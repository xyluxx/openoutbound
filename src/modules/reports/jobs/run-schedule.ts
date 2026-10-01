import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { JobContext } from "../../../core/context.js";
import { isOpenOutboundError, OpenOutboundError } from "../../../core/errors.js";
import { defineJob } from "../../../core/operation.js";
import {
  type ReportDelivery,
  type Report as ReportRow,
  reports,
  schedules,
  type Workspace,
} from "../../../db/schema/index.js";
import { jobWorkspaceContext } from "../../../runtime/context.js";
import { type NotifyInput, notify } from "../../../runtime/notify.js";
import { buildReport } from "../build-report.js";
import { headlineLines } from "../render/headlines.js";
import { REPORT_TITLES, renderMarkdown } from "../render/markdown.js";
import { parseStoredSchedule, REPORT_JOB_NAME, type StoredSchedule } from "../schedule-config.js";
import type { Report } from "../schemas.js";
import { summarizeReport } from "../summarize.js";
import { isValidTimeZone } from "../timezone.js";

export const runSchedulePayload = z.object({
  schedule_id: z.string(),
  workspace_id: z.string().optional(),
  /** Set by reports.schedules.run: runs even when the schedule is disabled. */
  manual: z.boolean().optional(),
});
export type RunSchedulePayload = z.infer<typeof runSchedulePayload>;

export type RunScheduleResult =
  | { status: "skipped"; reason: string }
  | {
      status: "delivered" | "stored";
      report_id: string;
      type: string;
      channels: number;
      summary: boolean;
      reused: boolean;
    };

interface StoredNotification {
  title: string;
  lines: string[];
}

/**
 * Scheduled report run (job `reports.run_schedule`, enqueued by the scheduler from the
 * `schedules` row): renders the report as markdown with an optional AI summary, stores a
 * `reports` row, emits `report.ready` and delivers through the runtime notify helper.
 * Idempotent per job: a retry reuses the report stored by an earlier attempt and only delivers
 * what was not delivered yet.
 */
export async function runScheduledReport(
  ctx: JobContext,
  payload: RunSchedulePayload,
): Promise<RunScheduleResult> {
  // A job acts only in its own workspace; an instance-level one gets a full context for it.
  const jobCtx = await jobWorkspaceContext(ctx, payload.workspace_id);
  const workspace = jobCtx?.workspace;
  if (!jobCtx || !workspace) return { status: "skipped", reason: "workspace_not_found" };
  if (workspace.status === "archived") return { status: "skipped", reason: "workspace_archived" };

  const [row] = await ctx.db
    .select()
    .from(schedules)
    .where(
      and(
        eq(schedules.id, payload.schedule_id),
        eq(schedules.workspace_id, workspace.id),
        eq(schedules.job_name, REPORT_JOB_NAME),
      ),
    );
  if (!row) return { status: "skipped", reason: "schedule_not_found" };
  if (!row.enabled && !payload.manual) return { status: "skipped", reason: "schedule_disabled" };
  const config = parseStoredSchedule(row);
  if (!config) return { status: "skipped", reason: "invalid_schedule_config" };

  const [previousAttempt] = await ctx.db
    .select()
    .from(reports)
    .where(
      and(
        eq(reports.workspace_id, workspace.id),
        sql`${reports.content}->>'job_id' = ${ctx.job.id}`,
      ),
    )
    .limit(1);

  let stored: ReportRow;
  let hasSummary: boolean;
  if (previousAttempt) {
    stored = previousAttempt;
    hasSummary = Boolean(previousAttempt.content.summary);
    const alreadyDelivered = previousAttempt.delivered_to.some((entry) => entry.ok);
    if (alreadyDelivered || config.channels.length === 0) {
      return {
        status: config.channels.length > 0 ? "delivered" : "stored",
        report_id: stored.id,
        type: stored.type,
        channels: previousAttempt.delivered_to.filter((entry) => entry.ok).length,
        summary: hasSummary,
        reused: true,
      };
    }
  } else {
    const created = await createReport(jobCtx, workspace, row.timezone, config);
    stored = created.row;
    hasSummary = created.summary;
  }

  if (config.channels.length === 0) {
    return {
      status: "stored",
      report_id: stored.id,
      type: stored.type,
      channels: 0,
      summary: hasSummary,
      reused: Boolean(previousAttempt),
    };
  }
  const delivered = await deliver(jobCtx, stored, config.channels);
  if (!delivered.some((entry) => entry.ok)) {
    // The report is stored; failing the job lets the retry deliver it again.
    throw new OpenOutboundError(
      "provider_error",
      `Report ${stored.id} is stored but could not be delivered: ${delivered[0]?.error ?? "unknown error"}`,
      {
        hint: "Check the channels with manage_notifications (action test); the job retries delivery.",
      },
    );
  }
  return {
    status: "delivered",
    report_id: stored.id,
    type: stored.type,
    channels: delivered.filter((entry) => entry.ok).length,
    summary: hasSummary,
    reused: Boolean(previousAttempt),
  };
}

async function createReport(
  ctx: JobContext,
  workspace: Workspace,
  timezone: string,
  config: StoredSchedule,
): Promise<{ row: ReportRow; summary: boolean }> {
  const request = {
    type: config.type,
    preset: config.period,
    timezone: isValidTimeZone(timezone) ? timezone : undefined,
    compare: config.compare,
    campaignId: config.campaign_id,
  };
  let report: Report;
  try {
    report = await buildReport(ctx, workspace, request);
  } catch (error) {
    if (!(isOpenOutboundError(error) && error.code === "not_found" && config.campaign_id))
      throw error;
    report = await buildReport(ctx, workspace, { ...request, campaignId: null });
    report = {
      ...report,
      notes: ["The scheduled campaign no longer exists; showing all campaigns.", ...report.notes],
    };
  }

  const summary = config.ai_summary
    ? await summarizeReport(ctx, report, { workspaceName: workspace.name, jobId: ctx.job.id })
    : null;
  if (summary && !summary.ok) {
    report = { ...report, notes: [...report.notes, `AI summary skipped: ${summary.reason}.`] };
  }
  const markdown = renderMarkdown(
    report,
    summary?.ok ? { summary: summary.summary, highlights: summary.highlights } : {},
  );
  const notification: StoredNotification = {
    title: `${REPORT_TITLES[report.type]} report for ${workspace.name}: ${report.period.label} (${report.period.start_date} to ${report.period.end_date})`,
    lines: [...(summary?.ok ? [summary.summary] : []), ...headlineLines(report)],
  };
  const [row] = await ctx.db
    .insert(reports)
    .values({
      workspace_id: workspace.id,
      type: report.type,
      period: { from: report.period.from, to: report.period.to, label: report.period.label },
      content: {
        schedule_id: config.schedule_id,
        schedule_name: config.name,
        job_id: ctx.job.id,
        generated_at: report.generated_at,
        period: report.period,
        previous_period: report.previous_period,
        data: report.data,
        definitions: report.definitions,
        notes: report.notes,
        summary: summary?.ok
          ? { text: summary.summary, highlights: summary.highlights, model: summary.model }
          : null,
        notification,
      },
      markdown,
      delivered_to: [],
    })
    .returning();
  if (!row) throw new Error("reports.run_schedule: insert returned no row");
  await ctx.events.emit("report.ready", {
    workspaceId: workspace.id,
    subject: { type: "report", id: row.id },
    data: { report_id: row.id, type: row.type },
  });
  return { row, summary: Boolean(summary?.ok) };
}

/** Hands the report to the notify helper for the schedule's channels and records the result. */
async function deliver(
  ctx: JobContext,
  row: ReportRow,
  channels: string[],
): Promise<ReportDelivery[]> {
  const stored = row.content.notification as StoredNotification | undefined;
  const input: NotifyInput & { channelIds: string[] } = {
    title: stored?.title ?? `Report ${row.id}`,
    lines: stored?.lines ?? [],
    severity: "info",
    event: "report.ready",
    url: null,
    channelIds: channels,
  };
  const at = ctx.clock.now().toISOString();
  let delivered: ReportDelivery[];
  try {
    await notify(ctx, input);
    delivered = channels.map((channel) => ({ channel_id: channel, delivered_at: at, ok: true }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.log.warn({ err: error, report_id: row.id }, "reports: delivery failed");
    delivered = channels.map((channel) => ({
      channel_id: channel,
      delivered_at: at,
      ok: false,
      error: message.slice(0, 300),
    }));
  }
  await ctx.db.update(reports).set({ delivered_to: delivered }).where(eq(reports.id, row.id));
  return delivered;
}

export const runScheduleJob = defineJob({
  name: REPORT_JOB_NAME,
  payload: runSchedulePayload,
  maxAttempts: 3,
  timeoutMs: 3 * 60_000,
  handler: (ctx, payload) => runScheduledReport(ctx, payload),
});
