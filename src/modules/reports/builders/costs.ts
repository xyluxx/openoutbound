import { sql } from "drizzle-orm";
import type { Db } from "../../../db/client.js";
import { rate, round2 } from "../metric.js";
import type { CostRow, CostsData } from "../schemas.js";
import { inWorkspaces, rows, type Window, windowsDef, withDefs } from "../sql.js";
import { type BuildArgs, type Built, compareAmount, settingsOf, windowsOf } from "./common.js";

/** Most rows in by_operation. */
export const MAX_OPERATION_ROWS = 20;

export interface CostTotals {
  ai_cost_usd: number;
  data_cost_usd: number;
  data_credits: number;
  unpriced_calls: number;
}

const EMPTY_TOTALS: CostTotals = {
  ai_cost_usd: 0,
  data_cost_usd: 0,
  data_credits: 0,
  unpriced_calls: 0,
};

/** Usage totals per workspace and window (AI = slot brain; data = every other slot). */
export async function costTotals(
  db: Db,
  workspaceIds: readonly string[],
  windows: readonly Window[],
): Promise<Map<string, CostTotals[]>> {
  const list = await rows<CostTotals & { workspace_id: string; idx: number }>(
    db,
    sql`${withDefs(windowsDef(windows))}
      select u.workspace_id, w.idx,
        coalesce(sum(u.cost_usd) filter (where u.slot = 'brain'), 0)::float8 as ai_cost_usd,
        coalesce(sum(u.cost_usd) filter (where u.slot <> 'brain'), 0)::float8 as data_cost_usd,
        coalesce(sum(u.credits) filter (where u.slot <> 'brain'), 0)::float8 as data_credits,
        count(*) filter (where u.slot = 'brain' and u.cost_usd is null)::int as unpriced_calls
      from usage_records u join w on u.created_at >= w.f and u.created_at < w.t
      where ${inWorkspaces("u", workspaceIds)}
      group by 1, 2`,
  );
  const out = new Map<string, CostTotals[]>();
  for (const id of workspaceIds)
    out.set(
      id,
      windows.map(() => ({ ...EMPTY_TOTALS })),
    );
  for (const row of list) {
    const target = out.get(row.workspace_id)?.[row.idx];
    if (!target) continue;
    target.ai_cost_usd = row.ai_cost_usd;
    target.data_cost_usd = row.data_cost_usd;
    target.data_credits = row.data_credits;
    target.unpriced_calls = row.unpriced_calls;
  }
  return out;
}

/** Start of the current calendar month in UTC (the budget month of the usage meter). */
export function utcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Costs (spec 11.12): AI and data spend by provider and operation, with the month-to-date use
 * of the workspace budgets (settings.ai.monthly_budget_usd, settings.data.monthly_credit_budget).
 */
export async function buildCosts(args: BuildArgs): Promise<Built<CostsData>> {
  const ids = [args.workspace.id];
  const windows = windowsOf(args);
  const monthWindow: Window = { from: utcMonthStart(args.now), to: args.now };
  const [totals, grouped, monthToDate] = await Promise.all([
    costTotals(args.db, ids, windows),
    rows<{
      slot: string;
      provider: string;
      operation: string;
      calls: number;
      cost_usd: number;
      credits: number;
    }>(
      args.db,
      sql`${withDefs(windowsDef(windows.slice(0, 1)))}
        select u.slot, u.provider, u.operation, count(*)::int as calls,
          coalesce(sum(u.cost_usd), 0)::float8 as cost_usd,
          coalesce(sum(u.credits), 0)::float8 as credits
        from usage_records u join w on u.created_at >= w.f and u.created_at < w.t
        where ${inWorkspaces("u", ids)}
        group by 1, 2, 3`,
    ),
    costTotals(args.db, ids, [monthWindow]),
  ]);

  const kindOf = (slot: string): CostRow["kind"] => (slot === "brain" ? "ai" : "data");
  const byProvider = new Map<string, CostRow>();
  for (const row of grouped) {
    const key = `${row.slot}:${row.provider}`;
    const entry = byProvider.get(key) ?? {
      kind: kindOf(row.slot),
      slot: row.slot,
      provider: row.provider,
      operation: null,
      calls: 0,
      cost_usd: 0,
      credits: 0,
    };
    entry.calls += row.calls;
    entry.cost_usd += row.cost_usd;
    entry.credits += row.credits;
    byProvider.set(key, entry);
  }
  const tidy = (row: CostRow): CostRow => ({
    ...row,
    cost_usd: round2(row.cost_usd),
    credits: round2(row.credits),
  });
  const bySpend = (a: CostRow, b: CostRow) =>
    b.cost_usd - a.cost_usd || b.credits - a.credits || b.calls - a.calls;
  const operations = grouped
    .map((row) =>
      tidy({
        kind: kindOf(row.slot),
        slot: row.slot,
        provider: row.provider,
        operation: row.operation,
        calls: row.calls,
        cost_usd: row.cost_usd,
        credits: row.credits,
      }),
    )
    .sort(bySpend);

  const perWindow = totals.get(args.workspace.id) ?? [];
  const current = perWindow[0] ?? EMPTY_TOTALS;
  const previous = args.previous ? (perWindow[1] ?? EMPTY_TOTALS) : undefined;
  const month = monthToDate.get(args.workspace.id)?.[0] ?? EMPTY_TOTALS;
  const settings = settingsOf(args.workspace);
  const aiBudget = settings.ai.monthly_budget_usd;
  const dataBudget = settings.data.monthly_credit_budget;
  const notes: string[] = [];
  if (current.unpriced_calls > 0) {
    notes.push(
      `${current.unpriced_calls} AI calls have no price (CLI brains or unknown models), so AI cost is a lower bound.`,
    );
  }
  if (operations.length > MAX_OPERATION_ROWS) {
    notes.push(
      `by_operation shows the top ${MAX_OPERATION_ROWS} of ${operations.length} rows by spend.`,
    );
  }
  return {
    data: {
      type: "costs",
      metrics: {
        ai_cost_usd: compareAmount(current, previous, (row) => row.ai_cost_usd),
        data_cost_usd: compareAmount(current, previous, (row) => row.data_cost_usd),
        data_credits: compareAmount(current, previous, (row) => row.data_credits),
        total_cost_usd: compareAmount(
          current,
          previous,
          (row) => row.ai_cost_usd + row.data_cost_usd,
        ),
      },
      by_provider: [...byProvider.values()].map(tidy).sort(bySpend),
      by_operation: operations.slice(0, MAX_OPERATION_ROWS),
      budget: {
        ai: {
          monthly_budget_usd: aiBudget,
          month_to_date_usd: round2(month.ai_cost_usd),
          used_pct: aiBudget ? rate(month.ai_cost_usd, aiBudget) : null,
        },
        data: {
          monthly_credit_budget: dataBudget,
          month_to_date_credits: round2(month.data_credits),
          used_pct: dataBudget ? rate(month.data_credits, dataBudget) : null,
        },
      },
      unpriced_calls: current.unpriced_calls,
    },
    metrics: ["ai_cost_usd", "data_cost_usd", "data_credits", "total_cost_usd"],
    notes: [
      ...notes,
      "Budget use is month to date (calendar month in UTC, like budget enforcement), whatever the report period.",
    ],
  };
}
