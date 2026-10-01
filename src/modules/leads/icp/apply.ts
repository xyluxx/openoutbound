/** Loads ICPs and stores fit scores on people and companies. */
import { and, desc, eq } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../../core/context.js";
import { notFound } from "../../../core/errors.js";
import { type Company, companies, icps, type Person, people } from "../../../db/schema/index.js";
import { loadCompanies } from "../records.js";
import { type ParsedIcp, parseIcp } from "./criteria.js";
import { type FitResult, scoreFit } from "./score.js";

/**
 * The ICP with this id (not_found when it is not in the workspace), or the workspace default
 * ICP when no id is given (null when there is none).
 */
export async function loadIcp(ctx: OpContext, icpId?: string | null): Promise<ParsedIcp | null> {
  const workspace = requireWorkspace(ctx);
  if (icpId) {
    const [row] = await ctx.db
      .select()
      .from(icps)
      .where(and(eq(icps.id, icpId), eq(icps.workspace_id, workspace.id)));
    if (!row) throw notFound("ICP", icpId);
    return parseIcp(row);
  }
  const [row] = await ctx.db
    .select()
    .from(icps)
    .where(and(eq(icps.workspace_id, workspace.id), eq(icps.is_default, true)))
    .orderBy(desc(icps.updated_at))
    .limit(1);
  return row ? parseIcp(row) : null;
}

/** Scores people (with their companies) and stores fit_score and fit_reasons. */
export async function scoreAndStorePeople(
  ctx: OpContext,
  icp: ParsedIcp,
  persons: Person[],
): Promise<Map<string, FitResult>> {
  const companyIds = persons.map((p) => p.company_id).filter((id): id is string => Boolean(id));
  const byId = new Map((await loadCompanies(ctx, companyIds)).map((c) => [c.id, c]));
  const results = new Map<string, FitResult>();
  for (const person of persons) {
    const company = person.company_id ? (byId.get(person.company_id) ?? null) : null;
    const fit = scoreFit(icp, { person, company });
    results.set(person.id, fit);
    if (
      fit.score === person.fit_score &&
      JSON.stringify(fit.reasons) === JSON.stringify(person.fit_reasons)
    ) {
      continue;
    }
    await ctx.db
      .update(people)
      .set({ fit_score: fit.score, fit_reasons: fit.reasons })
      .where(eq(people.id, person.id));
  }
  return results;
}

/** Scores companies on company criteria and stores fit_score and fit_reasons. */
export async function scoreAndStoreCompanies(
  ctx: OpContext,
  icp: ParsedIcp,
  rows: Company[],
): Promise<Map<string, FitResult>> {
  const results = new Map<string, FitResult>();
  for (const company of rows) {
    const fit = scoreFit(icp, { company });
    results.set(company.id, fit);
    if (
      fit.score === company.fit_score &&
      JSON.stringify(fit.reasons) === JSON.stringify(company.fit_reasons)
    ) {
      continue;
    }
    await ctx.db
      .update(companies)
      .set({ fit_score: fit.score, fit_reasons: fit.reasons })
      .where(eq(companies.id, company.id));
  }
  return results;
}
