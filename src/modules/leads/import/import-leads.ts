/**
 * leads.import orchestration: load the table, map headers (heuristics, then AI for the rest),
 * normalize rows, then preview (dry run), run inline, or hand large files to a job.
 */
import { and, eq } from "drizzle-orm";
import { type JobHandle, type OpContext, requireWorkspace } from "../../../core/context.js";
import type { ImportSource } from "../../../core/enums.js";
import { invalid, notFound } from "../../../core/errors.js";
import { imports, type List, lists } from "../../../db/schema/index.js";
import type { MergePolicy } from "../dedupe.js";
import { loadIcp } from "../icp/apply.js";
import { normalizeTags } from "../normalize.js";
import { aiMapHeaders } from "./ai-mapping.js";
import { type HeaderMapping, mapHeaders } from "./mapping.js";
import {
  fetchTable,
  type ParsedTable,
  parseCsvText,
  parseJsonText,
  parseXlsx,
  tableFromObjects,
} from "./parse.js";
import { type NormalizedRow, normalizeRow } from "./rows.js";
import {
  completeImport,
  createImportRow,
  emptyTally,
  finishRows,
  type ImportRunOptions,
  processRows,
  type RowOutcome,
  type SkipReason,
  tallyStats,
} from "./run.js";

/** Imports above this many rows run as a background job. */
export const INLINE_ROW_LIMIT = 500;
export const IMPORT_JOB = "leads.import_run";

export interface ImportRequest {
  source: "csv" | "xlsx" | "json" | "rows" | "url";
  content?: string | undefined;
  rows?: Array<Record<string, unknown>> | undefined;
  url?: string | undefined;
  file_name?: string | undefined;
  mapping?: Record<string, string> | undefined;
  ai_mapping: boolean;
  delimiter?: string | undefined;
  sheet?: string | undefined;
  merge_policy: MergePolicy;
  list_id?: string | undefined;
  list_name?: string | undefined;
  tags?: string[] | undefined;
  icp_id?: string | undefined;
  score: boolean;
  include_consent_countries: boolean;
}

export async function loadTable(ctx: OpContext, request: ImportRequest): Promise<ParsedTable> {
  switch (request.source) {
    case "csv":
      if (!request.content) throw missing("content", "the CSV text");
      return parseCsvText(request.content, request.delimiter);
    case "xlsx": {
      if (!request.content) throw missing("content", "the XLSX file as base64");
      return parseXlsx(Buffer.from(request.content, "base64"), request.sheet);
    }
    case "json":
      if (!request.content) throw missing("content", "the JSON text");
      return parseJsonText(request.content);
    case "rows":
      if (!request.rows) throw missing("rows", "an array of objects");
      return tableFromObjects(request.rows);
    case "url":
      if (!request.url) throw missing("url", "a public CSV URL");
      return fetchTable(ctx, request.url, request.delimiter);
  }
}

function missing(field: string, what: string) {
  return invalid(`Pass \`${field}\` with ${what} for this source.`, { field });
}

/** Header samples: up to 5 non-empty values per header. */
export function headerSamples(table: ParsedTable): Record<string, string[]> {
  const samples: Record<string, string[]> = {};
  for (const header of table.headers) {
    samples[header] = table.rows
      .map((row) => row[header] ?? "")
      .filter((value) => value.trim() !== "")
      .slice(0, 5);
  }
  return samples;
}

/** Heuristic mapping plus the AI step for unknown headers (when enabled). */
export async function buildMapping(
  ctx: OpContext,
  table: ParsedTable,
  request: Pick<ImportRequest, "mapping" | "ai_mapping">,
): Promise<HeaderMapping[]> {
  const samples = headerSamples(table);
  const { mappings, unknown } = mapHeaders(table.headers, samples, request.mapping ?? {});
  const worthAsking = unknown.filter((header) => (samples[header] ?? []).length > 0);
  if (!request.ai_mapping || worthAsking.length === 0) return mappings;
  try {
    return await aiMapHeaders(ctx, mappings, worthAsking, samples);
  } catch (error) {
    // Mapping must not fail the import: unknown columns stay custom fields.
    ctx.log.warn({ err: error }, "AI column mapping failed; keeping heuristic mapping");
    return mappings;
  }
}

export function importSourceOf(request: Pick<ImportRequest, "source" | "url">): ImportSource {
  if (request.source === "url") return /\.xlsx(\?|$)/i.test(request.url ?? "") ? "xlsx" : "csv";
  return request.source;
}

export function normalizeTable(
  table: ParsedTable,
  mappings: HeaderMapping[],
  source: string,
  tags: string[],
): NormalizedRow[] {
  return table.rows.map((record, index) =>
    normalizeRow(index + table.firstRowNumber, record, mappings, { source, extraTags: tags }),
  );
}

/** Existing list by id or name; with `create`, a missing named list is created (static). */
export async function resolveList(
  ctx: OpContext,
  input: { list_id?: string | undefined; list_name?: string | undefined },
  create: boolean,
): Promise<{ list: List | null; willCreate: string | null }> {
  const workspace = requireWorkspace(ctx);
  if (input.list_id) {
    const [list] = await ctx.db
      .select()
      .from(lists)
      .where(and(eq(lists.id, input.list_id), eq(lists.workspace_id, workspace.id)));
    if (!list) throw notFound("List", input.list_id);
    if (list.kind === "smart") {
      throw invalid("Smart lists fill themselves from their filter; import into a static list.", {
        list_id: list.id,
      });
    }
    return { list, willCreate: null };
  }
  const name = input.list_name?.trim();
  if (!name) return { list: null, willCreate: null };
  const [existing] = await ctx.db
    .select()
    .from(lists)
    .where(and(eq(lists.workspace_id, workspace.id), eq(lists.name, name)));
  if (existing) {
    if (existing.kind === "smart")
      throw invalid(`"${name}" is a smart list; import into a static list.`);
    return { list: existing, willCreate: null };
  }
  if (!create) return { list: null, willCreate: name };
  const [created] = await ctx.db
    .insert(lists)
    .values({ workspace_id: workspace.id, name, kind: "static" })
    .onConflictDoNothing()
    .returning();
  if (created) return { list: created, willCreate: null };
  const [raced] = await ctx.db
    .select()
    .from(lists)
    .where(and(eq(lists.workspace_id, workspace.id), eq(lists.name, name)));
  return { list: raced ?? null, willCreate: null };
}

function compactRow(row: NormalizedRow) {
  return {
    row: row.row,
    full_name: row.person?.full_name ?? null,
    email: row.person?.email ?? null,
    title: row.person?.title ?? null,
    linkedin_url: row.person?.linkedin_url ?? null,
    country: row.person?.country ?? row.company?.country ?? null,
    company: row.company
      ? { name: row.company.name ?? null, domain: row.company.domain ?? null }
      : null,
    tags: row.person?.tags ?? row.company?.tags ?? [],
    custom: row.person?.custom ?? row.company?.custom ?? {},
    warnings: row.warnings,
    invalid: row.invalid,
  };
}

function rowsFor(outcomes: RowOutcome[], reason: SkipReason) {
  return outcomes
    .filter((o) => o.reason === reason)
    .slice(0, 20)
    .map((o) => ({ row: o.row, detail: o.detail ?? null }));
}

/** Everything a dry run reports. */
export async function previewImport(
  ctx: OpContext,
  request: ImportRequest,
): Promise<{ preview: Record<string, unknown>; warnings: string[] }> {
  const table = await loadTable(ctx, request);
  const mappings = await buildMapping(ctx, table, request);
  const source = importSourceOf(request);
  const rows = normalizeTable(table, mappings, source, normalizeTags(request.tags ?? []));
  const { list, willCreate } = await resolveList(ctx, request, false);
  const icp = request.score ? await loadIcp(ctx, request.icp_id) : null;
  const options: ImportRunOptions = {
    source,
    mergePolicy: request.merge_policy,
    listId: list?.id ?? null,
    icp,
    includeConsentCountries: request.include_consent_countries,
    importId: null,
  };
  const tally = await processRows(ctx, rows, options, false);
  const warnings: string[] = [];
  const unmapped = mappings.filter((m) => m.method === "default").map((m) => m.header);
  if (unmapped.length) warnings.push(`Kept as custom fields: ${unmapped.slice(0, 10).join(", ")}`);
  if (
    !mappings.some((m) => ["email", "linkedin_url", "full_name", "first_name"].includes(m.field))
  ) {
    if (!mappings.some((m) => m.field === "company.name" || m.field === "company.domain")) {
      warnings.push(
        "No person or company column was recognized; pass `mapping` to map headers by hand.",
      );
    }
  }
  if (tally.skipped.consent_country > 0) {
    warnings.push(
      `${tally.skipped.consent_country} rows are in consent-required countries and will be skipped; set include_consent_countries to keep them (email stays blocked without consent).`,
    );
  }
  if (tally.skipped.role_address > 0) {
    warnings.push(
      `${tally.skipped.role_address} rows use system addresses such as noreply@ or postmaster@ and will be skipped.`,
    );
  }
  if (rows.length > INLINE_ROW_LIMIT) {
    warnings.push(
      `${rows.length} rows: the import will run as a background job; follow it with get_job.`,
    );
  }
  return {
    preview: {
      file: {
        rows: table.rows.length,
        headers: table.headers.length,
        delimiter: table.delimiter ?? null,
      },
      mapping: mappings.map((m) => ({
        header: m.header,
        field: m.field,
        method: m.method,
        sample:
          table.rows.find((r) => (r[m.header] ?? "").trim() !== "")?.[m.header]?.slice(0, 80) ??
          null,
      })),
      mapping_to_reuse: Object.fromEntries(mappings.map((m) => [m.header, m.field])),
      sample_rows: rows
        .filter((r) => !r.invalid)
        .slice(0, 5)
        .map(compactRow),
      counts: {
        total: tally.total,
        create: tally.created,
        update: tally.updated,
        merge: tally.merged,
        duplicate: tally.skipped.duplicate,
        suppressed: tally.skipped.suppressed,
        invalid: tally.skipped.invalid,
        consent_country: tally.skipped.consent_country,
        excluded_country: tally.skipped.excluded_country,
        role_address: tally.skipped.role_address,
        companies_create: tally.companies_created,
      },
      duplicates: rowsFor(tally.outcomes, "duplicate"),
      suppressed: rowsFor(tally.outcomes, "suppressed"),
      invalid: rowsFor(tally.outcomes, "invalid"),
      consent_country: rowsFor(tally.outcomes, "consent_country"),
      list: list
        ? { id: list.id, name: list.name, will_create: false }
        : willCreate
          ? { id: null, name: willCreate, will_create: true }
          : null,
      icp: icp ? { id: icp.id, name: icp.name } : null,
    },
    warnings,
  };
}

export interface ImportRunResult {
  import_id: string;
  status: "completed" | "failed";
  list_id: string | null;
  stats: ReturnType<typeof tallyStats>;
  skipped_rows: Array<{ row: number; reason: string; detail: string | null }>;
  warnings: string[];
}

/** Runs a real import: inline for small tables, as a job (returns a handle) for large ones. */
export async function executeImport(
  ctx: OpContext,
  request: ImportRequest,
): Promise<ImportRunResult | (JobHandle & { import_id: string })> {
  const table = await loadTable(ctx, request);
  const mappings = await buildMapping(ctx, table, request);
  const source = importSourceOf(request);
  const rows = normalizeTable(table, mappings, source, normalizeTags(request.tags ?? []));
  const { list } = await resolveList(ctx, request, true);
  const icp = request.score ? await loadIcp(ctx, request.icp_id) : null;
  const mapping = Object.fromEntries(mappings.map((m) => [m.header, m.field]));
  const baseOptions = {
    merge_policy: request.merge_policy,
    icp_id: icp?.id ?? null,
    include_consent_countries: request.include_consent_countries,
    tags: request.tags ?? [],
  };
  if (rows.length > INLINE_ROW_LIMIT) {
    const importRow = await createImportRow(ctx, {
      source,
      status: "running",
      fileName: request.file_name ?? request.url ?? null,
      mapping,
      options: { ...baseOptions, rows, processed: 0 },
      listId: list?.id ?? null,
    });
    const handle = await ctx.jobs.enqueue(
      IMPORT_JOB,
      { import_id: importRow.id },
      { singletonKey: `import:${importRow.id}` },
    );
    return { ...handle, import_id: importRow.id };
  }
  const importRow = await createImportRow(ctx, {
    source,
    status: "running",
    fileName: request.file_name ?? request.url ?? null,
    mapping,
    options: baseOptions,
    listId: list?.id ?? null,
  });
  return runRowsForImport(ctx, importRow.id, rows, {
    source,
    mergePolicy: request.merge_policy,
    listId: list?.id ?? null,
    icp,
    includeConsentCountries: request.include_consent_countries,
    importId: importRow.id,
  });
}

/** Processes rows for an existing imports row and completes it. */
export async function runRowsForImport(
  ctx: OpContext,
  importId: string,
  rows: NormalizedRow[],
  options: ImportRunOptions,
): Promise<ImportRunResult> {
  const tally = await processRows(ctx, rows, options, true, emptyTally());
  await finishRows(ctx, tally, options);
  const [importRow] = await ctx.db.select().from(imports).where(eq(imports.id, importId));
  if (!importRow) throw notFound("Import", importId);
  const done = await completeImport(ctx, importRow, tally, "completed");
  return importResult(done.id, tally, options.listId);
}

export function importResult(
  importId: string,
  tally: ReturnType<typeof emptyTally>,
  listId: string | null,
  warnings: string[] = [],
): ImportRunResult {
  return {
    import_id: importId,
    status: "completed",
    list_id: listId,
    stats: tallyStats(tally),
    skipped_rows: tally.outcomes
      .filter((o) => o.outcome === "skipped" || o.outcome === "failed")
      .slice(0, 50)
      .map((o) => ({ row: o.row, reason: o.reason ?? o.outcome, detail: o.detail ?? null })),
    warnings,
  };
}
