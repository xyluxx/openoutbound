/** Output shapes and small view helpers shared by the leads operations. */
import { z } from "zod";
import {
  COMPANY_STATUSES,
  EMAIL_STATUSES,
  ENRICH_STATUSES,
  IMPORT_SOURCES,
  IMPORT_STATUSES,
  LIST_KINDS,
  PERSON_STATUSES,
} from "../../../core/enums.js";
import { failureSchema } from "../../../core/failures.js";
import { isoDateTime } from "../../../core/operation.js";
import { decodeCursor, toPage } from "../../../core/pagination.js";
import type { Company, Person } from "../../../db/schema/index.js";

/** Example ids for operation examples (valid shapes, never real records). */
export const EXAMPLE = {
  person: "pe_01k6a3v0q8x3m2n4p5r6s7t8v9",
  person2: "pe_01k6a3v0q8x3m2n4p5r6s7t8va",
  company: "co_01k6a3v0q8x3m2n4p5r6s7t8w1",
  list: "ls_01k6a3v0q8x3m2n4p5r6s7t8w2",
  icp: "icp_01k6a3v0q8x3m2n4p5r6s7t8w3",
  import: "imp_01k6a3v0q8x3m2n4p5r6s7t8w4",
  savedSearch: "ss_01k6a3v0q8x3m2n4p5r6s7t8w5",
  suppression: "sup_01k6a3v0q8x3m2n4p5r6s7t8w6",
} as const;

export const fitReasonShape = z.object({
  rule: z.string(),
  points: z.number(),
  matched: z.boolean(),
  detail: z.string().optional(),
});

export const companyRef = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string().nullable(),
});

export const personSummary = z.object({
  id: z.string(),
  full_name: z.string().nullable(),
  title: z.string().nullable(),
  email: z.string().nullable(),
  email_status: z.enum(EMAIL_STATUSES),
  linkedin_url: z.string().nullable(),
  status: z.enum(PERSON_STATUSES),
  fit_score: z.number().int().nullable(),
  country: z.string().nullable(),
  tags: z.array(z.string()),
  company: companyRef.nullable(),
  created_at: isoDateTime(),
});
export type PersonSummary = z.input<typeof personSummary>;

/** A provider call of an enrichment run that failed. */
export const failedStepOutput = z.object({
  step: z.enum(["finder", "verifier"]),
  provider: z.string(),
  failure: failureSchema,
});

/** people.enrichment: what the last enrichment run did for the person. */
export const personEnrichmentOutput = z.object({
  at: z.string().describe("When the last enrichment run handled the person"),
  status: z
    .enum(ENRICH_STATUSES)
    .describe("provider_failed: a finder or the verifier failed and nothing usable was found"),
  no_match: z
    .record(z.string(), z.string())
    .optional()
    .describe("Paid finders that answered no match, with when: not asked again for 30 days"),
  failed: z
    .array(failedStepOutput)
    .optional()
    .describe("Steps whose provider failed: the next run asks them again"),
  retry_at: z
    .string()
    .nullable()
    .optional()
    .describe("When the engine retries the failed steps by itself, or null when it does not"),
});

export const personDetail = personSummary.extend({
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  seniority: z.string().nullable(),
  department: z.string().nullable(),
  email_source: z.string().nullable(),
  email_checked_at: isoDateTime().nullable(),
  enrichment: personEnrichmentOutput
    .nullable()
    .describe("The last enrichment run: its status, finder answers and what failed"),
  phone: z.string().nullable(),
  region: z.string().nullable(),
  city: z.string().nullable(),
  timezone: z.string().nullable(),
  language: z.string().nullable(),
  custom: z.record(z.string(), z.unknown()),
  source: z.string().nullable(),
  source_refs: z.record(z.string(), z.string()),
  fit_reasons: z.array(fitReasonShape).nullable(),
  last_contacted_at: isoDateTime().nullable(),
  updated_at: isoDateTime(),
});

export const companySummary = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string().nullable(),
  website: z.string().nullable(),
  industry: z.string().nullable(),
  employee_count: z.number().int().nullable(),
  country: z.string().nullable(),
  city: z.string().nullable(),
  status: z.enum(COMPANY_STATUSES),
  fit_score: z.number().int().nullable(),
  intent_score: z.number().int().nullable(),
  tags: z.array(z.string()),
  created_at: isoDateTime(),
});

export const companyDetail = companySummary.extend({
  linkedin_url: z.string().nullable(),
  description: z.string().nullable(),
  employee_range: z.string().nullable(),
  revenue_range: z.string().nullable(),
  founded_year: z.number().int().nullable(),
  region: z.string().nullable(),
  address: z.string().nullable(),
  postal_code: z.string().nullable(),
  phone: z.string().nullable(),
  timezone: z.string().nullable(),
  technologies: z.array(z.string()),
  custom: z.record(z.string(), z.unknown()),
  source: z.string().nullable(),
  source_refs: z.record(z.string(), z.string()),
  fit_reasons: z.array(fitReasonShape).nullable(),
  last_researched_at: isoDateTime().nullable(),
  updated_at: isoDateTime(),
});

export const listSummary = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  kind: z.enum(LIST_KINDS),
  filter: z.record(z.string(), z.unknown()).nullable(),
  members: z.number().int().describe("People in the list (smart lists: current matches)"),
  created_at: isoDateTime(),
});

export const importSummary = z.object({
  id: z.string(),
  source: z.enum(IMPORT_SOURCES),
  status: z.enum(IMPORT_STATUSES),
  file_name: z.string().nullable(),
  list_id: z.string().nullable(),
  stats: z
    .object({
      total: z.number(),
      created: z.number(),
      updated: z.number(),
      skipped: z.number(),
      failed: z.number(),
      merged: z.number().optional(),
      suppressed: z.number().optional(),
      skipped_by_reason: z.record(z.string(), z.number()).optional(),
      companies_created: z.number().optional(),
      companies_updated: z.number().optional(),
      processed: z.number().optional(),
    })
    .nullable(),
  created_at: isoDateTime(),
  finished_at: isoDateTime().nullable(),
});

/** Person row (+ its company) -> summary view. */
export function personView(
  person: Person,
  company: Pick<Company, "id" | "name" | "domain"> | null,
): PersonSummary {
  return {
    id: person.id,
    full_name: person.full_name,
    title: person.title,
    email: person.email,
    email_status: person.email_status,
    linkedin_url: person.linkedin_url,
    status: person.status,
    fit_score: person.fit_score,
    country: person.country,
    tags: person.tags,
    company: company ? { id: company.id, name: company.name, domain: company.domain } : null,
    created_at: person.created_at,
  };
}

/** Offset of an offset cursor (list operations with custom sort orders). */
export function offsetFrom(cursor: string | undefined): number {
  if (!cursor) return 0;
  const { o } = decodeCursor<{ o?: unknown }>(cursor);
  return typeof o === "number" && Number.isInteger(o) && o >= 0 ? o : 0;
}

/** `{ items, next_cursor, has_more }` from `limit + 1` rows fetched at `offset`. */
export function offsetPage<T>(rows: T[], limit: number, offset: number) {
  return toPage(rows, limit, () => ({ o: offset + limit }));
}
