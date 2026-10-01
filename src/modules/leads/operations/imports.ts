/** Import operations: leads.import (file, rows or URL) and the import history. */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireWorkspace } from "../../../core/context.js";
import { IMPORT_SOURCES, IMPORT_STATUSES } from "../../../core/enums.js";
import { notFound } from "../../../core/errors.js";
import { idSchema } from "../../../core/ids.js";
import {
  defineOperation,
  dryRun,
  dryRunOutput,
  jobHandleOutput,
  paginated,
  paginationInput,
} from "../../../core/operation.js";
import { decodeCursor, toPage } from "../../../core/pagination.js";
import { imports } from "../../../db/schema/index.js";
import { MERGE_POLICIES } from "../dedupe.js";
import { executeImport, type ImportRequest, previewImport } from "../import/import-leads.js";
import { MAX_IMPORT_ROWS } from "../import/parse.js";
import { EXAMPLE, importSummary } from "./shapes.js";

const importResultShape = z.object({
  import_id: z.string(),
  status: z.enum(["completed", "failed"]),
  list_id: z.string().nullable(),
  stats: importSummary.shape.stats.unwrap(),
  skipped_rows: z.array(
    z.object({ row: z.number().int(), reason: z.string(), detail: z.string().nullable() }),
  ),
  warnings: z.array(z.string()),
});

const previewShape = z.object({
  file: z.object({
    rows: z.number().int(),
    headers: z.number().int(),
    delimiter: z.string().nullable(),
  }),
  mapping: z.array(
    z.object({
      header: z.string(),
      field: z.string(),
      method: z.string(),
      sample: z.string().nullable(),
    }),
  ),
  mapping_to_reuse: z
    .record(z.string(), z.string())
    .describe("Pass back as mapping to skip the AI mapping step"),
  sample_rows: z.array(z.record(z.string(), z.unknown())),
  counts: z.record(z.string(), z.number()),
  duplicates: z.array(z.object({ row: z.number().int(), detail: z.string().nullable() })),
  suppressed: z.array(z.object({ row: z.number().int(), detail: z.string().nullable() })),
  invalid: z.array(z.object({ row: z.number().int(), detail: z.string().nullable() })),
  consent_country: z.array(z.object({ row: z.number().int(), detail: z.string().nullable() })),
  list: z
    .object({ id: z.string().nullable(), name: z.string(), will_create: z.boolean() })
    .nullable(),
  icp: z.object({ id: z.string(), name: z.string() }).nullable(),
  untrusted: z.literal(true),
});

export const importLeads = defineOperation({
  id: "leads.import",
  summary: "Import leads from CSV, XLSX, JSON, rows or a CSV URL",
  description:
    "Imports people and companies from a CSV (any delimiter), XLSX (base64), JSON, an array of row objects or a public CSV URL: columns are mapped by a synonyms table (Apollo, Sales Navigator and CRM exports included) with an AI call only for unknown headers, rows are normalized, deduplicated against the database with the merge policy, checked against suppressions and country rules, added to a list and scored. Always run with dry_run first: the preview shows the mapping, five sample rows, counts, duplicates, suppressed and invalid rows. Not for outside searches (use find_leads). Files above 500 rows run as a background job; rows in consent-required countries are skipped unless include_consent_countries is true.",
  effect: "write",
  input: z.object({
    source: z.enum(["csv", "xlsx", "json", "rows", "url"]),
    content: z.string().max(20_000_000).optional().describe("CSV or JSON text, or XLSX as base64"),
    rows: z.array(z.record(z.string(), z.unknown())).max(MAX_IMPORT_ROWS).optional(),
    url: z
      .string()
      .url()
      .max(2000)
      .optional()
      .describe("Public CSV URL (Google Sheets links work)"),
    file_name: z.string().max(200).optional(),
    mapping: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Header -> field overrides, e.g. {"Firma": "company.name"}; use "ignore" to drop a column',
      ),
    ai_mapping: z
      .boolean()
      .default(true)
      .describe("Ask the AI about headers the synonyms table does not know"),
    delimiter: z.string().max(1).optional(),
    sheet: z.string().max(100).optional().describe("XLSX sheet name (default: the first)"),
    merge_policy: z
      .enum(MERGE_POLICIES)
      .default("fill_empty")
      .describe(
        "Existing records: fill_empty (default) fills blanks, overwrite replaces, skip leaves them",
      ),
    list_id: idSchema("ls").optional(),
    list_name: z
      .string()
      .max(120)
      .optional()
      .describe("Static list to add everyone to (created when new)"),
    tags: z.array(z.string().max(60)).max(20).optional(),
    icp_id: idSchema("icp").optional().describe("Score with this ICP (default: the default ICP)"),
    score: z.boolean().default(true),
    include_consent_countries: z
      .boolean()
      .default(false)
      .describe(
        "Keep rows with an email in consent-required countries (email stays blocked without consent)",
      ),
  }),
  output: z.union([
    importResultShape,
    jobHandleOutput.extend({ import_id: z.string() }),
    dryRunOutput(previewShape),
  ]),
  http: { method: "POST", path: "/v1/imports" },
  dryRun: "supported",
  idempotent: false,
  workspace: "required",
  examples: [
    {
      title: "Preview a small CSV",
      input: {
        source: "csv",
        content:
          "First Name,Last Name,Email,Company,Website\nDana,Rivers,dana@brightsmile.example.com,Brightsmile Dental Studio,brightsmile.example.com",
        list_name: "Dental Austin",
      },
    },
  ],
  handler: async (ctx, input) => {
    requireWorkspace(ctx);
    const request: ImportRequest = input;
    if (ctx.request.dryRun) {
      const { preview, warnings } = await previewImport(ctx, request);
      return dryRun({ ...preview, untrusted: true as const } as z.input<typeof previewShape>, {
        warnings,
      });
    }
    return executeImport(ctx, request);
  },
});

export const listImports = defineOperation({
  id: "imports.list",
  summary: "List past imports",
  description:
    "Lists imports and find previews, newest first, with source, status and counts (created, updated, skipped, failed). Use it to find an import id, follow a running import or see what a saved search brought in. Not for the rows themselves: people from an import are searchable with search_leads. Previews from find_leads show status previewed until imported.",
  effect: "read",
  input: paginationInput.extend({
    status: z.enum(IMPORT_STATUSES).optional(),
    source: z.enum(IMPORT_SOURCES).optional(),
  }),
  output: paginated(importSummary),
  http: { method: "GET", path: "/v1/imports" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Recent imports", input: { limit: 10 } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const conditions = [eq(imports.workspace_id, workspace.id)];
    if (input.status) conditions.push(eq(imports.status, input.status));
    if (input.source) conditions.push(eq(imports.source, input.source));
    if (input.cursor) {
      const { id } = decodeCursor<{ id?: string }>(input.cursor);
      if (typeof id === "string") conditions.push(sql`${imports.id} < ${id}`);
    }
    const rows = await ctx.db
      .select()
      .from(imports)
      .where(and(...conditions))
      .orderBy(sql`${imports.id} desc`)
      .limit(input.limit + 1);
    return toPage(rows, input.limit, (row) => ({ id: row.id }));
  },
});

export const getImport = defineOperation({
  id: "imports.get",
  summary: "Get one import with counts and row notes",
  description:
    "Returns one import: source, status, the column mapping used, counts by outcome and skip reason, and up to 100 row notes (skipped or failed rows with reason codes such as duplicate, suppressed, invalid or consent_country). Use it after an import job finishes or when a user asks why rows were skipped. Not for the imported people: use search_leads. Row notes show row numbers as in the file.",
  effect: "read",
  input: z.object({ import_id: idSchema("imp") }),
  output: importSummary.extend({
    mapping: z.record(z.string(), z.string()).nullable(),
    errors: z.array(
      z.object({
        row: z.number().int(),
        message: z.string(),
        code: z.string().optional(),
        field: z.string().optional(),
      }),
    ),
    errors_total: z.number().int(),
  }),
  http: { method: "GET", path: "/v1/imports/:import_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Check an import", input: { import_id: EXAMPLE.import } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const [row] = await ctx.db
      .select()
      .from(imports)
      .where(and(eq(imports.id, input.import_id), eq(imports.workspace_id, workspace.id)));
    if (!row) throw notFound("Import", input.import_id);
    const errors = row.errors ?? [];
    return { ...row, errors: errors.slice(0, 100), errors_total: errors.length };
  },
});
