/**
 * Undo: settings (a new key is removed again), offers, ICPs and campaigns go back through their
 * update functions and the undo is recorded; creates and deletes are refused, and so is a
 * change that a later change touched.
 */
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { isOpenOutboundError } from "../../core/errors.js";
import type { AnyZodObject, OperationDefinition } from "../../core/operation.js";
import { change_log, change_proposals, offers, workspaces } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedCampaign } from "../../testing/factories.js";
import { updateCampaign } from "../campaigns/operations/campaigns.js";
import { createOfferOp, updateOfferOp } from "../knowledge/operations/offers.js";
import { createIcp, deleteIcp, updateIcp } from "../leads/operations/icps.js";
import { updateWorkspace } from "../workspaces/operations.js";
import { getChange, undoChangeOp } from "./operations.js";

async function call<In extends AnyZodObject, Out extends z.ZodType>(
  op: OperationDefinition<In, Out>,
  ctx: TestContext,
  input: unknown,
): Promise<z.output<Out>> {
  return op.output.parse(await op.handler(ctx, op.input.parse(input))) as z.output<Out>;
}

async function changes(ctx: TestContext) {
  return ctx.db
    .select()
    .from(change_log)
    .where(eq(change_log.workspace_id, ctx.workspace.id))
    .orderBy(asc(change_log.version));
}

async function storedSettings(ctx: TestContext) {
  const [row] = await ctx.db
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspace.id));
  return row?.settings;
}

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isOpenOutboundError(error)) return error;
    throw error;
  }
  throw new Error("expected an error");
}

/** Updates the settings the way the executor would (fresh workspace row each call). */
async function updateSettings(ctx: TestContext, settings: Record<string, unknown>) {
  await ctx.reloadWorkspace();
  await call(updateWorkspace, ctx, { settings });
  await ctx.reloadWorkspace();
}

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

describe("undoing settings changes", () => {
  it("restores changed values, removes new keys and records the undo", async () => {
    const ctx = await createTestContext({ db, settings: { ai: { monthly_budget_usd: 50 } } });
    await updateSettings(ctx, {
      ai: { monthly_budget_usd: 80 },
      strategy: { goals: "Ten demos a month" },
    });
    const [change] = await changes(ctx);
    const undone = await call(undoChangeOp, ctx.with({ request: { reason: "Too expensive" } }), {
      change_id: change?.id,
    });
    expect(undone).toMatchObject({
      undone: { change_id: change?.id, version: 1 },
      undo_change: { version: 2 },
      restored: [
        { path: "ai.monthly_budget_usd", value: 50, removed: false },
        { path: "strategy.goals", value: null, removed: true },
      ],
      warnings: [],
    });
    expect(await storedSettings(ctx)).toEqual({ ai: { monthly_budget_usd: 50 } });
    const [original, undo] = await changes(ctx);
    expect(original?.undone_at).not.toBeNull();
    expect(undo).toMatchObject({
      version: 2,
      area: "settings",
      operation: "changes.undo",
      undo_of: change?.id,
      reason: "Too expensive",
      diff: [
        { path: "ai.monthly_budget_usd", before: 80, after: 50 },
        { path: "strategy.goals", before: "Ten demos a month" },
      ],
    });
    const detail = await call(getChange, ctx, { change_id: change?.id });
    expect(detail).toMatchObject({
      undone: true,
      undone_by: { change_id: undo?.id, version: 2 },
      kind: "update",
    });
  });

  it("previews without writing on a dry run", async () => {
    const ctx = await createTestContext({ db, settings: { booking: { mode: "link" } } });
    await updateSettings(ctx, { booking: { mode: "handoff" } });
    const [change] = await changes(ctx);
    const preview = await call(undoChangeOp, ctx.with({ request: { dryRun: true } }), {
      change_id: change?.id,
    });
    expect(preview).toMatchObject({
      dry_run: true,
      preview: {
        change_id: change?.id,
        summary: "booking.mode: link -> handoff",
        restored: [{ path: "booking.mode", value: "link", removed: false }],
      },
    });
    expect(await storedSettings(ctx)).toEqual({ booking: { mode: "handoff" } });
    expect(await changes(ctx)).toHaveLength(1);
  });

  it("needs the admin scope for settings", async () => {
    const ctx = await createTestContext({ db });
    await updateSettings(ctx, { strategy: { goals: "Demos" } });
    const [change] = await changes(ctx);
    const error = await errorOf(
      call(undoChangeOp, ctx.with({ principal: { scopes: ["read", "write"] } }), {
        change_id: change?.id,
      }),
    );
    expect(error.code).toBe("forbidden");
  });

  it("refuses an undo that loosens a gate when the caller must ask", async () => {
    const ctx = await createTestContext({
      db,
      settings: { approvals: { agent_launch_requires_approval: false } },
    });
    await updateSettings(ctx, { approvals: { agent_launch_requires_approval: true } });
    const [change] = await changes(ctx);
    const agent = ctx.with({ principal: { type: "agent", id: "key_undo_agent", name: "Agent" } });
    const error = await errorOf(call(undoChangeOp, agent, { change_id: change?.id }));
    expect(error).toMatchObject({
      code: "forbidden",
      details: { fields: ["settings.approvals.agent_launch_requires_approval"] },
    });
    expect(await storedSettings(ctx)).toEqual({
      approvals: { agent_launch_requires_approval: true },
    });
    expect((await changes(ctx))[0]?.undone_at).toBeNull();
    // A person holding approve undoes it.
    await call(undoChangeOp, ctx, { change_id: change?.id });
    expect(await storedSettings(ctx)).toEqual({
      approvals: { agent_launch_requires_approval: false },
    });
  });

  it("refuses a change that a later change touched, and an undone change", async () => {
    const ctx = await createTestContext({ db, settings: { ai: { monthly_budget_usd: 50 } } });
    await updateSettings(ctx, { ai: { monthly_budget_usd: 80 } });
    await updateSettings(ctx, { ai: { monthly_budget_usd: 120 } });
    await updateSettings(ctx, { strategy: { goals: "Demos" } });
    const [first, second] = await changes(ctx);
    const conflict = await errorOf(call(undoChangeOp, ctx, { change_id: first?.id }));
    expect(conflict.code).toBe("conflict");
    expect(conflict.message).toContain("Version 2");
    expect(conflict.details).toMatchObject({ later_version: 2, later_change_id: second?.id });
    expect(conflict.hint).toContain(second?.id ?? "missing");

    // Undo the later change first; then the earlier one can go back too.
    await call(undoChangeOp, ctx, { change_id: second?.id });
    await call(undoChangeOp, ctx, { change_id: first?.id });
    expect(await storedSettings(ctx)).toEqual({
      ai: { monthly_budget_usd: 50 },
      strategy: { goals: "Demos" },
    });

    const again = await errorOf(call(undoChangeOp, ctx, { change_id: first?.id }));
    expect(again.code).toBe("conflict");
    expect(again.message).toMatch(/already undone by version 5/);
  });

  it("makes a change live again when its undo is undone, so later undos see it", async () => {
    const ctx = await createTestContext({ db, settings: { ai: { monthly_budget_usd: 50 } } });
    await updateSettings(ctx, { ai: { monthly_budget_usd: 80 } });
    await updateSettings(ctx, { ai: { monthly_budget_usd: 120 } });
    const [first, second] = await changes(ctx);
    await call(undoChangeOp, ctx, { change_id: second?.id });
    const undoOfSecond = (await changes(ctx))[2];
    // Undoing the undo puts 120 back: the second change is live again.
    await call(undoChangeOp, ctx, { change_id: undoOfSecond?.id });
    await ctx.reloadWorkspace();
    expect(await storedSettings(ctx)).toEqual({ ai: { monthly_budget_usd: 120 } });
    let rows = await changes(ctx);
    expect(rows.map((row) => row.undone_at !== null)).toEqual([false, false, true, false]);
    expect(await call(getChange, ctx, { change_id: second?.id })).toMatchObject({
      undone: false,
      undone_by: null,
    });

    // So undoing the first change would overwrite 120: refused, naming the second change.
    const conflict = await errorOf(call(undoChangeOp, ctx, { change_id: first?.id }));
    expect(conflict.code).toBe("conflict");
    expect(conflict.details).toMatchObject({ later_change_id: second?.id, later_version: 2 });
    expect(await storedSettings(ctx)).toEqual({ ai: { monthly_budget_usd: 120 } });

    // The second change can be undone again, then the first one.
    const again = await call(undoChangeOp, ctx, { change_id: second?.id });
    expect(again).toMatchObject({ undo_change: { version: 5 } });
    await ctx.reloadWorkspace();
    await call(undoChangeOp, ctx, { change_id: first?.id });
    expect(await storedSettings(ctx)).toEqual({ ai: { monthly_budget_usd: 50 } });
    rows = await changes(ctx);
    expect(await call(getChange, ctx, { change_id: second?.id })).toMatchObject({
      undone: true,
      undone_by: { change_id: rows[4]?.id, version: 5 },
    });
  });

  it("follows a longer chain of undos", async () => {
    const ctx = await createTestContext({ db, settings: { ai: { monthly_budget_usd: 50 } } });
    await updateSettings(ctx, { ai: { monthly_budget_usd: 80 } });
    const undoLatest = async () => {
      const rows = await changes(ctx);
      await call(undoChangeOp, ctx, { change_id: rows.at(-1)?.id });
      await ctx.reloadWorkspace();
    };
    await undoLatest(); // v2 undoes v1: 50
    await undoLatest(); // v3 undoes v2: 80, v1 live again
    await undoLatest(); // v4 undoes v3: 50, v2 live again and v1 undone again
    expect(await storedSettings(ctx)).toEqual({ ai: { monthly_budget_usd: 50 } });
    const rows = await changes(ctx);
    expect(rows.map((row) => row.undone_at !== null)).toEqual([true, false, true, false]);
    const repeated = await errorOf(call(undoChangeOp, ctx, { change_id: rows[0]?.id }));
    expect(repeated.message).toMatch(/already undone by version 2/);
  });

  it("undoes two settings changes at once without one write losing the other", async () => {
    const ctx = await createTestContext({ db });
    await updateSettings(ctx, { strategy: { goals: "Ten demos a month" } });
    await updateSettings(ctx, { booking: { mode: "handoff" } });
    const [goals, booking] = await changes(ctx);
    await Promise.all([
      call(undoChangeOp, ctx, { change_id: goals?.id }),
      call(undoChangeOp, ctx, { change_id: booking?.id }),
    ]);
    expect(await storedSettings(ctx)).toEqual({});
    const undos = (await changes(ctx)).slice(2);
    expect(undos.map((entry) => entry.diff.map((item) => item.path).join()).sort()).toEqual([
      "booking.mode",
      "strategy.goals",
    ]);
  });

  it("does not find another workspace's change", async () => {
    const one = await createTestContext({ db });
    const two = await createTestContext({ db });
    await updateSettings(one, { strategy: { goals: "Demos" } });
    const [change] = await changes(one);
    const error = await errorOf(call(undoChangeOp, two, { change_id: change?.id }));
    expect(error.code).toBe("not_found");
    expect(await storedSettings(one)).toEqual({ strategy: { goals: "Demos" } });
  });
});

describe("undoing offer, ICP and campaign updates", () => {
  it("restores an offer update through the offer update function", async () => {
    const ctx = await createTestContext({ db });
    const offer = await call(createOfferOp, ctx, {
      name: "Forecast Pilot",
      summary: "A 30 day pilot.",
      booking_url: "https://cal.example.com/pilot",
    });
    await call(updateOfferOp, ctx, {
      offer_id: offer.id,
      summary: "A free 30 day pilot.",
      booking_url: "https://cal.example.com/free-pilot",
    });
    const rows = await changes(ctx);
    const result = await call(undoChangeOp, ctx, { change_id: rows[1]?.id });
    expect(result).toMatchObject({ undo_change: { version: 3 } });
    const [stored] = await ctx.db.select().from(offers).where(eq(offers.id, offer.id));
    expect(stored).toMatchObject({
      summary: "A 30 day pilot.",
      booking_url: "https://cal.example.com/pilot",
    });
    const undo = (await changes(ctx))[2];
    expect(undo).toMatchObject({ area: "offer", target_id: offer.id, undo_of: rows[1]?.id });
  });

  it("refuses creates and deletes with a hint", async () => {
    const ctx = await createTestContext({ db });
    await call(createOfferOp, ctx, { name: "Forecast Pilot", summary: "A pilot." });
    const icp = await call(createIcp, ctx, {
      name: "Dental groups",
      criteria: { industries: ["dental clinic"] },
    });
    await call(deleteIcp, ctx, { icp_id: icp.id });
    const [offerCreate, icpCreate, icpDelete] = await changes(ctx);
    const created = await errorOf(call(undoChangeOp, ctx, { change_id: offerCreate?.id }));
    expect(created.code).toBe("unsupported");
    expect(created.hint).toContain("remove_offer");
    const createdIcp = await errorOf(call(undoChangeOp, ctx, { change_id: icpCreate?.id }));
    expect(createdIcp.hint).toContain("manage_icp action delete");
    const deleted = await errorOf(call(undoChangeOp, ctx, { change_id: icpDelete?.id }));
    expect(deleted.code).toBe("unsupported");
    expect(deleted.hint).toContain("manage_icp action create");
  });

  it("restores ICP criteria and name", async () => {
    const ctx = await createTestContext({ db });
    const icp = await call(createIcp, ctx, {
      name: "Dental practices",
      criteria: { industries: ["dental clinic"] },
    });
    await call(updateIcp, ctx, {
      icp_id: icp.id,
      name: "Dental groups",
      criteria: { industries: ["dental clinic"], countries: ["US"] },
    });
    const [, update] = await changes(ctx);
    await call(undoChangeOp, ctx, { change_id: update?.id });
    const restored = await ctx.db.query.icps.findFirst({
      where: (table, { eq: equals }) => equals(table.id, icp.id),
    });
    expect(restored?.name).toBe("Dental practices");
    expect(restored?.criteria).toMatchObject({ industries: ["dental clinic"], countries: [] });
  });

  it("undoes a campaign update that only added a setting by removing the key", async () => {
    const ctx = await createTestContext({ db });
    const { campaign } = await seedCampaign(ctx, {
      status: "active",
      settings: { daily_new_leads: 20 },
      steps: [{ type: "email" }],
    });
    await call(updateCampaign, ctx, {
      campaign_id: campaign.id,
      settings: { review_level: "every" },
    });
    const [change] = await changes(ctx);
    expect(change?.diff).toEqual([{ path: "settings.review_level", after: "every" }]);
    const detail = await call(getChange, ctx, { change_id: change?.id });
    expect(detail).toMatchObject({
      kind: "update",
      summary: "settings.review_level: (none) -> every",
    });
    const undone = await call(undoChangeOp, ctx, { change_id: change?.id });
    expect(undone).toMatchObject({
      restored: [{ path: "settings.review_level", value: null, removed: true }],
    });
    const stored = await ctx.db.query.campaigns.findFirst({
      where: (table, { eq: equals }) => equals(table.id, campaign.id),
    });
    expect(stored?.settings).toEqual({ daily_new_leads: 20 });
    // The undo only removed a key, and it is an update too.
    const undo = (await changes(ctx))[1];
    expect(undo?.diff).toEqual([{ path: "settings.review_level", before: "every" }]);
    expect(await call(getChange, ctx, { change_id: undo?.id })).toMatchObject({ kind: "update" });
  });

  it("restores campaign settings and steps, keeping step ids that still exist", async () => {
    const ctx = await createTestContext({ db });
    const { campaign, steps } = await seedCampaign(ctx, {
      status: "active",
      settings: { daily_new_leads: 20 },
      steps: [{ type: "email" }, { type: "wait", delay_days: 2 }],
    });
    await call(updateCampaign, ctx, {
      campaign_id: campaign.id,
      name: "Dental groups, Q4",
      settings: { daily_new_leads: 5 },
      steps: steps.map((step) => ({
        id: step.id,
        type: step.type,
        delay_days: step.type === "wait" ? 5 : step.delay_days,
        config: step.config,
      })),
    });
    const [change] = await changes(ctx);
    await call(undoChangeOp, ctx, { change_id: change?.id });
    const stored = await ctx.db.query.campaigns.findFirst({
      where: (table, { eq: equals }) => equals(table.id, campaign.id),
    });
    expect(stored?.name).toBe(campaign.name);
    expect(stored?.settings).toEqual({ daily_new_leads: 20 });
    const storedSteps = await ctx.db.query.campaign_steps.findMany({
      where: (table, { eq: equals }) => equals(table.campaign_id, campaign.id),
      orderBy: (table, { asc: ascending }) => ascending(table.position),
    });
    expect(storedSteps.map((step) => [step.id, step.delay_days])).toEqual(
      steps.map((step) => [step.id, step.delay_days]),
    );
  });

  it("marks the proposal behind an undone change as reverted", async () => {
    const ctx = await createTestContext({ db });
    const [proposal] = await ctx.db
      .insert(change_proposals)
      .values({
        workspace_id: ctx.workspace.id,
        title: "Goals",
        reason: "Clearer goals",
        operation: "workspaces.update",
        input: { settings: { strategy: { goals: "Demos" } } },
        status: "applied",
      })
      .returning();
    await updateSettings(ctx, { strategy: { goals: "Demos" } });
    const [change] = await changes(ctx);
    await ctx.db
      .update(change_log)
      .set({ proposal_id: proposal?.id ?? null })
      .where(eq(change_log.id, change?.id ?? ""));
    await call(undoChangeOp, ctx, { change_id: change?.id });
    const status = async () =>
      (
        await ctx.db
          .select()
          .from(change_proposals)
          .where(eq(change_proposals.id, proposal?.id ?? ""))
      )[0]?.status;
    expect(await status()).toBe("reverted");
    // Undoing the undo puts the change, and so the proposal, back in effect.
    await ctx.reloadWorkspace();
    const undo = (await changes(ctx))[1];
    await call(undoChangeOp, ctx, { change_id: undo?.id });
    expect(await status()).toBe("applied");
  });
});
