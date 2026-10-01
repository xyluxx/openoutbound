import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { usage_records } from "../db/schema/index.js";
import { createUsageMeter } from "../runtime/usage.js";
import { createTestContext, type TestContext } from "../testing/context.js";
import { truncateAll } from "../testing/db.js";
import { seedWorkspace } from "../testing/factories.js";
import {
  budgetStatusOf,
  budgetUsedUp,
  budgetWarning,
  cutShortWarning,
  usedUpWarning,
} from "./budget.js";
import type { UsageMeter } from "./context.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
});

async function meterWithUsage(
  budget: number | null,
  used: number,
): Promise<{ meter: UsageMeter; workspaceId: string }> {
  const workspace = await seedWorkspace(ctx.db, {
    settings: { data: { monthly_credit_budget: budget } },
  });
  await ctx.db.insert(usage_records).values({
    workspace_id: workspace.id,
    slot: "lead_source",
    provider: "apollo",
    operation: "leads.find_import",
    credits: used,
    created_at: ctx.clock.now(),
  });
  const meter = createUsageMeter({ db: ctx.db, clock: ctx.clock }, { workspaceId: workspace.id });
  return { meter, workspaceId: workspace.id };
}

describe("usage meter pre-spend check", () => {
  it("refuses a spend larger than what is left, with the numbers and a hint", async () => {
    const { meter, workspaceId } = await meterWithUsage(16, 8);
    expect(await meter.budgetStatus(workspaceId, "data")).toEqual({
      kind: "data",
      budget: 16,
      used: 8,
      remaining: 8,
      unit: "credits",
      setting: "settings.data.monthly_credit_budget",
    });
    // Only used >= budget used to fail, so this spend ended at 18 of 16.
    await expect(meter.assertBudget(workspaceId, "data")).resolves.toBeUndefined();
    await expect(meter.assertCanSpend(workspaceId, "data", 10)).rejects.toMatchObject({
      code: "budget_exceeded",
      message: "Not enough data budget: needs 10 credits, 8 left this month (8 of 16 used).",
      hint: "Lower the count, or ask the human to raise settings.data.monthly_credit_budget (openoutbound workspaces update).",
      details: { needed: 10, remaining: 8, used: 8, budget: 16 },
    });
    await expect(
      meter.assertCanSpend(workspaceId, "data", 9, {
        hint: (s) => `Import at most ${s.remaining}.`,
      }),
    ).rejects.toMatchObject({ hint: "Import at most 8." });
    await expect(meter.assertCanSpend(workspaceId, "data", 8)).resolves.toBeUndefined();
    await expect(meter.assertCanSpend(workspaceId, "data", 0)).resolves.toBeUndefined();
  });

  it("refuses once the budget is used up, with the numbers and where to raise it", async () => {
    const { meter, workspaceId } = await meterWithUsage(16, 20);
    await expect(meter.assertBudget(workspaceId, "data")).rejects.toMatchObject({
      code: "budget_exceeded",
      message: "The monthly data budget is used up (20 of 16 credits).",
      hint: "Wait until next month, or ask the human to raise settings.data.monthly_credit_budget (openoutbound workspaces update).",
      details: {
        kind: "data",
        used: 20,
        budget: 16,
        setting: "settings.data.monthly_credit_budget",
      },
    });

    const ai = await seedWorkspace(ctx.db, { settings: { ai: { monthly_budget_usd: 1 } } });
    await ctx.db.insert(usage_records).values({
      workspace_id: ai.id,
      slot: "brain",
      provider: "anthropic",
      operation: "research.run",
      cost_usd: 1.25,
      created_at: ctx.clock.now(),
    });
    const aiMeter = createUsageMeter({ db: ctx.db, clock: ctx.clock }, { workspaceId: ai.id });
    await expect(aiMeter.assertBudget(ai.id, "ai")).rejects.toMatchObject({
      message: "The monthly AI budget is used up (1.25 of 1 USD).",
      hint: "Wait until next month, or ask the human to raise settings.ai.monthly_budget_usd (openoutbound workspaces update).",
    });
    await expect(aiMeter.assertBudget(ai.id, "data")).resolves.toBeUndefined();
  });

  it("never blocks without a budget", async () => {
    const { meter, workspaceId } = await meterWithUsage(null, 500);
    expect(await meter.budgetStatus(workspaceId, "data")).toMatchObject({
      budget: null,
      used: 500,
      remaining: null,
    });
    await expect(meter.assertCanSpend(workspaceId, "data", 1000)).resolves.toBeUndefined();
  });

  it("words the dry-run warning with what the real run then does", () => {
    const status = budgetStatusOf("data", 16, 8);
    expect(budgetWarning(status, 8)).toBeNull();
    expect(budgetWarning(status, 1, { outcome: "x" })).toBeNull();
    expect(budgetWarning(status, 10)).toBe(
      "Not enough data budget: needs 10 credits, 8 left this month (8 of 16 used), so the real run will be refused. Lower the count, or ask the human to raise settings.data.monthly_credit_budget (openoutbound workspaces update).",
    );
    expect(budgetWarning(budgetStatusOf("data", 16, 15), 2)).toContain(
      "needs 2 credits, 1 left this month (15 of 16 used)",
    );
  });

  it("says when a spend needs at least some amount, and when it stops at what is left", async () => {
    const status = budgetStatusOf("data", 16, 10);
    // `most` changes only the wording: "at least" says the spend can cost more.
    expect(budgetWarning(status, 8, { most: 30 })).toBe(
      "Not enough data budget: needs at least 8 credits, 6 left this month (10 of 16 used), so the real run will be refused. Lower the count, or ask the human to raise settings.data.monthly_credit_budget (openoutbound workspaces update).",
    );
    expect(budgetWarning(status, 8, { most: 8 })).toContain("needs 8 credits,");
    // What fits is not warned about: a spend that can cost more stops at what is left.
    expect(budgetWarning(status, 2, { most: 30 })).toBeNull();
    const usedUp = budgetStatusOf("data", 16, 16);
    expect(budgetWarning(usedUp, 2, { most: 30 })).toBe(usedUpWarning(usedUp));

    // A spend that stops at what is left (a Google Maps search) is cut short, not refused.
    expect(cutShortWarning(status, 8)).toBe(
      "Not enough data budget to finish: needs at least 8 credits, 6 left this month (10 of 16 used), so the real run stops after 6 credits with fewer results. Lower the count, or ask the human to raise settings.data.monthly_credit_budget (openoutbound workspaces update).",
    );
    expect(cutShortWarning(budgetStatusOf("data", 16, 15), 3, "Ask for less.")).toBe(
      "Not enough data budget to finish: needs at least 3 credits, 1 left this month (15 of 16 used), so the real run stops after 1 credit with fewer results. Ask for less.",
    );
    expect(cutShortWarning(status, 6)).toBeNull();
    expect(cutShortWarning(budgetStatusOf("data", null, 10), 50)).toBeNull();
    expect(cutShortWarning(usedUp, 2)).toBe(usedUpWarning(usedUp));

    const { meter, workspaceId } = await meterWithUsage(16, 10);
    await expect(meter.assertCanSpend(workspaceId, "data", 8, { most: 30 })).rejects.toMatchObject({
      code: "budget_exceeded",
      message:
        "Not enough data budget: needs at least 8 credits, 6 left this month (10 of 16 used).",
      hint: "Lower the count, or ask the human to raise settings.data.monthly_credit_budget (openoutbound workspaces update).",
      details: { needed: 8, most: 30, remaining: 6 },
    });
    // The check compares the least: a spend whose least fits is let through.
    await expect(
      meter.assertCanSpend(workspaceId, "data", 2, { most: 30 }),
    ).resolves.toBeUndefined();
    const plain = await meter.assertCanSpend(workspaceId, "data", 8, { most: 8 }).catch((e) => e);
    expect(plain.message).toBe(
      "Not enough data budget: needs 8 credits, 6 left this month (10 of 16 used).",
    );
    expect(plain.details).not.toHaveProperty("most");
  });

  it("says a used-up budget refuses the real run, whatever the operation would do otherwise", () => {
    const over = budgetStatusOf("data", 16, 20);
    const refused =
      "The monthly data budget is used up (20 of 16 credits), so the real run will be refused (budget_exceeded). Wait until next month, or ask the human to raise settings.data.monthly_credit_budget (openoutbound workspaces update).";
    expect(usedUpWarning(over)).toBe(refused);
    expect(budgetWarning(over, 1)).toBe(refused);
    expect(budgetWarning(over, 5, { outcome: "paid lookups stop when it is used up" })).toBe(
      refused,
    );
    // Nothing to spend: the operation says nothing (the executor adds the refusal itself).
    expect(budgetWarning(over, 0)).toBeNull();
    expect(usedUpWarning(budgetStatusOf("data", 1, 1))).toContain("(1 of 1 credit),");
    expect(usedUpWarning(budgetStatusOf("ai", 50, 50))).toBe(
      "The monthly AI budget is used up (50 of 50 USD), so the real run will be refused (budget_exceeded). Wait until next month, or ask the human to raise settings.ai.monthly_budget_usd (openoutbound workspaces update).",
    );
    expect(budgetUsedUp(over)).toBe(true);
    expect(budgetUsedUp(budgetStatusOf("data", 16, 15.5))).toBe(false);
    expect(budgetUsedUp(budgetStatusOf("data", null, 500))).toBe(false);
    expect(budgetUsedUp(budgetStatusOf("data", 0, 0))).toBe(true);
  });
});
