/** One AI call (fast tier) for the columns the heuristics could not map. */
import type { OpContext } from "../../../core/context.js";
import { importMappingPrompt } from "../prompts/import-mapping.js";
import { customField, type HeaderMapping, isMappedField, TARGET_FIELDS } from "./mapping.js";

const MEANINGS: Record<string, string> = {
  email: "work email address of the person",
  first_name: "given name",
  last_name: "family name",
  full_name: "full person name",
  title: "job title",
  seniority: "seniority level",
  department: "department or function",
  linkedin_url: "LinkedIn profile URL of the person",
  phone: "phone number of the person",
  country: "country of the person",
  region: "state or region of the person",
  city: "city of the person",
  location: "free-text location of the person",
  timezone: "IANA timezone",
  language: "language to write in",
  tags: "comma separated labels",
  email_status: "email verification result",
  consent: "whether the person consented to email",
  "company.name": "company name",
  "company.domain": "company domain",
  "company.website": "company website URL",
  "company.linkedin_url": "company LinkedIn page",
  "company.industry": "industry or business category",
  "company.description": "what the company does",
  "company.employees": "employee count or range",
  "company.revenue_range": "annual revenue",
  "company.founded_year": "year founded",
  "company.country": "company country",
  "company.region": "company state or region",
  "company.city": "company city",
  "company.location": "free-text company location",
  "company.address": "street address",
  "company.postal_code": "postal code",
  "company.phone": "company phone number",
  "company.technologies": "technologies the company uses",
};

/**
 * Asks the brain to map `unknown` headers. Fields already taken stay taken; invalid answers
 * fall back to custom fields. Returns the updated mappings (method "ai" where it helped).
 */
export async function aiMapHeaders(
  ctx: OpContext,
  mappings: HeaderMapping[],
  unknown: string[],
  samples: Record<string, string[]>,
): Promise<HeaderMapping[]> {
  if (unknown.length === 0) return mappings;
  const used = new Set(
    mappings.filter((m) => !unknown.includes(m.header)).map((m) => m.field as string),
  );
  const free = TARGET_FIELDS.filter((field) => !used.has(field));
  const result = await ctx.brain.run(importMappingPrompt, {
    columns: unknown.slice(0, 40).map((header) => ({
      header,
      samples: (samples[header] ?? []).filter(Boolean).slice(0, 3),
    })),
    fields: free.map((field) => ({ field, meaning: MEANINGS[field] ?? field })),
  });
  const answers = new Map(result.output.mappings.map((m) => [m.header, m.field.trim()]));
  return mappings.map((mapping) => {
    if (!unknown.includes(mapping.header)) return mapping;
    const answer = answers.get(mapping.header);
    if (!answer) return mapping;
    if (answer === "ignore") return { header: mapping.header, field: "ignore", method: "ai" };
    if (answer === "custom")
      return { header: mapping.header, field: customField(mapping.header), method: "ai" };
    if (isMappedField(answer) && !answer.startsWith("custom.") && !used.has(answer)) {
      used.add(answer);
      return { header: mapping.header, field: answer, method: "ai" };
    }
    return mapping;
  });
}
