import { and, eq, gte, lt, sql } from "drizzle-orm";
import { budgetOf, budgetRefusal, budgetStatusOf, usedUpRefusal } from "../core/budget.js";
import type { Clock } from "../core/clock.js";
import type { BudgetKind, BudgetStatus, UsageMeter, UsageTotals } from "../core/context.js";
import { parseWorkspaceSettings } from "../core/settings.js";
import type { Db } from "../db/client.js";
import { usage_records, workspaces } from "../db/schema/index.js";

/** First instant of the calendar month (UTC) containing `now`, and of the next month. */
export function monthBounds(now: Date): { from: Date; to: Date } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { from, to };
}

export async function monthToDate(db: Db, clock: Clock, workspaceId: string): Promise<UsageTotals> {
  const { from, to } = monthBounds(clock.now());
  const rows = await db
    .select({
      isBrain: sql<boolean>`${usage_records.slot} = 'brain'`,
      cost: sql<number>`coalesce(sum(${usage_records.cost_usd}), 0)`.mapWith(Number),
      credits: sql<number>`coalesce(sum(${usage_records.credits}), 0)`.mapWith(Number),
    })
    .from(usage_records)
    .where(
      and(
        eq(usage_records.workspace_id, workspaceId),
        gte(usage_records.created_at, from),
        lt(usage_records.created_at, to),
      ),
    )
    .groupBy(sql`${usage_records.slot} = 'brain'`);
  const totals: UsageTotals = { aiCostUsd: 0, dataCredits: 0, dataCostUsd: 0 };
  for (const row of rows) {
    if (row.isBrain) totals.aiCostUsd += row.cost;
    else {
      totals.dataCredits += row.credits;
      totals.dataCostUsd += row.cost;
    }
  }
  return totals;
}

/** The workspace's monthly budget of one kind (null: no limit, or no such workspace). */
async function loadBudget(db: Db, workspaceId: string, kind: BudgetKind): Promise<number | null> {
  const [workspace] = await db
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return workspace ? budgetOf(parseWorkspaceSettings(workspace.settings), kind) : null;
}

/** The monthly budget of one kind with what is used and left this month. */
export async function budgetStatus(
  db: Db,
  clock: Clock,
  workspaceId: string,
  kind: BudgetKind,
): Promise<BudgetStatus> {
  const budget = await loadBudget(db, workspaceId, kind);
  const totals = await monthToDate(db, clock, workspaceId);
  return budgetStatusOf(kind, budget, kind === "ai" ? totals.aiCostUsd : totals.dataCredits);
}

/** Usage meter (spec 6): records spend and enforces the workspace monthly budgets. */
export function createUsageMeter(
  kernel: { db: Db; clock: Clock },
  scope: { workspaceId: string | null },
): UsageMeter {
  const { db, clock } = kernel;
  return {
    async record(entry) {
      await db.insert(usage_records).values({
        workspace_id: entry.workspaceId !== undefined ? entry.workspaceId : scope.workspaceId,
        slot: entry.slot,
        provider: entry.provider,
        operation: entry.operation,
        model: entry.model ?? null,
        input_tokens: Math.round(entry.inputTokens ?? 0),
        output_tokens: Math.round(entry.outputTokens ?? 0),
        cached_tokens: Math.round(entry.cachedTokens ?? 0),
        credits: entry.credits ?? 0,
        cost_usd: entry.costUsd ?? null,
        job_id: entry.jobId ?? null,
        created_at: clock.now(),
      });
    },
    monthToDate: (workspaceId) => monthToDate(db, clock, workspaceId),
    async assertBudget(workspaceId, kind) {
      const [workspace] = await db
        .select({ settings: workspaces.settings })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      if (!workspace) return;
      const settings = parseWorkspaceSettings(workspace.settings);
      const budget =
        kind === "ai" ? settings.ai.monthly_budget_usd : settings.data.monthly_credit_budget;
      if (budget === null) return;
      const totals = await monthToDate(db, clock, workspaceId);
      const used = kind === "ai" ? totals.aiCostUsd : totals.dataCredits;
      if (used < budget) return;
      throw usedUpRefusal(budgetStatusOf(kind, budget, used));
    },
    budgetStatus: (workspaceId, kind) => budgetStatus(db, clock, workspaceId, kind),
    async assertCanSpend(workspaceId, kind, needed, options = {}) {
      if (!(needed > 0)) return;
      const budget = await loadBudget(db, workspaceId, kind);
      if (budget === null) return;
      const totals = await monthToDate(db, clock, workspaceId);
      const status = budgetStatusOf(
        kind,
        budget,
        kind === "ai" ? totals.aiCostUsd : totals.dataCredits,
      );
      const refusal = budgetRefusal(status, needed, options);
      if (refusal) throw refusal;
    },
  };
}
