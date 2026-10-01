/**
 * Saved searches: a find (Apollo or Google Maps) or a leads filter kept with a mode and an
 * optional cron schedule. Modes: manual (keep the preview), ask_first (a lead_import approval
 * with the preview, or with the matching people for a leads filter; the resolver imports or
 * adds them to the list on approve) and auto_import (imports new candidates above
 * min_fit_score). Every run respects spend_cap_credits and the workspace data budget: a Google
 * Maps search gets the lower of the two as its request cap and stops there.
 *
 * Provider failures are recorded on the search: a run that fails stores `status: failed` with
 * the failure in last_result (last_run_at stays), and a run whose source failed part way keeps
 * what came back (`partial`, `failure`) and where it stopped: the next run continues from
 * `resume_cursor`, and the candidates an import did not reach wait in `remaining_preview_id`.
 */
import { Cron } from "croner";
import { and, asc, eq, gt, isNotNull, lte } from "drizzle-orm";
import { z } from "zod";
import { budgetHint, budgetRefusal, formatAmount } from "../../core/budget.js";
import { worthRetrying } from "../../core/call-failure.js";
import {
  type Approval,
  type ApprovalDecision,
  type OpContext,
  requireWorkspace,
} from "../../core/context.js";
import { isOpenOutboundError, OpenOutboundError } from "../../core/errors.js";
import { type Failure, failureOf, partialOf } from "../../core/failures.js";
import {
  type ApprovalApplyResult,
  type ApprovalResolver,
  type BuiltinSchedule,
  defineJob,
} from "../../core/operation.js";
import { people, type SavedSearch, saved_searches } from "../../db/schema/index.js";
import type { CostEstimate } from "../../providers/types.js";
import { leadFilterConditions, leadFilterSchema, resolvePeople } from "./filters.js";
import { candidateName, runFindImport, selectCandidates } from "./find/import.js";
import {
  creditsToStart,
  estimateSearch,
  FIND_KINDS,
  type FindKind,
  type FindSource,
  findProvider,
  importEstimate,
  isGoogleMaps,
  mostCredits,
  runFind,
  searchBudgetHint,
} from "./find/preview.js";
import { findCriteriaSchema } from "./find/query.js";
import { addToList } from "./list-members.js";
import type { LeadFilter } from "./types.js";

export const SAVED_SEARCH_RUN_JOB = "leads.saved_search_run";
export const SAVED_SEARCH_TICK_JOB = "leads.saved_searches_tick";
const MIN_INTERVAL_MS = 60 * 60_000;
const LEADS_SOURCE_MAX = 1000;

/** Why the data budget or the spend cap skipped a run or its reveals, as the user needs it. */
export interface RunRefusal {
  /** What happened, e.g. "Not enough data budget: needs at least 1 credit, 0 left this month". */
  message: string;
  /** How to fix it. */
  hint: string | null;
  /** The numbers: needed, remaining, used, budget, setting, or the spend cap. */
  details: Record<string, unknown>;
}

export interface SavedSearchRunResult {
  saved_search_id: string;
  /** failed: the run stopped on an error (recorded in last_result; the run itself throws). */
  status: "previewed" | "awaiting_approval" | "imported" | "skipped" | "failed";
  reason: string | null;
  /** Set when the data budget or the spend cap skipped the run or left nothing to reveal. */
  refusal: RunRefusal | null;
  preview_id: string | null;
  new_candidates: number;
  selected: number;
  approval_id: string | null;
  import_id: string | null;
  imported: number;
  credits_used: number;
  list_id: string | null;
  ran_at: string;
  /** The source failed part way: what it returned before was kept (see failure). */
  partial: boolean;
  /** The provider failure of a failed or partial run, else null. */
  failure: Failure | null;
  /** A failed run: the error it stopped on. */
  error: { code: string; message: string; hint: string | null } | null;
  /** Where a partial search stopped: the next run continues from here. */
  resume_cursor: string | null;
  /** Candidates a partial import did not reach, as a preview to import with find_leads. */
  remaining_preview_id: string | null;
}

/** Stored query of a find saved search: `{ kind, ...criteria }`. */
export const findQuerySchema = findCriteriaSchema.extend({ kind: z.enum(FIND_KINDS).optional() });

function invalid(message: string, hint: string): OpenOutboundError {
  return new OpenOutboundError("validation_failed", message, { hint });
}

/** Throws unless `schedule` is a valid cron that runs at most hourly. */
export function assertSchedule(schedule: string, timezone: string): void {
  let runs: Date[];
  try {
    runs = new Cron(schedule, { timezone, paused: true }).nextRuns(3);
  } catch (error) {
    throw invalid(
      `"${schedule}" is not a valid cron expression (${(error as Error).message}).`,
      'Use five fields, e.g. "0 8 * * 1-5" for 08:00 on weekdays.',
    );
  }
  if (runs.length === 0) {
    throw invalid(`"${schedule}" never runs.`, 'Use a repeating cron such as "0 8 * * 1".');
  }
  for (let i = 1; i < runs.length; i++) {
    const gap = (runs[i] as Date).getTime() - (runs[i - 1] as Date).getTime();
    if (gap < MIN_INTERVAL_MS) {
      throw invalid(
        "Saved searches run at most once an hour.",
        'Use a daily or weekly cron such as "0 8 * * 1-5".',
      );
    }
  }
}

export function nextRunAt(schedule: string | null, timezone: string, after: Date): Date | null {
  if (!schedule) return null;
  try {
    return new Cron(schedule, { timezone, paused: true }).nextRun(after);
  } catch {
    return null;
  }
}

export function savedSearchKind(search: Pick<SavedSearch, "source" | "query">): FindKind {
  const kind = (search.query as { kind?: unknown }).kind;
  if (kind === "people" || kind === "companies") return kind;
  return search.source === "google_maps" ? "companies" : "people";
}

async function finish(
  ctx: OpContext,
  search: SavedSearch,
  result: SavedSearchRunResult,
): Promise<SavedSearchRunResult> {
  const workspace = requireWorkspace(ctx);
  const now = ctx.clock.now();
  await ctx.db
    .update(saved_searches)
    .set({
      last_run_at: now,
      next_run_at: nextRunAt(search.schedule, workspace.timezone, now),
      last_result: { ...result },
    })
    .where(and(eq(saved_searches.id, search.id), eq(saved_searches.workspace_id, workspace.id)));
  return result;
}

function baseResult(ctx: OpContext, search: SavedSearch): SavedSearchRunResult {
  return {
    saved_search_id: search.id,
    status: "previewed",
    reason: null,
    refusal: null,
    preview_id: null,
    new_candidates: 0,
    selected: 0,
    approval_id: null,
    import_id: null,
    imported: 0,
    credits_used: 0,
    list_id: search.list_id,
    ran_at: ctx.clock.now().toISOString(),
    partial: false,
    failure: null,
    error: null,
    resume_cursor: null,
    remaining_preview_id: null,
  };
}

/** Where the last run's search stopped part way, to continue from (null: start at the top). */
function resumeCursor(search: SavedSearch): string | null {
  const cursor = (search.last_result as { resume_cursor?: unknown } | null)?.resume_cursor;
  return typeof cursor === "string" && cursor.length > 0 ? cursor : null;
}

/**
 * Records a run that stopped on an error in last_result, so the next scheduled run and the
 * agent see it. last_run_at and next_run_at stay as they were.
 */
async function recordFailedRun(
  ctx: OpContext,
  search: SavedSearch,
  result: SavedSearchRunResult,
  error: unknown,
): Promise<void> {
  const workspace = requireWorkspace(ctx);
  const failure = failureOf(error);
  const failed: SavedSearchRunResult = {
    ...result,
    status: "failed",
    reason: failure ? "provider_failed" : "error",
    failure,
    error: isOpenOutboundError(error)
      ? { code: error.code, message: error.message, hint: error.hint ?? null }
      : { code: "internal", message: "The run failed with an internal error.", hint: null },
    credits_used: result.credits_used + (partialOf(error)?.credits ?? 0),
    // Keep the place to continue from: the failed run did not get past it.
    resume_cursor: resumeCursor(search),
  };
  await ctx.db
    .update(saved_searches)
    .set({ last_result: { ...failed } })
    .where(and(eq(saved_searches.id, search.id), eq(saved_searches.workspace_id, workspace.id)));
}

/**
 * Leads source: people matching the filter created since the last run go to the list, right
 * away in auto_import and after a lead_import approval in ask_first.
 */
async function runLeadsSearch(ctx: OpContext, search: SavedSearch): Promise<SavedSearchRunResult> {
  const result = baseResult(ctx, search);
  const filter = leadFilterSchema.parse(search.query) as LeadFilter;
  const conditions = await leadFilterConditions(ctx, filter);
  if (search.last_run_at) conditions.push(gt(people.created_at, search.last_run_at));
  const rows = await ctx.db
    .select({
      id: people.id,
      full_name: people.full_name,
      email: people.email,
      fit_score: people.fit_score,
    })
    .from(people)
    .where(and(...conditions))
    .orderBy(asc(people.created_at))
    .limit(Math.min(search.max_results ?? LEADS_SOURCE_MAX, LEADS_SOURCE_MAX));
  const ids = rows.map((row) => row.id);
  result.new_candidates = ids.length;
  result.selected = ids.length;
  if (ids.length === 0) return finish(ctx, search, { ...result, reason: "no_new_matches" });
  if (search.mode === "manual" || !search.list_id) return finish(ctx, search, result);
  if (search.mode === "ask_first") {
    const best = Math.max(...rows.map((row) => row.fit_score ?? 0));
    const approval = await ctx.approvals.request({
      kind: "lead_import",
      title: `Add ${ids.length} lead(s) from "${search.name}" to the list`,
      summary: `${ids.length} of your own lead(s) match "${search.name}" (best fit ${best}); approving adds them to the saved search's list. No credits are spent.`,
      payload: {
        saved_search_id: search.id,
        source: "leads",
        person_ids: ids,
        list_id: search.list_id,
        people: rows.map((row) => ({
          person_id: row.id,
          name: row.full_name ?? row.email ?? row.id,
          fit_score: row.fit_score,
        })),
      },
      target: { type: "saved_search", id: search.id },
    });
    return finish(ctx, search, {
      ...result,
      status: "awaiting_approval",
      approval_id: approval.id,
    });
  }
  result.imported = await addToList(ctx, search.list_id, ids);
  return finish(ctx, search, { ...result, status: "imported" });
}

function isBudgetError(error: unknown): error is OpenOutboundError {
  return error instanceof OpenOutboundError && error.code === "budget_exceeded";
}

/** How to spend less on a saved search (first half of the budget hint). */
export const SAVED_SEARCH_BUDGET_LOWER =
  "Lower max_results with manage_saved_searches action update";
const RAISE_SPEND_CAP = "Raise spend_cap_credits with manage_saved_searches action update.";

function refusalOf(error: OpenOutboundError): RunRefusal {
  return { message: error.message, hint: error.hint ?? null, details: { ...error.details } };
}

/** "spend_cap_credits is 0, less than the 1 credit a search needs to start" (null: it fits). */
function capBelowStart(cap: number, estimate: CostEstimate): string | null {
  const start = creditsToStart(estimate);
  if (start <= cap) return null;
  const need =
    estimate.minCredits !== undefined
      ? `the ${formatAmount(start, "credits")} a search needs to start`
      : `the ${formatAmount(start, "credits")} the search costs`;
  return `spend_cap_credits is ${cap}, less than ${need}`;
}

/**
 * The dry-run warning when spend_cap_credits stops a run early (a Google Maps search stops at
 * the cap) or skips it (not even the first request fits, or the price is above the cap).
 */
export function spendCapWarning(cap: number | null, estimate: CostEstimate): string | null {
  if (cap === null || estimate.credits <= cap) return null;
  const tooLow = capBelowStart(cap, estimate);
  if (tooLow) return `${tooLow}, so the run will be skipped (spend_cap). ${RAISE_SPEND_CAP}`;
  return `spend_cap_credits is ${cap}, less than the at least ${formatAmount(estimate.credits, "credits")} this search needs, so the run stops after ${formatAmount(cap, "credits")} with fewer results. Raise spend_cap_credits or lower max_results with manage_saved_searches action update.`;
}

/** Runs one saved search now (mode, spend cap and data budget applied) and records the result. */
export async function runSavedSearch(
  ctx: OpContext,
  search: SavedSearch,
): Promise<SavedSearchRunResult> {
  const workspace = requireWorkspace(ctx);
  if (search.source === "leads") return runLeadsSearch(ctx, search);
  const result = baseResult(ctx, search);
  const source = search.source as FindSource;
  const kind = savedSearchKind(search);
  const limit = Math.min(Math.max(search.max_results ?? 25, 1), 100);
  const cap = search.spend_cap_credits;
  const provider = await findProvider(ctx, source, kind);
  const estimate = await estimateSearch(provider, kind, limit);
  // A Google Maps search needs one request to start and stops at the cap and the budget.
  const start = creditsToStart(estimate);
  const tooLow = cap === null ? null : capBelowStart(cap, estimate);
  if (tooLow) {
    return finish(ctx, search, {
      ...result,
      status: "skipped",
      reason: "spend_cap",
      refusal: {
        message: `${tooLow}.`,
        hint: RAISE_SPEND_CAP,
        details: { needed: start, spend_cap_credits: cap },
      },
    });
  }
  const mayReveal = search.mode === "auto_import" && kind === "people" && provider.enrichPeople;
  if (estimate.credits > 0 || mayReveal) {
    try {
      await ctx.usage.assertBudget(workspace.id, "data");
      await ctx.usage.assertCanSpend(workspace.id, "data", start, {
        hint: (status) => searchBudgetHint(status, estimate, SAVED_SEARCH_BUDGET_LOWER),
        most: mostCredits(estimate),
      });
    } catch (error) {
      if (!isBudgetError(error)) throw error;
      return finish(ctx, search, {
        ...result,
        status: "skipped",
        reason: "budget_exceeded",
        refusal: refusalOf(error),
      });
    }
  }

  const { kind: _kind, ...criteria } = findQuerySchema.parse(search.query);
  const resume = resumeCursor(search);
  let found: Awaited<ReturnType<typeof runFind>>;
  try {
    found = await runFind(ctx, {
      source,
      kind,
      criteria,
      limit,
      ...(resume ? { cursor: resume } : {}),
      icpId: search.icp_id,
      savedSearchId: search.id,
      spendCap: cap,
      operation: SAVED_SEARCH_RUN_JOB,
    });
  } catch (error) {
    await recordFailedRun(ctx, search, result, error);
    throw error;
  }
  result.preview_id = found.preview.id;
  result.credits_used = found.credits_used;
  if (found.failure) {
    result.partial = true;
    result.failure = found.failure;
    // Continuing only helps when asking again can succeed.
    result.resume_cursor = worthRetrying(found.failure) ? found.options.next_cursor : null;
  }
  const fresh = selectCandidates(found.options.candidates, {
    topN: limit,
    ...(search.min_fit_score !== null ? { minFitScore: search.min_fit_score } : {}),
  }).selected;
  result.new_candidates = fresh.length;
  if (fresh.length === 0) return finish(ctx, search, { ...result, reason: "no_new_candidates" });

  if (search.mode === "manual") return finish(ctx, search, { ...result, selected: fresh.length });

  // Reveal only as many people as both the spend cap and the monthly data budget still allow.
  let selected = fresh;
  let revealCost = 0;
  let refused: Pick<SavedSearchRunResult, "reason" | "refusal"> = {
    reason: "spend_cap",
    refusal: null,
  };
  if (kind === "people" && provider.enrichPeople) {
    const perPerson = (await importEstimate(provider, kind, 1)).credits;
    if (perPerson > 0) {
      const capLeft = cap === null ? Number.POSITIVE_INFINITY : cap - result.credits_used;
      const budget = await ctx.usage.budgetStatus(workspace.id, "data");
      const budgetLeft = budget.remaining ?? Number.POSITIVE_INFINITY;
      const left = Math.min(capLeft, budgetLeft);
      if (Number.isFinite(left)) {
        selected = fresh.slice(0, Math.floor(Math.max(0, left) / perPerson));
      }
      if (selected.length === 0) {
        const byBudget =
          budgetLeft < capLeft
            ? budgetRefusal(budget, perPerson, {
                hint: budgetHint(budget, "Wait until next month"),
              })
            : null;
        refused = byBudget
          ? { reason: "budget_exceeded", refusal: refusalOf(byBudget) }
          : {
              reason: "spend_cap",
              refusal: {
                message: `spend_cap_credits is ${cap} and the search used ${formatAmount(result.credits_used, "credits")}, which leaves nothing to reveal people (${formatAmount(perPerson, "credits")} each).`,
                hint: RAISE_SPEND_CAP,
                details: {
                  spend_cap_credits: cap,
                  credits_used: result.credits_used,
                  per_person: perPerson,
                },
              },
            };
      }
    }
    revealCost = perPerson * selected.length;
  }
  result.selected = selected.length;
  if (selected.length === 0) {
    return finish(ctx, search, { ...result, ...refused });
  }

  if (search.mode === "ask_first") {
    const best = Math.max(...selected.map((c) => c.fit_score ?? 0));
    const approval = await ctx.approvals.request({
      kind: "lead_import",
      title: `Import ${selected.length} new lead(s) from "${search.name}"`,
      summary: `${selected.length} new candidate(s) from ${isGoogleMaps(provider.id) ? "Google Maps" : source} (best fit ${best}); importing costs about ${revealCost} credit(s).`,
      payload: {
        saved_search_id: search.id,
        preview_id: found.preview.id,
        candidate_ids: selected.map((c) => c.id),
        list_id: search.list_id,
        estimated_credits: revealCost,
        candidates: selected.map((c) => ({
          candidate_id: c.id,
          name: candidateName(c),
          fit_score: c.fit_score,
        })),
      },
      target: { type: "saved_search", id: search.id },
    });
    return finish(ctx, search, {
      ...result,
      status: "awaiting_approval",
      approval_id: approval.id,
    });
  }

  let imported: Awaited<ReturnType<typeof runFindImport>>;
  try {
    imported = await runFindImport(ctx, {
      previewId: found.preview.id,
      candidateIds: selected.map((c) => c.id),
      listId: search.list_id ?? undefined,
      mergePolicy: "fill_empty",
      includeConsentCountries: false,
      enrich: false,
      findPeople: true,
      operation: SAVED_SEARCH_RUN_JOB,
    });
  } catch (error) {
    await recordFailedRun(ctx, search, result, error);
    throw error;
  }
  return finish(ctx, search, {
    ...result,
    status: "imported",
    import_id: imported.import_id,
    imported: imported.stats.created + imported.stats.updated + (imported.stats.merged ?? 0),
    credits_used: result.credits_used + imported.credits_used,
    ...(imported.failure
      ? {
          partial: true,
          failure: result.failure ?? imported.failure,
          remaining_preview_id: imported.remaining?.preview_id ?? null,
        }
      : {}),
  });
}

export const savedSearchRunJob = defineJob({
  name: SAVED_SEARCH_RUN_JOB,
  payload: z.object({ saved_search_id: z.string() }),
  maxAttempts: 2,
  timeoutMs: 10 * 60_000,
  handler: async (ctx, payload) => {
    if (!ctx.workspace) return { skipped: "no_workspace" };
    if (ctx.workspace.status !== "active") return { skipped: "workspace_not_active" };
    const [search] = await ctx.db
      .select()
      .from(saved_searches)
      .where(
        and(
          eq(saved_searches.id, payload.saved_search_id),
          eq(saved_searches.workspace_id, ctx.workspace.id),
        ),
      );
    if (!search?.enabled) return { skipped: "disabled_or_deleted" };
    return runSavedSearch(ctx, search);
  },
});

/** Enqueues due scheduled searches (every 15 minutes per workspace). */
export const savedSearchTickJob = defineJob({
  name: SAVED_SEARCH_TICK_JOB,
  payload: z.object({}).passthrough(),
  maxAttempts: 1,
  handler: async (ctx) => {
    if (!ctx.workspace) return { skipped: "no_workspace" };
    const workspace = ctx.workspace;
    if (workspace.status !== "active") return { skipped: "workspace_not_active" };
    const now = ctx.clock.now();
    const scheduled = await ctx.db
      .select()
      .from(saved_searches)
      .where(
        and(
          eq(saved_searches.workspace_id, workspace.id),
          eq(saved_searches.enabled, true),
          isNotNull(saved_searches.schedule),
        ),
      );
    let enqueued = 0;
    for (const search of scheduled) {
      const next = nextRunAt(search.schedule, workspace.timezone, now);
      if (!search.next_run_at) {
        await ctx.db
          .update(saved_searches)
          .set({ next_run_at: next })
          .where(eq(saved_searches.id, search.id));
        continue;
      }
      if (search.next_run_at > now) continue;
      await ctx.db
        .update(saved_searches)
        .set({ next_run_at: next })
        .where(and(eq(saved_searches.id, search.id), lte(saved_searches.next_run_at, now)));
      await ctx.jobs.enqueue(
        SAVED_SEARCH_RUN_JOB,
        { saved_search_id: search.id },
        { singletonKey: `saved_search:${search.id}` },
      );
      enqueued += 1;
    }
    return { enqueued };
  },
});

export const savedSearchTickSchedule: BuiltinSchedule = {
  name: "leads.saved_searches_tick",
  cron: "*/15 * * * *",
  job: SAVED_SEARCH_TICK_JOB,
  perWorkspace: true,
};

const leadImportPayload = z.object({
  preview_id: z.string(),
  candidate_ids: z.array(z.string()).min(1).max(100),
  list_id: z.string().nullable().optional(),
});

/** Approval payload of an ask_first leads-source run: people already in the workspace. */
const leadListPayload = z.object({
  source: z.literal("leads"),
  person_ids: z.array(z.string()).min(1).max(LEADS_SOURCE_MAX),
  list_id: z.string(),
});

/** Adds the approved people to the list; edits may drop people, never add others. */
async function addApprovedLeads(
  ctx: OpContext,
  approval: Approval,
  decision: ApprovalDecision,
): Promise<ApprovalApplyResult> {
  const asked = leadListPayload.parse(approval.payload);
  const edited = leadListPayload.parse({ ...approval.payload, ...(decision.edits ?? {}) });
  const allowed = new Set(asked.person_ids);
  const ids = await resolvePeople(ctx, {
    personIds: edited.person_ids.filter((id) => allowed.has(id)),
  });
  const added = ids.length > 0 ? await addToList(ctx, edited.list_id, ids) : 0;
  return {
    message: `Added ${added} lead(s) to the list.`,
    target: { type: "list", id: edited.list_id },
    data: { list_id: edited.list_id, added },
  };
}

/**
 * Applies an ask_first saved search: imports the approved find candidates, or adds the approved
 * people of a leads filter to the list (edits may drop candidates or people).
 */
export const leadImportResolver: ApprovalResolver = {
  kind: "lead_import",
  async apply(ctx, approval, decision) {
    const leadsSource = (approval.payload as { source?: unknown }).source === "leads";
    if (decision.decision === "reject") {
      return {
        message: leadsSource
          ? "Nobody was added to the list."
          : "Import skipped. The preview can still be imported with find_leads.",
      };
    }
    if (leadsSource) return addApprovedLeads(ctx, approval, decision);
    const payload = leadImportPayload.parse({ ...approval.payload, ...(decision.edits ?? {}) });
    const result = await runFindImport(ctx, {
      previewId: payload.preview_id,
      candidateIds: payload.candidate_ids,
      listId: payload.list_id ?? undefined,
      mergePolicy: "fill_empty",
      includeConsentCountries: false,
      enrich: false,
      findPeople: true,
      operation: "approvals.lead_import",
    });
    const rest = result.remaining
      ? ` The source failed part way (${result.failure?.class ?? "failed"}): ${result.remaining.candidates} candidate(s) were not reached; import preview ${result.remaining.preview_id} with find_leads action import to continue.`
      : "";
    return {
      message: `Imported ${result.stats.created} new and updated ${result.stats.updated + (result.stats.merged ?? 0)} lead(s).${rest}`,
      target: { type: "import", id: result.import_id },
      data: {
        import_id: result.import_id,
        list_id: result.list_id,
        credits_used: result.credits_used,
        contacts_job_id: result.contacts_job_id,
        status: result.status,
        remaining_preview_id: result.remaining?.preview_id ?? null,
      },
    };
  },
};
