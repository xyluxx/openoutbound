/**
 * Every path that changes workspace settings, offers, ICPs or campaigns records the change, and
 * updates that change nothing record nothing.
 */
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import type { AnyZodObject, OperationDefinition } from "../../core/operation.js";
import { change_log, knowledge_items, offers } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedCampaign, seedEnrollment, seedPerson } from "../../testing/factories.js";
import { updateCampaign } from "../campaigns/operations/campaigns.js";
import { approveSuggestions } from "../knowledge/operations/approve.js";
import { deleteKnowledgeItem } from "../knowledge/operations/items.js";
import { createOfferOp, deleteOfferOp, updateOfferOp } from "../knowledge/operations/offers.js";
import { createIcp, deleteIcp, updateIcp } from "../leads/operations/icps.js";
import { updateWorkspace } from "../workspaces/operations.js";
import { changeKind, summarizeChange } from "./change-log.js";

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

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

describe("workspace settings", () => {
  it("records settings updates with the stored values before and after", async () => {
    const ctx = await createTestContext({ db, settings: { ai: { monthly_budget_usd: 50 } } });
    await call(updateWorkspace, ctx, {
      settings: { ai: { monthly_budget_usd: 80 }, strategy: { goals: "Ten demos a month" } },
    });
    const [row] = await changes(ctx);
    expect(row).toMatchObject({
      version: 1,
      area: "settings",
      target_id: ctx.workspace.id,
      operation: "workspaces.update",
      diff: [
        { path: "ai.monthly_budget_usd", before: 50, after: 80 },
        { path: "strategy.goals", after: "Ten demos a month" },
      ],
    });
  });

  it("records nothing for a no-op or a change without settings", async () => {
    const ctx = await createTestContext({ db, settings: { ai: { monthly_budget_usd: 50 } } });
    await call(updateWorkspace, ctx, { settings: { ai: { monthly_budget_usd: 50 } } });
    await call(updateWorkspace, ctx, { name: "Renamed Client" });
    expect(await changes(ctx)).toHaveLength(0);
  });
});

describe("offers", () => {
  it("records create, update and delete with the fields that matter", async () => {
    const ctx = await createTestContext({ db });
    const offer = await call(createOfferOp, ctx, {
      name: "Forecast Pilot",
      summary: "A 30 day pilot.",
      booking_url: "https://cal.example.com/pilot",
    });
    await call(updateOfferOp, ctx, {
      offer_id: offer.id,
      summary: "A 30 day pilot on your own data.",
    });
    await call(updateOfferOp, ctx, {
      offer_id: offer.id,
      summary: "A 30 day pilot on your own data.",
    });
    await call(deleteOfferOp, ctx, { offer_id: offer.id });
    const rows = await changes(ctx);
    expect(rows.map((row) => [row.version, row.operation, row.target_id])).toEqual([
      [1, "offers.create", offer.id],
      [2, "offers.update", offer.id],
      [3, "offers.delete", offer.id],
    ]);
    expect(rows[0]?.diff).toContainEqual({
      path: "booking_url",
      after: "https://cal.example.com/pilot",
    });
    expect(rows[1]?.diff).toEqual([
      { path: "summary", before: "A 30 day pilot.", after: "A 30 day pilot on your own data." },
    ]);
    expect(rows[2]?.diff).toEqual([
      { path: "status", before: "active", after: "archived" },
      { path: "is_default", before: true, after: false },
    ]);
  });

  it("records approving a suggested offer and losing proof when an item is deleted", async () => {
    const ctx = await createTestContext({ db });
    const [proof] = await ctx.db
      .insert(knowledge_items)
      .values({
        workspace_id: ctx.workspace.id,
        kind: "proof",
        title: "Stockouts down",
        body: "31%",
      })
      .returning();
    const [suggested] = await ctx.db
      .insert(offers)
      .values({
        workspace_id: ctx.workspace.id,
        name: "Drafted offer",
        status: "archived",
        suggested: true,
        proof_item_ids: [proof?.id ?? ""],
      })
      .returning();
    await call(approveSuggestions, ctx, { offer_ids: [suggested?.id] });
    await call(deleteKnowledgeItem, ctx, { item_id: proof?.id, permanent: true });
    const rows = await changes(ctx);
    // The offer lost a proof item: an update of its proof ids, not the offer being removed.
    expect(rows.map((row) => row.operation)).toEqual(["knowledge.approve", "offers.update"]);
    expect(rows[0]?.diff).toContainEqual({ path: "status", before: "suggested", after: "active" });
    expect(rows[1]?.diff).toEqual([{ path: "proof_item_ids", before: [proof?.id], after: [] }]);
    expect(changeKind(rows[1] as NonNullable<(typeof rows)[1]>)).toBe("update");
    expect(summarizeChange(rows[1] as NonNullable<(typeof rows)[1]>)).toBe(
      `proof_item_ids: ["${proof?.id}"] -> []`,
    );
  });
});

describe("ICPs", () => {
  it("records create, update and delete, and nothing for a no-op update", async () => {
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
    await call(updateIcp, ctx, { icp_id: icp.id, name: "Dental groups" });
    await call(deleteIcp, ctx, { icp_id: icp.id });
    const rows = await changes(ctx);
    expect(rows.map((row) => row.operation)).toEqual(["icps.create", "icps.update", "icps.delete"]);
    expect(rows[1]?.diff).toEqual([
      { path: "name", before: "Dental practices", after: "Dental groups" },
      { path: "criteria.countries", before: [], after: ["US"] },
    ]);
    expect(rows[2]?.diff.every((entry) => entry.after === undefined)).toBe(true);
  });
});

describe("campaigns", () => {
  it("records name, goal, settings and steps, and nothing for a no-op update", async () => {
    const ctx = await createTestContext({ db });
    const { campaign, steps } = await seedCampaign(ctx, {
      settings: { daily_new_leads: 20 },
      steps: [{ type: "email" }],
    });
    const stepInput = steps.map((step) => ({
      type: step.type,
      delay_days: step.delay_days,
      config: step.config,
    }));
    // A draft stores its steps again on every update: same content is no change.
    await call(updateCampaign, ctx, { campaign_id: campaign.id, steps: stepInput });
    await call(updateCampaign, ctx, {
      campaign_id: campaign.id,
      name: "Dental groups, Q4",
      goal: "reply",
      settings: { daily_new_leads: 10, review_level: "every" },
      steps: [...stepInput, { type: "wait", delay_days: 3 }],
    });
    const rows = await changes(ctx);
    expect(rows).toHaveLength(1);
    const paths = rows[0]?.diff.map((entry) => entry.path);
    expect(paths).toEqual([
      "name",
      "goal",
      "settings.daily_new_leads",
      "settings.review_level",
      "steps",
    ]);
    expect(rows[0]).toMatchObject({ area: "campaign", target_id: campaign.id });
  });

  it("records step edits on a live campaign that keeps its progress", async () => {
    const ctx = await createTestContext({ db });
    const { campaign, steps } = await seedCampaign(ctx, {
      status: "active",
      steps: [{ type: "email" }, { type: "wait", delay_days: 2 }, { type: "email" }],
    });
    const person = await seedPerson(ctx);
    const enrollment = await seedEnrollment(ctx, {
      campaign_id: campaign.id,
      person_id: person.id,
      current_step: 2,
    });
    const kept = steps.map((step) => ({
      id: step.id,
      type: step.type,
      delay_days: step.type === "wait" ? 4 : step.delay_days,
      config: step.config,
    }));
    await call(updateCampaign, ctx, { campaign_id: campaign.id, steps: kept });
    const [row] = await changes(ctx);
    expect(row?.diff.map((entry) => entry.path)).toEqual(["steps"]);
    const [after] = await ctx.db
      .select()
      .from(change_log)
      .where(and(eq(change_log.workspace_id, ctx.workspace.id), eq(change_log.area, "campaign")));
    expect(after?.id).toBe(row?.id);
    const stored = await ctx.db.query.enrollments.findFirst({
      where: (table, { eq: equals }) => equals(table.id, enrollment.id),
    });
    expect(stored?.current_step).toBe(2);
  });
});
