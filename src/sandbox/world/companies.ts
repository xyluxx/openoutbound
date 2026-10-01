/**
 * The world's companies: invented direct-to-consumer e-commerce brands (Northwind's ICP) and
 * invented local dental clinics (Brightsmile's ICP). `seeded` marks the subset inserted directly
 * into the workspace at seed time; the rest exist only for the sandbox lead_source provider to
 * "discover" through search, so `find_leads` has something new to import.
 */
import type { CompanyStatus } from "../../core/enums.js";
import type { FitReason } from "../../db/schema/index.js";
import {
  DENTAL_NAME_SUFFIXES,
  DENTAL_NAME_WORDS,
  ECOMMERCE_BRAND_SUFFIXES,
  ECOMMERCE_BRAND_WORDS,
  GLOBAL_CITIES,
  slugify,
  US_CITIES,
  type WorldCity,
} from "./names.js";
import type { Rng } from "./rng.js";

export type WorldSegment = "ecommerce" | "dental";

export interface WorldCompany {
  /** Stable key used to link people, signals and canned pages to this company (its domain). */
  key: string;
  segment: WorldSegment;
  name: string;
  domain: string;
  website: string;
  linkedin_url: string;
  industry: string;
  description: string;
  employee_count: number;
  employee_range: string;
  founded_year: number;
  country: string;
  region: string;
  city: string;
  address: string | null;
  postal_code: string | null;
  phone: string;
  timezone: string;
  technologies: string[];
  tags: string[];
  custom: Record<string, unknown>;
  source: string;
  source_refs: Record<string, string>;
  status: CompanyStatus;
  /** Scored against the workspace's default ICP once the world is built (world/index.ts). */
  fit_score: number | null;
  fit_reasons: FitReason[];
  /** Recomputed from the world's signals once they are built (see world/index.ts). */
  intent_score: number;
  categories?: string[];
  rating?: number;
  reviews_count?: number;
  /** Already imported into the workspace at seed time (vs. search-only, for `find_leads`). */
  seeded: boolean;
}

const ECOMMERCE_INDUSTRIES = [
  "Home goods e-commerce",
  "Apparel e-commerce",
  "Consumer electronics e-commerce",
  "Outdoor and sporting goods e-commerce",
  "Beauty and personal care e-commerce",
  "Food and beverage e-commerce",
];
const ECOMMERCE_TECH = [
  "Shopify",
  "Shopify Plus",
  "NetSuite",
  "Klaviyo",
  "ShipBob",
  "Recharge",
  "BigCommerce",
  "ChannelAdvisor",
  "Gorgias",
  "Loop Returns",
];
const EMPLOYEE_BANDS: Array<{ range: string; min: number; max: number }> = [
  { range: "20-49", min: 20, max: 49 },
  { range: "50-99", min: 50, max: 99 },
  { range: "100-249", min: 100, max: 249 },
  { range: "250-500", min: 250, max: 500 },
];

function employeeBand(rng: Rng): { range: string; count: number } {
  const band = rng.pick(EMPLOYEE_BANDS);
  return { range: band.range, count: rng.int(band.min, band.max) };
}

function phoneFor(rng: Rng, country: string): string {
  if (country === "US" || country === "CA")
    return `+1-${rng.int(200, 989)}-555-${rng.int(1000, 9999)}`;
  if (country === "GB") return `+44 20 7${rng.int(100, 999)} ${rng.int(1000, 9999)}`;
  if (country === "DE") return `+49 30 ${rng.int(1000000, 9999999)}`;
  if (country === "AT") return `+43 1 ${rng.int(1000000, 9999999)}`;
  if (country === "NL") return `+31 20 ${rng.int(1000000, 9999999)}`;
  return `+61 2 ${rng.int(1000, 9999)} ${rng.int(1000, 9999)}`;
}

/** Builds the direct-to-consumer e-commerce world (Northwind Analytics' ICP). */
export function buildEcommerceCompanies(
  rng: Rng,
  total: number,
  seededCount: number,
): WorldCompany[] {
  const usedNames = new Set<string>();
  const companies: WorldCompany[] = [];
  for (let i = 0; i < total; i++) {
    let brand = "";
    let domain = "";
    do {
      const word = rng.pick(ECOMMERCE_BRAND_WORDS);
      const suffix = rng.pick(ECOMMERCE_BRAND_SUFFIXES);
      brand = `${word} ${suffix}`;
      domain = `${slugify(`${word}${suffix}`)}.example.com`;
    } while (usedNames.has(domain));
    usedNames.add(domain);

    const place: WorldCity = rng.pick(GLOBAL_CITIES);
    const { range, count } = employeeBand(rng);
    const industry = rng.pick(ECOMMERCE_INDUSTRIES);
    const seeded = i < seededCount;
    const isCompetitor = seeded && i === Math.floor(seededCount / 2);
    const founded = rng.int(2012, 2022);

    companies.push({
      key: domain,
      segment: "ecommerce",
      name: brand,
      domain,
      website: `https://${domain}`,
      linkedin_url: `https://www.linkedin.com/company/${slugify(brand)}`,
      industry: isCompetitor ? "Inventory forecasting software" : industry,
      description: isCompetitor
        ? `${brand} sells demand-planning software that competes directly with Northwind Analytics.`
        : `${brand} is a ${industry.toLowerCase()} brand selling direct to consumers online, founded in ${founded}.`,
      employee_count: count,
      employee_range: range,
      founded_year: founded,
      country: place.country,
      region: place.region,
      city: place.city,
      address: null,
      postal_code: null,
      phone: phoneFor(rng, place.country),
      timezone: place.timezone,
      technologies: rng.pickN(ECOMMERCE_TECH, rng.int(2, 4)),
      tags: isCompetitor ? ["competitor"] : [],
      custom: {},
      source: "apollo",
      source_refs: { apollo: `sbx_org_${i.toString(36)}` },
      status: isCompetitor ? "competitor" : "active",
      fit_score: null,
      fit_reasons: [],
      intent_score: 0,
      seeded,
    });
  }
  return companies;
}

const DENTAL_CATEGORIES = ["dentist", "dental_clinic"];

/** Builds the local dental-clinic world (Brightsmile Dental Supply's ICP). */
export function buildDentalCompanies(rng: Rng, total: number, seededCount: number): WorldCompany[] {
  const usedNames = new Set<string>();
  const companies: WorldCompany[] = [];
  for (let i = 0; i < total; i++) {
    let brand = "";
    let domain = "";
    const place: WorldCity = rng.pick(US_CITIES);
    do {
      const word = rng.pick(DENTAL_NAME_WORDS);
      const suffix = rng.pick(DENTAL_NAME_SUFFIXES);
      brand = `${word} ${suffix} - ${place.city}`;
      domain = `${slugify(`${word}${suffix}${place.city}`)}.example.com`;
    } while (usedNames.has(domain));
    usedNames.add(domain);

    const seeded = i < seededCount;
    const isCompetitor = seeded && i === Math.floor(seededCount / 2);
    const practitioners = rng.int(1, 9);
    const rating = Math.round((3.4 + rng.next() * 1.5) * 10) / 10;
    const reviews = rng.int(8, 340);

    companies.push({
      key: domain,
      segment: "dental",
      name: brand,
      domain,
      website: `https://${domain}`,
      linkedin_url: `https://www.linkedin.com/company/${slugify(brand)}`,
      industry: "Dental practice",
      description: isCompetitor
        ? `${brand} is a multi-location DSO-managed dental group; decisions sit at headquarters, not this location.`
        : `${brand} is an independently owned dental practice with ${practitioners} practitioner(s).`,
      employee_count: practitioners * 4,
      employee_range: practitioners <= 2 ? "1-10" : "11-50",
      founded_year: rng.int(1998, 2020),
      country: place.country,
      region: place.region,
      city: place.city,
      address: `${rng.int(100, 9999)} ${rng.pick(["Main St", "Oak Ave", "Center Blvd", "Elm St", "Congress Ave"])}`,
      postal_code: String(rng.int(10000, 99950)),
      phone: phoneFor(rng, place.country),
      timezone: place.timezone,
      technologies: rng.pickN(
        ["Dentrix", "Open Dental", "Weave", "NexHealth", "Curve Dental"],
        rng.int(1, 2),
      ),
      tags: isCompetitor ? ["competitor", "dso"] : [],
      custom: { rating, reviews_count: reviews, place_id: `sbx_place_${i.toString(36)}` },
      source: "google_maps",
      source_refs: { google_maps: `sbx_place_${i.toString(36)}` },
      status: isCompetitor ? "competitor" : "active",
      fit_score: null,
      fit_reasons: [],
      intent_score: 0,
      categories: DENTAL_CATEGORIES,
      rating,
      reviews_count: reviews,
      seeded,
    });
  }
  return companies;
}
