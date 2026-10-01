/** Normalizes one mapped import row into person and company fields (or an invalid reason). */
import type { EmailStatus } from "../../../core/enums.js";
import type { CompanyFields, PersonFields } from "../dedupe.js";
import {
  buildNames,
  cleanText,
  companyDomainFrom,
  normalizeCompanyLinkedin,
  normalizeCountry,
  normalizeEmail,
  normalizePersonLinkedin,
  normalizePhone,
  normalizeTags,
  normalizeWebsite,
  parseBoolean,
  parseEmployees,
  parseInteger,
  parseLocation,
} from "../normalize.js";
import type { HeaderMapping } from "./mapping.js";

export interface NormalizedRow {
  /** Row number as the user sees it (spreadsheet numbering for files). */
  row: number;
  /** Null when the row only describes a company. */
  person: PersonFields | null;
  company: CompanyFields | null;
  /** Why the row cannot be imported, or null. */
  invalid: string | null;
  warnings: string[];
}

const EMAIL_STATUS_WORDS: Array<[RegExp, EmailStatus]> = [
  [/^(valid|verified|deliverable|ok|safe)$/, "valid"],
  [/^(invalid|undeliverable|bounced?|bad)$/, "invalid"],
  [/^(catch[\s_-]?all|accept[\s_-]?all|accept_all)$/, "catch_all"],
  [/^(risky)$/, "risky"],
];

function emailStatusFrom(value: string | null): EmailStatus | null {
  const text = value?.toLowerCase().trim();
  if (!text) return null;
  for (const [pattern, status] of EMAIL_STATUS_WORDS) if (pattern.test(text)) return status;
  return "unknown";
}

function validTimezone(value: string | null): string | null {
  if (!value) return null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

/** Splits "Shopify, Klaviyo; Stripe" into a list. */
function listOf(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(/[,;|]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 100);
}

/**
 * Builds person and company fields from a raw record. `extraTags` are added to every row;
 * `source` is recorded on created records (csv, xlsx, apollo, ...).
 */
export function normalizeRow(
  row: number,
  record: Record<string, string>,
  mappings: HeaderMapping[],
  options: { source: string; extraTags?: string[] } = { source: "import" },
): NormalizedRow {
  const warnings: string[] = [];
  const values = new Map<string, string>();
  const custom: Record<string, unknown> = {};
  for (const mapping of mappings) {
    const raw = cleanText(record[mapping.header]);
    if (raw === null || mapping.field === "ignore") continue;
    if (mapping.field.startsWith("custom.")) custom[mapping.field.slice(7)] = raw.slice(0, 2000);
    else values.set(mapping.field, raw);
  }
  const get = (field: string) => values.get(field) ?? null;

  // Person
  const rawEmail = get("email");
  const email = normalizeEmail(rawEmail);
  if (rawEmail && !email) warnings.push(`invalid email "${rawEmail.slice(0, 80)}"`);
  const rawLinkedin = get("linkedin_url");
  const linkedin = normalizePersonLinkedin(rawLinkedin);
  if (rawLinkedin && !linkedin) warnings.push("LinkedIn URL is not a profile URL");
  const names = buildNames({
    first_name: get("first_name"),
    last_name: get("last_name"),
    full_name: get("full_name"),
  });
  const personLocation = parseLocation(get("location"));
  const rawCountry = get("country");
  const country = normalizeCountry(rawCountry) ?? personLocation.country;
  if (rawCountry && !normalizeCountry(rawCountry))
    warnings.push(`unknown country "${rawCountry.slice(0, 60)}"`);
  const consent = parseBoolean(get("consent"));
  if (consent !== null) custom.consent = consent;

  // Company
  const website = normalizeWebsite(get("company.website"));
  const companyDomain = companyDomainFrom({
    domain: get("company.domain"),
    website: get("company.website"),
    email,
  });
  const employees = parseEmployees(get("company.employees"));
  const companyLocation = parseLocation(get("company.location"));
  const company: CompanyFields = {
    name: get("company.name"),
    domain: companyDomain,
    website: website.website ?? (companyDomain ? `https://${companyDomain}` : null),
    linkedin_url: normalizeCompanyLinkedin(get("company.linkedin_url")),
    industry: get("company.industry"),
    description: get("company.description")?.slice(0, 2000) ?? null,
    employee_count: employees.count,
    employee_range: employees.range,
    revenue_range: get("company.revenue_range"),
    founded_year: parseInteger(get("company.founded_year")),
    country: normalizeCountry(get("company.country")) ?? companyLocation.country,
    region: get("company.region") ?? companyLocation.region,
    city: get("company.city") ?? companyLocation.city,
    address: get("company.address"),
    postal_code: get("company.postal_code"),
    phone: normalizePhone(get("company.phone")),
    technologies: listOf(get("company.technologies")),
    source: options.source,
  };
  const hasCompany = Boolean(company.name || company.domain);

  const person: PersonFields = {
    ...names,
    title: get("title"),
    seniority: get("seniority"),
    department: get("department"),
    email,
    email_status: email ? (emailStatusFrom(get("email_status")) ?? "unknown") : null,
    email_source: email ? options.source : null,
    linkedin_url: linkedin,
    phone: normalizePhone(get("phone")),
    country: country ?? null,
    region: get("region") ?? personLocation.region,
    city: get("city") ?? personLocation.city,
    timezone: validTimezone(get("timezone")),
    language: get("language")?.toLowerCase().slice(0, 12) ?? null,
    tags: normalizeTags([...normalizeTags(get("tags")), ...(options.extraTags ?? [])]),
    custom,
    source: options.source,
  };

  const hasPersonData = Boolean(
    email || linkedin || names.full_name || person.title || rawEmail || rawLinkedin,
  );
  const hasIdentity = Boolean(email || linkedin || (names.full_name && hasCompany));
  if (!hasPersonData) {
    if (!hasCompany) return { row, person: null, company: null, invalid: "empty_row", warnings };
    // Company-only rows: location, phone, custom fields and tags describe the company.
    return {
      row,
      person: null,
      company: {
        ...company,
        country: company.country ?? person.country ?? null,
        region: company.region ?? person.region ?? null,
        city: company.city ?? person.city ?? null,
        phone: company.phone ?? person.phone ?? null,
        custom,
        tags: person.tags ?? [],
      },
      invalid: null,
      warnings,
    };
  }
  if (!hasIdentity) {
    return { row, person, company: hasCompany ? company : null, invalid: "no_identity", warnings };
  }
  return { row, person, company: hasCompany ? company : null, invalid: null, warnings };
}
