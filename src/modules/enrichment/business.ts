/**
 * Business facts from a company's own website: name, postal address and phone. Sources, best
 * first: schema.org JSON-LD (Organization, LocalBusiness and subtypes), og:site_name and the
 * page title for the name, tel: links for the phone, <address> blocks and imprint-style
 * address lines. Used to fill companies imported from Google Maps without storing Google's
 * content (see providers/lead-source/google-maps.ts). Web pages are untrusted input: every
 * value is trimmed and length-capped and nothing here follows instructions.
 */
import { load } from "cheerio";
import { normalizeCountry, normalizePhone } from "../leads/normalize.js";

export interface BusinessDetails {
  name: string | null;
  /** One line, e.g. "12 Harbor Rd, 78701 Austin". */
  address: string | null;
  city: string | null;
  postal_code: string | null;
  region: string | null;
  /** ISO 3166-1 alpha-2. */
  country: string | null;
  phone: string | null;
  /** Page the details were read from. */
  source_url: string | null;
}

export function emptyBusinessDetails(): BusinessDetails {
  return {
    name: null,
    address: null,
    city: null,
    postal_code: null,
    region: null,
    country: null,
    phone: null,
    source_url: null,
  };
}

const BUSINESS_TYPE =
  /(organization|organisation|business|corporation|store|shop|dentist|physician|clinic|practice|office|agency|restaurant|hotel|service|firm|attorney|legal|medical|company|brand|contractor|plumber|electrician|salon|spa|center|centre)/i;

const GENERIC_TITLE_PARTS = new Set([
  "home",
  "homepage",
  "home page",
  "start",
  "startseite",
  "welcome",
  "willkommen",
  "accueil",
  "inicio",
  "benvenuti",
  "index",
  "official site",
  "official website",
]);

// Title separators: | : - middle dot, bullet, en dash (built from code points).
const SEPARATOR_CHARS = [
  "|",
  ":",
  "\\-",
  ...[0xb7, 0x2022, 0x2013].map((c) => String.fromCharCode(c)),
];
const TITLE_SEPARATOR = new RegExp(`\\s+[${SEPARATOR_CHARS.join("")}]\\s+`);

function clean(value: unknown, max = 200): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function typesOf(node: Record<string, unknown>): string[] {
  const type = node["@type"];
  if (typeof type === "string") return [type];
  return Array.isArray(type) ? type.filter((t): t is string => typeof t === "string") : [];
}

/** Every object in a JSON-LD document (arrays and @graph flattened, one level of nesting). */
function nodesOf(value: unknown, depth = 0): Array<Record<string, unknown>> {
  if (depth > 3 || !value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item) => nodesOf(item, depth + 1));
  const node = value as Record<string, unknown>;
  const out = [node];
  if (Array.isArray(node["@graph"])) out.push(...nodesOf(node["@graph"], depth + 1));
  return out;
}

function countryOf(value: unknown): string | null {
  if (value && typeof value === "object") {
    return countryOf((value as Record<string, unknown>).name);
  }
  const text = clean(value, 60);
  return text ? normalizeCountry(text) : null;
}

function fromPostalAddress(value: unknown): Partial<BusinessDetails> {
  if (typeof value === "string") return { address: clean(value) };
  if (!value || typeof value !== "object") return {};
  const node = (Array.isArray(value) ? value[0] : value) as Record<string, unknown> | undefined;
  if (!node || typeof node !== "object") return {};
  const street = clean(node.streetAddress);
  const postal = clean(node.postalCode, 20);
  const city = clean(node.addressLocality, 80);
  const region = clean(node.addressRegion, 80);
  const place = [postal, city].filter(Boolean).join(" ");
  const address = [street, place].filter(Boolean).join(", ") || null;
  return { address, city, postal_code: postal, region, country: countryOf(node.addressCountry) };
}

function validPhone(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length < 6 || digits.length > 16) return null;
  return normalizePhone(value) ?? value;
}

function nameFromTitle(title: string | null): string | null {
  if (!title) return null;
  const parts = title
    .split(TITLE_SEPARATOR)
    .map((part) => part.trim())
    .filter((part) => part && !GENERIC_TITLE_PARTS.has(part.toLowerCase()));
  return clean(parts[0] ?? null, 120);
}

const POSTAL_CITY = /^(\d{4,5})\s+([\p{L}][\p{L} .'()-]{1,40})$/u;
const STREET = /^[\p{L}][\p{L} .'-]*\s\d+\s?[a-z]?(?:[-/]\d+[a-z]?)?$/iu;
const US_CITY_LINE = /^([\p{L}][\p{L} .'-]{1,40}),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?$/u;

/** Address from imprint-style lines ("Main Street 5" then "12345 City", or "City, ST 12345"). */
export function addressFromLines(text: string): Partial<BusinessDetails> {
  const lines = text
    .split(/\n|<br\s*\/?>/i)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 400);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const eu = POSTAL_CITY.exec(line);
    if (eu) {
      const previous = lines[i - 1];
      const street = previous && STREET.test(previous) ? previous : null;
      return {
        address: [street, `${eu[1]} ${eu[2]}`].filter(Boolean).join(", "),
        postal_code: eu[1] ?? null,
        city: clean(eu[2], 80),
      };
    }
    const us = US_CITY_LINE.exec(line);
    if (us) {
      const previous = lines[i - 1];
      const street = previous && /\d/.test(previous) && previous.length <= 80 ? previous : null;
      return {
        address: [street, line].filter(Boolean).join(", "),
        city: clean(us[1], 80),
        region: us[2] ?? null,
        postal_code: us[3] ?? null,
        country: "US",
      };
    }
  }
  return {};
}

/** Fills empty fields of `into` from `from`. */
export function mergeBusinessDetails(
  into: BusinessDetails,
  from: Partial<BusinessDetails>,
  sourceUrl: string,
): BusinessDetails {
  const next = { ...into };
  let used = false;
  for (const key of [
    "name",
    "address",
    "city",
    "postal_code",
    "region",
    "country",
    "phone",
  ] as const) {
    const value = from[key];
    if (!next[key] && value) {
      next[key] = value;
      used = true;
    }
  }
  if (used && !next.source_url) next.source_url = sourceUrl;
  return next;
}

/** Business facts found on one page (fields stay null when the page does not say). */
export function extractBusinessDetails(html: string, pageUrl: string): BusinessDetails {
  const $ = load(html);
  let details = emptyBusinessDetails();
  $('script[type="application/ld+json"]').each((_, element) => {
    let json: unknown;
    try {
      json = JSON.parse($(element).text());
    } catch {
      return;
    }
    for (const node of nodesOf(json)) {
      const types = typesOf(node);
      const looksLikeBusiness =
        types.some((type) => BUSINESS_TYPE.test(type)) ||
        (types.length === 0 && (node.address !== undefined || node.telephone !== undefined));
      if (
        !looksLikeBusiness ||
        types.some((type) => /^(WebSite|WebPage|BreadcrumbList)$/i.test(type))
      )
        continue;
      details = mergeBusinessDetails(
        details,
        {
          name: clean(node.legalName, 120) ?? clean(node.name, 120),
          phone: validPhone(clean(node.telephone, 40)),
          ...fromPostalAddress(node.address),
        },
        pageUrl,
      );
    }
  });

  const siteName = clean($('meta[property="og:site_name"]').attr("content"), 120);
  const title = nameFromTitle(clean($("title").first().text(), 200));
  details = mergeBusinessDetails(details, { name: siteName ?? title }, pageUrl);

  const tel = $('a[href^="tel:"]').first().attr("href");
  if (tel) {
    let number = tel.slice(4);
    try {
      number = decodeURIComponent(number);
    } catch {
      // keep the raw value
    }
    details = mergeBusinessDetails(details, { phone: validPhone(clean(number, 40)) }, pageUrl);
  }

  if (!details.address) {
    const block = $("address").first();
    if (block.length > 0) {
      block.find("br").replaceWith("\n");
      const fromBlock = addressFromLines(block.text());
      details = mergeBusinessDetails(details, fromBlock, pageUrl);
    }
  }
  if (!details.address) {
    $("br").replaceWith("\n");
    $("p, div, li, td").each((_, element) => {
      $(element).prepend("\n").append("\n");
    });
    $("script, style, noscript").remove();
    details = mergeBusinessDetails(details, addressFromLines($("body").text()), pageUrl);
  }
  return details;
}
