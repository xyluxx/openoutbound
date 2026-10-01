/**
 * Invented names, built from small syllable lists rather than hand-written blobs. Nothing here
 * is a real person, business or place; overlaps with real words are coincidental.
 */
import type { Rng } from "./rng.js";

const FIRST_START = [
  "Da",
  "Mi",
  "Jo",
  "Lu",
  "El",
  "An",
  "Ka",
  "To",
  "Ri",
  "Sa",
  "Ni",
  "Be",
  "Ol",
  "Ar",
  "Ev",
  "Ya",
  "Ce",
  "Ro",
  "Ma",
  "Fi",
];
const FIRST_END = [
  "na",
  "ra",
  "el",
  "an",
  "son",
  "ley",
  "vin",
  "eth",
  "mar",
  "lia",
  "din",
  "ka",
  "ren",
  "mon",
  "ita",
  "as",
  "nor",
  "wen",
  "iel",
  "yn",
];

/** Slightly different sound so DE/AT people read as such without being real names. */
const FIRST_START_DE = ["Ma", "Jo", "Le", "Ni", "Ka", "To", "An", "El", "Fr", "Ste"];
const FIRST_END_DE = ["thias", "hann", "na", "klas", "trin", "bias", "ke", "ike", "anz", "fanie"];

const LAST_START = [
  "Rey",
  "Had",
  "Nai",
  "Bec",
  "Chen",
  "Nov",
  "Bel",
  "Lar",
  "Kess",
  "Mor",
  "Vand",
  "Sor",
  "Whit",
  "Green",
  "Stone",
  "Field",
];
const LAST_END = [
  "es",
  "dad",
  "r",
  "ker",
  "",
  "ak",
  "lo",
  "sen",
  "ler",
  "gan",
  "ley",
  "ren",
  "ford",
  "wood",
  "brook",
  "ridge",
];

const LAST_START_DE = ["Bau", "Hoff", "Sch", "Wei", "Krü", "Zim", "Lang", "Fisch"];
const LAST_END_DE = ["mann", "mann", "midt", "ner", "gel", "mer", "er", "bach"];

export interface WorldName {
  first_name: string;
  last_name: string;
  full_name: string;
}

/** Builds an invented full name. `flavor` picks the syllable sets (a light regional accent). */
export function buildName(rng: Rng, flavor: "generic" | "de_at" = "generic"): WorldName {
  const firstStart = flavor === "de_at" ? FIRST_START_DE : FIRST_START;
  const firstEnd = flavor === "de_at" ? FIRST_END_DE : FIRST_END;
  const lastStart = flavor === "de_at" ? LAST_START_DE : LAST_START;
  const lastEnd = flavor === "de_at" ? LAST_END_DE : LAST_END;
  const first_name = rng.pick(firstStart) + rng.pick(firstEnd);
  const last_name = rng.pick(lastStart) + rng.pick(lastEnd);
  return { first_name, last_name, full_name: `${first_name} ${last_name}` };
}

/** Lowercase, hyphenated, ASCII-only slug for domains and LinkedIn handles. */
export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// --- Companies -------------------------------------------------------------------------------

/** Word roots for invented direct-to-consumer e-commerce brand names. */
export const ECOMMERCE_BRAND_WORDS = [
  "Lumen",
  "Harbor",
  "Cedar",
  "Bluefield",
  "Brightline",
  "Oakridge",
  "Summit",
  "Vantage",
  "Clearpath",
  "Silverline",
  "Ridgeway",
  "Fieldstone",
  "Windmere",
  "Truenorth",
  "Ashgrove",
  "Rivermark",
  "Cobalt",
  "Northgate",
  "Palefox",
  "Amberly",
  "Driftwood",
  "Kindled",
  "Maple & Co",
  "Norrland",
  "Verdant",
  "Highbank",
  "Coppervale",
  "Wrenfield",
  "Solace",
  "Basecamp",
  "Fernwood",
  "Glowpoint",
  "Hearthstone",
  "Ironvale",
  "Loomis",
  "Meridian",
];
export const ECOMMERCE_BRAND_SUFFIXES = [
  "Home",
  "Goods",
  "Supply Co.",
  "Apparel",
  "Gear",
  "Living",
  "Outfitters",
  "Provisions",
  "Collective",
  "Trading Co.",
  "Studio",
  "Kitchen",
];

/** Naming pieces for invented dental clinics (local businesses). */
export const DENTAL_NAME_WORDS = [
  "Cedar",
  "Harbor",
  "Northwind",
  "Bluebonnet",
  "Summit",
  "Riverside",
  "Oakridge",
  "Brightline",
  "Lonestar",
  "Sunridge",
  "Willowbrook",
  "Highland",
  "Pinecrest",
  "Meadowview",
  "Silverleaf",
  "Fieldstone",
  "Cypress",
  "Bayview",
  "Stonegate",
  "Maple",
];
export const DENTAL_NAME_SUFFIXES = [
  "Family Dental",
  "Dental Care",
  "Dental Group",
  "Smiles",
  "Dental Studio",
  "Modern Dentistry",
  "Dental Associates",
];

export interface WorldCity {
  city: string;
  region: string;
  country: string;
  timezone: string;
}

/** US cities used for the local-business (dental) world; enough spread for timezone variety. */
export const US_CITIES: WorldCity[] = [
  { city: "Austin", region: "TX", country: "US", timezone: "America/Chicago" },
  { city: "San Antonio", region: "TX", country: "US", timezone: "America/Chicago" },
  { city: "Denver", region: "CO", country: "US", timezone: "America/Denver" },
  { city: "Phoenix", region: "AZ", country: "US", timezone: "America/Phoenix" },
  { city: "Tampa", region: "FL", country: "US", timezone: "America/New_York" },
  { city: "Columbus", region: "OH", country: "US", timezone: "America/New_York" },
  { city: "Portland", region: "OR", country: "US", timezone: "America/Los_Angeles" },
  { city: "Raleigh", region: "NC", country: "US", timezone: "America/New_York" },
  { city: "Sacramento", region: "CA", country: "US", timezone: "America/Los_Angeles" },
  { city: "Kansas City", region: "MO", country: "US", timezone: "America/Chicago" },
];

/** Wider spread of countries for the SaaS/e-commerce world (exercises timezone + consent rules). */
export const GLOBAL_CITIES: WorldCity[] = [
  { city: "Austin", region: "TX", country: "US", timezone: "America/Chicago" },
  { city: "Chicago", region: "IL", country: "US", timezone: "America/Chicago" },
  { city: "Brooklyn", region: "NY", country: "US", timezone: "America/New_York" },
  { city: "Denver", region: "CO", country: "US", timezone: "America/Denver" },
  { city: "Seattle", region: "WA", country: "US", timezone: "America/Los_Angeles" },
  { city: "Toronto", region: "ON", country: "CA", timezone: "America/Toronto" },
  { city: "London", region: "England", country: "GB", timezone: "Europe/London" },
  { city: "Manchester", region: "England", country: "GB", timezone: "Europe/London" },
  { city: "Berlin", region: "Berlin", country: "DE", timezone: "Europe/Berlin" },
  { city: "Munich", region: "Bavaria", country: "DE", timezone: "Europe/Berlin" },
  { city: "Vienna", region: "Vienna", country: "AT", timezone: "Europe/Vienna" },
  { city: "Amsterdam", region: "North Holland", country: "NL", timezone: "Europe/Amsterdam" },
  { city: "Sydney", region: "NSW", country: "AU", timezone: "Australia/Sydney" },
];
