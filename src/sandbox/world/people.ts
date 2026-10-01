/**
 * The world's people, one to three per company. Invented names built from syllables (names.ts);
 * roles reflect each ICP's buying committee (spec: VP Operations / Head of Supply Chain / Founder
 * for Northwind, Owner / Practice Manager for Brightsmile).
 */
import type { EmailStatus } from "../../core/enums.js";
import type { CustomFields, FitReason } from "../../db/schema/index.js";
import type { WorldCompany } from "./companies.js";
import { classifyEmailStatus } from "./email-status.js";
import { buildName, slugify } from "./names.js";
import type { Rng } from "./rng.js";

export interface WorldPerson {
  /** Stable key (email, or a synthetic key when there is none). */
  key: string;
  /** WorldCompany.key of the employer. */
  companyKey: string;
  first_name: string;
  last_name: string;
  full_name: string;
  title: string;
  seniority: string;
  department: string;
  email: string | null;
  email_status: EmailStatus;
  email_source: string | null;
  linkedin_url: string;
  country: string;
  region: string;
  city: string;
  timezone: string;
  language: string;
  tags: string[];
  custom: CustomFields;
  source: string;
  source_refs: Record<string, string>;
  /** Scored against the workspace's default ICP once the world is built (world/index.ts). */
  fit_score: number | null;
  fit_reasons: FitReason[];
  /** Employer was seeded into the workspace (this person is too; otherwise search-only). */
  seeded: boolean;
}

interface RoleDef {
  title: string;
  seniority: string;
  department: string;
}

const ECOMMERCE_ROLES: RoleDef[] = [
  { title: "VP of Operations", seniority: "vp", department: "operations" },
  { title: "Head of Supply Chain", seniority: "head", department: "operations" },
  { title: "Founder & CEO", seniority: "c_level", department: "executive" },
  { title: "Chief Operating Officer", seniority: "c_level", department: "operations" },
  { title: "Director of Operations", seniority: "director", department: "operations" },
];

const DENTAL_ROLES: RoleDef[] = [
  { title: "Owner & Principal Dentist", seniority: "owner", department: "executive" },
  { title: "Practice Manager", seniority: "manager", department: "operations" },
  { title: "Associate Dentist", seniority: "associate", department: "clinical" },
];

/** People for one e-commerce company (Northwind's Apollo-style world): mostly pre-enriched. */
export function buildEcommercePeople(
  rng: Rng,
  company: WorldCompany,
  catchAllDomains: ReadonlySet<string>,
): WorldPerson[] {
  if (company.status === "competitor") return [];
  const count = rng.int(2, 3);
  const roles = rng.pickN(ECOMMERCE_ROLES, count);
  // Always include one champion-type role (ops/supply chain) so the ICP persona is represented.
  if (!roles.some((r) => r.department === "operations" && r.seniority !== "c_level")) {
    roles[0] = ECOMMERCE_ROLES[0] as RoleDef;
  }
  const isEuConsentCountry = company.country === "DE" || company.country === "AT";
  return roles.map((role, index) => {
    const name = buildName(rng, isEuConsentCountry ? "de_at" : "generic");
    const hasEmail = rng.bool(0.8);
    const email = hasEmail
      ? `${slugify(name.first_name)}.${slugify(name.last_name)}@${company.domain}`
      : null;
    const custom: CustomFields = {};
    if (isEuConsentCountry) custom.consent = rng.bool(0.2);
    return {
      key: email ?? `${company.domain}#${index}`,
      companyKey: company.key,
      first_name: name.first_name,
      last_name: name.last_name,
      full_name: name.full_name,
      title: role.title,
      seniority: role.seniority,
      department: role.department,
      email,
      email_status: email ? classifyEmailStatus(email, catchAllDomains) : "unknown",
      email_source: email ? "apollo" : null,
      linkedin_url: `https://www.linkedin.com/in/${slugify(name.full_name)}-${rng.int(100, 999)}`,
      country: company.country,
      region: company.region,
      city: company.city,
      timezone: company.timezone,
      language: isEuConsentCountry ? "de" : "en",
      tags: [],
      custom,
      source: "apollo",
      source_refs: { apollo: `sbx_person_${slugify(name.full_name)}` },
      fit_score: null,
      fit_reasons: [],
      seeded: company.seeded,
    };
  });
}

/** People for one dental clinic (Brightsmile's Maps-style world): mostly not yet enriched. */
export function buildDentalPeople(rng: Rng, company: WorldCompany): WorldPerson[] {
  if (company.status === "competitor") return [];
  const count = rng.pick([1, 2, 2, 2, 3]);
  const roles =
    count === 1
      ? [DENTAL_ROLES[0] as RoleDef]
      : count === 2
        ? DENTAL_ROLES.slice(0, 2)
        : DENTAL_ROLES;
  return roles.map((role, index) => {
    const name = buildName(rng);
    // The crawler flow has not run yet for most: emails are rare, and when found they are the
    // clinic's shared inbox rather than a personal address.
    const hasGenericEmail = rng.bool(0.25);
    const email = hasGenericEmail ? `info@${company.domain}` : null;
    return {
      key: email ? `${email}#${index}` : `${company.domain}#${index}`,
      companyKey: company.key,
      first_name: name.first_name,
      last_name: name.last_name,
      full_name: name.full_name,
      title: role.title,
      seniority: role.seniority,
      department: role.department,
      email,
      email_status: email ? "unknown" : "unknown",
      email_source: email ? "website" : null,
      linkedin_url: `https://www.linkedin.com/in/${slugify(name.full_name)}-${rng.int(100, 999)}`,
      country: company.country,
      region: company.region,
      city: company.city,
      timezone: company.timezone,
      language: "en",
      tags: [],
      custom: {},
      source: "google_maps",
      source_refs: { google_maps: `sbx_person_${slugify(name.full_name)}` },
      fit_score: null,
      fit_reasons: [],
      seeded: company.seeded,
    };
  });
}
