/** find_leads operations: search an outside source (preview) and import selected candidates. */
import { z } from "zod";
import { budgetWarning, dataBudgetShape, dataBudgetView } from "../../../core/budget.js";
import { requireWorkspace } from "../../../core/context.js";
import { failureSchema } from "../../../core/failures.js";
import { idSchema } from "../../../core/ids.js";
import { defineOperation, dryRun, dryRunOutput } from "../../../core/operation.js";
import { MERGE_POLICIES } from "../dedupe.js";
import { importBudgetHint, planFindImport, runFindImport } from "../find/import.js";
import {
  candidateView,
  estimateSearch,
  FIND_KINDS,
  FIND_SOURCES,
  type FindKind,
  findProvider,
  runFind,
  SEARCH_BUDGET_LOWER,
  searchBudgetWarning,
} from "../find/preview.js";
import {
  assertCriteria,
  type FindCriteria,
  findCriteriaShape,
  toCompanyQuery,
  toPeopleQuery,
} from "../find/query.js";
import { EXAMPLE, importSummary } from "./shapes.js";

const costShape = z.object({ credits: z.number(), note: z.string().nullable() });

const findOutput = z.object({
  preview_id: z.string().describe("Pass to find_leads action import"),
  source: z.enum(FIND_SOURCES),
  kind: z.enum(FIND_KINDS),
  provider: z.string(),
  candidates: z.array(candidateView),
  total_available: z.number().nullable(),
  next_cursor: z.string().nullable().describe("Pass as cursor with the same criteria for more"),
  credits_used: z.number(),
  import_estimate: costShape.describe("Credits to import every candidate of this page"),
  warnings: z.array(z.string()),
  failure: failureSchema
    .nullable()
    .describe(
      "The source failed part way: these are the results it returned (and charged) before, and next_cursor continues after them",
    ),
  untrusted: z.literal(true),
});

const findDryRunPreview = z.object({
  source: z.enum(FIND_SOURCES),
  kind: z.enum(FIND_KINDS),
  provider: z.string(),
  limit: z.number().int(),
  query: z.record(z.string(), z.unknown()).describe("What the provider will be asked"),
  budget: dataBudgetShape,
});

function kindOf(input: { source: string; kind?: FindKind | undefined }): FindKind {
  return input.kind ?? (input.source === "google_maps" ? "companies" : "people");
}

function criteriaOf(input: Record<string, unknown>): FindCriteria {
  const criteria: Record<string, unknown> = {};
  for (const key of Object.keys(findCriteriaShape)) {
    if (input[key] !== undefined) criteria[key] = input[key];
  }
  return criteria as FindCriteria;
}

export const findLeads = defineOperation({
  id: "leads.find",
  summary: "Search Apollo or Google Maps for new leads (preview with fit scores)",
  description:
    "Searches an outside lead source and returns a preview: Apollo people (free, no emails yet) or companies, and Google Maps local businesses, each with an ICP fit score, a one-line reason and flags for records already in the database or suppressed. Use it to find new prospects, then import the ones you want with find_leads action import and the preview_id. Not for leads you already have (use search_leads) or for files (use import_leads). Google Maps and Apollo company searches cost credits per request (check with dry_run; a Google Maps estimate is the least a search costs, since splitting a busy area takes more requests, and a search stops at what is left of the data budget or at a provider failure with a next_cursor to continue); Google names, addresses and ratings are shown here only and are never stored.",
  effect: "spend",
  input: z.object({
    source: z
      .enum(FIND_SOURCES)
      .describe("apollo (people or companies) or google_maps (businesses)"),
    kind: z
      .enum(FIND_KINDS)
      .optional()
      .describe("people or companies (default: people for apollo, companies for google_maps)"),
    ...findCriteriaShape,
    limit: z.number().int().min(1).max(100).default(25).describe("Candidates in this page"),
    cursor: z
      .string()
      .max(8000)
      .optional()
      .describe("next_cursor of a previous search with the same criteria"),
    icp_id: idSchema("icp").optional().describe("Score with this ICP (default: the default ICP)"),
  }),
  output: z.union([findOutput, dryRunOutput(findDryRunPreview)]),
  http: { method: "POST", path: "/v1/find" },
  dryRun: "supported",
  idempotent: false,
  workspace: "required",
  examples: [
    {
      title: "Operations leaders at US e-commerce brands",
      input: {
        source: "apollo",
        kind: "people",
        titles: ["Head of Operations", "VP Operations"],
        industries: ["e-commerce"],
        countries: ["US"],
        employees_min: 20,
        employees_max: 500,
        limit: 25,
      },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const kind = kindOf(input);
    const criteria = criteriaOf(input);
    if (ctx.request.dryRun) {
      assertCriteria(criteria);
      const provider = await findProvider(ctx, input.source, kind);
      const estimate = await estimateSearch(provider, kind, input.limit);
      const query = kind === "people" ? toPeopleQuery(criteria) : toCompanyQuery(criteria);
      const budget = await ctx.usage.budgetStatus(workspace.id, "data");
      const warning = searchBudgetWarning(budget, estimate, { lower: SEARCH_BUDGET_LOWER });
      return dryRun(
        {
          source: input.source,
          kind,
          provider: provider.id,
          limit: input.limit,
          query: { ...query },
          budget: dataBudgetView(budget),
        },
        {
          warnings: warning ? [warning] : [],
          estimatedCost: {
            credits: estimate.credits,
            ...(estimate.note ? { note: estimate.note } : {}),
          },
        },
      );
    }
    const result = await runFind(ctx, {
      source: input.source,
      kind,
      criteria,
      limit: input.limit,
      cursor: input.cursor,
      icpId: input.icp_id,
      operation: "leads.find",
    });
    return {
      preview_id: result.preview.id,
      source: input.source,
      kind,
      provider: result.options.provider,
      candidates: result.views,
      total_available: result.total_available,
      next_cursor: result.options.next_cursor,
      credits_used: result.credits_used,
      import_estimate: {
        credits: result.import_estimate.credits,
        note: result.import_estimate.note ?? null,
      },
      warnings: result.warnings,
      failure: result.failure,
      untrusted: true as const,
    };
  },
});

const findImportResult = z.object({
  import_id: z.string(),
  status: z
    .enum(["completed", "partial"])
    .describe(
      "partial: the source failed part way; the people revealed before were imported and remaining holds the rest",
    ),
  list_id: z.string().nullable(),
  stats: importSummary.shape.stats.unwrap(),
  skipped_rows: z.array(
    z.object({ row: z.number().int(), reason: z.string(), detail: z.string().nullable() }),
  ),
  warnings: z.array(z.string()),
  credits_used: z.number(),
  enrichment_job_id: z.string().nullable().describe("Email waterfall job (enrich: true)"),
  contacts_job_id: z.string().nullable().describe("Website crawl job for imported companies"),
  failure: failureSchema.nullable().describe("The failure that cut the import short"),
  remaining: z
    .object({ preview_id: z.string(), candidates: z.number().int() })
    .nullable()
    .describe(
      "Candidates the source did not reach, as a new preview: import it with find_leads action import to continue",
    ),
});

const findImportPlan = z.object({
  preview_id: z.string(),
  source: z.string(),
  kind: z.string(),
  selected: z.array(
    z.object({ candidate_id: z.string(), name: z.string(), fit_score: z.number().nullable() }),
  ),
  skipped: z.array(z.object({ candidate_id: z.string(), reason: z.string(), detail: z.string() })),
  below_min_fit: z.number().int(),
  list: z
    .object({ id: z.string().nullable(), name: z.string(), will_create: z.boolean() })
    .nullable(),
  follow_up: z.array(z.string()),
  budget: dataBudgetShape,
});

export const importFoundLeads = defineOperation({
  id: "leads.find_import",
  summary: "Import selected candidates of a find_leads preview",
  description:
    "Imports candidates from a find_leads preview, chosen by candidate_ids or as the best top_n above min_fit_score, skipping records already in the database and suppressed ones; not for files (use import_leads), and each preview can be imported once. Apollo people get their names, LinkedIn and work emails revealed now (1 credit per matched person, only for the selected people); Google Maps businesses are stored with their place id and website domain, and a website crawl job then fills name, address, phone and, with find_people, the decision makers. Dry run is the default: it lists the selection, the credits, what is left of the monthly data budget and the follow-up jobs; pass dry_run false to import. A real run that needs more credits than are left is refused before revealing anyone (with how many fit), and a source that fails part way leaves a partial import plus a new preview of the candidates it did not reach.",
  effect: "spend",
  input: z.object({
    preview_id: idSchema("imp").describe("preview_id from find_leads action search"),
    candidate_ids: z
      .array(z.string().regex(/^c\d{1,3}$/))
      .min(1)
      .max(100)
      .optional()
      .describe('Candidates to import, e.g. ["c1", "c4"]'),
    top_n: z.number().int().min(1).max(100).optional().describe("Import the N best new candidates"),
    min_fit_score: z.number().int().min(0).max(100).optional(),
    list_id: idSchema("ls").optional(),
    list_name: z
      .string()
      .max(120)
      .optional()
      .describe("Static list to add everyone to (created when new)"),
    tags: z.array(z.string().max(60)).max(20).optional(),
    merge_policy: z.enum(MERGE_POLICIES).default("fill_empty"),
    include_consent_countries: z
      .boolean()
      .default(false)
      .describe("Keep people with an email in consent-required countries"),
    enrich: z
      .boolean()
      .default(false)
      .describe("People: run the email waterfall for the imported people afterwards"),
    find_people: z
      .boolean()
      .default(true)
      .describe(
        "Companies: also create the decision makers named on each website (one fast AI call per company)",
      ),
  }),
  output: z.union([findImportResult, dryRunOutput(findImportPlan)]),
  http: { method: "POST", path: "/v1/find/import" },
  dryRun: "default",
  idempotent: false,
  workspace: "required",
  examples: [
    {
      title: "Import the ten best new candidates into a list",
      input: {
        preview_id: EXAMPLE.import,
        top_n: 10,
        min_fit_score: 60,
        list_name: "Ops leaders Q4",
      },
    },
  ],
  handler: async (ctx, input) => {
    const request = {
      previewId: input.preview_id,
      candidateIds: input.candidate_ids,
      topN: input.top_n,
      minFitScore: input.min_fit_score,
      listId: input.list_id,
      listName: input.list_name,
      tags: input.tags,
      mergePolicy: input.merge_policy,
      includeConsentCountries: input.include_consent_countries,
      enrich: input.enrich,
      findPeople: input.find_people,
      operation: "leads.find_import",
    };
    if (ctx.request.dryRun) {
      const workspace = requireWorkspace(ctx);
      const plan = await planFindImport(ctx, request);
      const { estimate, ...preview } = plan;
      const warnings = plan.selected.length === 0 ? ["Nothing to import with this selection."] : [];
      const budget = await ctx.usage.budgetStatus(workspace.id, "data");
      const warning = budgetWarning(budget, estimate.credits, {
        hint: importBudgetHint(budget, estimate.credits / Math.max(1, plan.selected.length)),
      });
      if (warning) warnings.push(warning);
      return dryRun(
        { ...preview, budget: dataBudgetView(budget) },
        {
          warnings,
          estimatedCost: {
            credits: estimate.credits,
            ...(estimate.note ? { note: estimate.note } : {}),
          },
        },
      );
    }
    return runFindImport(ctx, request);
  },
});
