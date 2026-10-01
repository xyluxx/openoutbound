import { addDays, isoWeekday } from "../timezone.js";
import type { HeaderMap } from "./headers.js";

/** An automatic reply (out of office or other auto-responder). */
export interface AutoReply {
  outOfOffice: boolean;
  /** ISO date the person is back, when the text says so. */
  returnDate: string | null;
  /** What gave it away, e.g. "header auto-submitted". */
  signal: string;
}

const AUTO_SUBJECT =
  /^\s*(automatic reply|auto(matic)?[- ]?(reply|response|respond|antwort)|autoreply|out of (the )?office|ooo\b|away from (the )?office|on vacation|on holiday|on leave|vacation (reply|message|notice)|abwesenheit|abwesend|automatische antwort|nicht im b(ü|ue)ro|au(ß|ss)er haus|r(é|e)ponse automatique|message d'absence|absence du bureau|absent du bureau|en cong(é|e)s?|respuesta autom(á|a)tica|fuera de (la )?oficina|ausencia|ausente|de vacaciones)/i;
const OOO_SUBJECT =
  /(out of (the )?office|ooo\b|away|vacation|holiday|leave|abwesen|nicht im b|au(ß|ss)er haus|urlaub|absence|absent|cong(é|e)|fuera de|ausen|vacaciones)/i;
const OOO_BODY =
  /(out of (the )?office|i am (currently )?away|i'?m (currently )?away|on (annual |parental |sick )?leave|on vacation|on holiday|limited access to (my )?e-?mail|abwesend|nicht im b(ü|ue)ro|im urlaub|au(ß|ss)er haus|je suis (actuellement )?(absent|en cong)|absente? du bureau|estoy (fuera de la oficina|de vacaciones|ausente)|fuera de la oficina)/i;

/**
 * Detects automatic replies by headers (Auto-Submitted, X-Autoreply, X-Autorespond,
 * Precedence: auto_reply) or subject patterns in English, German, French and Spanish. Body text
 * alone never makes a reply automatic (a human may write "I'm on holiday, but interested").
 */
export function detectAutoReply(input: {
  subject: string;
  text: string;
  headers: HeaderMap;
  receivedAt: Date;
}): AutoReply | null {
  const headers = input.headers;
  let signal: string | null = null;
  const autoSubmitted = headers["auto-submitted"]?.trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") signal = "header auto-submitted";
  else if (headers["x-autoreply"] !== undefined) signal = "header x-autoreply";
  else if (headers["x-autorespond"] !== undefined) signal = "header x-autorespond";
  else if (/auto[_-]?reply/i.test(headers.precedence ?? "")) signal = "header precedence";
  else if (headers["x-auto-response-suppress"] !== undefined && AUTO_SUBJECT.test(input.subject)) {
    signal = "header x-auto-response-suppress";
  } else if (AUTO_SUBJECT.test(stripReplyPrefix(input.subject))) signal = "subject";
  if (!signal) return null;
  const outOfOffice = OOO_SUBJECT.test(input.subject) || OOO_BODY.test(input.text);
  return {
    outOfOffice,
    returnDate: extractReturnDate(input.text, input.receivedAt),
    signal,
  };
}

function stripReplyPrefix(subject: string): string {
  return subject.replace(/^\s*((re|aw|sv|antw|r|fw|fwd|wg|tr)\s*:\s*)+/i, "");
}

/** Bulk mail markers (newsletters, lists): never a personal reply. */
export function isBulkMail(headers: HeaderMap): boolean {
  return (
    /^(bulk|list|junk)$/i.test(headers.precedence?.trim() ?? "") ||
    headers["list-id"] !== undefined ||
    headers["list-unsubscribe"] !== undefined
  );
}

// --- Return dates ------------------------------------------------------------------------------

const MONTHS: Record<string, number> = {};
const monthNames: Array<[number, string[]]> = [
  [1, ["january", "jan", "januar", "jänner", "janvier", "enero"]],
  [2, ["february", "feb", "februar", "février", "fevrier", "febrero"]],
  [3, ["march", "mar", "märz", "maerz", "mars", "marzo"]],
  [4, ["april", "apr", "avril", "abril"]],
  [5, ["may", "mai", "mayo"]],
  [6, ["june", "jun", "juni", "juin", "junio"]],
  [7, ["july", "jul", "juli", "juillet", "julio"]],
  [8, ["august", "aug", "août", "aout", "agosto"]],
  [9, ["september", "sep", "sept", "septembre", "septiembre", "setiembre"]],
  [10, ["october", "oct", "oktober", "okt", "octobre", "octubre"]],
  [11, ["november", "nov", "novembre", "noviembre"]],
  [12, ["december", "dec", "dezember", "dez", "décembre", "decembre", "diciembre"]],
];
for (const [month, names] of monthNames) for (const name of names) MONTHS[name] = month;
const MONTH_PATTERN = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|");

const WEEKDAYS: Record<string, number> = {};
const weekdayNames: Array<[number, string[]]> = [
  [1, ["monday", "montag", "lundi", "lunes"]],
  [2, ["tuesday", "dienstag", "mardi", "martes"]],
  [3, ["wednesday", "mittwoch", "mercredi", "miércoles", "miercoles"]],
  [4, ["thursday", "donnerstag", "jeudi", "jueves"]],
  [5, ["friday", "freitag", "vendredi", "viernes"]],
  [6, ["saturday", "samstag", "samedi", "sábado", "sabado"]],
  [7, ["sunday", "sonntag", "dimanche", "domingo"]],
];
for (const [day, names] of weekdayNames) for (const name of names) WEEKDAYS[name] = day;
const WEEKDAY_PATTERN = Object.keys(WEEKDAYS).join("|");

/** Words after which the return date follows ("back on", "zurück am", "de retour le", ...). */
const RETURN_ANCHOR =
  /(?<!\p{L})(back|return(ing)?|returns|in the office|zur(ü|ue)ck|wieder (da|erreichbar|im b(ü|ue)ro)|retour|de retour|regreso|regresar(é|e)|volver(é|e)|vuelvo|estar(é|e) de vuelta)(?!\p{L})/giu;
const UNTIL_ANCHOR =
  /(?<!\p{L})(until|till|through|bis( zum| einschlie(ß|ss)lich)?|jusqu'?(au|à)|hasta( el)?)(?!\p{L})/giu;

interface FoundDate {
  date: string;
  index: number;
  /** Weekday names and slash dates without a year: only trusted right after an anchor word. */
  weak?: boolean;
}

function iso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Picks the year that puts month/day on or after `today` (dates without a year). */
function withYear(month: number, day: number, year: number | null, today: string): string | null {
  if (year !== null) return iso(year < 100 ? 2000 + year : year, month, day);
  const thisYear = Number(today.slice(0, 4));
  const candidate = iso(thisYear, month, day);
  if (candidate && candidate >= today) return candidate;
  return iso(thisYear + 1, month, day);
}

function findDates(text: string, today: string, dayFirst: boolean): FoundDate[] {
  const found: FoundDate[] = [];
  const push = (date: string | null, index: number, weak = false) => {
    if (date) found.push(weak ? { date, index, weak } : { date, index });
  };
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    push(iso(Number(m[1]), Number(m[2]), Number(m[3])), m.index ?? 0);
  }
  for (const m of text.matchAll(/\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})?(?!\d)/g)) {
    push(withYear(Number(m[2]), Number(m[1]), m[3] ? Number(m[3]) : null, today), m.index ?? 0);
  }
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const [month, day] = a > 12 ? [b, a] : b > 12 ? [a, b] : dayFirst ? [b, a] : [a, b];
    push(withYear(month, day, m[3] ? Number(m[3]) : null, today), m.index ?? 0, !m[3]);
  }
  const monthFirst = new RegExp(
    `\\b(${MONTH_PATTERN})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`,
    "gi",
  );
  for (const m of text.matchAll(monthFirst)) {
    const month = MONTHS[(m[1] ?? "").toLowerCase()];
    if (month) push(withYear(month, Number(m[2]), m[3] ? Number(m[3]) : null, today), m.index ?? 0);
  }
  const dayFirstNames = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th|er|\\.)?\\s+(?:of\\s+|de\\s+)?(${MONTH_PATTERN})\\.?(?:,?\\s+(?:de\\s+)?(\\d{4}))?`,
    "gi",
  );
  for (const m of text.matchAll(dayFirstNames)) {
    const month = MONTHS[(m[2] ?? "").toLowerCase()];
    if (month) push(withYear(month, Number(m[1]), m[3] ? Number(m[3]) : null, today), m.index ?? 0);
  }
  const weekday = new RegExp(`\\b(${WEEKDAY_PATTERN})\\b`, "gi");
  for (const m of text.matchAll(weekday)) {
    const target = WEEKDAYS[(m[1] ?? "").toLowerCase()];
    if (!target) continue;
    const current = isoWeekday(today);
    const ahead = (target - current + 7) % 7 || 7;
    push(addDays(today, ahead), m.index ?? 0, true);
  }
  return found;
}

/**
 * The return date an out-of-office text mentions (ISO date), within a year after `receivedAt`.
 * Prefers a date right after "back"/"return" words, then after "until", then the latest date.
 */
export function extractReturnDate(text: string, receivedAt: Date): string | null {
  const today = receivedAt.toISOString().slice(0, 10);
  const limit = addDays(today, 366);
  const sample = text.slice(0, 4000);
  const dayFirst = !/\b(back|return|until|office)\b/i.test(sample);
  const dates = findDates(sample, today, dayFirst).filter(
    (found) => found.date >= today && found.date <= limit,
  );
  if (dates.length === 0) return null;
  const after = (anchor: RegExp): string | null => {
    for (const match of sample.matchAll(anchor)) {
      const start = (match.index ?? 0) + match[0].length;
      const next = dates
        .filter((found) => found.index >= start && found.index - start <= 40)
        .sort((a, b) => a.index - b.index)[0];
      if (next) return next.date;
    }
    return null;
  };
  return (
    after(RETURN_ANCHOR) ??
    after(UNTIL_ANCHOR) ??
    dates
      .filter((found) => !found.weak)
      .map((found) => found.date)
      .sort()
      .at(-1) ??
    null
  );
}
