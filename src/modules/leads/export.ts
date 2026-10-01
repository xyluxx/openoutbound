/**
 * Lead export: CSV or JSON of a list, a filter or ids, with a field selection. Small sets are
 * returned inline; large ones are streamed to a file under the state directory by a job.
 */

import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { and, asc, eq, gt, inArray, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { OpContext } from "../../core/context.js";
import { OpenOutboundError } from "../../core/errors.js";
import { defineJob } from "../../core/operation.js";
import { type Company, companies, type Person, people } from "../../db/schema/index.js";
import { leadFilterConditions, leadFilterSchema } from "./filters.js";
import type { LeadFilter } from "./types.js";

export const EXPORT_FIELDS = [
  "id",
  "first_name",
  "last_name",
  "full_name",
  "title",
  "seniority",
  "department",
  "email",
  "email_status",
  "linkedin_url",
  "phone",
  "country",
  "region",
  "city",
  "timezone",
  "status",
  "tags",
  "fit_score",
  "source",
  "created_at",
  "last_contacted_at",
  "company_id",
  "company_name",
  "company_domain",
  "company_website",
  "company_industry",
  "company_employees",
  "company_country",
  "company_city",
  "company_phone",
] as const;
export type ExportField = (typeof EXPORT_FIELDS)[number];

export const DEFAULT_EXPORT_FIELDS: ExportField[] = [
  "full_name",
  "title",
  "email",
  "email_status",
  "linkedin_url",
  "country",
  "status",
  "fit_score",
  "company_name",
  "company_domain",
];

export const EXPORT_FORMATS = ["csv", "json"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const INLINE_EXPORT_LIMIT = 5000;
export const EXPORT_JOB = "leads.export_file";
const BATCH = 1000;

export const exportSelectorSchema = z.object({
  list_id: z.string().optional(),
  filter: leadFilterSchema.optional(),
  person_ids: z.array(z.string()).max(1000).optional(),
});
export type ExportSelector = z.infer<typeof exportSelectorSchema>;

type Value = string | number | null;

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/** One field of a person row (company fields from the joined company). */
export function fieldValue(person: Person, company: Company | null, field: ExportField): Value {
  switch (field) {
    case "tags":
      return person.tags.join("; ");
    case "created_at":
      return iso(person.created_at);
    case "last_contacted_at":
      return iso(person.last_contacted_at);
    case "company_id":
      return company?.id ?? null;
    case "company_name":
      return company?.name ?? null;
    case "company_domain":
      return company?.domain ?? null;
    case "company_website":
      return company?.website ?? null;
    case "company_industry":
      return company?.industry ?? null;
    case "company_employees":
      return company?.employee_count ?? null;
    case "company_country":
      return company?.country ?? null;
    case "company_city":
      return company?.city ?? null;
    case "company_phone":
      return company?.phone ?? null;
    default: {
      const value = person[field];
      return typeof value === "number" || typeof value === "string" ? value : null;
    }
  }
}

/**
 * One CSV cell: quoted when needed, and cells that start like a spreadsheet formula get a
 * leading apostrophe so opening the file never runs imported text as a formula.
 */
export function csvCell(value: Value): string {
  if (value === null) return "";
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvLine(values: Value[]): string {
  return `${values.map(csvCell).join(",")}\r\n`;
}

function hasSelection(selector: ExportSelector): boolean {
  return (
    selector.list_id !== undefined ||
    selector.filter !== undefined ||
    selector.person_ids !== undefined
  );
}

/** Throws when the selector names nobody (use filter {} for everyone). */
export function assertSelector(selector: ExportSelector): void {
  if (!hasSelection(selector)) {
    throw new OpenOutboundError("validation_failed", "Say who to export.", {
      hint: "Pass list_id, person_ids or filter (an empty filter {} exports everyone).",
    });
  }
}

async function selectorConditions(ctx: OpContext, selector: ExportSelector): Promise<SQL[]> {
  const conditions = await leadFilterConditions(ctx, (selector.filter ?? {}) as LeadFilter);
  if (selector.list_id) {
    conditions.push(...(await leadFilterConditions(ctx, { list_id: selector.list_id })));
  }
  if (selector.person_ids) {
    conditions.push(
      selector.person_ids.length ? inArray(people.id, selector.person_ids) : sql`false`,
    );
  }
  return conditions;
}

export async function countExport(ctx: OpContext, selector: ExportSelector): Promise<number> {
  const conditions = await selectorConditions(ctx, selector);
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(people)
    .where(and(...conditions));
  return row?.n ?? 0;
}

/** People with their companies in id order, `BATCH` at a time. */
export async function* exportRows(
  ctx: OpContext,
  selector: ExportSelector,
): AsyncGenerator<Array<{ person: Person; company: Company | null }>> {
  const conditions = await selectorConditions(ctx, selector);
  let after: string | null = null;
  for (;;) {
    const where: SQL | undefined = after
      ? and(...conditions, gt(people.id, after))
      : and(...conditions);
    const rows: Array<{ person: Person; company: Company | null }> = await ctx.db
      .select({ person: people, company: companies })
      .from(people)
      .leftJoin(companies, eq(companies.id, people.company_id))
      .where(where)
      .orderBy(asc(people.id))
      .limit(BATCH);
    if (rows.length === 0) return;
    yield rows;
    after = rows[rows.length - 1]?.person.id ?? null;
    if (rows.length < BATCH) return;
  }
}

function record(
  person: Person,
  company: Company | null,
  fields: ExportField[],
): Record<string, Value> {
  return Object.fromEntries(fields.map((field) => [field, fieldValue(person, company, field)]));
}

/** Builds the whole export in memory (callers keep it under INLINE_EXPORT_LIMIT). */
export async function exportInline(
  ctx: OpContext,
  selector: ExportSelector,
  format: ExportFormat,
  fields: ExportField[],
): Promise<{ content: string; rows: number }> {
  let rows = 0;
  if (format === "json") {
    const items: Array<Record<string, Value>> = [];
    for await (const batch of exportRows(ctx, selector)) {
      for (const { person, company } of batch) items.push(record(person, company, fields));
    }
    return { content: JSON.stringify(items), rows: items.length };
  }
  let content = csvLine(fields);
  for await (const batch of exportRows(ctx, selector)) {
    for (const { person, company } of batch) {
      content += csvLine(fields.map((field) => fieldValue(person, company, field)));
      rows += 1;
    }
  }
  return { content, rows };
}

/** Streams the export to a file; returns the path and row count. */
export async function exportToFile(
  ctx: OpContext,
  selector: ExportSelector,
  format: ExportFormat,
  fields: ExportField[],
  fileName: string,
): Promise<{ path: string; rows: number }> {
  const dir = join(ctx.config.stateDir, "exports");
  await mkdir(dir, { recursive: true });
  const path = join(dir, fileName);
  const stream = createWriteStream(path, { encoding: "utf8" });
  const write = async (chunk: string) => {
    if (!stream.write(chunk)) await once(stream, "drain");
  };
  let rows = 0;
  try {
    await write(format === "csv" ? csvLine(fields) : "[");
    for await (const batch of exportRows(ctx, selector)) {
      let chunk = "";
      for (const { person, company } of batch) {
        chunk +=
          format === "csv"
            ? csvLine(fields.map((field) => fieldValue(person, company, field)))
            : `${rows > 0 ? "," : ""}\n${JSON.stringify(record(person, company, fields))}`;
        rows += 1;
      }
      await write(chunk);
    }
    if (format === "json") await write("\n]\n");
  } finally {
    stream.end();
    await once(stream, "finish").catch(() => undefined);
  }
  return { path, rows };
}

export const exportJobPayload = z.object({
  selector: exportSelectorSchema,
  format: z.enum(EXPORT_FORMATS),
  fields: z.array(z.enum(EXPORT_FIELDS)).min(1),
  file_name: z.string().regex(/^[a-z0-9_.-]+$/i),
});

export const exportFileJob = defineJob({
  name: EXPORT_JOB,
  payload: exportJobPayload,
  maxAttempts: 2,
  timeoutMs: 30 * 60_000,
  handler: async (ctx, payload) => {
    if (!ctx.workspace) return { skipped: "no_workspace" };
    return exportToFile(ctx, payload.selector, payload.format, payload.fields, payload.file_name);
  },
});
