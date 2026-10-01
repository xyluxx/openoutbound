import type { CampaignSettings } from "../../core/settings.js";
import type { Company, Person } from "../../db/schema/index.js";

/** Representative zone per country (the most populous zone for countries with several). */
const COUNTRY_ZONES: Record<string, string> = {
  US: "America/Chicago",
  CA: "America/Toronto",
  MX: "America/Mexico_City",
  BR: "America/Sao_Paulo",
  AR: "America/Argentina/Buenos_Aires",
  CL: "America/Santiago",
  CO: "America/Bogota",
  GB: "Europe/London",
  IE: "Europe/Dublin",
  PT: "Europe/Lisbon",
  ES: "Europe/Madrid",
  FR: "Europe/Paris",
  BE: "Europe/Brussels",
  NL: "Europe/Amsterdam",
  LU: "Europe/Luxembourg",
  DE: "Europe/Berlin",
  AT: "Europe/Vienna",
  CH: "Europe/Zurich",
  IT: "Europe/Rome",
  DK: "Europe/Copenhagen",
  NO: "Europe/Oslo",
  SE: "Europe/Stockholm",
  FI: "Europe/Helsinki",
  PL: "Europe/Warsaw",
  CZ: "Europe/Prague",
  HU: "Europe/Budapest",
  RO: "Europe/Bucharest",
  GR: "Europe/Athens",
  TR: "Europe/Istanbul",
  IL: "Asia/Jerusalem",
  AE: "Asia/Dubai",
  SA: "Asia/Riyadh",
  EG: "Africa/Cairo",
  ZA: "Africa/Johannesburg",
  NG: "Africa/Lagos",
  KE: "Africa/Nairobi",
  IN: "Asia/Kolkata",
  SG: "Asia/Singapore",
  MY: "Asia/Kuala_Lumpur",
  ID: "Asia/Jakarta",
  PH: "Asia/Manila",
  TH: "Asia/Bangkok",
  VN: "Asia/Ho_Chi_Minh",
  CN: "Asia/Shanghai",
  HK: "Asia/Hong_Kong",
  JP: "Asia/Tokyo",
  KR: "Asia/Seoul",
  AU: "Australia/Sydney",
  NZ: "Pacific/Auckland",
};

export function isValidTimeZone(zone: string | null | undefined): zone is string {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function countryTimeZone(country: string | null | undefined): string | null {
  if (!country) return null;
  return COUNTRY_ZONES[country.toUpperCase()] ?? null;
}

/**
 * The zone sends are planned in (sequences playbook, timing): fixed mode uses the campaign
 * zone; lead mode tries the person's zone, then the company's, then the country default,
 * then the campaign fallback.
 */
export function recipientTimeZone(
  schedule: CampaignSettings["schedule"],
  person: Pick<Person, "timezone" | "country">,
  company: Pick<Company, "timezone" | "country"> | null,
): string {
  const fallback = isValidTimeZone(schedule.timezone) ? schedule.timezone : "UTC";
  if (schedule.timezone_mode === "fixed") return fallback;
  const candidates = [
    person.timezone,
    company?.timezone,
    countryTimeZone(person.country),
    countryTimeZone(company?.country),
  ];
  for (const zone of candidates) if (isValidTimeZone(zone)) return zone;
  return fallback;
}

function partsIn(
  instant: Date,
  zone: string,
): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const values: Record<string, number> = {};
  for (const part of format.formatToParts(instant)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    y: values.year ?? 1970,
    m: values.month ?? 1,
    d: values.day ?? 1,
    h: values.hour ?? 0,
    mi: values.minute ?? 0,
    s: values.second ?? 0,
  };
}

/** Offset of `zone` from UTC at `instant`, in milliseconds (positive east of UTC). */
function offsetMs(instant: Date, zone: string): number {
  const p = partsIn(instant, zone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Local calendar date (YYYY-MM-DD) of `instant` in `zone`. */
export function localDate(instant: Date, zone: string): string {
  const p = partsIn(instant, zone);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** The instant local midnight started in `zone` on the local day of `instant` (DST-safe). */
export function startOfLocalDay(instant: Date, zone: string): Date {
  const p = partsIn(instant, zone);
  const midnightAsUtc = Date.UTC(p.y, p.m - 1, p.d, 0, 0, 0);
  let guess = midnightAsUtc - offsetMs(instant, zone);
  // The offset at midnight can differ from the offset now (DST change during the day).
  guess = midnightAsUtc - offsetMs(new Date(guess), zone);
  return new Date(guess);
}
