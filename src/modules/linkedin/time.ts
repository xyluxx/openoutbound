/**
 * Timezone math for LinkedIn working hours (DST-aware, Intl only). Local days are
 * `YYYY-MM-DD` keys in the account timezone; windows are UTC instants.
 */

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** ISO weekday: 1 = Monday ... 7 = Sunday. */
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let found = formatters.get(timezone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(timezone, found);
  }
  return found;
}

/** True when `timezone` is an IANA zone this runtime knows. */
export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of an instant in a timezone. */
export function localParts(date: Date, timezone: string): LocalParts {
  const parts = formatter(timezone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAYS[get("weekday")] ?? 1,
  };
}

const pad = (value: number) => String(value).padStart(2, "0");

/** Local calendar day (`YYYY-MM-DD`) of an instant. */
export function dayKey(date: Date, timezone: string): string {
  const p = localParts(date, timezone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function splitDay(key: string): [number, number, number] {
  const [y, m, d] = key.split("-").map(Number);
  return [y ?? 1970, m ?? 1, d ?? 1];
}

/** Calendar arithmetic on day keys (no timezone involved). */
export function addDays(key: string, days: number): string {
  const [y, m, d] = splitDay(key);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  const [y1, m1, d1] = splitDay(from);
  const [y2, m2, d2] = splitDay(to);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

/** ISO weekday of a day key. */
export function weekdayOf(key: string): number {
  const [y, m, d] = splitDay(key);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
}

function offsetMs(instant: number, timezone: string): number {
  const p = localParts(new Date(instant), timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant when the wall clock in `timezone` shows `hour:minute` on `key`. Hour 24 means
 * the next midnight. Times skipped by a DST jump resolve to the shifted instant.
 */
export function zonedTime(key: string, hour: number, minute: number, timezone: string): Date {
  const [y, m, d] = splitDay(key);
  const localAsUtc = Date.UTC(y, m - 1, d, hour, minute);
  let utc = localAsUtc - offsetMs(localAsUtc, timezone);
  const second = offsetMs(utc, timezone);
  if (second !== localAsUtc - utc) utc = localAsUtc - second;
  return new Date(utc);
}

/** Working-hours rules for one sender. */
export interface WorkSchedule {
  timezone: string;
  /** ISO weekdays. */
  days: readonly number[];
  startHour: number;
  endHour: number;
  /** Day keys that are off (workspace holidays). */
  holidays: ReadonlySet<string>;
  /** Inclusive day-key ranges that are off (workspace blackouts). */
  blackouts: ReadonlyArray<{ from: string; to: string }>;
}

export interface WorkWindow {
  dayKey: string;
  start: Date;
  end: Date;
}

export function isWorkingDay(schedule: WorkSchedule, key: string): boolean {
  if (!schedule.days.includes(weekdayOf(key))) return false;
  if (schedule.holidays.has(key)) return false;
  return !schedule.blackouts.some((range) => key >= range.from && key <= range.to);
}

/**
 * The first working window that ends after `from` (the window may already have started).
 * Null when no working day exists within `maxDays` local days.
 */
export function nextWindow(schedule: WorkSchedule, from: Date, maxDays = 30): WorkWindow | null {
  if (schedule.endHour <= schedule.startHour) return null;
  let key = dayKey(from, schedule.timezone);
  for (let i = 0; i <= maxDays; i++) {
    if (isWorkingDay(schedule, key)) {
      const start = zonedTime(key, schedule.startHour, 0, schedule.timezone);
      const end = zonedTime(key, schedule.endHour, 0, schedule.timezone);
      if (end.getTime() > from.getTime()) return { dayKey: key, start, end };
    }
    key = addDays(key, 1);
  }
  return null;
}
