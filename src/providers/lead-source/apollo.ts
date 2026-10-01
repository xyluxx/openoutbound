/**
 * Apollo.io lead source (provider API notes section 1).
 * - People search `POST /api/v1/mixed_people/api_search`: free, no emails, last names masked.
 * - Organization search `POST /api/v1/mixed_companies/search`: 1 credit per page.
 * - People bulk match `POST /api/v1/people/bulk_match` (10 per call): 1 credit per matched
 *   person; used only for the people a user selects to import.
 * Request and response mapping live in one small function per call so they are easy to fix.
 */
import { z } from "zod";
import { normalizeDomain, normalizeLinkedinUrl } from "../../lib/web/extract.js";
import { withPartial } from "../http.js";
import {
  type CompanyCandidate,
  type CompanyQuery,
  defineProvider,
  type EmployeeRange,
  type LeadSourceProvider,
  type PeopleQuery,
  type PersonCandidate,
  type SourcePage,
} from "../types.js";
import { asArray, asNumber, asRecord, asString, malformed, requestJson } from "./http.js";

export const apolloConfigSchema = z.object({
  base_url: z.url({ protocol: /^https?$/ }).default("https://api.apollo.io"),
  reveal_personal_emails: z
    .boolean()
    .default(false)
    .describe("Also reveal personal (non-work) emails when enriching; off by default"),
});
export type ApolloConfig = z.output<typeof apolloConfigSchema>;

const PROVIDER = { provider: "Apollo", slot: "lead_source", providerId: "apollo" } as const;
const MAX_PAGE = 500;
const MAX_PER_PAGE = 100;

function countryNames(codes: string[] | undefined): string[] {
  if (!codes?.length) return [];
  const names = new Intl.DisplayNames(["en"], { type: "region", fallback: "code" });
  return codes.map((code) => names.of(code.toUpperCase()) ?? code);
}

function employeeRanges(range: EmployeeRange | undefined): string[] | undefined {
  if (!range || (range.min === undefined && range.max === undefined)) return undefined;
  return [`${range.min ?? 1},${range.max ?? 1_000_000}`];
}

function technologyUids(technologies: string[] | undefined): string[] | undefined {
  if (!technologies?.length) return undefined;
  return technologies.map((t) =>
    t
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_"),
  );
}

function pageOf(cursor: string | undefined): number {
  const page = cursor ? Number.parseInt(cursor, 10) : 1;
  return Number.isFinite(page) && page >= 1 ? Math.min(page, MAX_PAGE) : 1;
}

/** PeopleQuery -> api_search body. */
export function peopleSearchBody(
  query: PeopleQuery,
  page: number,
  perPage: number,
): Record<string, unknown> {
  const keywords = [query.query, ...(query.keywords ?? []), ...(query.industries ?? [])]
    .filter(Boolean)
    .join(" ");
  const locations = query.location?.text ? [query.location.text] : countryNames(query.countries);
  const body: Record<string, unknown> = { page, per_page: perPage };
  if (keywords) body.q_keywords = keywords;
  if (query.titles?.length) {
    body.person_titles = query.titles;
    body.include_similar_titles = true;
  }
  if (query.seniorities?.length) body.person_seniorities = query.seniorities;
  if (locations.length) body.person_locations = locations;
  if (query.company_domains?.length)
    body.q_organization_domains_list = query.company_domains.slice(0, 1000);
  const ranges = employeeRanges(query.employee_range);
  if (ranges) body.organization_num_employees_ranges = ranges;
  const uids = technologyUids(query.technologies);
  if (uids) body.currently_using_any_of_technology_uids = uids;
  return body;
}

/** CompanyQuery -> mixed_companies/search body. */
export function companySearchBody(
  query: CompanyQuery,
  page: number,
  perPage: number,
): Record<string, unknown> {
  const tags = [
    query.query,
    ...(query.keywords ?? []),
    ...(query.industries ?? []),
    ...(query.categories ?? []),
  ].filter((t): t is string => Boolean(t));
  const locations = query.location?.text ? [query.location.text] : countryNames(query.countries);
  const body: Record<string, unknown> = { page, per_page: perPage };
  if (tags.length) body.q_organization_keyword_tags = tags;
  if (locations.length) body.organization_locations = locations;
  if (query.domains?.length) body.q_organization_domains_list = query.domains.slice(0, 1000);
  const ranges = employeeRanges(query.employee_range);
  if (ranges) body.organization_num_employees_ranges = ranges;
  const uids = technologyUids(query.technologies);
  if (uids) body.currently_using_any_of_technology_uids = uids;
  return body;
}

/** Apollo org object -> CompanyCandidate. */
export function mapApolloOrganization(raw: unknown): CompanyCandidate | null {
  const org = asRecord(raw);
  const name = asString(org?.name);
  if (!org || !name) return null;
  const website = asString(org.website_url);
  const phone = asRecord(org.primary_phone);
  return {
    external_id: asString(org.id) ?? undefined,
    name,
    domain:
      asString(org.primary_domain)?.toLowerCase() ?? (website ? normalizeDomain(website) : null),
    website,
    linkedin_url: asString(org.linkedin_url)
      ? normalizeLinkedinUrl(asString(org.linkedin_url) as string)
      : null,
    industry: asString(org.industry),
    description: asString(org.short_description),
    employee_count: asNumber(org.estimated_num_employees),
    founded_year: asNumber(org.founded_year),
    country: asString(org.country),
    region: asString(org.state),
    city: asString(org.city),
    phone: asString(phone?.sanitized_number) ?? asString(phone?.number) ?? asString(org.phone),
    technologies: asArray(org.technology_names).filter((t): t is string => typeof t === "string"),
    source: "apollo",
  };
}

/** api_search person (masked) -> PersonCandidate. */
export function mapApolloSearchPerson(raw: unknown): PersonCandidate | null {
  const person = asRecord(raw);
  const id = asString(person?.id);
  if (!person || !id) return null;
  const first = asString(person.first_name);
  const masked = asString(person.last_name_obfuscated);
  const org = asRecord(person.organization);
  const orgName = asString(org?.name);
  return {
    external_id: id,
    first_name: first,
    last_name: null,
    full_name: [first, masked].filter(Boolean).join(" ") || null,
    title: asString(person.title),
    company: orgName ? { name: orgName, source: "apollo" } : null,
    source: "apollo",
    raw: { has_email: person.has_email === true, masked_last_name: masked },
  };
}

function usableEmail(value: unknown): string | null {
  const email = asString(value)?.toLowerCase() ?? null;
  if (!email?.includes("@")) return null;
  // Apollo returns placeholders such as email_not_unlocked@domain.com for locked emails.
  if (email.includes("not_unlocked") || email.endsWith("@domain.com")) return null;
  return email;
}

/** people/match person -> PersonCandidate (full identity). */
export function mapApolloMatch(raw: unknown): PersonCandidate | null {
  const person = asRecord(raw);
  const id = asString(person?.id);
  if (!person || !id) return null;
  if (person.match_confidence === "none") return null;
  const email = usableEmail(person.email);
  const departments = asArray(person.departments).filter((d): d is string => typeof d === "string");
  const linkedin = asString(person.linkedin_url);
  return {
    external_id: id,
    first_name: asString(person.first_name),
    last_name: asString(person.last_name),
    full_name: asString(person.name),
    title: asString(person.title),
    seniority: asString(person.seniority),
    department: departments[0]?.replace(/^master_/, "").replace(/_/g, " ") ?? null,
    email,
    email_status: email ? (person.email_status === "verified" ? "valid" : "unknown") : undefined,
    linkedin_url: linkedin ? normalizeLinkedinUrl(linkedin) : null,
    country: asString(person.country),
    region: asString(person.state),
    city: asString(person.city),
    company: mapApolloOrganization(person.organization),
    source: "apollo",
  };
}

export interface ApolloOptions {
  apiKey: string;
  baseUrl?: string;
  revealPersonalEmails?: boolean;
  fetch: typeof fetch;
}

export function createApollo(options: ApolloOptions): LeadSourceProvider {
  const base = (options.baseUrl ?? "https://api.apollo.io").replace(/\/+$/, "");
  const headers = { "x-api-key": options.apiKey, "cache-control": "no-cache" };
  const post = (path: string, body: unknown, paid = false) =>
    requestJson(options.fetch, {
      ...PROVIDER,
      url: `${base}${path}`,
      method: "POST",
      headers,
      body,
      paid,
    });

  return {
    id: "apollo",
    capabilities: { people: true, companies: true, enrich: true },

    async searchPeople(query, pageRequest): Promise<SourcePage<PersonCandidate>> {
      const page = pageOf(pageRequest.cursor);
      const perPage = Math.min(Math.max(pageRequest.limit, 1), MAX_PER_PAGE);
      const { body } = await post(
        "/api/v1/mixed_people/api_search",
        peopleSearchBody(query, page, perPage),
      );
      const record = asRecord(body);
      if (!record || !Array.isArray(record.people))
        throw malformed("Apollo", "apollo", "no people array");
      const items = record.people
        .map(mapApolloSearchPerson)
        .filter((p): p is PersonCandidate => p !== null);
      const total = asNumber(record.total_entries);
      const more =
        items.length > 0 && page < MAX_PAGE && (total === null || page * perPage < total);
      return { items, total, nextCursor: more ? String(page + 1) : null, creditsUsed: 0 };
    },

    async searchCompanies(query, pageRequest): Promise<SourcePage<CompanyCandidate>> {
      const page = pageOf(pageRequest.cursor);
      const perPage = Math.min(Math.max(pageRequest.limit, 1), MAX_PER_PAGE);
      // Paid per page: a lost answer may have been charged, so it is not retried automatically.
      const { body } = await post(
        "/api/v1/mixed_companies/search",
        companySearchBody(query, page, perPage),
        true,
      );
      const record = asRecord(body);
      if (!record || !Array.isArray(record.organizations)) {
        throw malformed("Apollo", "apollo", "no organizations array");
      }
      const items = record.organizations
        .map(mapApolloOrganization)
        .filter((c): c is CompanyCandidate => c !== null);
      const pagination = asRecord(record.pagination);
      const total = asNumber(pagination?.total_entries);
      const totalPages = asNumber(pagination?.total_pages);
      const more =
        items.length > 0 && page < MAX_PAGE && (totalPages === null || page < totalPages);
      // Organization search costs 1 credit per page returned.
      return { items, total, nextCursor: more ? String(page + 1) : null, creditsUsed: 1 };
    },

    async enrichPeople(candidates) {
      const items: Array<PersonCandidate | null> = [];
      let creditsUsed = 0;
      for (let i = 0; i < candidates.length; i += 10) {
        const chunk = candidates.slice(i, i + 10);
        const details = chunk.map((c) => {
          if (c.external_id) return { id: c.external_id };
          const detail: Record<string, unknown> = {};
          if (c.first_name) detail.first_name = c.first_name;
          if (c.last_name) detail.last_name = c.last_name;
          if (c.full_name) detail.name = c.full_name;
          if (c.email) detail.email = c.email;
          if (c.linkedin_url) detail.linkedin_url = c.linkedin_url;
          if (c.company?.domain) detail.domain = c.company.domain;
          if (c.company?.name) detail.organization_name = c.company.name;
          return detail;
        });
        let mapped: Array<PersonCandidate | null>;
        let consumed: number | null;
        try {
          const { body } = await post(
            "/api/v1/people/bulk_match",
            {
              details,
              reveal_personal_emails: options.revealPersonalEmails ?? false,
              reveal_phone_number: false,
            },
            true,
          );
          const record = asRecord(body);
          if (!record || !Array.isArray(record.matches))
            throw malformed("Apollo", "apollo", "no matches array");
          mapped = record.matches.map((m) => (m === null ? null : mapApolloMatch(m)));
          consumed = asNumber(record.credits_consumed);
        } catch (error) {
          // Earlier chunks were matched (and paid for): hand them back. `items` lines up with
          // the first items.length candidates (whole chunks; null: answered, no match).
          if (items.length === 0) throw error;
          throw withPartial(
            error,
            { id: "apollo", name: "Apollo" },
            { items, credits: creditsUsed },
            `Enrich only the candidates after the first ${items.length} to go on.`,
          );
        }
        const byId = new Map(
          mapped.filter((m): m is PersonCandidate => m !== null).map((m) => [m.external_id, m]),
        );
        chunk.forEach((candidate, index) => {
          items.push(
            (candidate.external_id ? byId.get(candidate.external_id) : undefined) ??
              (candidate.external_id ? null : (mapped[index] ?? null)),
          );
        });
        creditsUsed += consumed ?? mapped.filter((m) => m !== null).length;
      }
      return { items, creditsUsed };
    },

    async estimate(request) {
      if (request.kind === "people")
        return { credits: 0, note: "Apollo people search is free (no emails)." };
      if (request.kind === "companies") {
        return {
          credits: Math.max(1, Math.ceil(request.count / MAX_PER_PAGE)),
          note: "Apollo organization search costs 1 credit per page of up to 100 companies.",
        };
      }
      return {
        credits: request.count,
        note: "Apollo charges 1 credit per matched person (no charge when there is no match).",
      };
    },
  };
}

export const apolloProvider = defineProvider({
  slot: "lead_source",
  id: "apollo",
  name: "Apollo.io",
  description:
    "B2B people and company search. People search is free and returns no emails; organization search costs 1 credit per page; enrichment (names, LinkedIn, work email) costs 1 credit per matched person and runs only for the people you select.",
  docsUrl: "https://docs.apollo.io/reference/people-api-search",
  configSchema: apolloConfigSchema,
  secrets: [{ key: "api_key", label: "API key", env: "APOLLO_API_KEY", required: true }],
  create: ({ config, secrets, ctx }) =>
    createApollo({
      apiKey: secrets.api_key ?? "",
      baseUrl: config.base_url,
      revealPersonalEmails: config.reveal_personal_emails,
      fetch: ctx.fetch,
    }),
  test: async (instance) => {
    try {
      const page = await instance.searchPeople?.({ titles: ["owner"] }, { limit: 1 });
      return {
        ok: true,
        message: `Apollo key works (people search returned ${page?.items.length ?? 0} result).`,
      };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  },
});
