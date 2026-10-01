/**
 * Timezone math on top of `Intl.DateTimeFormat` (no dependencies, DST safe). Local dates are
 * `YYYY-MM-DD` strings; instants are `Date`s.
 */

/** Wall-clock parts of an instant in an IANA timezone. `weekday` is ISO (1 = Monday). */
export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(timeZone, cached);
  }
  return cached;
}

/** True for IANA zone names the runtime knows (e.g. "Europe/Berlin"). */
export function isValidTimeZone(timeZone: string | null | undefined): timeZone is string {
  if (!timeZone) return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of `date` in `timeZone`. */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(date)) parts[part.type] = part.value;
  const hour = Number(parts.hour);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: hour === 24 ? 0 : hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday ?? ""] ?? 1,
  };
}

/** Local calendar date (`YYYY-MM-DD`) of an instant in a timezone. */
export function localDate(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return formatDate(p.year, p.month, p.day);
}

function formatDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseDate(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = date.split("-").map(Number);
  return { year: year ?? 1970, month: month ?? 1, day: day ?? 1 };
}

/** `date` plus `days` calendar days. */
export function addDays(date: string, days: number): string {
  const { year, month, day } = parseDate(date);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return formatDate(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  const a = parseDate(from);
  const b = parseDate(to);
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000,
  );
}

/** ISO weekday of a calendar date (1 = Monday ... 7 = Sunday). */
export function isoWeekday(date: string): number {
  const { year, month, day } = parseDate(date);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

/** Offset of the zone from UTC at an instant, in milliseconds (east positive). */
function offsetAt(ms: number, timeZone: string): number {
  const base = Math.floor(ms / 1000) * 1000;
  const p = zonedParts(new Date(base), timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - base;
}

/**
 * The instant when the wall clock in `timeZone` shows `date` at `hour:minute`. Hour 24 means
 * midnight of the next day. Times skipped by a DST jump move forward by the size of the jump
 * (like Temporal's "compatible" mode); repeated times resolve to the earlier occurrence.
 */
export function zonedTimeToUtc(date: string, hour: number, minute = 0, timeZone = "UTC"): Date {
  const target = hour >= 24 ? addDays(date, 1) : date;
  const { year, month, day } = parseDate(target);
  const wall = Date.UTC(year, month - 1, day, hour >= 24 ? 0 : hour, minute);
  const first = wall - offsetAt(wall, timeZone);
  const second = wall - offsetAt(first, timeZone);
  if (second === first) return new Date(first);
  // Near a transition: prefer the candidate whose wall clock matches, else the later one (gap).
  const candidates = [first, second].sort((a, b) => a - b);
  for (const candidate of candidates) {
    const p = zonedParts(new Date(candidate), timeZone);
    if (formatDate(p.year, p.month, p.day) === target && p.hour === (hour >= 24 ? 0 : hour)) {
      return new Date(candidate);
    }
  }
  return new Date(Math.max(first, second));
}

/** Start (00:00 local) of the day after `date` in `timeZone`. */
export function startOfNextDay(date: string, timeZone: string): Date {
  return zonedTimeToUtc(addDays(date, 1), 0, 0, timeZone);
}
