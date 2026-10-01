/**
 * A fake Apollo API for evals, served through the eval provider APIs with the request and
 * response shapes the real adapter uses: people search (free, masked last names, no emails),
 * organization search (1 credit per page) and people bulk match (1 credit per matched person).
 * It keeps its own tally of what it charged, so scenarios can check spend without trusting the
 * engine's usage records.
 */
import type { ApiRequest, ApiResponse, EvalApis } from "./eval-apis.js";

export interface FakeApolloOrganization {
  id: string;
  name: string;
  domain: string;
  industry: string;
  employees: number;
  city: string;
  state: string;
  country: string;
  description: string;
}

export interface FakeApolloPerson {
  id: string;
  first_name: string;
  last_name: string;
  title: string;
  /** Apollo seniority: owner, founder, c_suite, vp, head, director, manager, senior, entry. */
  seniority: string;
  /** Department without the master_ prefix, e.g. operations. */
  department: string;
  email: string;
  city: string;
  state: string;
  country: string;
  organization: FakeApolloOrganization;
}

export interface FakeApollo {
  /** Base URL to configure on the provider (config base_url). */
  base: string;
  /** Credits charged so far: organization search pages plus matched people. */
  credits: number;
  /** Apollo ids revealed through bulk match, in order. */
  revealed: string[];
  /** People and organization searches answered. */
  searches: number;
}

/** Words that describe a level rather than a function ("Head of Operations" -> operations). */
const LEVEL_WORDS = new Set([
  "of",
  "and",
  "the",
  "head",
  "vp",
  "vice",
  "president",
  "director",
  "senior",
  "sr",
  "manager",
  "lead",
  "chief",
  "officer",
  "global",
]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((token) => (token === "ops" ? "operations" : token));
}

/** Loose title match, like Apollo's include_similar_titles: same function words. */
function titleMatches(title: string, wanted: string): boolean {
  const have = new Set(tokens(title));
  const want = tokens(wanted);
  if (want.length > 0 && want.every((token) => have.has(token))) return true;
  const functional = want.filter((token) => !LEVEL_WORDS.has(token));
  return functional.length > 0 && functional.some((token) => have.has(token));
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function inRanges(employees: number, ranges: string[]): boolean {
  if (ranges.length === 0) return true;
  return ranges.some((range) => {
    const [min, max] = range.split(",").map((part) => Number.parseInt(part, 10));
    return employees >= (min ?? 0) && employees <= (max ?? Number.MAX_SAFE_INTEGER);
  });
}

function inLocations(place: { city: string; state: string; country: string }, wanted: string[]) {
  if (wanted.length === 0) return true;
  const parts = [place.city, place.state, place.country].map((part) => part.toLowerCase());
  return wanted.some((location) => {
    const text = location.toLowerCase();
    return parts.some((part) => text.includes(part) || part.includes(text));
  });
}

function page(body: Record<string, unknown>): { page: number; perPage: number } {
  const pageNumber = Number(body.page ?? 1);
  const perPage = Number(body.per_page ?? 25);
  return {
    page: Number.isFinite(pageNumber) && pageNumber >= 1 ? Math.floor(pageNumber) : 1,
    perPage: Number.isFinite(perPage) && perPage >= 1 ? Math.min(Math.floor(perPage), 100) : 25,
  };
}

function organizationJson(org: FakeApolloOrganization) {
  return {
    id: org.id,
    name: org.name,
    website_url: `https://${org.domain}`,
    primary_domain: org.domain,
    industry: org.industry,
    estimated_num_employees: org.employees,
    short_description: org.description,
    city: org.city,
    state: org.state,
    country: org.country,
  };
}

function maskedLastName(last: string): string {
  return last.length <= 2 ? `${last[0] ?? ""}***` : `${last[0]}***${last.at(-1)}`;
}

function matchJson(person: FakeApolloPerson) {
  return {
    id: person.id,
    first_name: person.first_name,
    last_name: person.last_name,
    name: `${person.first_name} ${person.last_name}`,
    email: person.email,
    email_status: "verified",
    title: person.title,
    seniority: person.seniority,
    departments: [`master_${person.department.replace(/ /g, "_")}`],
    city: person.city,
    state: person.state,
    country: person.country,
    match_confidence: "high",
    organization: organizationJson(person.organization),
  };
}

const UNAUTHORIZED: ApiResponse = {
  status: 401,
  body: { error: "Invalid access credentials." },
};

/** Serves a fake Apollo at `base` over `people` (in the order searches return them). */
export function installFakeApollo(
  apis: EvalApis,
  base: string,
  people: readonly FakeApolloPerson[],
): FakeApollo {
  const origin = base.replace(/\/+$/, "");
  const state: FakeApollo = { base: origin, credits: 0, revealed: [], searches: 0 };
  const authorized = (request: ApiRequest) => Boolean(request.headers.get("x-api-key"));

  apis.route(`${origin}/api/v1/mixed_people/api_search`, (request) => {
    if (!authorized(request)) return UNAUTHORIZED;
    state.searches += 1;
    const body = record(request.body);
    const titles = strings(body.person_titles);
    const seniorities = strings(body.person_seniorities).map((s) => s.toLowerCase());
    const locations = strings(body.person_locations);
    const domains = strings(body.q_organization_domains_list).map((d) => d.toLowerCase());
    const ranges = strings(body.organization_num_employees_ranges);
    const matches = people.filter(
      (person) =>
        (titles.length === 0 || titles.some((title) => titleMatches(person.title, title))) &&
        (seniorities.length === 0 || seniorities.includes(person.seniority)) &&
        inLocations(person, locations) &&
        (domains.length === 0 || domains.includes(person.organization.domain)) &&
        inRanges(person.organization.employees, ranges),
    );
    const { page: pageNumber, perPage } = page(body);
    const slice = matches.slice((pageNumber - 1) * perPage, pageNumber * perPage);
    return {
      body: {
        total_entries: matches.length,
        people: slice.map((person) => ({
          id: person.id,
          first_name: person.first_name,
          last_name_obfuscated: maskedLastName(person.last_name),
          title: person.title,
          has_email: true,
          organization: { name: person.organization.name, has_industry: true },
        })),
      },
    };
  });

  apis.route(`${origin}/api/v1/mixed_companies/search`, (request) => {
    if (!authorized(request)) return UNAUTHORIZED;
    state.searches += 1;
    state.credits += 1;
    const body = record(request.body);
    const locations = strings(body.organization_locations);
    const ranges = strings(body.organization_num_employees_ranges);
    const organizations = [
      ...new Map(people.map((person) => [person.organization.id, person.organization])).values(),
    ].filter((org) => inLocations(org, locations) && inRanges(org.employees, ranges));
    const { page: pageNumber, perPage } = page(body);
    const slice = organizations.slice((pageNumber - 1) * perPage, pageNumber * perPage);
    return {
      body: {
        organizations: slice.map(organizationJson),
        pagination: {
          page: pageNumber,
          per_page: perPage,
          total_entries: organizations.length,
          total_pages: Math.max(1, Math.ceil(organizations.length / perPage)),
        },
      },
    };
  });

  apis.route(`${origin}/api/v1/people/bulk_match`, (request) => {
    if (!authorized(request)) return UNAUTHORIZED;
    const details = Array.isArray(record(request.body).details)
      ? (record(request.body).details as unknown[])
      : [];
    const matches = details.map((detail) => {
      const id = record(detail).id;
      const person = typeof id === "string" ? people.find((p) => p.id === id) : undefined;
      return person ? matchJson(person) : null;
    });
    const matched = matches.filter((match) => match !== null);
    state.credits += matched.length;
    state.revealed.push(...matched.map((match) => match.id));
    return {
      body: {
        status: "success",
        total_requested_enrichments: details.length,
        unique_enriched_records: matched.length,
        missing_records: details.length - matched.length,
        credits_consumed: matched.length,
        matches,
      },
    };
  });

  return state;
}
