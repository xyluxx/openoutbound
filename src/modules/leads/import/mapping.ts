/**
 * Header -> field mapping for imports: a synonyms table (English plus common German, French
 * and Spanish headers, Apollo and Sales Navigator export headers), value sniffing for
 * unlabeled columns, then (in ai-mapping.ts) one AI call for whatever is still unknown.
 */
import { normalizeEmail, normalizePersonLinkedin } from "../normalize.js";

export const PERSON_FIELDS = [
  "email",
  "first_name",
  "last_name",
  "full_name",
  "title",
  "seniority",
  "department",
  "linkedin_url",
  "phone",
  "country",
  "region",
  "city",
  "location",
  "timezone",
  "language",
  "tags",
  "email_status",
  "consent",
] as const;

export const COMPANY_FIELDS = [
  "company.name",
  "company.domain",
  "company.website",
  "company.linkedin_url",
  "company.industry",
  "company.description",
  "company.employees",
  "company.revenue_range",
  "company.founded_year",
  "company.country",
  "company.region",
  "company.city",
  "company.location",
  "company.address",
  "company.postal_code",
  "company.phone",
  "company.technologies",
] as const;

export const TARGET_FIELDS = [...PERSON_FIELDS, ...COMPANY_FIELDS] as const;
export type TargetField = (typeof TARGET_FIELDS)[number];

/** A mapping value: a target field, "ignore", or "custom.<key>". */
export type MappedField = TargetField | "ignore" | `custom.${string}`;

export type MappingMethod = "manual" | "synonym" | "values" | "ai" | "default";

export interface HeaderMapping {
  header: string;
  field: MappedField;
  method: MappingMethod;
}

const SYNONYMS: Record<TargetField, string[]> = {
  email: [
    "email",
    "e-mail",
    "email address",
    "e-mail address",
    "mail",
    "work email",
    "business email",
    "professional email",
    "person email",
    "contact email",
    "primary email",
    "corporate email",
    "email 1",
    "emails",
    "work e-mail",
    "courriel",
    "adresse email",
    "correo",
    "correo electronico",
    "e-mail adresse",
    "email adresse",
  ],
  first_name: [
    "first name",
    "firstname",
    "first",
    "given name",
    "forename",
    "vorname",
    "prenom",
    "nombre",
    "person first name",
    "contact first name",
  ],
  last_name: [
    "last name",
    "lastname",
    "last",
    "surname",
    "family name",
    "nachname",
    "nom",
    "nom de famille",
    "apellido",
    "apellidos",
    "person last name",
    "contact last name",
  ],
  full_name: [
    "name",
    "full name",
    "fullname",
    "contact name",
    "person name",
    "contact",
    "lead name",
    "contact full name",
    "prospect name",
    "display name",
    "person",
  ],
  title: [
    "title",
    "job title",
    "jobtitle",
    "position",
    "role",
    "job role",
    "designation",
    "current title",
    "current position",
    "job",
    "occupation",
    "person title",
    "contact title",
    "titel",
    "berufsbezeichnung",
    "poste",
    "cargo",
    "headline title",
  ],
  seniority: ["seniority", "seniority level", "level", "management level"],
  department: ["department", "departments", "function", "job function", "division", "abteilung"],
  linkedin_url: [
    "linkedin",
    "linkedin url",
    "linkedin profile",
    "linkedin profile url",
    "person linkedin url",
    "profile url",
    "default profile url",
    "li url",
    "public profile url",
    "linkedin link",
    "linkedin public url",
    "contact linkedin url",
    "person linkedin",
    "linkedin person url",
  ],
  phone: [
    "phone",
    "phone number",
    "telephone",
    "tel",
    "mobile",
    "mobile phone",
    "mobile number",
    "cell",
    "cell phone",
    "direct phone",
    "work direct phone",
    "first phone",
    "work phone",
    "personal phone",
    "telefon",
    "telefonnummer",
    "handy",
    "telephone number",
    "telefono",
  ],
  country: ["country", "person country", "contact country", "land", "pays", "pais"],
  region: ["state", "region", "province", "person state", "county", "bundesland", "state province"],
  city: ["city", "person city", "contact city", "town", "stadt", "ort", "ville", "ciudad"],
  location: [
    "location",
    "person location",
    "contact location",
    "geo",
    "standort",
    "lieu",
    "ubicacion",
  ],
  timezone: ["timezone", "time zone", "tz"],
  language: ["language", "sprache", "langue", "idioma", "lang"],
  tags: ["tags", "tag", "labels", "label", "lists", "segment", "segments"],
  email_status: [
    "email status",
    "email verification",
    "verification status",
    "email validity",
    "email verification status",
  ],
  consent: [
    "consent",
    "email consent",
    "opt in",
    "marketing consent",
    "gdpr consent",
    "einwilligung",
    "has consent",
  ],
  "company.name": [
    "company",
    "company name",
    "companyname",
    "organization",
    "organisation",
    "organization name",
    "organisation name",
    "account",
    "account name",
    "employer",
    "business name",
    "firma",
    "firmenname",
    "unternehmen",
    "entreprise",
    "societe",
    "empresa",
    "current company",
    "company name for emails",
    "practice name",
    "business",
  ],
  "company.domain": [
    "domain",
    "company domain",
    "website domain",
    "primary domain",
    "domain name",
    "email domain",
  ],
  "company.website": [
    "website",
    "company website",
    "url",
    "web",
    "homepage",
    "home page",
    "site",
    "web site",
    "website url",
    "company url",
    "company site",
    "webseite",
    "internetseite",
    "site web",
    "sitio web",
    "organization website",
    "regular company url",
  ],
  "company.linkedin_url": [
    "company linkedin url",
    "company linkedin",
    "organization linkedin url",
    "company linkedin profile",
    "linkedin company url",
    "linkedin company page",
    "company li url",
    "company url linkedin",
  ],
  "company.industry": [
    "industry",
    "company industry",
    "sector",
    "vertical",
    "branche",
    "industrie",
    "secteur",
    "category",
    "business category",
    "niche",
    "organization industry",
  ],
  "company.description": [
    "company description",
    "description",
    "about",
    "company about",
    "short description",
    "company summary",
    "seo description",
    "beschreibung",
  ],
  "company.employees": [
    "employees",
    "number of employees",
    "num employees",
    "employee count",
    "employees count",
    "headcount",
    "company size",
    "size",
    "staff count",
    "company headcount",
    "estimated num employees",
    "mitarbeiter",
    "anzahl mitarbeiter",
    "company employee count",
  ],
  "company.revenue_range": [
    "annual revenue",
    "revenue",
    "company revenue",
    "annual revenue range",
    "umsatz",
    "revenue range",
  ],
  "company.founded_year": [
    "founded year",
    "founded",
    "year founded",
    "founding year",
    "grundungsjahr",
  ],
  "company.country": [
    "company country",
    "organization country",
    "account country",
    "hq country",
    "headquarters country",
  ],
  "company.region": ["company state", "company region", "organization state", "hq state"],
  "company.city": ["company city", "organization city", "hq city", "account city"],
  "company.location": [
    "company location",
    "headquarters",
    "hq",
    "hq location",
    "company headquarters",
  ],
  "company.address": [
    "address",
    "company address",
    "street",
    "street address",
    "address line 1",
    "adresse",
    "strasse",
    "full address",
    "formatted address",
  ],
  "company.postal_code": [
    "zip",
    "zip code",
    "postal code",
    "postcode",
    "post code",
    "plz",
    "postleitzahl",
    "code postal",
    "company postal code",
    "company zip",
  ],
  "company.phone": [
    "company phone",
    "corporate phone",
    "business phone",
    "main phone",
    "office phone",
    "company phone number",
    "hq phone",
  ],
  "company.technologies": [
    "technologies",
    "technology",
    "tech stack",
    "technology stack",
    "software used",
  ],
};

/** Compact comparison key: camelCase split, no accents, letters and digits only. */
export function headerKey(header: string): string {
  return header
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

let synonymIndex: Map<string, TargetField> | undefined;

function synonymsByKey(): Map<string, TargetField> {
  if (synonymIndex) return synonymIndex;
  const index = new Map<string, TargetField>();
  for (const [field, words] of Object.entries(SYNONYMS) as Array<[TargetField, string[]]>) {
    for (const word of words) {
      const key = headerKey(word);
      if (!index.has(key)) index.set(key, field);
    }
  }
  synonymIndex = index;
  return index;
}

/** The target field for a header by synonym, or null. */
export function synonymField(header: string): TargetField | null {
  return synonymsByKey().get(headerKey(header)) ?? null;
}

/** Field guessed from sample values (emails, LinkedIn URLs, websites), or null. */
export function fieldFromValues(samples: string[]): TargetField | null {
  const values = samples.map((v) => v.trim()).filter(Boolean);
  if (values.length === 0) return null;
  const share = (test: (v: string) => boolean) => values.filter(test).length / values.length;
  if (share((v) => normalizeEmail(v) !== null && !/\s/.test(v)) >= 0.8) return "email";
  if (share((v) => normalizePersonLinkedin(v) !== null) >= 0.8) return "linkedin_url";
  if (share((v) => /linkedin\.com\/company\//i.test(v)) >= 0.8) return "company.linkedin_url";
  if (
    share(
      (v) =>
        /^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(v) && !v.includes("@"),
    ) >= 0.8
  ) {
    return "company.website";
  }
  return null;
}

/** "Lead Score (Q3)" -> "custom.lead_score_q3". */
export function customField(header: string): `custom.${string}` {
  const key =
    header
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "field";
  return `custom.${key}`;
}

/** True for a valid mapping value. */
export function isMappedField(value: string): value is MappedField {
  return (
    value === "ignore" ||
    (TARGET_FIELDS as readonly string[]).includes(value) ||
    /^custom\.[a-z0-9_]{1,40}$/.test(value)
  );
}

/**
 * Maps headers with manual overrides first, then synonyms, then value sniffing. Each target
 * field is used once (first header wins; later ones become custom fields). Headers nothing
 * recognized are returned in `unknown` for the AI step.
 */
export function mapHeaders(
  headers: string[],
  samples: Record<string, string[]>,
  overrides: Record<string, string> = {},
): { mappings: HeaderMapping[]; unknown: string[] } {
  const used = new Set<string>();
  const mappings: HeaderMapping[] = [];
  const unknown: string[] = [];
  const overrideByKey = new Map(
    Object.entries(overrides).map(([header, field]) => [headerKey(header), field]),
  );
  const manualFor = (header: string) => {
    const manual = overrides[header] ?? overrideByKey.get(headerKey(header));
    return manual !== undefined && isMappedField(manual) ? manual : null;
  };
  for (const header of headers) {
    const manual = manualFor(header);
    if (manual && manual !== "ignore" && !manual.startsWith("custom.")) used.add(manual);
  }
  for (const header of headers) {
    const manual = manualFor(header);
    if (manual) {
      mappings.push({ header, field: manual, method: "manual" });
      continue;
    }
    const bySynonym = synonymField(header);
    const byValues = bySynonym ? null : fieldFromValues(samples[header] ?? []);
    const field = bySynonym ?? byValues;
    if (field && !used.has(field)) {
      used.add(field);
      mappings.push({ header, field, method: bySynonym ? "synonym" : "values" });
    } else if (field) {
      mappings.push({ header, field: customField(header), method: "default" });
    } else {
      unknown.push(header);
      mappings.push({ header, field: customField(header), method: "default" });
    }
  }
  return { mappings, unknown };
}
