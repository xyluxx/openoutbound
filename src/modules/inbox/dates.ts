/**
 * Calendar math for reply actions: out-of-office resume moments and follow-up due dates, in
 * the prospect's timezone (DST-safe through Intl).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Default pause when an out-of-office reply has no usable return date (replies playbook). */
export const OOO_DEFAULT_DAYS = 7;
/** Longest pause for an out-of-office reply. */
export const OOO_MAX_DAYS = 180;
/** Default follow-up for not_now replies (spec 11.11). */
export const FOLLOW_UP_DEFAULT_DAYS = 90;

/** A valid IANA zone, else "UTC". */
export function safeTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return timeZone;
  } catch {
    return "UTC";
  }
}

/** True for a real calendar date written as YYYY-MM-DD. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Wall-clock offset of the zone at an instant, in ms (local = utc + offset). */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const local = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return local - Math.floor(instant / 1000) * 1000;
}

/** 00:00 local time of a calendar date in a timezone, as an instant. */
export function zonedMidnight(isoDate: string, timeZone: string): Date {
  const zone = safeTimeZone(timeZone);
  const guess = Date.parse(`${isoDate}T00:00:00Z`);
  const first = guess - zoneOffsetMs(guess, zone);
  const second = guess - zoneOffsetMs(first, zone);
  return new Date(second);
}

/** Calendar date (YYYY-MM-DD) of an instant in a timezone. */
export function isoDateInZone(instant: Date, timeZone: string): string {
  const zone = safeTimeZone(timeZone);
  const local = new Date(instant.getTime() + zoneOffsetMs(instant.getTime(), zone));
  return local.toISOString().slice(0, 10);
}

function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** ISO weekday (1 = Monday ... 7 = Sunday) of a calendar date. */
function isoWeekday(isoDate: string): number {
  const day = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/** First working day strictly after `isoDate` (working weekdays, holidays skipped). */
export function nextWorkingDay(isoDate: string, workingDays: number[], holidays: string[]): string {
  const days = workingDays.length > 0 ? new Set(workingDays) : new Set([1, 2, 3, 4, 5, 6, 7]);
  const off = new Set(holidays);
  let candidate = addDays(isoDate, 1);
  for (let i = 0; i < 60; i++) {
    if (days.has(isoWeekday(candidate)) && !off.has(candidate)) return candidate;
    candidate = addDays(candidate, 1);
  }
  return addDays(isoDate, 1);
}

export interface ResumeAtInput {
  returnDate: string | null | undefined;
  now: Date;
  timeZone: string | null | undefined;
  workingDays: number[];
  holidays: string[];
}

export interface ResumeAt {
  until: Date;
  /** No usable return date: the default pause was used. */
  defaulted: boolean;
  /** The return date was further than OOO_MAX_DAYS away. */
  capped: boolean;
}

/**
 * When to resume after an out-of-office reply: 00:00 in the prospect's timezone on the first
 * working day after the return date. Missing, invalid or past dates pause for 7 days; dates
 * beyond 180 days are capped.
 */
export function outOfOfficeResumeAt(input: ResumeAtInput): ResumeAt {
  const zone = safeTimeZone(input.timeZone);
  const today = isoDateInZone(input.now, zone);
  const fallback = new Date(input.now.getTime() + OOO_DEFAULT_DAYS * DAY_MS);
  if (!isIsoDate(input.returnDate) || input.returnDate < today) {
    return { until: fallback, defaulted: true, capped: false };
  }
  const resumeDay = nextWorkingDay(input.returnDate, input.workingDays, input.holidays);
  const until = zonedMidnight(resumeDay, zone);
  const max = new Date(input.now.getTime() + OOO_MAX_DAYS * DAY_MS);
  if (until.getTime() > max.getTime()) return { until: max, defaulted: false, capped: true };
  return { until, defaulted: false, capped: false };
}

export interface SendWindow {
  /** ISO weekdays (1 = Monday) replies may go out. */
  days: number[];
  /** Local hours [start, end). */
  startHour: number;
  endHour: number;
  timeZone: string | null | undefined;
  holidays: string[];
  blackoutRanges: Array<{ from: string; to: string }>;
}

function hourInZone(instant: Date, timeZone: string): number {
  const local = new Date(instant.getTime() + zoneOffsetMs(instant.getTime(), timeZone));
  return local.getUTCHours() + local.getUTCMinutes() / 60;
}

/**
 * First moment at or after `earliest` inside the sending window: an allowed weekday that is
 * not a holiday or blackout date, between startHour and endHour local time. Used so automatic
 * replies never go out at night or on days off.
 */
export function nextSendWindowStart(earliest: Date, window: SendWindow): Date {
  const zone = safeTimeZone(window.timeZone);
  const days = window.days.length > 0 ? new Set(window.days) : new Set([1, 2, 3, 4, 5]);
  const start = Math.max(0, Math.min(23, window.startHour));
  const end = Math.max(start + 1, Math.min(24, window.endHour));
  const blocked = (isoDate: string) =>
    !days.has(isoWeekday(isoDate)) ||
    window.holidays.includes(isoDate) ||
    window.blackoutRanges.some((range) => isoDate >= range.from && isoDate <= range.to);

  let day = isoDateInZone(earliest, zone);
  for (let i = 0; i < 400; i++) {
    if (!blocked(day)) {
      const opens = new Date(zonedMidnight(day, zone).getTime() + start * 60 * 60 * 1000);
      if (i === 0) {
        const hour = hourInZone(earliest, zone);
        if (hour >= start && hour < end) return earliest;
        if (hour < start) return opens;
      } else {
        return opens;
      }
    }
    day = addDays(day, 1);
  }
  return earliest;
}

/**
 * Due time of a follow-up task: 09:00 in the prospect's timezone on the date they asked for
 * (when valid and in the future), else `defaultDays` from now.
 */
export function followUpDueAt(input: {
  date: string | null | undefined;
  now: Date;
  timeZone: string | null | undefined;
  defaultDays?: number;
}): Date {
  const zone = safeTimeZone(input.timeZone);
  if (isIsoDate(input.date) && input.date > isoDateInZone(input.now, zone)) {
    return new Date(zonedMidnight(input.date, zone).getTime() + 9 * 60 * 60 * 1000);
  }
  return new Date(input.now.getTime() + (input.defaultDays ?? FOLLOW_UP_DEFAULT_DAYS) * DAY_MS);
}
