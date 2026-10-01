/**
 * Sandbox lead_source provider: an Apollo-like people search and a Google-Maps-like company
 * search, both answered from the in-memory sandbox world instead of a real API. Free (0 credits)
 * like a real people-search call; nothing is enriched.
 */
import { eq } from "drizzle-orm";
import { workspaces } from "../../db/schema/index.js";
import type {
  CompanyCandidate,
  CompanyQuery,
  LeadSourceProvider,
  PageRequest,
  PeopleQuery,
  PersonCandidate,
  ProviderRuntime,
  SourcePage,
} from "../../providers/types.js";
import type { WorldCompany } from "../world/companies.js";
import { WORLD, type WorkspaceWorld, worldOfWorkspace } from "../world/index.js";
import type { WorldPerson } from "../world/people.js";

async function resolveWorld(ctx: ProviderRuntime): Promise<WorkspaceWorld | null> {
  if (!ctx.workspaceId) return null;
  const [row] = await ctx.db
    .select({ slug: workspaces.slug, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId));
  return row ? worldOfWorkspace(row) : null;
}

function companiesOf(world: WorkspaceWorld | null): WorldCompany[] {
  return world ? world.companies : Object.values(WORLD).flatMap((w) => w.companies);
}

function peopleOf(world: WorkspaceWorld | null): WorldPerson[] {
  return world ? world.people : Object.values(WORLD).flatMap((w) => w.people);
}

function includesCaseInsensitive(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function matchesText(hay: string, query: string | undefined): boolean {
  if (!query) return true;
  return includesCaseInsensitive(hay, query);
}

function matchesPeopleQuery(
  person: WorldPerson,
  company: WorldCompany | undefined,
  query: PeopleQuery,
): boolean {
  if (query.titles?.length && !query.titles.some((t) => includesCaseInsensitive(person.title, t)))
    return false;
  if (
    query.seniorities?.length &&
    !query.seniorities.some((s) => person.seniority.toLowerCase() === s.toLowerCase())
  )
    return false;
  if (
    query.departments?.length &&
    !query.departments.some((d) => person.department.toLowerCase() === d.toLowerCase())
  )
    return false;
  if (query.countries?.length && !query.countries.includes(person.country)) return false;
  if (query.company_domains?.length && !(company && query.company_domains.includes(company.domain)))
    return false;
  if (
    query.company_names?.length &&
    !(company && query.company_names.some((n) => includesCaseInsensitive(company.name, n)))
  )
    return false;
  if (
    query.industries?.length &&
    !(company && query.industries.some((i) => includesCaseInsensitive(company.industry, i)))
  )
    return false;
  if (query.employee_range && company) {
    if (query.employee_range.min !== undefined && company.employee_count < query.employee_range.min)
      return false;
    if (query.employee_range.max !== undefined && company.employee_count > query.employee_range.max)
      return false;
  }
  if (
    query.technologies?.length &&
    !(
      company &&
      query.technologies.some((t) =>
        company.technologies.some((ct) => ct.toLowerCase() === t.toLowerCase()),
      )
    )
  )
    return false;
  if (
    query.location?.text &&
    !matchesText(`${person.city} ${person.region} ${person.country}`, query.location.text)
  )
    return false;
  if (query.keywords?.length) {
    const hay = `${person.title} ${person.department} ${company?.name ?? ""} ${company?.description ?? ""}`;
    if (!query.keywords.some((k) => includesCaseInsensitive(hay, k))) return false;
  }
  if (query.query) {
    const hay = `${person.full_name} ${person.title} ${company?.name ?? ""}`;
    if (!includesCaseInsensitive(hay, query.query)) return false;
  }
  return true;
}

function matchesCompanyQuery(company: WorldCompany, query: CompanyQuery): boolean {
  if (company.status === "competitor") return false;
  if (query.countries?.length && !query.countries.includes(company.country)) return false;
  if (
    query.industries?.length &&
    !query.industries.some((i) => includesCaseInsensitive(company.industry, i))
  )
    return false;
  if (query.employee_range) {
    if (query.employee_range.min !== undefined && company.employee_count < query.employee_range.min)
      return false;
    if (query.employee_range.max !== undefined && company.employee_count > query.employee_range.max)
      return false;
  }
  if (
    query.technologies?.length &&
    !query.technologies.some((t) =>
      company.technologies.some((ct) => ct.toLowerCase() === t.toLowerCase()),
    )
  )
    return false;
  if (query.domains?.length && !query.domains.includes(company.domain)) return false;
  if (
    query.categories?.length &&
    !query.categories.some((cat) => company.categories?.includes(cat))
  )
    return false;
  if (query.min_rating !== undefined && (company.rating ?? 0) < query.min_rating) return false;
  if (
    query.location?.text &&
    !matchesText(`${company.city} ${company.region} ${company.country}`, query.location.text)
  )
    return false;
  if (query.keywords?.length) {
    const hay = `${company.name} ${company.industry} ${company.description}`;
    if (!query.keywords.some((k) => includesCaseInsensitive(hay, k))) return false;
  }
  if (query.query) {
    const hay = `${company.name} ${company.industry} ${company.description}`;
    if (!includesCaseInsensitive(hay, query.query)) return false;
  }
  return true;
}

function toCompanyCandidate(company: WorldCompany): CompanyCandidate {
  return {
    external_id: company.source_refs[company.source],
    name: company.name,
    domain: company.domain,
    website: company.website,
    linkedin_url: company.linkedin_url,
    industry: company.industry,
    description: company.description,
    employee_count: company.employee_count,
    employee_range: company.employee_range,
    founded_year: company.founded_year,
    country: company.country,
    region: company.region,
    city: company.city,
    address: company.address,
    postal_code: company.postal_code,
    phone: company.phone,
    timezone: company.timezone,
    rating: company.rating ?? null,
    reviews_count: company.reviews_count ?? null,
    categories: company.categories,
    technologies: company.technologies,
    source: "sandbox",
  };
}

function toPersonCandidate(
  person: WorldPerson,
  company: WorldCompany | undefined,
): PersonCandidate {
  return {
    external_id: person.source_refs[person.source],
    first_name: person.first_name,
    last_name: person.last_name,
    full_name: person.full_name,
    title: person.title,
    seniority: person.seniority,
    department: person.department,
    email: person.email,
    email_status: person.email_status,
    linkedin_url: person.linkedin_url,
    country: person.country,
    region: person.region,
    city: person.city,
    timezone: person.timezone,
    company: company ? toCompanyCandidate(company) : null,
    source: "sandbox",
  };
}

function paginate<T>(items: T[], page: PageRequest): SourcePage<T> {
  const offset = page.cursor ? Number.parseInt(page.cursor, 10) || 0 : 0;
  const limit = Math.max(1, page.limit);
  const slice = items.slice(offset, offset + limit);
  const nextOffset = offset + slice.length;
  return {
    items: slice,
    nextCursor: nextOffset < items.length ? String(nextOffset) : null,
    total: items.length,
    creditsUsed: 0,
  };
}

/** Builds the provider instance, bound to the calling workspace's runtime (so it knows its world). */
export async function createSandboxLeadSource(ctx: ProviderRuntime): Promise<LeadSourceProvider> {
  const world = await resolveWorld(ctx);
  const companyByKey = new Map(companiesOf(world).map((c) => [c.key, c]));
  return {
    id: "sandbox",
    capabilities: { people: true, companies: true, enrich: false },
    async searchPeople(query: PeopleQuery, page: PageRequest) {
      const matches = peopleOf(world).filter((p) =>
        matchesPeopleQuery(p, companyByKey.get(p.companyKey), query),
      );
      const result = paginate(matches, page);
      return {
        ...result,
        items: result.items.map((p) => toPersonCandidate(p, companyByKey.get(p.companyKey))),
      };
    },
    async searchCompanies(query: CompanyQuery, page: PageRequest) {
      const matches = companiesOf(world).filter((c) => matchesCompanyQuery(c, query));
      const result = paginate(matches, page);
      return { ...result, items: result.items.map(toCompanyCandidate) };
    },
  };
}
