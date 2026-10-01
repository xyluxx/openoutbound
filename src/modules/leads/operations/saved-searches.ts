/** manage_saved_searches: saved finds and filters with a mode and an optional schedule. */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { dataBudgetShape, dataBudgetView } from "../../../core/budget.js";
import { type OpContext, requireWorkspace } from "../../../core/context.js";
import { SAVED_SEARCH_MODES, SAVED_SEARCH_SOURCES } from "../../../core/enums.js";
import { notFound, OpenOutboundError } from "../../../core/errors.js";
import { failureSchema } from "../../../core/failures.js";
import { idSchema } from "../../../core/ids.js";
import {
  defineOperation,
  dryRun,
  dryRunOutput,
  isoDateTime,
  paginated,
  paginationInput,
} from "../../../core/operation.js";
import { decodeCursor, toPage } from "../../../core/pagination.js";
import { type SavedSearch, saved_searches } from "../../../db/schema/index.js";
import type { CostEstimate } from "../../../providers/types.js";
import { leadFilterConditions, leadFilterSchema } from "../filters.js";
import {
  estimateSearch,
  FIND_KINDS,
  type FindSource,
  findProvider,
  mostCredits,
  searchBudgetWarning,
} from "../find/preview.js";
import {
  assertCriteria,
  findCriteriaSchema,
  toCompanyQuery,
  toPeopleQuery,
} from "../find/query.js";
import { loadIcp } from "../icp/apply.js";
import { resolveList } from "../import/import-leads.js";
import {
  assertSchedule,
  findQuerySchema,
  nextRunAt,
  runSavedSearch,
  SAVED_SEARCH_BUDGET_LOWER,
  savedSearchKind,
  spendCapWarning,
} from "../saved-searches.js";
import type { LeadFilter } from "../types.js";
import { EXAMPLE } from "./shapes.js";

const savedSearchView = z.object({
  id: z.string(),
  name: z.string(),
  source: z.enum(SAVED_SEARCH_SOURCES),
  kind: z.enum(FIND_KINDS).nullable(),
  query: z
    .record(z.string(), z.unknown())
    .describe("Find criteria, or the lead filter for source leads"),
  icp_id: z.string().nullable(),
  schedule: z.string().nullable(),
  mode: z.enum(SAVED_SEARCH_MODES),
  min_fit_score: z.number().int().nullable(),
  max_results: z.number().int().nullable(),
  spend_cap_credits: z.number().int().nullable(),
  list_id: z.string().nullable(),
  campaign_id: z.string().nullable(),
  enabled: z.boolean(),
  last_run_at: isoDateTime().nullable(),
  next_run_at: isoDateTime().nullable(),
  last_result: z
    .record(z.string(), z.unknown())
    .nullable()
    .describe(
      "The last run: status (failed when it stopped on an error, with failure and error), partial and failure when the source failed part way, resume_cursor where the next run continues",
    ),
  created_at: isoDateTime(),
});

const runResult = z.object({
  saved_search_id: z.string(),
  status: z
    .enum(["previewed", "awaiting_approval", "imported", "skipped", "failed"])
    .describe("failed appears only in last_result: a run that fails returns the error instead"),
  reason: z.string().nullable().describe("spend_cap, budget_exceeded, no_new_candidates, ..."),
  refusal: z
    .object({
      message: z.string(),
      hint: z.string().nullable(),
      details: z
        .record(z.string(), z.unknown())
        .describe("The numbers: needed, remaining, used, budget and setting, or the spend cap"),
    })
    .nullable()
    .describe("Why the data budget or the spend cap skipped the run or left nothing to reveal"),
  preview_id: z.string().nullable().describe("Import more of it with find_leads action import"),
  new_candidates: z.number().int(),
  selected: z.number().int(),
  approval_id: z.string().nullable(),
  import_id: z.string().nullable(),
  imported: z.number().int(),
  credits_used: z.number(),
  list_id: z.string().nullable(),
  ran_at: z.string(),
  partial: z
    .boolean()
    .describe("The source failed part way: what it returned before was kept (see failure)"),
  failure: failureSchema.nullable(),
  resume_cursor: z
    .string()
    .nullable()
    .describe("Where the partial search stopped: the next run continues from here"),
  remaining_preview_id: z
    .string()
    .nullable()
    .describe("Candidates a partial import did not reach: import with find_leads action import"),
});

function view(search: SavedSearch) {
  return {
    ...search,
    kind: search.source === "leads" ? null : savedSearchKind(search),
  };
}

async function requireSavedSearch(ctx: OpContext, id: string): Promise<SavedSearch> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select()
    .from(saved_searches)
    .where(and(eq(saved_searches.id, id), eq(saved_searches.workspace_id, workspace.id)));
  if (!row) throw notFound("Saved search", id);
  return row;
}

function invalid(message: string, hint: string): OpenOutboundError {
  return new OpenOutboundError("validation_failed", message, { hint });
}

interface Definition {
  source: SavedSearch["source"];
  kind?: (typeof FIND_KINDS)[number] | undefined;
  criteria?: z.output<typeof findCriteriaSchema> | undefined;
  filter?: z.output<typeof leadFilterSchema> | undefined;
  mode: SavedSearch["mode"];
  spend_cap_credits: number | null;
}

/** Validates the search definition and returns the query to store. */
async function queryFor(ctx: OpContext, def: Definition): Promise<Record<string, unknown>> {
  if (def.source === "leads") {
    if (!def.filter) {
      throw invalid("Source leads needs a filter.", 'Pass filter, e.g. {"min_fit_score": 70}.');
    }
    await leadFilterConditions(ctx, def.filter as LeadFilter);
    return { ...def.filter };
  }
  if (!def.criteria) {
    throw invalid(
      `Source ${def.source} needs criteria.`,
      'Pass criteria, e.g. {"query": "dental clinic", "location": "Austin, TX"}.',
    );
  }
  assertCriteria(def.criteria);
  const kind = def.kind ?? (def.source === "google_maps" ? "companies" : "people");
  if (def.source === "google_maps" && kind === "people") {
    throw invalid("Google Maps finds businesses, not people.", "Use kind companies.");
  }
  // Maps the criteria once so invalid countries or ranges fail now, not at run time.
  if (kind === "people") toPeopleQuery(def.criteria);
  else toCompanyQuery(def.criteria);
  if (def.mode === "auto_import" && def.spend_cap_credits === null) {
    throw invalid(
      "auto_import needs a spend cap.",
      "Pass spend_cap_credits (credits one run may spend), or use mode ask_first.",
    );
  }
  return { kind, ...def.criteria };
}

export const listSavedSearches = defineOperation({
  id: "saved_searches.list",
  summary: "List saved searches",
  description:
    "Lists saved searches with their source, mode, schedule, next run and the result of the last run. Use it to see what runs automatically and what it found; the last result names the preview, approval or import it produced. Not for running one (use manage_saved_searches action run) or for searching leads directly (use search_leads or find_leads). Disabled searches are included unless enabled is true.",
  effect: "read",
  input: paginationInput.extend({
    enabled: z.boolean().optional(),
    source: z.enum(SAVED_SEARCH_SOURCES).optional(),
  }),
  output: paginated(savedSearchView),
  http: { method: "GET", path: "/v1/saved-searches" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Scheduled searches", input: { enabled: true } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const conditions = [eq(saved_searches.workspace_id, workspace.id)];
    if (input.enabled !== undefined) conditions.push(eq(saved_searches.enabled, input.enabled));
    if (input.source) conditions.push(eq(saved_searches.source, input.source));
    if (input.cursor) {
      const { id } = decodeCursor<{ id?: string }>(input.cursor);
      if (typeof id === "string") conditions.push(sql`${saved_searches.id} < ${id}`);
    }
    const rows = await ctx.db
      .select()
      .from(saved_searches)
      .where(and(...conditions))
      .orderBy(sql`${saved_searches.id} desc`)
      .limit(input.limit + 1);
    const page = toPage(rows, input.limit, (row) => ({ id: row.id }));
    return { ...page, items: page.items.map(view) };
  },
});

export const getSavedSearch = defineOperation({
  id: "saved_searches.get",
  summary: "Get one saved search",
  description:
    "Returns one saved search: its criteria or filter, ICP, mode, spend cap, destination list, schedule, next run and last result. Use it before changing or running a search. Not for the leads it found: open the preview or import named in last_result with find_leads or import_leads. Times are UTC; schedules run in the workspace timezone.",
  effect: "read",
  input: z.object({ saved_search_id: idSchema("ss") }),
  output: savedSearchView,
  http: { method: "GET", path: "/v1/saved-searches/:saved_search_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Open a saved search", input: { saved_search_id: EXAMPLE.savedSearch } }],
  handler: async (ctx, input) => view(await requireSavedSearch(ctx, input.saved_search_id)),
});

const definitionFields = {
  kind: z
    .enum(FIND_KINDS)
    .optional()
    .describe("people or companies (apollo); google_maps is always companies"),
  criteria: findCriteriaSchema
    .optional()
    .describe("find_leads criteria (sources apollo and google_maps)"),
  filter: leadFilterSchema
    .optional()
    .describe("Lead filter (source leads: new matches go to the list)"),
  icp_id: idSchema("icp").optional().describe("Score with this ICP (default: the default ICP)"),
  schedule: z
    .string()
    .max(100)
    .nullable()
    .optional()
    .describe(
      'Cron in the workspace timezone, at most hourly, e.g. "0 8 * * 1-5"; null = manual only',
    ),
  mode: z
    .enum(SAVED_SEARCH_MODES)
    .optional()
    .describe("manual (keep a preview), ask_first (approval before importing) or auto_import"),
  min_fit_score: z.number().int().min(0).max(100).nullable().optional(),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(100)
    .nullable()
    .optional()
    .describe("Candidates per run (default 25)"),
  spend_cap_credits: z
    .number()
    .int()
    .min(0)
    .nullable()
    .optional()
    .describe(
      "Most credits one run may spend (search plus email reveals); required for auto_import",
    ),
  list_id: idSchema("ls").optional(),
  list_name: z
    .string()
    .max(120)
    .optional()
    .describe("Static list for imported people (created when new)"),
  campaign_id: z.string().max(40).nullable().optional().describe("Stored for later auto-enroll"),
  enabled: z.boolean().optional(),
};

export const createSavedSearch = defineOperation({
  id: "saved_searches.create",
  summary: "Save a find or filter, optionally on a schedule",
  description:
    "Saves an Apollo or Google Maps search (or a leads filter) with a mode: manual keeps a preview each run, ask_first creates a lead_import approval with the new candidates (for a leads filter: the matching people, added to the list on approve), auto_import imports new candidates above min_fit_score into the destination list within spend_cap_credits. Use it for recurring prospecting, for example new local businesses every Monday. Not for one-off searches (use find_leads). Schedules run at most hourly in the workspace timezone and skip paused workspaces; auto_import requires a spend cap.",
  effect: "write",
  input: z.object({
    name: z.string().min(1).max(120),
    source: z.enum(SAVED_SEARCH_SOURCES),
    ...definitionFields,
  }),
  output: savedSearchView,
  http: { method: "POST", path: "/v1/saved-searches" },
  dryRun: "none",
  idempotent: false,
  workspace: "required",
  examples: [
    {
      title: "Weekly dental clinics in Austin, with approval",
      input: {
        name: "Austin dental clinics",
        source: "google_maps",
        criteria: { query: "dental clinic", location: "Austin, TX" },
        schedule: "0 8 * * 1",
        mode: "ask_first",
        min_fit_score: 60,
        max_results: 40,
        spend_cap_credits: 5,
        list_name: "Austin dental",
      },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const mode = input.mode ?? "manual";
    const spendCap = input.spend_cap_credits ?? null;
    const query = await queryFor(ctx, {
      source: input.source,
      kind: input.kind,
      criteria: input.criteria,
      filter: input.filter,
      mode,
      spend_cap_credits: spendCap,
    });
    if (input.icp_id) await loadIcp(ctx, input.icp_id);
    const schedule = input.schedule?.trim() || null;
    if (schedule) assertSchedule(schedule, workspace.timezone);
    const { list } = await resolveList(
      ctx,
      { list_id: input.list_id, list_name: input.list_name },
      true,
    );
    const [row] = await ctx.db
      .insert(saved_searches)
      .values({
        workspace_id: workspace.id,
        name: input.name.trim(),
        source: input.source,
        query,
        icp_id: input.icp_id ?? null,
        schedule,
        mode,
        min_fit_score: input.min_fit_score ?? null,
        max_results: input.max_results ?? null,
        spend_cap_credits: spendCap,
        list_id: list?.id ?? null,
        campaign_id: input.campaign_id ?? null,
        enabled: input.enabled ?? true,
        next_run_at: nextRunAt(schedule, workspace.timezone, ctx.clock.now()),
      })
      .returning();
    if (!row) throw new Error("saved search insert returned no row");
    return view(row);
  },
});

export const updateSavedSearch = defineOperation({
  id: "saved_searches.update",
  summary: "Change a saved search",
  description:
    "Changes the fields you pass on a saved search: criteria or filter, mode, schedule (null stops scheduling), fit threshold, spend cap, destination list or enabled. Use it to pause a search (enabled false), tighten its criteria or switch it to ask_first. Not for running it now (use action run). Changing the schedule recomputes the next run; switching to auto_import requires a spend cap.",
  effect: "write",
  input: z.object({
    saved_search_id: idSchema("ss"),
    name: z.string().min(1).max(120).optional(),
    ...definitionFields,
  }),
  output: savedSearchView,
  http: { method: "PATCH", path: "/v1/saved-searches/:saved_search_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    { title: "Pause a search", input: { saved_search_id: EXAMPLE.savedSearch, enabled: false } },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const current = await requireSavedSearch(ctx, input.saved_search_id);
    const mode = input.mode ?? current.mode;
    const spendCap =
      input.spend_cap_credits !== undefined ? input.spend_cap_credits : current.spend_cap_credits;
    const patch: Partial<typeof saved_searches.$inferInsert> = {};
    const definitionChanged =
      input.criteria !== undefined ||
      input.filter !== undefined ||
      input.kind !== undefined ||
      input.mode !== undefined ||
      input.spend_cap_credits !== undefined;
    if (definitionChanged) {
      const stored = findQuerySchema.safeParse(current.query);
      const { kind: storedKind, ...storedCriteria } = stored.success ? stored.data : {};
      patch.query = await queryFor(ctx, {
        source: current.source,
        kind: input.kind ?? storedKind,
        criteria: input.criteria ?? (current.source === "leads" ? undefined : storedCriteria),
        filter:
          input.filter ??
          (current.source === "leads" ? leadFilterSchema.parse(current.query) : undefined),
        mode,
        spend_cap_credits: spendCap,
      });
    }
    // A changed search starts from the top: where the old one stopped does not apply.
    if (definitionChanged && current.last_result?.resume_cursor) {
      patch.last_result = { ...current.last_result, resume_cursor: null };
    }
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.icp_id !== undefined) {
      await loadIcp(ctx, input.icp_id);
      patch.icp_id = input.icp_id;
    }
    if (input.schedule !== undefined) {
      const schedule = input.schedule?.trim() || null;
      if (schedule) assertSchedule(schedule, workspace.timezone);
      patch.schedule = schedule;
      patch.next_run_at = nextRunAt(schedule, workspace.timezone, ctx.clock.now());
    }
    if (input.mode !== undefined) patch.mode = input.mode;
    if (input.min_fit_score !== undefined) patch.min_fit_score = input.min_fit_score;
    if (input.max_results !== undefined) patch.max_results = input.max_results;
    if (input.spend_cap_credits !== undefined) patch.spend_cap_credits = input.spend_cap_credits;
    if (input.list_id !== undefined || input.list_name !== undefined) {
      const { list } = await resolveList(
        ctx,
        { list_id: input.list_id, list_name: input.list_name },
        true,
      );
      patch.list_id = list?.id ?? null;
    }
    if (input.campaign_id !== undefined) patch.campaign_id = input.campaign_id;
    if (input.enabled !== undefined) {
      patch.enabled = input.enabled;
      if (input.enabled && current.schedule && input.schedule === undefined) {
        patch.next_run_at = nextRunAt(current.schedule, workspace.timezone, ctx.clock.now());
      }
    }
    if (Object.keys(patch).length === 0) return view(current);
    const [row] = await ctx.db
      .update(saved_searches)
      .set(patch)
      .where(and(eq(saved_searches.id, current.id), eq(saved_searches.workspace_id, workspace.id)))
      .returning();
    return view(row ?? current);
  },
});

export const deleteSavedSearch = defineOperation({
  id: "saved_searches.delete",
  summary: "Delete a saved search",
  description:
    "Deletes a saved search and its schedule. Leads it already imported, previews and pending approvals stay. Use it when a recurring search is no longer wanted; to stop it only for a while, use action update with enabled false. Not reversible.",
  effect: "destructive",
  input: z.object({ saved_search_id: idSchema("ss") }),
  output: z.object({ deleted: z.boolean(), saved_search_id: z.string() }),
  http: { method: "DELETE", path: "/v1/saved-searches/:saved_search_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Delete a search", input: { saved_search_id: EXAMPLE.savedSearch } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const rows = await ctx.db
      .delete(saved_searches)
      .where(
        and(
          eq(saved_searches.id, input.saved_search_id),
          eq(saved_searches.workspace_id, workspace.id),
        ),
      )
      .returning({ id: saved_searches.id });
    if (rows.length === 0) throw notFound("Saved search", input.saved_search_id);
    return { deleted: true, saved_search_id: input.saved_search_id };
  },
});

export const runSavedSearchOp = defineOperation({
  id: "saved_searches.run",
  summary: "Run a saved search now",
  description:
    "Runs a saved search now with its mode: manual returns the preview id, ask_first creates a lead_import approval, auto_import imports the new candidates above min_fit_score into the destination list. Use it to test a search before scheduling it or to refresh on demand; not for one-off searches (use find_leads). Searches that cost credits stop at spend_cap_credits and at the workspace data budget (a Google Maps search stops there with fewer results, other searches are skipped when their price does not fit); dry_run shows the estimated credits only. A failed run is recorded in last_result with its failure, and when the source failed part way the run keeps what came back (partial) and the next one continues from resume_cursor.",
  effect: "spend",
  input: z.object({ saved_search_id: idSchema("ss") }),
  output: z.union([
    runResult,
    dryRunOutput(
      z.object({
        saved_search_id: z.string(),
        source: z.string(),
        mode: z.string(),
        search_credits: z.number().describe("Estimated credits (for Google Maps the least)"),
        max_search_credits: z
          .number()
          .describe("The most the search can cost (Google Maps: max_requests_per_search)"),
        spend_cap_credits: z.number().nullable(),
        within_cap: z
          .boolean()
          .describe(
            "The most the search can cost fits spend_cap_credits; if not, a Google Maps search stops at the cap and other searches are skipped",
          ),
        budget: dataBudgetShape,
      }),
    ),
  ]),
  http: { method: "POST", path: "/v1/saved-searches/:saved_search_id/run" },
  dryRun: "supported",
  idempotent: false,
  workspace: "required",
  examples: [{ title: "Run now", input: { saved_search_id: EXAMPLE.savedSearch } }],
  handler: async (ctx, input) => {
    const search = await requireSavedSearch(ctx, input.saved_search_id);
    if (ctx.request.dryRun) {
      const workspace = requireWorkspace(ctx);
      let estimate: CostEstimate = { credits: 0 };
      if (search.source !== "leads") {
        const kind = savedSearchKind(search);
        const provider = await findProvider(ctx, search.source as FindSource, kind);
        estimate = await estimateSearch(provider, kind, search.max_results ?? 25);
      }
      const { credits } = estimate;
      const most = mostCredits(estimate);
      const cap = search.spend_cap_credits;
      const budget = await ctx.usage.budgetStatus(workspace.id, "data");
      const warnings = [
        spendCapWarning(cap, estimate),
        searchBudgetWarning(budget, estimate, {
          lower: SAVED_SEARCH_BUDGET_LOWER,
          outcome: "the run will be skipped (budget_exceeded)",
        }),
      ].filter((warning): warning is string => warning !== null);
      return dryRun(
        {
          saved_search_id: search.id,
          source: search.source,
          mode: search.mode,
          search_credits: credits,
          max_search_credits: most,
          spend_cap_credits: cap,
          within_cap: cap === null || most <= cap,
          budget: dataBudgetView(budget),
        },
        {
          warnings,
          estimatedCost: { credits, ...(estimate.note ? { note: estimate.note } : {}) },
        },
      );
    }
    return runSavedSearch(ctx, search);
  },
});
