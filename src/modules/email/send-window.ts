import type { CampaignSettings, WorkspaceSettings } from "../../core/settings.js";
import { addDays, isoWeekday, isValidTimeZone, localDate, zonedTimeToUtc } from "./timezone.js";

/** When a send may happen: a daily window on allowed local days in one timezone. */
export interface SendWindowSpec {
  timezone: string;
  /** Allowed ISO weekdays (campaign days that are also workspace working days). */
  days: readonly number[];
  startHour: number;
  /** Exclusive; 24 = midnight. */
  endHour: number;
  /** Local dates (`YYYY-MM-DD`) with no sending. */
  holidays: ReadonlySet<string>;
  /** Inclusive local date ranges with no sending. */
  blackouts: ReadonlyArray<{ from: string; to: string }>;
  /** Campaign start and end (absolute instants). */
  startAt?: Date | null;
  endAt?: Date | null;
}

/** One opening of the window: sending is allowed in [start, end). */
export interface WindowInstance {
  start: Date;
  end: Date;
  /** Local date of the opening in the window timezone. */
  date: string;
}

/**
 * Builds the window spec for a recipient: the campaign schedule in the recipient timezone
 * (campaign timezone when unknown, invalid or `timezone_mode: fixed`), limited to workspace
 * working days, holidays and blackout ranges.
 */
export function buildWindowSpec(
  schedule: CampaignSettings["schedule"],
  workspaceSchedule: WorkspaceSettings["schedule"],
  recipientTimezone: string | null | undefined,
): SendWindowSpec {
  const fallback = isValidTimeZone(schedule.timezone) ? schedule.timezone : "UTC";
  const timezone =
    schedule.timezone_mode === "lead" && isValidTimeZone(recipientTimezone)
      ? recipientTimezone
      : fallback;
  const working = new Set(workspaceSchedule.working_days);
  return {
    timezone,
    days: [...new Set(schedule.days)].filter((day) => working.has(day)),
    startHour: schedule.start_hour,
    endHour: schedule.end_hour,
    holidays: new Set(workspaceSchedule.holidays),
    blackouts: workspaceSchedule.blackout_ranges,
    startAt: schedule.start_at ? new Date(schedule.start_at) : null,
    endAt: schedule.end_at ? new Date(schedule.end_at) : null,
  };
}

/** True when the local date is an allowed sending day. */
export function isAllowedDate(date: string, spec: SendWindowSpec): boolean {
  if (!spec.days.includes(isoWeekday(date))) return false;
  if (spec.holidays.has(date)) return false;
  return !spec.blackouts.some((range) => date >= range.from && date <= range.to);
}

/**
 * The window opening that contains `at`, or the next one after it. Null when the spec can never
 * open (no allowed days, start >= end, campaign ended) or nothing opens within `maxDays`.
 */
export function windowAt(at: Date, spec: SendWindowSpec, maxDays = 60): WindowInstance | null {
  if (spec.startHour >= spec.endHour || spec.days.length === 0) return null;
  const from = spec.startAt && spec.startAt > at ? spec.startAt : at;
  let date = localDate(from, spec.timezone);
  for (let i = 0; i <= maxDays; i++) {
    if (isAllowedDate(date, spec)) {
      const start = zonedTimeToUtc(date, spec.startHour, 0, spec.timezone);
      const end = zonedTimeToUtc(date, spec.endHour, 0, spec.timezone);
      if (from < end) {
        const opening = start > from ? start : from;
        if (spec.endAt && opening >= spec.endAt) return null;
        const clippedEnd = spec.endAt && spec.endAt < end ? spec.endAt : end;
        return { start: start > from ? start : from, end: clippedEnd, date };
      }
    }
    date = addDays(date, 1);
  }
  return null;
}

/** True when a send at `at` is inside the window. */
export function isInWindow(at: Date, spec: SendWindowSpec): boolean {
  const instance = windowAt(at, spec, 0);
  return instance !== null && instance.start.getTime() <= at.getTime();
}
