import { Cron } from "croner";
import { z } from "zod";
import { OpenOutboundError } from "../../core/errors.js";
import { isoDateTime } from "../../core/operation.js";
import type { Schedule } from "../../db/schema/index.js";
import { PERIOD_PRESETS } from "./period.js";
import { SCHEDULABLE_REPORT_TYPES } from "./schemas.js";

/**
 * Scheduled reports live in the core `schedules` table (the runtime scheduler runs them):
 * job_name `reports.run_schedule`, row name `report:<name>`, and this config as the payload.
 */
export const REPORT_JOB_NAME = "reports.run_schedule";
export const SCHEDULE_NAME_PREFIX = "report:";
/** Scheduled reports run at most once an hour. */
export const MIN_SCHEDULE_INTERVAL_MS = 3_600_000;
export const MAX_SCHEDULES_PER_WORKSPACE = 25;

export const storedScheduleSchema = z.object({
  schedule_id: z.string(),
  workspace_id: z.string(),
  name: z.string(),
  type: z.enum(SCHEDULABLE_REPORT_TYPES),
  period: z.enum(PERIOD_PRESETS),
  channels: z.array(z.string()).default([]),
  ai_summary: z.boolean().default(false),
  campaign_id: z.string().nullable().default(null),
  compare: z.boolean().default(true),
});
export type StoredSchedule = z.infer<typeof storedScheduleSchema>;

export const reportScheduleSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(SCHEDULABLE_REPORT_TYPES),
  period: z.enum(PERIOD_PRESETS),
  cron: z.string(),
  timezone: z.string(),
  channels: z.array(z.string()),
  ai_summary: z.boolean(),
  campaign_id: z.string().nullable(),
  compare: z.boolean(),
  enabled: z.boolean(),
  next_run_at: isoDateTime().nullable(),
  last_run_at: isoDateTime().nullable(),
  created_at: isoDateTime(),
});
export type ReportScheduleOutput = z.input<typeof reportScheduleSchema>;

/** Reads a schedule row's config; null when the payload no longer parses. */
export function parseStoredSchedule(row: Pick<Schedule, "payload">): StoredSchedule | null {
  const parsed = storedScheduleSchema.safeParse(row.payload);
  return parsed.success ? parsed.data : null;
}

export function toScheduleOutput(row: Schedule): ReportScheduleOutput {
  const config = parseStoredSchedule(row);
  return {
    id: row.id,
    name: config?.name ?? row.name.replace(SCHEDULE_NAME_PREFIX, ""),
    type: config?.type ?? "overview",
    period: config?.period ?? "last_7_days",
    cron: row.cron,
    timezone: row.timezone,
    channels: config?.channels ?? [],
    ai_summary: config?.ai_summary ?? false,
    campaign_id: config?.campaign_id ?? null,
    compare: config?.compare ?? true,
    enabled: row.enabled,
    next_run_at: row.next_run_at,
    last_run_at: row.last_run_at,
    created_at: row.created_at,
  };
}

/**
 * Validates a cron in a timezone and returns its next run. Rejects schedules that would run more
 * than once an hour (reports are digests, not alerts).
 */
export function nextCronRun(cron: string, timeZone: string, now: Date): Date {
  let job: Cron;
  try {
    // Same parsing mode as the runtime scheduler, so a schedule it cannot run is refused here.
    job = new Cron(cron, { timezone: timeZone, paused: true, mode: "5-or-6-parts" });
  } catch (error) {
    throw new OpenOutboundError(
      "validation_failed",
      `Invalid cron "${cron}": ${error instanceof Error ? error.message : String(error)}`,
      {
        hint: "Use 5 fields: minute hour day-of-month month day-of-week, e.g. '0 8 * * 1' for Mondays 08:00.",
      },
    );
  }
  try {
    const [first, second] = job.nextRuns(2, now);
    if (!first) {
      throw new OpenOutboundError("validation_failed", `The cron "${cron}" never runs again.`, {
        hint: "Use a repeating cron such as '0 8 * * 1' (Mondays 08:00).",
      });
    }
    if (second && second.getTime() - first.getTime() < MIN_SCHEDULE_INTERVAL_MS) {
      throw new OpenOutboundError(
        "validation_failed",
        `The cron "${cron}" runs more than once an hour; scheduled reports are digests.`,
        {
          hint: "Pick a daily or weekly cron such as '0 8 * * *' (daily 08:00) or '0 8 * * 1' (Mondays 08:00).",
        },
      );
    }
    return first;
  } finally {
    job.stop();
  }
}
