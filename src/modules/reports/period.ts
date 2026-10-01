import { OpenOutboundError } from "../../core/errors.js";
import {
  addDays,
  addMonths,
  DAY_MS,
  daysInMonth,
  formatLocalDate,
  fromLocal,
  type LocalDate,
  type LocalDateTime,
  parseLocalDate,
  toLocal,
} from "./timezone.js";

/**
 * Report periods (spec 11.12). Every period is a half-open UTC range [from, to) computed from
 * local calendar days in the report timezone, so "yesterday" in Asia/Tokyo and in
 * America/Chicago are different instants, and DST days have 23 or 25 hours.
 */
export const PERIOD_PRESETS = [
  "today",
  "yesterday",
  "last_7_days",
  "last_30_days",
  "this_month",
  "last_month",
  "this_quarter",
] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export const DEFAULT_PERIOD: PeriodPreset = "last_7_days";

/** Longest custom range, to keep report queries bounded. */
export const MAX_CUSTOM_DAYS = 731;

export interface Period {
  preset: PeriodPreset | "custom";
  label: string;
  /** Inclusive start. */
  from: Date;
  /** Exclusive end. */
  to: Date;
  timezone: string;
  /** True when the period ends now (still running). */
  partial: boolean;
}

export interface PeriodRequest {
  preset?: PeriodPreset | undefined;
  /** YYYY-MM-DD (local day start) or an ISO datetime with offset. */
  from?: string | undefined;
  /** YYYY-MM-DD (inclusive: the whole day) or an ISO datetime with offset (exclusive). */
  to?: string | undefined;
}

export interface ResolvedPeriods {
  current: Period;
  /** Same length directly before (same elapsed part of the previous unit for "to date" presets). */
  previous: Period;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * Resolves a preset or a custom from/to into the current and previous period. Throws
 * `validation_failed` with a hint on contradictory or impossible input.
 */
export function resolvePeriods(
  request: PeriodRequest,
  now: Date,
  timeZone: string,
): ResolvedPeriods {
  const hasCustom = request.from !== undefined || request.to !== undefined;
  if (hasCustom) {
    if (request.preset !== undefined) {
      throw periodError("Pass either period or from/to, not both.");
    }
    if (request.from === undefined || request.to === undefined) {
      throw periodError("A custom period needs both from and to.");
    }
    return customPeriods(request.from, request.to, now, timeZone);
  }
  return presetPeriods(request.preset ?? DEFAULT_PERIOD, now, timeZone);
}

function presetPeriods(preset: PeriodPreset, now: Date, timeZone: string): ResolvedPeriods {
  const local = toLocal(now, timeZone);
  const today: LocalDate = { year: local.year, month: local.month, day: local.day };
  const dayStart = (date: LocalDate) => fromLocal(date, timeZone);
  const make = (label: string, from: Date, to: Date, partial: boolean): Period => ({
    preset,
    label,
    from,
    to,
    timezone: timeZone,
    partial,
  });

  switch (preset) {
    case "today": {
      const yesterday = addDays(today, -1);
      return {
        current: make("Today", dayStart(today), now, true),
        previous: make(
          "Yesterday (same time)",
          dayStart(yesterday),
          fromLocal({ ...local, ...yesterday }, timeZone),
          false,
        ),
      };
    }
    case "yesterday": {
      const yesterday = addDays(today, -1);
      return {
        current: make("Yesterday", dayStart(yesterday), dayStart(today), false),
        previous: make("Day before", dayStart(addDays(today, -2)), dayStart(yesterday), false),
      };
    }
    case "last_7_days":
    case "last_30_days": {
      const days = preset === "last_7_days" ? 7 : 30;
      const start = addDays(today, -days);
      return {
        current: make(`Last ${days} days`, dayStart(start), dayStart(today), false),
        previous: make(
          `Previous ${days} days`,
          dayStart(addDays(start, -days)),
          dayStart(start),
          false,
        ),
      };
    }
    case "this_month": {
      const monthStart: LocalDate = { year: today.year, month: today.month, day: 1 };
      const previousStart = addMonths(monthStart, -1);
      return {
        current: make(`${monthLabel(monthStart)} to date`, dayStart(monthStart), now, true),
        previous: make(
          `${monthLabel(previousStart)} (same days)`,
          dayStart(previousStart),
          shiftedEnd(local, previousStart, timeZone),
          false,
        ),
      };
    }
    case "last_month": {
      const monthStart: LocalDate = { year: today.year, month: today.month, day: 1 };
      const lastStart = addMonths(monthStart, -1);
      const beforeStart = addMonths(monthStart, -2);
      return {
        current: make(monthLabel(lastStart), dayStart(lastStart), dayStart(monthStart), false),
        previous: make(monthLabel(beforeStart), dayStart(beforeStart), dayStart(lastStart), false),
      };
    }
    case "this_quarter": {
      const quarterMonth = Math.floor((today.month - 1) / 3) * 3 + 1;
      const quarterStart: LocalDate = { year: today.year, month: quarterMonth, day: 1 };
      const previousStart = addMonths(quarterStart, -3);
      const targetMonth = addMonths({ ...today, day: 1 }, -3);
      return {
        current: make(`${quarterLabel(quarterStart)} to date`, dayStart(quarterStart), now, true),
        previous: make(
          `${quarterLabel(previousStart)} (same days)`,
          dayStart(previousStart),
          shiftedEnd(local, targetMonth, timeZone),
          false,
        ),
      };
    }
  }
}

/**
 * `now` moved to the same day and time in an earlier month. When that day does not exist
 * (March 31 -> February), the end is the start of the following month (the whole month).
 */
function shiftedEnd(now: LocalDateTime, targetMonth: LocalDate, timeZone: string): Date {
  if (now.day > daysInMonth(targetMonth.year, targetMonth.month)) {
    return fromLocal(addMonths(targetMonth, 1), timeZone);
  }
  return fromLocal({ ...now, year: targetMonth.year, month: targetMonth.month }, timeZone);
}

function customPeriods(from: string, to: string, now: Date, timeZone: string): ResolvedPeriods {
  const start = parseBoundary(from, "from", timeZone);
  const end = parseBoundary(to, "to", timeZone);
  if (start.getTime() >= end.getTime()) {
    throw periodError(`from (${from}) must be before to (${to}).`);
  }
  if (start.getTime() > now.getTime()) {
    throw periodError(`from (${from}) is in the future; nothing has happened yet.`);
  }
  const length = end.getTime() - start.getTime();
  if (length > MAX_CUSTOM_DAYS * DAY_MS) {
    throw periodError(`Custom periods can span at most ${MAX_CUSTOM_DAYS} days.`);
  }
  const label = `${describeBoundary(start, timeZone)} to ${describeBoundary(new Date(end.getTime() - 1), timeZone)}`;
  const previousFrom = new Date(start.getTime() - length);
  return {
    current: {
      preset: "custom",
      label,
      from: start,
      to: end,
      timezone: timeZone,
      partial: end.getTime() > now.getTime(),
    },
    previous: {
      preset: "custom",
      label: `${describeBoundary(previousFrom, timeZone)} to ${describeBoundary(new Date(start.getTime() - 1), timeZone)}`,
      from: previousFrom,
      to: start,
      timezone: timeZone,
      partial: false,
    },
  };
}

function parseBoundary(value: string, field: "from" | "to", timeZone: string): Date {
  if (DATE_ONLY.test(value)) {
    const date = parseLocalDate(value);
    if (date.month < 1 || date.month > 12 || date.day < 1) {
      throw periodError(`${field} is not a valid date: ${value}.`);
    }
    if (date.day > daysInMonth(date.year, date.month)) {
      throw periodError(`${field} is not a valid date: ${value}.`);
    }
    return fromLocal(field === "to" ? addDays(date, 1) : date, timeZone);
  }
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw periodError(`${field} must be a date (YYYY-MM-DD) or an ISO datetime: ${value}.`);
  }
  return instant;
}

function describeBoundary(instant: Date, timeZone: string): string {
  return formatLocalDate(toLocal(instant, timeZone));
}

function monthLabel(date: LocalDate): string {
  return `${MONTH_NAMES[date.month - 1] ?? ""} ${date.year}`;
}

function quarterLabel(date: LocalDate): string {
  return `Q${Math.floor((date.month - 1) / 3) + 1} ${date.year}`;
}

/** Local first and last calendar day of a period (the last day is inclusive). */
export function periodDates(period: Period): { start_date: string; end_date: string } {
  const lastInstant = new Date(Math.max(period.from.getTime(), period.to.getTime() - 1));
  return {
    start_date: formatLocalDate(toLocal(period.from, period.timezone)),
    end_date: formatLocalDate(toLocal(lastInstant, period.timezone)),
  };
}

function periodError(message: string): OpenOutboundError {
  return new OpenOutboundError("validation_failed", message, {
    hint: `Use period (${PERIOD_PRESETS.join(", ")}) or both from and to as YYYY-MM-DD dates in the report timezone.`,
  });
}
