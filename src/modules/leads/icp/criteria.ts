/**
 * ICP criteria and scoring config (stored in icps.criteria / icps.scoring). Every field is
 * optional; only configured criteria count toward the 0-100 fit score.
 */
import { z } from "zod";
import { COMPANY_STATUSES } from "../../../core/enums.js";
import type { Icp } from "../../../db/schema/index.js";
import { SENIORITIES } from "./seniority.js";

const terms = (description: string) =>
  z.array(z.string().min(1).max(100)).max(100).default([]).describe(description);

const employeeBounds = z.object({
  min: z.number().int().min(0).optional(),
  max: z.number().int().min(0).optional(),
});

export const icpCriteriaSchema = z.object({
  industries: terms(
    "Core industries or business categories, e.g. dental clinic, e-commerce (full points)",
  ),
  industries_adjacent: terms("Adjacent industries (half points)"),
  keywords: terms("Words to find in the company name, description, industry or technologies"),
  titles: terms("Job titles of the people to contact, e.g. practice manager, vp operations"),
  seniorities: z
    .array(z.enum(SENIORITIES))
    .default([])
    .describe("Decision levels; one level off earns half points"),
  departments: terms("Functions, e.g. operations, supply chain"),
  employee_range: employeeBounds
    .optional()
    .describe("Sweet spot; up to half the minimum or twice the maximum earns half points"),
  employee_limits: employeeBounds
    .optional()
    .describe("Hard limits: companies outside them are disqualified"),
  countries: terms("Core countries (ISO-2 codes or names)"),
  countries_secondary: terms("Secondary countries (half points)"),
  regions: terms("States, regions or cities (full points)"),
  technologies: terms("Technologies the company uses, e.g. shopify, hubspot"),
  exclude: z
    .object({
      industries: terms("Industries that disqualify"),
      titles: terms("Titles that disqualify, e.g. intern, recruiter"),
      countries: terms("Countries that disqualify"),
      keywords: terms("Words in company text that disqualify"),
      domains: terms("Company domains that disqualify"),
      company_statuses: z
        .array(z.enum(COMPANY_STATUSES))
        .default(["customer", "competitor", "do_not_contact"])
        .describe("Company statuses that disqualify"),
      free_mail: z
        .boolean()
        .default(false)
        .describe("Disqualify people with gmail.com, outlook.com and similar addresses"),
    })
    .prefault({}),
});

export const icpScoringSchema = z.object({
  weights: z
    .object({
      industry: z.number().min(0).max(100).default(25),
      employees: z.number().min(0).max(100).default(15),
      geography: z.number().min(0).max(100).default(10),
      technologies: z.number().min(0).max(100).default(10),
      keywords: z.number().min(0).max(100).default(10),
      title: z.number().min(0).max(100).default(20),
      seniority: z.number().min(0).max(100).default(10),
      department: z.number().min(0).max(100).default(5),
    })
    .prefault({}),
  unknown_share: z
    .number()
    .min(0)
    .max(1)
    .default(0.4)
    .describe("Share of a criterion's weight earned when the value is unknown"),
  ai_refinement: z
    .object({
      enabled: z.boolean().default(false),
      max_adjust: z.number().int().min(1).max(30).default(10),
      top_n: z.number().int().min(1).max(50).default(10),
    })
    .prefault({})
    .describe("Optional AI adjustment for the top candidates of a find preview"),
});

export type IcpCriteria = z.output<typeof icpCriteriaSchema>;
export type IcpCriteriaInput = z.input<typeof icpCriteriaSchema>;
export type IcpScoring = z.output<typeof icpScoringSchema>;
export type IcpScoringInput = z.input<typeof icpScoringSchema>;

export interface ParsedIcp {
  id: string;
  name: string;
  description: string | null;
  criteria: IcpCriteria;
  scoring: IcpScoring;
}

/** Criteria and scoring of a stored ICP with defaults filled (tolerates old or partial rows). */
export function parseIcp(
  row: Pick<Icp, "id" | "name" | "description" | "criteria" | "scoring">,
): ParsedIcp {
  const criteria = icpCriteriaSchema.safeParse(row.criteria ?? {});
  const scoring = icpScoringSchema.safeParse(row.scoring ?? {});
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    criteria: criteria.success ? criteria.data : icpCriteriaSchema.parse({}),
    scoring: scoring.success ? scoring.data : icpScoringSchema.parse({}),
  };
}

/** Short plain-text description of the criteria (for prompts and summaries). */
export function describeCriteria(criteria: IcpCriteria): string {
  const lines: string[] = [];
  const list = (label: string, values: string[]) => {
    if (values.length) lines.push(`${label}: ${values.join(", ")}`);
  };
  list("Industries", criteria.industries);
  list("Adjacent industries", criteria.industries_adjacent);
  list("Keywords", criteria.keywords);
  list("Titles", criteria.titles);
  list("Seniorities", criteria.seniorities);
  list("Departments", criteria.departments);
  if (criteria.employee_range) {
    lines.push(
      `Employees: ${criteria.employee_range.min ?? "any"} to ${criteria.employee_range.max ?? "any"}`,
    );
  }
  list("Countries", criteria.countries);
  list("Secondary countries", criteria.countries_secondary);
  list("Regions", criteria.regions);
  list("Technologies", criteria.technologies);
  list("Excluded industries", criteria.exclude.industries);
  list("Excluded titles", criteria.exclude.titles);
  return lines.join("\n");
}
