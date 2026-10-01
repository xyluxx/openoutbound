/** Search criteria for find_leads and saved searches (snake_case), mapped to provider queries. */
import { z } from "zod";
import { OpenOutboundError } from "../../../core/errors.js";
import type { CompanyQuery, GeoFilter, PeopleQuery } from "../../../providers/types.js";
import { normalizeCountry, normalizeWebsite } from "../normalize.js";

const terms = (max: number, description: string) =>
  z.array(z.string().trim().min(1).max(120)).max(max).optional().describe(description);

export const findCriteriaShape = {
  query: z
    .string()
    .trim()
    .max(300)
    .optional()
    .describe('Free text, e.g. "dental clinic" (Google Maps) or "inventory planning" (Apollo)'),
  titles: terms(25, 'Job titles, e.g. ["Head of Operations"] (people)'),
  seniorities: terms(10, "owner, founder, c_suite, vp, head, director, manager, senior (people)"),
  departments: terms(10, 'Departments, e.g. ["operations"] (people)'),
  countries: z
    .array(z.string().trim().min(2).max(60))
    .max(20)
    .optional()
    .describe("Country names or ISO-2 codes"),
  location: z.string().trim().max(200).optional().describe('Place, e.g. "Austin, TX" or "Munich"'),
  lat: z.number().min(-90).max(90).optional().describe("Circle center latitude (with lng)"),
  lng: z.number().min(-180).max(180).optional().describe("Circle center longitude (with lat)"),
  radius_km: z.number().positive().max(50).optional().describe("Circle radius, default 10"),
  industries: terms(20, 'Industries, e.g. ["dental"]'),
  keywords: terms(20, "Extra keywords"),
  technologies: terms(20, 'Technologies used, e.g. ["shopify"] (Apollo)'),
  company_domains: z
    .array(z.string().trim().min(3).max(253))
    .max(100)
    .optional()
    .describe("Only people at these company domains (Apollo people)"),
  employees_min: z.number().int().min(1).optional(),
  employees_max: z.number().int().min(1).optional(),
  categories: terms(10, 'Google place types, e.g. ["dentist"] (Google Maps)'),
  min_rating: z.number().min(0).max(5).optional().describe("Minimum Google rating (Google Maps)"),
};

export const findCriteriaSchema = z.object(findCriteriaShape);
export type FindCriteria = z.output<typeof findCriteriaSchema>;

function invalid(message: string, hint: string): OpenOutboundError {
  return new OpenOutboundError("validation_failed", message, { hint });
}

function countriesOf(values: string[] | undefined): string[] | undefined {
  if (!values?.length) return undefined;
  const codes: string[] = [];
  for (const value of values) {
    const code = normalizeCountry(value);
    if (!code) {
      throw invalid(
        `Unknown country "${value}".`,
        'Use ISO-2 codes such as "US" or "DE" in countries.',
      );
    }
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

function geoOf(criteria: FindCriteria): GeoFilter | undefined {
  const hasLat = criteria.lat !== undefined;
  const hasLng = criteria.lng !== undefined;
  if (hasLat !== hasLng) {
    throw invalid("lat and lng go together.", "Pass both lat and lng, or use location instead.");
  }
  if (hasLat && hasLng) {
    const geo: GeoFilter = {
      lat: criteria.lat as number,
      lng: criteria.lng as number,
      radius_m: Math.round((criteria.radius_km ?? 10) * 1000),
    };
    if (criteria.location) geo.text = criteria.location;
    return geo;
  }
  return criteria.location ? { text: criteria.location } : undefined;
}

function employeeRange(criteria: FindCriteria) {
  const { employees_min: min, employees_max: max } = criteria;
  if (min !== undefined && max !== undefined && min > max) {
    throw invalid("employees_min is above employees_max.", "Swap the two values.");
  }
  if (min === undefined && max === undefined) return undefined;
  return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
}

function domainsOf(values: string[] | undefined): string[] | undefined {
  if (!values?.length) return undefined;
  const domains = values
    .map((value) => normalizeWebsite(value).domain)
    .filter((d): d is string => Boolean(d));
  return domains.length ? [...new Set(domains)] : undefined;
}

/** Throws when nothing was asked for. */
export function assertCriteria(criteria: FindCriteria): void {
  const hasSomething = Object.values(criteria).some((value) =>
    Array.isArray(value) ? value.length > 0 : value !== undefined && value !== "",
  );
  if (!hasSomething) {
    throw invalid(
      "Say what to look for.",
      "Pass query, titles, industries, location or countries (for example query and location).",
    );
  }
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export function toPeopleQuery(criteria: FindCriteria): PeopleQuery {
  return withoutUndefined<PeopleQuery>({
    query: criteria.query || undefined,
    titles: criteria.titles,
    seniorities: criteria.seniorities,
    departments: criteria.departments,
    location: geoOf(criteria),
    countries: countriesOf(criteria.countries),
    company_domains: domainsOf(criteria.company_domains),
    industries: criteria.industries,
    employee_range: employeeRange(criteria),
    keywords: criteria.keywords,
    technologies: criteria.technologies,
  });
}

export function toCompanyQuery(criteria: FindCriteria): CompanyQuery {
  return withoutUndefined<CompanyQuery>({
    query: criteria.query || undefined,
    location: geoOf(criteria),
    countries: countriesOf(criteria.countries),
    industries: criteria.industries,
    employee_range: employeeRange(criteria),
    keywords: criteria.keywords,
    technologies: criteria.technologies,
    domains: domainsOf(criteria.company_domains),
    categories: criteria.categories,
    min_rating: criteria.min_rating,
  });
}
