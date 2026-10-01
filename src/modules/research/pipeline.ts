/**
 * The `research.run` job: fills every pending brief row of one company (or one company-less
 * person). Company briefs come first and are reused by the people of that company while
 * fresh; each brief is one brain call over gathered sources, then source-validated.
 *
 * A brief built while a source failed is `partial`, with the failed sources in `gaps` (a
 * person brief also lists the gaps of the company brief it builds on). A later run of a target
 * whose latest brief is partial completes it: the searches the partial run kept are reused and
 * only the failed ones are asked again, the company brief first.
 *
 * Nothing is paid for while no brief can be written: before its first search the job checks
 * that the workspace has a brain (without one it waits, using no attempt) and AI budget left.
 * The searches a run paid for stay on the pending row (`gaps.kept`) until the brief is written,
 * so the run after a wait for the brain (the agent brain answering, a brain being set) or a
 * brain error reuses them instead of paying again.
 */
import { and, eq } from "drizzle-orm";
import { assertBrainReady } from "../../brain/service.js";
import type { JobContext } from "../../core/context.js";
import { isJobWaitError, isOpenOutboundError } from "../../core/errors.js";
import type { EventData } from "../../core/events.js";
import type { Failure } from "../../core/failures.js";
import { parseWorkspaceSettings } from "../../core/settings.js";
import {
  type Company,
  companies,
  type KeptSearch,
  type Person,
  type ResearchBrief,
  type ResearchBriefRow,
  type ResearchGap,
  type ResearchGaps,
  type ResearchSource,
  research_briefs,
} from "../../db/schema/index.js";
import { listActiveOffers } from "../knowledge/service.js";
import {
  type GatheredSource,
  type GatherResult,
  gatherCompanySources,
  gatherPersonSources,
} from "./gather.js";
import { type BriefSource, briefPrompt } from "./prompts/brief.js";
import {
  type BriefTarget,
  ensurePendingRow,
  freshSince,
  latestBrief,
  pendingRowsForScope,
} from "./store.js";
import { loadCompany, loadPerson, personName } from "./targets.js";
import { validateBrief } from "./validate.js";

export interface ResearchJobPayload {
  company_id: string | null;
  person_id: string | null;
}

export interface ResearchJobResult {
  briefs: Array<{
    brief_id: string;
    person_id: string | null;
    company_id: string | null;
    status: "ready" | "partial" | "failed";
    confidence: string | null;
    dropped: number;
    /** Sources that failed (partial briefs): research.run again asks only these. */
    gaps: ResearchGap[];
  }>;
  warnings: string[];
  stopped: "budget_exceeded" | null;
}

/** What the briefs of one job share. */
interface JobState {
  /** Providers the job stopped asking after a failure of their account or service. */
  stopped: Map<string, Failure>;
  /** Briefs written by this job (a partial company brief from this job is not redone). */
  produced: Set<string>;
  /** The workspace has a brain to write briefs with (checked before the first search). */
  brainReady: boolean;
}

const MAX_ROUNDS = 3;
const MAX_STORED_SOURCES = 40;
const SOURCE_TEXT_CHARS = 2_500;

export async function runResearchJob(
  ctx: JobContext,
  payload: ResearchJobPayload,
): Promise<ResearchJobResult> {
  const workspace = ctx.workspace;
  if (!workspace) throw new Error("research.run: job has no workspace");
  const result: ResearchJobResult = { briefs: [], warnings: [], stopped: null };
  const scope = { companyId: payload.company_id, personId: payload.person_id };
  const done = new Set<string>();
  const state: JobState = { stopped: new Map(), produced: new Set(), brainReady: false };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const rows = (await pendingRowsForScope(ctx.db, workspace.id, scope)).filter(
      (row) => !done.has(row.id),
    );
    if (rows.length === 0) break;
    const ordered = [
      ...rows.filter((row) => !row.person_id),
      ...rows.filter((row) => row.person_id),
    ];
    for (const [index, row] of ordered.entries()) {
      done.add(row.id);
      await ctx.setProgress({
        stage: "researching",
        done: index,
        total: ordered.length,
        message: row.person_id ? `Person ${row.person_id}` : `Company ${row.company_id}`,
      });
      try {
        if (!state.brainReady) {
          // No search is paid for while no brief can be written: without a brain the job waits
          // for one first (JobWaitError, no attempt used, the rechecks cost nothing), and with
          // the AI budget used up the briefs fail at once (budget_exceeded below).
          await assertBrainReady(ctx.brain, briefPrompt, { jobId: ctx.job.id });
          await ctx.usage.assertBudget(workspace.id, "ai");
          state.brainReady = true;
        }
        const outcome = await processRow(ctx, row, state);
        result.briefs.push(...outcome.briefs);
        result.warnings.push(...outcome.warnings);
      } catch (error) {
        if (isJobWaitError(error)) throw error;
        if (isOpenOutboundError(error) && error.code === "budget_exceeded") {
          // Every pending row of the scope, including company rows created on the way.
          const remaining = await pendingRowsForScope(ctx.db, workspace.id, scope);
          for (const pending of remaining) {
            result.briefs.push(await failRow(ctx, pending, "The monthly AI budget is used up."));
          }
          result.stopped = "budget_exceeded";
          return result;
        }
        if (ctx.job.attempt < ctx.job.maxAttempts) throw error;
        result.briefs.push(await failRow(ctx, row, errorMessage(error)));
      }
    }
  }
  return result;
}

async function processRow(
  ctx: JobContext,
  row: ResearchBriefRow,
  state: JobState,
): Promise<{ briefs: ResearchJobResult["briefs"]; warnings: string[] }> {
  if (!row.person_id) {
    const company = row.company_id ? await loadCompany(ctx, row.company_id) : null;
    if (!company) return { briefs: [await failRow(ctx, row, "Company not found.")], warnings: [] };
    const outcome = await researchCompany(ctx, company, row, state);
    return { briefs: [outcome.entry], warnings: outcome.warnings };
  }

  const loaded = await loadPerson(ctx, row.person_id);
  if (!loaded) return { briefs: [await failRow(ctx, row, "Person not found.")], warnings: [] };
  const { person, company } = loaded;
  const briefs: ResearchJobResult["briefs"] = [];
  const warnings: string[] = [];
  let companyBrief: ResearchBriefRow | null = null;
  if (company) {
    companyBrief = await latestBrief(
      ctx.db,
      row.workspace_id,
      { companyId: company.id },
      ["ready", "partial"],
      freshSince(ctx.clock.now()),
    );
    // A partial company brief from an earlier job gets its gaps filled first.
    const redo = companyBrief?.status === "partial" && !state.produced.has(companyBrief.id);
    if (!companyBrief || redo) {
      // Research the company first so every person at it reuses one company brief.
      const { row: companyRow } = await ensurePendingRow(
        ctx.db,
        row.workspace_id,
        { personId: null, companyId: company.id },
        ctx.clock.now(),
      );
      const outcome = await researchCompany(ctx, company, companyRow, state);
      briefs.push(outcome.entry);
      warnings.push(...outcome.warnings);
      companyBrief = outcome.row;
    }
  }
  const outcome = await researchPerson(ctx, person, company, companyBrief, row, state);
  briefs.push(outcome.entry);
  warnings.push(...outcome.warnings);
  return { briefs, warnings };
}

interface BriefOutcome {
  row: ResearchBriefRow | null;
  entry: ResearchJobResult["briefs"][number];
  warnings: string[];
}

/**
 * What a run can reuse instead of paying again: the gaps of the target's latest brief when it is
 * partial and fresh (to complete it), plus the searches the row being processed already paid for
 * (an earlier run of this job stopped at the brain call: a wait for a brain or a brain error).
 */
async function gapsToFill(
  ctx: JobContext,
  row: ResearchBriefRow,
  target: BriefTarget,
): Promise<ResearchGaps | null> {
  const previous = await latestBrief(
    ctx.db,
    row.workspace_id,
    target,
    ["ready", "partial"],
    freshSince(ctx.clock.now()),
  );
  const partial = previous?.status === "partial" ? previous.gaps : null;
  const paid = row.status === "pending" ? (row.gaps?.kept ?? []) : [];
  if (paid.length === 0) return partial;
  const kept = new Map<string, KeptSearch>();
  for (const search of [...(partial?.kept ?? []), ...paid]) kept.set(search.query, search);
  return { failed: partial?.failed ?? [], kept: [...kept.values()] };
}

/**
 * Keeps the searches a run paid for on the pending row until the brief is written, so a run
 * after a wait for the brain or a brain error reuses them instead of paying again. `failed`
 * stays empty: the gaps of a brief are known only once it is written.
 */
async function keepPaidSearches(ctx: JobContext, row: ResearchBriefRow, kept: KeptSearch[]) {
  if (kept.length === 0) return;
  await ctx.db
    .update(research_briefs)
    .set({ gaps: { failed: [], kept } })
    .where(and(eq(research_briefs.id, row.id), eq(research_briefs.status, "pending")));
}

async function researchCompany(
  ctx: JobContext,
  company: Company,
  row: ResearchBriefRow,
  state: JobState,
): Promise<BriefOutcome> {
  const fill = await gapsToFill(ctx, row, { companyId: company.id });
  const gathered = await gatherCompanySources(ctx, company, { fill, stopped: state.stopped });
  const outcome = await writeBrief(ctx, row, {
    target: "company",
    record: companyRecord(company),
    companyBrief: null,
    gathered,
    extraSources: [],
    gaps: gathered.failed,
    summaryOf: (brief) => brief.company.summary,
  });
  state.produced.add(row.id);
  if (outcome.row?.status === "ready" || outcome.row?.status === "partial") {
    await ctx.db
      .update(companies)
      .set({ last_researched_at: ctx.clock.now() })
      .where(and(eq(companies.workspace_id, row.workspace_id), eq(companies.id, company.id)));
  }
  return outcome;
}

async function researchPerson(
  ctx: JobContext,
  person: Person,
  company: Company | null,
  companyBrief: ResearchBriefRow | null,
  row: ResearchBriefRow,
  state: JobState,
): Promise<BriefOutcome> {
  const fill = await gapsToFill(ctx, row, { personId: person.id });
  const gathered = await gatherPersonSources(ctx, person, company, {
    fill,
    stopped: state.stopped,
  });
  const extraSources = companyBrief?.brief ? companyBriefSources(companyBrief) : [];
  // What the company brief misses, this brief misses too.
  const inherited: ResearchGap[] =
    companyBrief?.status === "partial"
      ? (companyBrief.gaps?.failed ?? [])
          .filter((gap) => !gap.company_brief_id)
          .map((gap) => ({ ...gap, company_brief_id: companyBrief.id }))
      : [];
  const outcome = await writeBrief(ctx, row, {
    target: "person",
    record: [personRecord(person), company ? companyRecord(company) : "Company: unknown"].join(
      "\n\n",
    ),
    companyBrief: companyBrief?.brief ? JSON.stringify(companyBrief.brief) : null,
    gathered,
    extraSources,
    gaps: [...gathered.failed, ...inherited],
    summaryOf: (brief) => brief.who.summary,
  });
  state.produced.add(row.id);
  return outcome;
}

/** Sources of a company brief, with the facts that cite each, so person briefs can reuse them. */
function companyBriefSources(row: ResearchBriefRow): GatheredSource[] {
  const brief = row.brief;
  if (!brief) return [];
  return row.sources.map((source) => ({
    url: source.url,
    title: source.title ?? null,
    published_at: source.published_at ?? null,
    kind: "company_brief" as const,
    text: brief.now
      .filter((fact) => fact.source_url === source.url)
      .map((fact) => `${fact.date ? `${fact.date}: ` : ""}${fact.fact}`)
      .join("\n"),
  }));
}

async function writeBrief(
  ctx: JobContext,
  row: ResearchBriefRow,
  input: {
    target: "company" | "person";
    record: string;
    companyBrief: string | null;
    gathered: GatherResult;
    extraSources: GatheredSource[];
    /** Sources that failed: the brief is partial when there are any. */
    gaps: ResearchGap[];
    summaryOf: (brief: ResearchBrief) => string;
  },
): Promise<BriefOutcome> {
  const workspace = ctx.workspace;
  if (!workspace) throw new Error("research.run: job has no workspace");
  const settings = parseWorkspaceSettings(workspace.settings);
  const now = ctx.clock.now();
  const offers = await listActiveOffers(ctx);

  const all: GatheredSource[] = [];
  const seen = new Set<string>();
  for (const source of [...input.gathered.sources, ...input.extraSources]) {
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    all.push(source);
  }
  const numbered: BriefSource[] = all.map((source, index) => ({
    n: index + 1,
    url: source.url,
    title: source.title,
    published_at: source.published_at,
    kind: source.kind,
    text: source.text.slice(0, SOURCE_TEXT_CHARS),
  }));

  await keepPaidSearches(ctx, row, input.gathered.kept);
  const result = await ctx.brain.run(
    briefPrompt,
    {
      target: input.target,
      today: now.toISOString().slice(0, 10),
      language: settings.ai.language,
      record: input.record,
      companyBrief: input.companyBrief,
      offers: offers.map((offer) => ({
        id: offer.id,
        name: offer.name,
        summary: offer.summary,
        value_props: offer.value_props,
      })),
      sources: numbered,
    },
    { jobId: ctx.job.id, taskKey: `research.brief:${row.id}` },
  );

  const { brief, stats } = validateBrief(result.output, {
    sourceUrls: all.map((source) => source.url),
    activeOfferIds: offers.map((offer) => offer.id),
    today: now,
  });
  const dropped = stats.dropped_facts + stats.dropped_urls;
  const main = input.summaryOf(brief).replace(/\s+/g, " ").trim();
  const summary = `${main.length > 200 ? `${main.slice(0, 197)}...` : main}${
    dropped > 0 ? ` (${dropped} unsourced claim${dropped === 1 ? "" : "s"} dropped)` : ""
  }`;
  const sources: ResearchSource[] = all.slice(0, MAX_STORED_SOURCES).map((source) => ({
    url: source.url,
    title: source.title,
    published_at: source.published_at,
  }));

  const status = input.gaps.length > 0 ? "partial" : "ready";
  const [updated] = await ctx.db
    .update(research_briefs)
    .set({
      status,
      brief,
      summary,
      sources,
      model: result.model,
      provider: result.provider,
      cost_usd: result.usage.costUsd,
      error: null,
      gaps: status === "partial" ? { failed: input.gaps, kept: input.gathered.kept } : null,
      updated_at: now,
    })
    .where(eq(research_briefs.id, row.id))
    .returning();
  await emitCompleted(ctx, row, status, brief.confidence);
  const warnings = [...input.gathered.warnings];
  if (status === "partial") {
    const count = input.gaps.length;
    warnings.push(
      `Brief ${row.id} is partial: ${count} ${count === 1 ? "source" : "sources"} failed. Run research_lead action run again later to fill the gaps.`,
    );
  }
  return {
    row: updated ?? null,
    entry: {
      brief_id: row.id,
      person_id: row.person_id,
      company_id: row.company_id,
      status,
      confidence: brief.confidence,
      dropped,
      gaps: input.gaps,
    },
    warnings,
  };
}

async function failRow(
  ctx: JobContext,
  row: ResearchBriefRow,
  message: string,
): Promise<ResearchJobResult["briefs"][number]> {
  await ctx.db
    .update(research_briefs)
    .set({ status: "failed", error: message.slice(0, 500), updated_at: ctx.clock.now() })
    .where(eq(research_briefs.id, row.id));
  await emitCompleted(ctx, row, "failed", null);
  return {
    brief_id: row.id,
    person_id: row.person_id,
    company_id: row.company_id,
    status: "failed",
    confidence: null,
    dropped: 0,
    gaps: [],
  };
}

async function emitCompleted(
  ctx: JobContext,
  row: ResearchBriefRow,
  status: "ready" | "partial" | "failed",
  confidence: ResearchBrief["confidence"] | null,
) {
  // `confidence` is an extra field for webhook consumers (payloads may grow compatibly).
  const data: EventData["research.completed"] & { confidence: string | null } = {
    brief_id: row.id,
    company_id: row.company_id,
    person_id: row.person_id,
    status,
    confidence,
  };
  await ctx.events.emit("research.completed", {
    subject: row.person_id
      ? { type: "person", id: row.person_id }
      : { type: "company", id: row.company_id ?? row.id },
    data,
  });
}

function companyRecord(company: Company): string {
  return [
    `Company: ${company.name}`,
    company.domain ? `Domain: ${company.domain}` : null,
    company.industry ? `Industry: ${company.industry}` : null,
    company.employee_count ? `Employees: ${company.employee_count}` : null,
    company.employee_range ? `Employee range: ${company.employee_range}` : null,
    [company.city, company.region, company.country].filter(Boolean).length > 0
      ? `Location: ${[company.city, company.region, company.country].filter(Boolean).join(", ")}`
      : null,
    company.description ? `Description: ${company.description}` : null,
    company.technologies.length > 0 ? `Technologies: ${company.technologies.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function personRecord(person: Person): string {
  return [
    `Person: ${personName(person)}`,
    person.title ? `Title: ${person.title}` : null,
    person.seniority ? `Seniority: ${person.seniority}` : null,
    person.department ? `Department: ${person.department}` : null,
    [person.city, person.region, person.country].filter(Boolean).length > 0
      ? `Location: ${[person.city, person.region, person.country].filter(Boolean).join(", ")}`
      : null,
    person.linkedin_url ? `LinkedIn: ${person.linkedin_url}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function errorMessage(error: unknown): string {
  if (isOpenOutboundError(error)) return error.message;
  return "Research failed with an internal error.";
}
