/**
 * Monthly budgets: the status the usage meters report and the pre-spend check they share. A
 * spend whose cost is known up front is compared with what is left before any provider is
 * called, so a run never ends above the budget ("needs 10 credits, 8 left this month").
 *
 * Some costs are known only as a range: a Google Maps search that splits a busy area makes
 * more requests. Such a search gets what is left as its request cap and stops there, so it is
 * refused only when not even one request fits ("needs at least 1 credit"), and its dry run
 * warns when what is left cannot finish it (`cutShortWarning`).
 */
import { z } from "zod";
import type { BudgetKind, BudgetStatus, SpendCheckOptions } from "./context.js";
import { OpenOutboundError } from "./errors.js";
import { askToRaiseBudget } from "./setting-hints.js";
import type { WorkspaceSettings } from "./settings.js";

export const BUDGET_SETTINGS: Record<BudgetKind, string> = {
  ai: "settings.ai.monthly_budget_usd",
  data: "settings.data.monthly_credit_budget",
};

/** The monthly budget of one kind from workspace settings (null: no limit). */
export function budgetOf(settings: WorkspaceSettings, kind: BudgetKind): number | null {
  return kind === "ai" ? settings.ai.monthly_budget_usd : settings.data.monthly_credit_budget;
}

export function budgetStatusOf(
  kind: BudgetKind,
  budget: number | null,
  used: number,
): BudgetStatus {
  return {
    kind,
    budget,
    used: round(used),
    remaining: budget === null ? null : round(Math.max(0, budget - used)),
    unit: kind === "ai" ? "USD" : "credits",
    setting: BUDGET_SETTINGS[kind],
  };
}

/** The monthly data budget, shown by dry runs of operations that spend credits. */
export const dataBudgetShape = z
  .object({
    monthly_credits: z
      .number()
      .nullable()
      .describe("settings.data.monthly_credit_budget; null means no limit"),
    used_this_month: z.number(),
    left_this_month: z.number().nullable().describe("null when there is no budget"),
  })
  .describe("Compare left_this_month with the estimated credits before the real run");

export function dataBudgetView(status: BudgetStatus): z.infer<typeof dataBudgetShape> {
  return {
    monthly_credits: status.budget,
    used_this_month: status.used,
    left_this_month: status.remaining,
  };
}

/** "10 credits", "1 credit", "0.5 USD". */
export function formatAmount(value: number, unit: BudgetStatus["unit"]): string {
  const n = round(value);
  if (unit === "USD") return `${n} USD`;
  return `${n} ${n === 1 ? "credit" : "credits"}`;
}

/** True when a spend of `needed` fits in what is left (always without a budget). */
export function fitsBudget(status: BudgetStatus, needed: number): boolean {
  return status.remaining === null || !(needed > 0) || needed <= status.remaining;
}

/** True when nothing is left this month (never without a budget). */
export function budgetUsedUp(status: BudgetStatus): boolean {
  return status.budget !== null && status.remaining === 0;
}

/** "The monthly data budget is used up (20 of 16 credits)". */
function usedUp(status: BudgetStatus): string {
  return `The monthly ${label(status.kind)} budget is used up (${status.used} of ${formatAmount(status.budget ?? 0, status.unit)})`;
}

function usedUpHint(status: BudgetStatus): string {
  return `Wait until next month, or ${askToRaiseBudget(status.setting)}.`;
}

/**
 * The dry-run warning while the budget is used up. The executor then refuses every spend
 * operation before it starts (and the brain every AI call), so the real run is refused whatever
 * it would cost. The executor adds this warning to dry runs of spend operations itself.
 */
export function usedUpWarning(status: BudgetStatus): string {
  return `${usedUp(status)}, so the real run will be refused (budget_exceeded). ${usedUpHint(status)}`;
}

/** The `budget_exceeded` error once the budget is used up (the usage meters' assertBudget). */
export function usedUpRefusal(status: BudgetStatus): OpenOutboundError {
  return new OpenOutboundError("budget_exceeded", `${usedUp(status)}.`, {
    hint: usedUpHint(status),
    details: {
      kind: status.kind,
      used: status.used,
      budget: status.budget,
      setting: status.setting,
    },
  });
}

/** Default hint for a spend that does not fit (never tells an agent to raise its own budget). */
export function budgetHint(status: BudgetStatus, lower = "Lower the count"): string {
  return `${lower}, or ${askToRaiseBudget(status.setting)}.`;
}

/** "needs 10 credits, 8 left this month (8 of 16 used)"; "needs at least" for a range. */
function shortfall(status: BudgetStatus, needed: number, atLeast: boolean): string {
  return `needs ${atLeast ? "at least " : ""}${formatAmount(needed, status.unit)}, ${round(status.remaining ?? 0)} left this month (${status.used} of ${status.budget} used)`;
}

/** The most a spend can cost when that is more than `needed` (then only the least), else null. */
function mostOf(needed: number, most: number | undefined): number | null {
  return most !== undefined && most > needed ? most : null;
}

function label(kind: BudgetKind): string {
  return kind === "ai" ? "AI" : "data";
}

/**
 * The dry-run warning for a spend that does not fit (null when it fits). `outcome` says what
 * the real run then does (default: it is refused). With nothing left the real run is refused
 * before it starts, so the warning is `usedUpWarning` instead, whatever `outcome` says. With
 * `most` (more than `needed`), the warning says "needs at least".
 */
export function budgetWarning(
  status: BudgetStatus,
  needed: number,
  options: { hint?: string; outcome?: string; most?: number } = {},
): string | null {
  if (fitsBudget(status, needed)) return null;
  if (budgetUsedUp(status)) return usedUpWarning(status);
  const outcome = options.outcome ?? "the real run will be refused";
  return `Not enough ${label(status.kind)} budget: ${shortfall(status, needed, mostOf(needed, options.most) !== null)}, so ${outcome}. ${options.hint ?? budgetHint(status)}`;
}

/**
 * The dry-run warning for a spend that stops at what is left instead of going over (a Google
 * Maps search gets the credits left as its request cap): null when the least it needs to
 * finish (`needed`) fits, else it says the real run stops early. Check first that it can start.
 */
export function cutShortWarning(
  status: BudgetStatus,
  needed: number,
  hint?: string,
): string | null {
  if (fitsBudget(status, needed)) return null;
  if (budgetUsedUp(status)) return usedUpWarning(status);
  const left = formatAmount(status.remaining ?? 0, status.unit);
  return `Not enough ${label(status.kind)} budget to finish: ${shortfall(status, needed, true)}, so the real run stops after ${left} with fewer results. ${hint ?? budgetHint(status)}`;
}

/**
 * The `budget_exceeded` error for a spend that does not fit (null when it fits). With `most`,
 * `needed` is the least the spend can cost: only the least is compared, and the message says
 * "needs at least".
 */
export function budgetRefusal(
  status: BudgetStatus,
  needed: number,
  options: SpendCheckOptions = {},
): OpenOutboundError | null {
  if (fitsBudget(status, needed)) return null;
  const most = mostOf(needed, options.most);
  const { hint } = options;
  return new OpenOutboundError(
    "budget_exceeded",
    `Not enough ${label(status.kind)} budget: ${shortfall(status, needed, most !== null)}.`,
    {
      hint: typeof hint === "function" ? hint(status) : (hint ?? budgetHint(status)),
      details: {
        kind: status.kind,
        needed: round(needed),
        ...(most !== null ? { most: round(most) } : {}),
        remaining: status.remaining,
        used: status.used,
        budget: status.budget,
        setting: status.setting,
      },
    },
  );
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
