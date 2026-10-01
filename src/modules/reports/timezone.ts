/**
 * Wall-clock helpers for IANA timezones, built on Intl (no date library). Used to turn report
 * periods ("last 7 days in Europe/Berlin") into exact UTC instants, including DST days.
 */

export const DAY_MS = 86_400_000;

export interface LocalDate {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
}

export interface LocalDateTime extends LocalDate {
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, found);
  }
  return found;
}

/** True when Intl knows the IANA zone (e.g. "Europe/Berlin"). */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Local wall-clock parts of an instant in a timezone. */
export function toLocal(instant: Date, timeZone: string): LocalDateTime {
  const parts = formatter(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

/** Local time minus UTC, in milliseconds, at an instant. */
function offsetMs(instantMs: number, timeZone: string): number {
  const whole = Math.floor(instantMs / 1000) * 1000;
  const local = toLocal(new Date(whole), timeZone);
  return (
    Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - whole
  );
}

/**
 * The instant a local wall-clock time happens in a timezone. Ambiguous times (clocks turned
 * back) resolve to the earlier instant; times skipped by a DST jump resolve to the same
 * distance after the jump (a skipped midnight becomes the first instant of that day).
 */
export function fromLocal(local: LocalDate & Partial<LocalDateTime>, timeZone: string): Date {
  const wall = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour ?? 0,
    local.minute ?? 0,
    local.second ?? 0,
  );
  const before = offsetMs(wall - DAY_MS, timeZone);
  const after = offsetMs(wall + DAY_MS, timeZone);
  const valid = [before, after]
    .filter((offset) => offsetMs(wall - offset, timeZone) === offset)
    .map((offset) => wall - offset);
  if (valid.length > 0) return new Date(Math.min(...valid));
  return new Date(wall - before);
}

/** Start of the local day that contains the instant. */
export function startOfLocalDay(instant: Date, timeZone: string): Date {
  const local = toLocal(instant, timeZone);
  return fromLocal({ year: local.year, month: local.month, day: local.day }, timeZone);
}

/** Calendar arithmetic on local dates (month and year overflow handled). */
export function addDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** First day of the month `months` away from the given date's month. */
export function addMonths(date: LocalDate, months: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1 + months, 1));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: 1 };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** YYYY-MM-DD */
export function formatLocalDate(date: LocalDate): string {
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`;
}

/** Parses YYYY-MM-DD (no validation beyond shape; callers validate with zod first). */
export function parseLocalDate(value: string): LocalDate {
  const [year, month, day] = value.split("-").map(Number);
  return { year: year ?? 1970, month: month ?? 1, day: day ?? 1 };
}
