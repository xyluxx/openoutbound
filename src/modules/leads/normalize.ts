/**
 * Normalization of lead data (emails, domains, websites, LinkedIn URLs, countries, names,
 * employee counts). Every write path (imports, find, API, enrichment) goes through these so
 * dedupe keys are stable.
 */
import { normalizeDomain, normalizeLinkedinUrl, splitName } from "../../lib/web/extract.js";
import { normalizeCountry } from "./countries.js";
import { isFreeMailDomain } from "./free-mail.js";

export { normalizeCountry } from "./countries.js";
export { isFreeMailDomain } from "./free-mail.js";

const EMPTY_VALUES = new Set([
  "",
  "-",
  "--",
  "n/a",
  "na",
  "null",
  "none",
  "undefined",
  "nan",
  "#n/a",
]);

/** Trimmed text, or null for empty and placeholder values ("", "-", "N/A", "null"). */
export function cleanText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const text = String(value).replace(/\s+/g, " ").trim();
  return EMPTY_VALUES.has(text.toLowerCase()) ? null : text;
}

const EMAIL_SHAPE =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Lowercase, trimmed email or null when it is not a plausible address. Accepts
 * "mailto:x@y.com", "<x@y.com>" and "Dana Reyes <x@y.com>". Unicode domains become punycode.
 */
export function normalizeEmail(input: unknown): string | null {
  const text = cleanText(input);
  if (!text) return null;
  let value = text;
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(value);
  if (angle?.[1]) value = angle[1];
  value = (value.replace(/^mailto:/i, "").split("?")[0] ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "");
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return null;
  const local = value.slice(0, at);
  let domain = value.slice(at + 1);
  if (/[^\p{ASCII}]/u.test(domain)) {
    try {
      domain = new URL(`http://${domain}`).hostname;
    } catch {
      return null;
    }
  }
  const email = `${local}@${domain}`;
  if (local.length > 64 || email.length > 254) return null;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  return EMAIL_SHAPE.test(email) ? email : null;
}

/** Domain part of a normalized email. */
export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  return at === -1 ? null : email.slice(at + 1).toLowerCase() || null;
}

/** Local part of an email ("dana.reyes@x.com" -> "dana.reyes"). */
export function emailLocalPart(email: string): string {
  return email.slice(0, email.lastIndexOf("@"));
}

/**
 * Website URL with a scheme ("www.example.com/about" -> "https://www.example.com/about") and
 * its bare domain. Null parts for garbage.
 */
export function normalizeWebsite(input: unknown): {
  website: string | null;
  domain: string | null;
} {
  const text = cleanText(input);
  if (!text || /\s/.test(text) || text.includes("@")) return { website: null, domain: null };
  const domain = normalizeDomain(text);
  if (!domain) return { website: null, domain: null };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let website: string;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return { website: null, domain: null };
    url.hash = "";
    website = url.toString().replace(/\/$/, "");
  } catch {
    return { website: null, domain: null };
  }
  return { website, domain };
}

/**
 * The company domain from whatever is known, in order: explicit domain, website, work email.
 * Free-mail domains (gmail.com, outlook.com, ...) never count.
 */
export function companyDomainFrom(input: {
  domain?: unknown;
  website?: unknown;
  email?: string | null;
}): string | null {
  for (const candidate of [input.domain, input.website]) {
    const text = cleanText(candidate);
    const domain = text ? normalizeDomain(text) : null;
    if (domain && !isFreeMailDomain(domain)) return domain;
  }
  const fromEmail = emailDomain(input.email ?? null);
  return fromEmail && !isFreeMailDomain(fromEmail) ? fromEmail : null;
}

/**
 * Person LinkedIn URL as `https://www.linkedin.com/in/<slug>`: strips query, fragment,
 * sub-pages, trailing slashes and locale subdomains, and converts legacy
 * `/pub/<name>/<a>/<b>/<c>` URLs to `/in/<name>-<c><b><a>`. Null for company pages and junk.
 */
export function normalizePersonLinkedin(input: unknown): string | null {
  const text = cleanText(input);
  if (!text) return null;
  const legacy =
    /linkedin\.com\/pub\/([^/?#]+)\/([0-9a-z]{1,3})\/([0-9a-z]{1,3})\/([0-9a-z]{1,3})/i.exec(text);
  if (legacy) {
    const [, name, a, b, c] = legacy;
    const suffix = `${(c ?? "").padStart(3, "0")}${(b ?? "").padStart(3, "0")}${(a ?? "").padStart(2, "0")}`;
    return normalizeLinkedinUrl(`https://www.linkedin.com/in/${name}-${suffix}`);
  }
  const url = normalizeLinkedinUrl(text);
  return url?.startsWith("https://www.linkedin.com/in/") ? url : null;
}

/** Company LinkedIn URL as `https://www.linkedin.com/company/<slug>`, or null. */
export function normalizeCompanyLinkedin(input: unknown): string | null {
  const text = cleanText(input);
  if (!text) return null;
  const url = normalizeLinkedinUrl(text);
  return url?.startsWith("https://www.linkedin.com/company/") ? url : null;
}

/** First, last and full name from whichever parts are known. */
export function buildNames(input: {
  first_name?: unknown;
  last_name?: unknown;
  full_name?: unknown;
}): { first_name: string | null; last_name: string | null; full_name: string | null } {
  let first = cleanText(input.first_name);
  let last = cleanText(input.last_name);
  const full = cleanText(input.full_name);
  if ((!first || !last) && full) {
    const split = splitName(full);
    first ??= split.first_name;
    if (!last && split.first_name && split.last_name) last = split.last_name;
  }
  const joined = [first, last].filter(Boolean).join(" ");
  return { first_name: first, last_name: last, full_name: full ?? (joined || null) };
}

/** Phone as given, trimmed; null when it has fewer than 5 digits. */
export function normalizePhone(input: unknown): string | null {
  const text = cleanText(input);
  if (!text) return null;
  return (text.match(/\d/g)?.length ?? 0) >= 5 ? text : null;
}

/** Tags from a list or a comma/semicolon separated string: trimmed, lowercase, unique. */
export function normalizeTags(input: unknown): string[] {
  const values = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(/[,;|]/)
      : [];
  const out: string[] = [];
  for (const value of values) {
    const tag = cleanText(value)?.toLowerCase();
    if (tag && tag.length <= 60 && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/**
 * Employee count or range from "25", "11-50", "1,001-5,000", "10000+", "51 to 200".
 * A range also yields its midpoint as an estimate (count stays null).
 */
export function parseEmployees(input: unknown): {
  count: number | null;
  range: string | null;
  estimate: number | null;
} {
  const text = cleanText(input);
  if (!text) return { count: null, range: null, estimate: null };
  const cleaned = text.replace(/(\d)[,.](\d{3})/g, "$1$2").toLowerCase();
  const range = /(\d+)\s*(?:-|to|\u2013)\s*(\d+)/.exec(cleaned);
  if (range) {
    const min = Number(range[1]);
    const max = Number(range[2]);
    if (max >= min)
      return { count: null, range: `${min}-${max}`, estimate: Math.round((min + max) / 2) };
  }
  const plus = /^(\d+)\s*\+$/.exec(cleaned);
  if (plus) return { count: null, range: `${plus[1]}+`, estimate: Number(plus[1]) };
  const single = /^(\d+)$/.exec(cleaned);
  if (single) return { count: Number(single[1]), range: null, estimate: Number(single[1]) };
  return { count: null, range: null, estimate: null };
}

/** Midpoint estimate for a stored employee range ("11-50" -> 31, "10000+" -> 10000). */
export function employeeEstimate(company: {
  employee_count?: number | null;
  employee_range?: string | null;
}): number | null {
  if (typeof company.employee_count === "number") return company.employee_count;
  return parseEmployees(company.employee_range).estimate;
}

/** true/false from "yes", "true", "1", "x", "ja", "oui", "si" and their negatives; null otherwise. */
export function parseBoolean(input: unknown): boolean | null {
  if (typeof input === "boolean") return input;
  if (typeof input === "number") return input !== 0;
  const text = cleanText(input)?.toLowerCase();
  if (!text) return null;
  if (
    [
      "yes",
      "y",
      "true",
      "1",
      "x",
      "ja",
      "oui",
      "si",
      "sí",
      "granted",
      "opt-in",
      "opted in",
    ].includes(text)
  )
    return true;
  if (["no", "n", "false", "0", "nein", "non", "denied", "opt-out", "opted out"].includes(text))
    return false;
  return null;
}

/** Integer from "1998", 1998 or "1,200"; null otherwise. */
export function parseInteger(input: unknown): number | null {
  if (typeof input === "number") return Number.isFinite(input) ? Math.round(input) : null;
  const text = cleanText(input)?.replace(/(\d)[,.](\d{3})\b/g, "$1$2");
  if (!text || !/^-?\d+$/.test(text)) return null;
  return Number(text);
}

/** US state and territory codes, for "City, ST" locations. */
const US_STATES = new Set(
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR".split(
    " ",
  ),
);

/**
 * Splits a free-text location ("Berlin, Germany", "Austin, TX, United States") into city,
 * region and ISO-2 country. Ambiguous two-letter tails ("Berlin, DE" could be Delaware)
 * leave the country null rather than guess.
 */
export function parseLocation(input: unknown): {
  city: string | null;
  region: string | null;
  country: string | null;
} {
  const text = cleanText(input);
  if (!text) return { city: null, region: null, country: null };
  const parts = text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 1) {
    const country = normalizeCountry(parts[0]);
    return country
      ? { city: null, region: null, country }
      : { city: parts[0] ?? null, region: null, country: null };
  }
  const last = parts.at(-1) ?? "";
  const isTwoLetters = /^[A-Za-z]{2}$/.test(last);
  if (parts.length === 2 && isTwoLetters) {
    const upper = last.toUpperCase();
    const state = US_STATES.has(upper);
    const country = normalizeCountry(upper);
    if (state && !country) return { city: parts[0] ?? null, region: upper, country: "US" };
    if (state && country) return { city: parts[0] ?? null, region: upper, country: null };
    return { city: parts[0] ?? null, region: null, country };
  }
  const country = normalizeCountry(last);
  if (country) {
    const rest = parts.slice(0, -1);
    return {
      city: rest[0] ?? null,
      region: rest.length > 1 ? (rest.at(-1) ?? null) : null,
      country,
    };
  }
  return { city: parts[0] ?? null, region: parts.slice(1).join(", ") || null, country: null };
}
