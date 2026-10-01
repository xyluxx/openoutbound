/**
 * icps.score over any number of people and companies: the selection is read in id order a
 * batch at a time, so nothing is capped, and selections above the inline limit run as the
 * `leads.icp_score` job instead of inside the request.
 */
import { and, asc, eq, gt, inArray, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { type OpContext, requireWorkspace } from "../../../core/context.js";
import { OpenOutboundError } from "../../../core/errors.js";
import { defineJob } from "../../../core/operation.js";
import { companies, people } from "../../../db/schema/index.js";
import { leadFilterConditions, leadFilterSchema } from "../filters.js";
import { loadCompanies, loadPeople } from "../records.js";
import { loadIcp, scoreAndStoreCompanies, scoreAndStorePeople } from "./apply.js";
import type { ParsedIcp } from "./criteria.js";

export const ICP_SCORE_JOB = "leads.icp_score";

/** Rows scored per batch, and the largest selection scored inline (more runs as a job). */
export const SCORE_LIMITS = { batch: 500, inline: 20_000 };

/** Who to score: the icps.score selection fields (also the job payload). */
export const scoreSelectionSchema = z.object({
  person_ids: z.array(z.string()).optional(),
  list_id: z.string().optional(),
  filter: leadFilterSchema.optional(),
  all_people: z.boolean().default(false),
  company_ids: z.array(z.string()).optional(),
  all_companies: z.boolean().default(false),
});
export type ScoreSelection = z.output<typeof scoreSelectionSchema>;

export interface ScoreTotals {
  people_scored: number;
  companies_scored: number;
  average_person_score: number | null;
  distribution: { strong: number; medium: number; weak: number; unscored: number };
}

function selectsPeople(selection: ScoreSelection): boolean {
  return (
    selection.all_people ||
    selection.person_ids !== undefined ||
    selection.list_id !== undefined ||
    selection.filter !== undefined
  );
}

/** Conditions on people for the selection (ids, list and filter intersect; workspace included). */
async function peopleConditions(ctx: OpContext, selection: ScoreSelection): Promise<SQL[]> {
  const conditions = await leadFilterConditions(ctx, selection.filter ?? {});
  if (selection.list_id) {
    conditions.push(...(await leadFilterConditions(ctx, { list_id: selection.list_id })));
  }
  return conditions;
}

function chunks(ids: string[], size: number): string[][] {
  const unique = [...new Set(ids)];
  const out: string[][] = [];
  for (let i = 0; i < unique.length; i += size) out.push(unique.slice(i, i + size));
  return out;
}

async function countRows(rows: Promise<Array<{ n: number }>>): Promise<number> {
  const [row] = await rows;
  return Number(row?.n ?? 0);
}

/** How many people and companies the selection covers. */
export async function countSelection(
  ctx: OpContext,
  selection: ScoreSelection,
): Promise<{ people: number; companies: number }> {
  const workspace = requireWorkspace(ctx);
  const n = sql<number>`count(*)::int`;
  let peopleCount = 0;
  if (selectsPeople(selection)) {
    const conditions = await peopleConditions(ctx, selection);
    if (selection.person_ids !== undefined) {
      for (const chunk of chunks(selection.person_ids, 1000)) {
        peopleCount += await countRows(
          ctx.db
            .select({ n })
            .from(people)
            .where(and(...conditions, inArray(people.id, chunk))),
        );
      }
    } else {
      peopleCount = await countRows(
        ctx.db
          .select({ n })
          .from(people)
          .where(and(...conditions)),
      );
    }
  }
  let companyCount = 0;
  if (selection.all_companies) {
    companyCount = await countRows(
      ctx.db.select({ n }).from(companies).where(eq(companies.workspace_id, workspace.id)),
    );
  } else {
    for (const chunk of chunks(selection.company_ids ?? [], 1000)) {
      companyCount += await countRows(
        ctx.db
          .select({ n })
          .from(companies)
          .where(and(eq(companies.workspace_id, workspace.id), inArray(companies.id, chunk))),
      );
    }
  }
  return { people: peopleCount, companies: companyCount };
}

/** Person ids of the selection in id order, `size` at a time. */
async function* personIdBatches(
  ctx: OpContext,
  selection: ScoreSelection,
  size: number,
): AsyncGenerator<string[]> {
  if (!selectsPeople(selection)) return;
  const conditions = await peopleConditions(ctx, selection);
  if (selection.person_ids !== undefined) {
    for (const chunk of chunks(selection.person_ids, size)) {
      const rows = await ctx.db
        .select({ id: people.id })
        .from(people)
        .where(and(...conditions, inArray(people.id, chunk)))
        .orderBy(asc(people.id));
      if (rows.length > 0) yield rows.map((row) => row.id);
    }
    return;
  }
  let after: string | null = null;
  for (;;) {
    const where: SQL | undefined = after
      ? and(...conditions, gt(people.id, after))
      : and(...conditions);
    const rows: Array<{ id: string }> = await ctx.db
      .select({ id: people.id })
      .from(people)
      .where(where)
      .orderBy(asc(people.id))
      .limit(size);
    if (rows.length === 0) return;
    yield rows.map((row) => row.id);
    if (rows.length < size) return;
    after = rows[rows.length - 1]?.id ?? null;
  }
}

/** Company ids of the selection (all_companies wins over company_ids), `size` at a time. */
async function* companyIdBatches(
  ctx: OpContext,
  selection: ScoreSelection,
  size: number,
): AsyncGenerator<string[]> {
  if (!selection.all_companies) {
    yield* chunks(selection.company_ids ?? [], size);
    return;
  }
  const workspace = requireWorkspace(ctx);
  let after: string | null = null;
  for (;;) {
    const where: SQL | undefined = after
      ? and(eq(companies.workspace_id, workspace.id), gt(companies.id, after))
      : eq(companies.workspace_id, workspace.id);
    const rows: Array<{ id: string }> = await ctx.db
      .select({ id: companies.id })
      .from(companies)
      .where(where)
      .orderBy(asc(companies.id))
      .limit(size);
    if (rows.length === 0) return;
    yield rows.map((row) => row.id);
    if (rows.length < size) return;
    after = rows[rows.length - 1]?.id ?? null;
  }
}

/** Scores and stores fit for the whole selection, one batch at a time. */
export async function scoreSelection(
  ctx: OpContext,
  icp: ParsedIcp,
  selection: ScoreSelection,
  options: { onBatch?: (done: number) => Promise<void> } = {},
): Promise<ScoreTotals> {
  const size = Math.max(1, SCORE_LIMITS.batch);
  const totals: ScoreTotals = {
    people_scored: 0,
    companies_scored: 0,
    average_person_score: null,
    distribution: { strong: 0, medium: 0, weak: 0, unscored: 0 },
  };
  let sum = 0;
  let scored = 0;
  for await (const ids of personIdBatches(ctx, selection, size)) {
    const results = await scoreAndStorePeople(ctx, icp, await loadPeople(ctx, ids));
    totals.people_scored += results.size;
    for (const fit of results.values()) {
      if (fit.score === null) totals.distribution.unscored += 1;
      else {
        scored += 1;
        sum += fit.score;
        if (fit.score >= 70) totals.distribution.strong += 1;
        else if (fit.score >= 40) totals.distribution.medium += 1;
        else totals.distribution.weak += 1;
      }
    }
    await options.onBatch?.(totals.people_scored + totals.companies_scored);
  }
  for await (const ids of companyIdBatches(ctx, selection, size)) {
    const results = await scoreAndStoreCompanies(ctx, icp, await loadCompanies(ctx, ids));
    totals.companies_scored += results.size;
    await options.onBatch?.(totals.people_scored + totals.companies_scored);
  }
  totals.average_person_score = scored > 0 ? Math.round(sum / scored) : null;
  return totals;
}

export const icpScoreJobPayload = z.object({
  icp_id: z.string(),
  selection: scoreSelectionSchema,
});

/** Rescoring of a large selection (icps.score above SCORE_LIMITS.inline). */
export const icpScoreJob = defineJob({
  name: ICP_SCORE_JOB,
  payload: icpScoreJobPayload,
  maxAttempts: 2,
  timeoutMs: 60 * 60_000,
  handler: async (ctx, payload) => {
    if (!ctx.workspace) return { skipped: "no_workspace" };
    let icp: ParsedIcp | null;
    try {
      icp = await loadIcp(ctx, payload.icp_id);
    } catch (error) {
      if (error instanceof OpenOutboundError && error.code === "not_found") {
        return { skipped: "icp_deleted", icp_id: payload.icp_id };
      }
      throw error;
    }
    if (!icp) return { skipped: "icp_deleted", icp_id: payload.icp_id };
    const count = await countSelection(ctx, payload.selection);
    const total = count.people + count.companies;
    const totals = await scoreSelection(ctx, icp, payload.selection, {
      onBatch: (done) =>
        ctx.setProgress({ done, total, stage: "scoring", message: `${done} of ${total} scored` }),
    });
    return { icp_id: icp.id, ...totals };
  },
});
