/**
 * Country names and codes to ISO 3166-1 alpha-2. Names come from the runtime's ICU data
 * (Intl.DisplayNames) in several languages, plus common aliases and alpha-3 codes.
 */

/** Region codes Intl knows that are not current ISO 3166-1 countries. */
const NOT_COUNTRIES = new Set([
  "AC",
  "AN",
  "BU",
  "CP",
  "CQ",
  "CS",
  "DD",
  "DG",
  "EA",
  "EU",
  "EZ",
  "FX",
  "IC",
  "QO",
  "SU",
  "TA",
  "TP",
  "UN",
  "XA",
  "XB",
  "YD",
  "YU",
  "ZR",
  "ZZ",
]);

const NAME_LOCALES = ["en", "de", "fr", "es", "it", "nl", "pt", "pl", "sv", "da"];

const ALIASES: Record<string, string> = {
  usa: "US",
  "u s a": "US",
  "u s": "US",
  us: "US",
  america: "US",
  "united states of america": "US",
  "the united states": "US",
  uk: "GB",
  "u k": "GB",
  "great britain": "GB",
  britain: "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "northern ireland": "GB",
  "united kingdom of great britain and northern ireland": "GB",
  holland: "NL",
  "the netherlands": "NL",
  uae: "AE",
  "czech republic": "CZ",
  korea: "KR",
  "republic of korea": "KR",
  "south korea": "KR",
  "north korea": "KP",
  russia: "RU",
  "russian federation": "RU",
  turkey: "TR",
  "ivory coast": "CI",
  "cote d ivoire": "CI",
  macedonia: "MK",
  swaziland: "SZ",
  burma: "MM",
  myanmar: "MM",
  "cape verde": "CV",
  "hong kong": "HK",
  macau: "MO",
  macao: "MO",
  "dr congo": "CD",
  drc: "CD",
  "democratic republic of the congo": "CD",
  "republic of the congo": "CG",
  "vatican city": "VA",
  "holy see": "VA",
  palestine: "PS",
  taiwan: "TW",
  "viet nam": "VN",
  "people s republic of china": "CN",
  prc: "CN",
  bosnia: "BA",
  trinidad: "TT",
  "the bahamas": "BS",
  "the gambia": "GM",
};

/** Common ISO 3166-1 alpha-3 codes (exports from CRMs and data vendors). */
const ALPHA3: Record<string, string> = {
  USA: "US",
  GBR: "GB",
  DEU: "DE",
  AUT: "AT",
  CHE: "CH",
  FRA: "FR",
  ESP: "ES",
  ITA: "IT",
  NLD: "NL",
  BEL: "BE",
  LUX: "LU",
  CAN: "CA",
  AUS: "AU",
  NZL: "NZ",
  IRL: "IE",
  SWE: "SE",
  NOR: "NO",
  DNK: "DK",
  FIN: "FI",
  ISL: "IS",
  POL: "PL",
  PRT: "PT",
  CZE: "CZ",
  HUN: "HU",
  ROU: "RO",
  BGR: "BG",
  GRC: "GR",
  HRV: "HR",
  SVN: "SI",
  SVK: "SK",
  EST: "EE",
  LVA: "LV",
  LTU: "LT",
  BRA: "BR",
  MEX: "MX",
  ARG: "AR",
  CHL: "CL",
  COL: "CO",
  PER: "PE",
  IND: "IN",
  JPN: "JP",
  CHN: "CN",
  KOR: "KR",
  SGP: "SG",
  HKG: "HK",
  TWN: "TW",
  ARE: "AE",
  SAU: "SA",
  ISR: "IL",
  TUR: "TR",
  ZAF: "ZA",
  NGA: "NG",
  KEN: "KE",
  EGY: "EG",
  UKR: "UA",
  RUS: "RU",
  PHL: "PH",
  IDN: "ID",
  MYS: "MY",
  THA: "TH",
  VNM: "VN",
};

let lookup: Map<string, string> | undefined;
let codes: Set<string> | undefined;

/** Lowercase, no accents, no punctuation, single spaces ("Côte d'Ivoire" -> "cote d ivoire"). */
export function countryKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function countryCodes(): Set<string> {
  if (codes) return codes;
  const english = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
  const found = new Set<string>();
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      if (NOT_COUNTRIES.has(code)) continue;
      if (english.of(code)) found.add(code);
    }
  }
  codes = found;
  return found;
}

function buildLookup(): Map<string, string> {
  const map = new Map<string, string>();
  const all = countryCodes();
  for (const locale of NAME_LOCALES) {
    const names = new Intl.DisplayNames([locale], { type: "region", fallback: "none" });
    for (const code of all) {
      const name = names.of(code);
      if (!name) continue;
      const key = countryKey(name);
      if (key && !map.has(key)) map.set(key, code);
      // "Myanmar (Burma)" -> also "myanmar"; "Hong Kong SAR China" handled by aliases.
      const bare = countryKey(name.replace(/\(.*?\)/g, ""));
      if (bare && !map.has(bare)) map.set(bare, code);
    }
  }
  for (const [alias, code] of Object.entries(ALIASES)) map.set(countryKey(alias), code);
  return map;
}

/** True for a current ISO 3166-1 alpha-2 code (uppercase), e.g. "DE". */
export function isCountryCode(value: string): boolean {
  return /^[A-Z]{2}$/.test(value) && countryCodes().has(value);
}

/**
 * ISO 3166-1 alpha-2 code for a country name or code in common languages ("Germany",
 * "Deutschland", "DEU", "de", "U.S.A.", "UK"). Null when unknown or ambiguous.
 */
export function normalizeCountry(input: string | null | undefined): string | null {
  if (!input) return null;
  const raw = input.trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (upper === "UK") return "GB";
  if (/^[A-Z]{2}$/i.test(raw) && isCountryCode(upper)) return upper;
  if (/^[A-Z]{3}$/i.test(raw) && ALPHA3[upper]) return ALPHA3[upper] ?? null;
  lookup ??= buildLookup();
  return lookup.get(countryKey(raw)) ?? null;
}

/** English display name for an ISO-2 code ("DE" -> "Germany"), for providers that want names. */
export function countryName(code: string): string {
  const names = new Intl.DisplayNames(["en"], { type: "region", fallback: "code" });
  return names.of(code.toUpperCase()) ?? code;
}
