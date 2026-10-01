import { and, count, desc, eq, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import { type OpContext, requireWorkspace } from "../../../core/context.js";
import { invalid, OpenOutboundError } from "../../../core/errors.js";
import { idSchema, newId } from "../../../core/ids.js";
import {
  defineOperation,
  jobHandleOutput,
  paginated,
  paginationInput,
} from "../../../core/operation.js";
import { decodeCursor, toPage } from "../../../core/pagination.js";
import {
  campaigns,
  notification_channels,
  type Schedule,
  schedules,
} from "../../../db/schema/index.js";
import { reportTimeZone } from "../build-report.js";
import { PERIOD_PRESETS } from "../period.js";
import {
  MAX_SCHEDULES_PER_WORKSPACE,
  nextCronRun,
  REPORT_JOB_NAME,
  reportScheduleSchema,
  SCHEDULE_NAME_PREFIX,
  type StoredSchedule,
  toScheduleOutput,
} from "../schedule-config.js";
import { SCHEDULABLE_REPORT_TYPES } from "../schemas.js";

const scheduleIdInput = z.object({
  schedule_id: idSchema("sch").describe("Report schedule id (from manage_report_schedules list)"),
});

async function findSchedule(ctx: OpContext, scheduleId: string): Promise<Schedule> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select()
    .from(schedules)
    .where(
      and(
        eq(schedules.id, scheduleId),
        eq(schedules.workspace_id, workspace.id),
        eq(schedules.job_name, REPORT_JOB_NAME),
      ),
    );
  if (!row) {
    throw new OpenOutboundError("not_found", `Report schedule ${scheduleId} not found.`, {
      hint: "List report schedules with manage_report_schedules (action list) and use one of their ids.",
      details: { what: "Report schedule", id: scheduleId },
    });
  }
  return row;
}

/** Channels must exist in the workspace and be enabled. */
async function assertChannels(ctx: OpContext, workspaceId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const found = await ctx.db
    .select({ id: notification_channels.id, enabled: notification_channels.enabled })
    .from(notification_channels)
    .where(
      and(
        eq(notification_channels.workspace_id, workspaceId),
        inArray(notification_channels.id, ids),
      ),
    );
  const missing = ids.filter((id) => !found.some((row) => row.id === id));
  if (missing.length > 0) {
    throw new OpenOutboundError(
      "not_found",
      `Notification channel${missing.length > 1 ? "s" : ""} not found: ${missing.join(", ")}.`,
      {
        hint: "List channels with manage_notifications (action list), or create one with manage_notifications (action create).",
        details: { missing },
      },
    );
  }
  const disabled = found.filter((row) => !row.enabled).map((row) => row.id);
  if (disabled.length > 0) {
    throw invalid(
      `Notification channel${disabled.length > 1 ? "s are" : " is"} disabled: ${disabled.join(", ")}.`,
      {
        disabled,
      },
    );
  }
}

export const createReportSchedule = defineOperation({
  id: "reports.schedules.create",
  summary: "Schedule a report to notification channels",
  description:
    "Schedules a recurring report (for example a weekly overview every Monday at 08:00) that is rendered as markdown, stored, announced with the report.ready event and sent to the given notification channels, optionally with a short AI summary that only uses numbers from the report. Use it to keep a team or client informed without asking. Not for one-off numbers (use get_report); agency reports cannot be scheduled. The cron runs in the schedule timezone (default the workspace timezone) and at most once an hour.",
  effect: "write",
  input: z.object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .optional()
      .describe("Unique per workspace; default '<type> <period>'"),
    type: z.enum(SCHEDULABLE_REPORT_TYPES).default("overview"),
    period: z
      .enum(PERIOD_PRESETS)
      .default("last_7_days")
      .describe("Period relative to each run, e.g. last_7_days for a Monday weekly report"),
    cron: z
      .string()
      .trim()
      .min(9)
      .max(120)
      .describe(
        "Cron in the schedule timezone: '0 8 * * 1' = Mondays 08:00, '0 8 * * *' = daily 08:00",
      ),
    timezone: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("IANA timezone for the cron and the period; default the workspace timezone"),
    channels: z
      .array(idSchema("ntf"))
      .max(10)
      .default([])
      .describe("Notification channel ids to deliver to; empty = store and emit report.ready only"),
    ai_summary: z
      .boolean()
      .default(false)
      .describe("Add a 2-3 sentence AI summary (fast tier, facts only from the report)"),
    campaign_id: idSchema("cmp").optional().describe("Only with type campaign: one campaign"),
    compare: z.boolean().default(true).describe("Compare with the previous period"),
  }),
  output: reportScheduleSchema,
  http: { method: "POST", path: "/v1/report-schedules" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Weekly overview to Slack with a summary",
      input: {
        type: "overview",
        period: "last_7_days",
        cron: "0 8 * * 1",
        channels: ["ntf_01k6a3v0q8x3m2n4p5r6s7t8v9"],
        ai_summary: true,
      },
    },
    {
      title: "Monthly costs",
      input: { name: "Monthly costs", type: "costs", period: "last_month", cron: "0 9 1 * *" },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    if (input.campaign_id && input.type !== "campaign") {
      throw invalid("campaign_id only works with type campaign.", { type: input.type });
    }
    const timezone = reportTimeZone(input.timezone, workspace);
    const nextRun = nextCronRun(input.cron, timezone, ctx.clock.now());
    const channels = [...new Set(input.channels)];
    await assertChannels(ctx, workspace.id, channels);
    if (input.campaign_id) {
      const [campaign] = await ctx.db
        .select({ id: campaigns.id })
        .from(campaigns)
        .where(and(eq(campaigns.id, input.campaign_id), eq(campaigns.workspace_id, workspace.id)));
      if (!campaign) {
        throw new OpenOutboundError("not_found", `Campaign ${input.campaign_id} not found.`, {
          hint: "List campaigns with get_campaigns and pass one of their ids.",
          details: { what: "Campaign", id: input.campaign_id },
        });
      }
    }
    const [existing] = await ctx.db
      .select({ n: count() })
      .from(schedules)
      .where(
        and(eq(schedules.workspace_id, workspace.id), eq(schedules.job_name, REPORT_JOB_NAME)),
      );
    if ((existing?.n ?? 0) >= MAX_SCHEDULES_PER_WORKSPACE) {
      throw new OpenOutboundError(
        "limit_reached",
        `This workspace already has ${MAX_SCHEDULES_PER_WORKSPACE} report schedules.`,
        { hint: "Delete one with manage_report_schedules (action delete) first." },
      );
    }
    const name = input.name ?? `${input.type} ${input.period}`;
    const rowName = `${SCHEDULE_NAME_PREFIX}${name}`;
    const [clash] = await ctx.db
      .select({ id: schedules.id })
      .from(schedules)
      .where(and(eq(schedules.workspace_id, workspace.id), eq(schedules.name, rowName)));
    if (clash) {
      throw new OpenOutboundError("conflict", `A report schedule named "${name}" already exists.`, {
        hint: "Pass a different name, or delete the existing schedule with manage_report_schedules (action delete).",
        details: { schedule_id: clash.id },
      });
    }
    const id = newId("sch");
    const payload: StoredSchedule = {
      schedule_id: id,
      workspace_id: workspace.id,
      name,
      type: input.type,
      period: input.period,
      channels,
      ai_summary: input.ai_summary,
      campaign_id: input.campaign_id ?? null,
      compare: input.compare,
    };
    const [row] = await ctx.db
      .insert(schedules)
      .values({
        id,
        workspace_id: workspace.id,
        name: rowName,
        cron: input.cron,
        timezone,
        job_name: REPORT_JOB_NAME,
        payload,
        enabled: true,
        next_run_at: nextRun,
      })
      .returning();
    if (!row) throw new Error("reports.schedules.create: insert returned no row");
    return toScheduleOutput(row);
  },
});

export const listReportSchedules = defineOperation({
  id: "reports.schedules.list",
  summary: "List report schedules",
  description:
    "Lists the workspace's scheduled reports, newest first, with cron, timezone, channels, next and last run. Use it before creating one (names are unique) or to find a schedule id to delete or run. Not for the reports themselves (use get_report). Paginates with limit and cursor.",
  effect: "read",
  input: paginationInput,
  output: paginated(reportScheduleSchema),
  http: { method: "GET", path: "/v1/report-schedules" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "All schedules", input: {} }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const conditions = [
      eq(schedules.workspace_id, workspace.id),
      eq(schedules.job_name, REPORT_JOB_NAME),
    ];
    if (input.cursor) {
      const cursor = decodeCursor<{ id?: unknown }>(input.cursor);
      if (typeof cursor.id !== "string") {
        throw invalid("Invalid cursor.", { cursor: input.cursor });
      }
      conditions.push(lt(schedules.id, cursor.id));
    }
    const list = await ctx.db
      .select()
      .from(schedules)
      .where(and(...conditions))
      .orderBy(desc(schedules.id))
      .limit(input.limit + 1);
    return toPage(list, input.limit, (row) => ({ id: row.id }), toScheduleOutput);
  },
});

export const deleteReportSchedule = defineOperation({
  id: "reports.schedules.delete",
  summary: "Delete a report schedule",
  description:
    "Deletes a scheduled report so it stops running; reports already delivered stay stored. Use it when a schedule is no longer wanted or goes to the wrong channel (delete, then create a new one). Not for pausing everything (use manage_workspaces). A run that is already queued finds the schedule gone and skips.",
  effect: "destructive",
  input: scheduleIdInput,
  output: z.object({ id: z.string(), deleted: z.literal(true) }),
  http: { method: "DELETE", path: "/v1/report-schedules/:schedule_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Delete", input: { schedule_id: "sch_01k6a3v0q8x3m2n4p5r6s7t8v9" } }],
  handler: async (ctx, input) => {
    const row = await findSchedule(ctx, input.schedule_id);
    await ctx.db.delete(schedules).where(eq(schedules.id, row.id));
    return { id: row.id, deleted: true as const };
  },
});

export const runReportSchedule = defineOperation({
  id: "reports.schedules.run",
  summary: "Run a report schedule now",
  description:
    "Runs a scheduled report once, right away, in the background (render, store, deliver to its channels), without changing its cron. Use it to test a new schedule or resend a report. Not for reading numbers yourself (use get_report). Returns a job handle; check it with get_job.",
  effect: "write",
  input: scheduleIdInput,
  output: jobHandleOutput,
  http: { method: "POST", path: "/v1/report-schedules/:schedule_id/run" },
  dryRun: "none",
  idempotent: false,
  workspace: "required",
  examples: [{ title: "Run now", input: { schedule_id: "sch_01k6a3v0q8x3m2n4p5r6s7t8v9" } }],
  handler: async (ctx, input) => {
    const row = await findSchedule(ctx, input.schedule_id);
    const handle = await ctx.jobs.enqueue(
      REPORT_JOB_NAME,
      { schedule_id: row.id, workspace_id: row.workspace_id, manual: true },
      { singletonKey: `reports.run_now:${row.id}` },
    );
    return { job_id: handle.job_id, status: handle.status };
  },
});
