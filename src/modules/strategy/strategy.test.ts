/**
 * The strategy page: every section from the workspace's settings and records, lessons and the
 * last changes, the precedence line, and nothing secret.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import type { AnyZodObject, OperationDefinition } from "../../core/operation.js";
import {
  change_log,
  change_proposals,
  knowledge_items,
  offers,
  signal_definitions,
} from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedCampaign } from "../../testing/factories.js";
import { updateCampaign } from "../campaigns/operations/campaigns.js";
import { createOfferOp, updateOfferOp } from "../knowledge/operations/offers.js";
import { createIcp } from "../leads/operations/icps.js";
import { updateWorkspace } from "../workspaces/operations.js";
import { getStrategy } from "./operations.js";
import { PRECEDENCE } from "./strategy.js";

async function call<In extends AnyZodObject, Out extends z.ZodType>(
  op: OperationDefinition<In, Out>,
  ctx: TestContext,
  input: unknown,
): Promise<z.output<Out>> {
  return op.output.parse(await op.handler(ctx, op.input.parse(input))) as z.output<Out>;
}

const DAY = 24 * 60 * 60 * 1000;
const SECRET = "smtp-pass-example-7f3a91";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

async function seedStrategy(ctx: TestContext) {
  const now = ctx.clock.now();
  const pilot = await call(createOfferOp, ctx, {
    name: "Forecast Pilot",
    summary: "A 30 day pilot on your own data.\nIncludes a weekly call.",
  });
  await call(createOfferOp, ctx, {
    name: "Audit",
    summary: "A one hour inventory audit.",
    booking_url: "https://cal.example.com/audit",
  });
  await ctx.db.insert(offers).values([
    { workspace_id: ctx.workspace.id, name: "Old offer", status: "archived" },
    { workspace_id: ctx.workspace.id, name: "Drafted offer", status: "archived", suggested: true },
  ]);
  await call(createIcp, ctx, {
    name: "Dental groups",
    criteria: { industries: ["dental clinic"], countries: ["US"] },
  });
  await ctx.db.insert(knowledge_items).values([
    { workspace_id: ctx.workspace.id, kind: "rule", title: "Never promise savings" },
    { workspace_id: ctx.workspace.id, kind: "rule", title: "Never mention competitors" },
    { workspace_id: ctx.workspace.id, kind: "voice_sample", title: "Intro email", body: "Hi" },
    {
      workspace_id: ctx.workspace.id,
      kind: "lesson",
      title: "Short subjects win",
      body: "Subjects under 5 words got twice the replies.",
      sample_size: 420,
      expires_at: new Date(now.getTime() + 30 * DAY),
      updated_at: new Date(now.getTime() - 2 * DAY),
    },
    {
      workspace_id: ctx.workspace.id,
      kind: "lesson",
      title: "Mention the clinic count",
      body: "Openers naming the number of clinics beat generic ones.",
      expires_at: new Date(now.getTime() + 60 * DAY),
      updated_at: new Date(now.getTime() - DAY),
    },
    {
      workspace_id: ctx.workspace.id,
      kind: "lesson",
      title: "Expired lesson",
      body: "Old news.",
      expires_at: new Date(now.getTime() - DAY),
    },
    {
      workspace_id: ctx.workspace.id,
      kind: "lesson",
      title: "Archived lesson",
      status: "archived",
    },
  ]);
  await ctx.db.insert(signal_definitions).values([
    {
      workspace_id: ctx.workspace.id,
      key: "new_clinic",
      name: "Opened a new clinic",
      kind: "custom",
    },
    {
      workspace_id: ctx.workspace.id,
      key: "payroll_switch",
      name: "Switching payroll",
      kind: "custom",
      enabled: false,
    },
  ]);
  await ctx.vault.putSecret(ctx.workspace.id, "mailbox_password", SECRET);
  await ctx.usage.record({
    slot: "brain",
    provider: "anthropic",
    operation: "campaigns.write_email",
    costUsd: 12.345,
  });
  return { pilot };
}

describe("strategy page", () => {
  it("gathers every section from the workspace", async () => {
    const ctx = await createTestContext({
      db,
      workspace: { name: "Harbor Analytics" },
      settings: {
        company: { name: "Harbor Analytics", website: "https://harbor.example.com" },
        ai: { monthly_budget_usd: 50, language: "de", tone_notes: "Warm, no jargon" },
        data: { monthly_credit_budget: 1000 },
        booking: { default_url: "https://cal.example.com/intro" },
        crm: { mode: "agent", notes: "Add people to the Outbound list" },
        compliance: { excluded_countries: ["FR"], contact_cap_per_company: 2 },
        approvals: { agent_changes: "auto", default_review_level: "every" },
        replies: { question: { action: "human" } },
        strategy: {
          goals: "Ten qualified demos a month",
          qualified_meeting: "Dental group with 5+ clinics, owner attends",
          agent_notes: "Never touch the Q4 campaign",
        },
      },
    });
    const { pilot } = await seedStrategy(ctx);
    const page = await call(getStrategy, ctx, {});

    expect(page.version).toBe(3);
    expect(page.workspace).toMatchObject({ id: ctx.workspace.id, name: "Harbor Analytics" });
    expect(page.company).toEqual({
      name: "Harbor Analytics",
      website: "https://harbor.example.com",
    });
    expect(page.offers).toEqual([
      {
        id: pilot.id,
        name: "Forecast Pilot",
        summary: "A 30 day pilot on your own data.",
        booking_url: "https://cal.example.com/intro",
        is_default: true,
      },
      expect.objectContaining({ name: "Audit", booking_url: "https://cal.example.com/audit" }),
    ]);
    expect(page.icps).toEqual([
      expect.objectContaining({ name: "Dental groups", is_default: true }),
    ]);
    expect(page.icps[0]?.summary).toMatch(/dental clinic/);
    expect(page.signals.custom).toEqual(["Opened a new clinic", "Switching payroll (off)"]);
    expect(page.signals.enabled.length).toBeGreaterThan(5);
    expect(page.voice).toEqual({
      language: "de",
      tone_notes: "Warm, no jargon",
      never_say: ["Never promise savings", "Never mention competitors"],
      voice_samples: 1,
    });
    expect(page.replies).toMatchObject({
      question: "human",
      unsubscribe: "suppress (locked)",
      interested: "opportunity_and_draft",
    });
    expect(page.review).toEqual({
      default_review_level: "every",
      agent_launch_requires_approval: true,
      agent_changes: "auto",
      expire_days: 7,
    });
    expect(page.booking).toMatchObject({
      mode: "link",
      default_url: "https://cal.example.com/intro",
      tag_links: true,
      assume_held_after_hours: 24,
    });
    expect(page.crm).toMatchObject({
      mode: "agent",
      sync_from: "interested",
      notes: "Add people to the Outbound list",
    });
    expect(page.compliance).toMatchObject({
      excluded_countries: ["FR"],
      contact_cap_per_company: 2,
      rest_days_after_campaign: 30,
      privacy_response_days: 30,
    });
    expect(page.compliance.consent_required_countries).toContain("DE");
    expect(page.budgets).toEqual({
      ai: { budget_usd: 50, used_usd: 12.35, remaining_usd: 37.66 },
      data: { budget_credits: 1000, used_credits: 0, remaining_credits: 1000 },
    });
    expect(page.strategy).toEqual({
      goals: "Ten qualified demos a month",
      qualified_meeting: "Dental group with 5+ clinics, owner attends",
      agent_notes: "Never touch the Q4 campaign",
    });
    expect(page.lessons.map((lesson) => lesson.title)).toEqual([
      "Mention the clinic count",
      "Short subjects win",
    ]);
    expect(page.lessons[1]).toMatchObject({ sample_size: 420 });
    expect(page.precedence).toBe(PRECEDENCE);
    expect(page.precedence).toBe(
      "Engine protections, then workspace rules, then campaign settings, then person facts, then task instructions",
    );
  });

  it("lists the last five changes with target names, actors and verdicts", async () => {
    const ctx = await createTestContext({ db });
    const offer = await call(createOfferOp, ctx, { name: "Pilot", summary: "A pilot." });
    const { campaign } = await seedCampaign(ctx, { name: "Dental Q4" });
    for (const days of [10, 20, 30]) {
      await ctx.reloadWorkspace();
      await call(updateWorkspace, ctx, { settings: { approvals: { expire_days: days } } });
    }
    await call(updateOfferOp, ctx, { offer_id: offer.id, summary: "A free pilot." });
    await call(updateCampaign, ctx, { campaign_id: campaign.id, name: "Dental groups Q4" });
    const [proposal] = await ctx.db
      .insert(change_proposals)
      .values({
        workspace_id: ctx.workspace.id,
        title: "Rename",
        reason: "Clearer",
        operation: "campaigns.update",
        input: { campaign_id: campaign.id, name: "Dental groups Q4" },
        status: "applied",
        outcome: { window_days: 14, before: {}, after: {}, verdict: "better" },
      })
      .returning();
    await ctx.db
      .update(change_log)
      .set({ proposal_id: proposal?.id ?? null })
      .where(eq(change_log.version, 6));

    const page = await call(getStrategy, ctx, {});
    expect(page.version).toBe(6);
    expect(page.recent_changes.map((change) => change.version)).toEqual([6, 5, 4, 3, 2]);
    expect(page.recent_changes[0]).toMatchObject({
      area: "campaign",
      target_id: campaign.id,
      target_name: "Dental groups Q4",
      summary: "name: Dental Q4 -> Dental groups Q4",
      actor: { type: "human", name: "Test User" },
      verdict: "better",
      undone: false,
    });
    expect(page.recent_changes[1]).toMatchObject({
      area: "offer",
      target_name: "Pilot",
      summary: "summary: A pilot. -> A free pilot.",
      verdict: null,
    });
    expect(page.recent_changes[2]).toMatchObject({
      area: "settings",
      target_name: null,
      summary: "approvals.expire_days: 20 -> 30",
    });
  });

  it("contains no secrets or provider internals", async () => {
    const ctx = await createTestContext({
      db,
      settings: {
        ai: {
          fallback_provider: "openai-backup",
          task_models: { "campaigns.write_email": { model: "private-model-x" } },
        },
      },
    });
    await seedStrategy(ctx);
    const text = JSON.stringify(await call(getStrategy, ctx, {}));
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("openai-backup");
    expect(text).not.toContain("private-model-x");
    expect(text).not.toMatch(/password|api_key|"secret|token/i);
    expect(text.length).toBeLessThan(12_000);
  });

  it("starts at version 0 for a new workspace", async () => {
    const ctx = await createTestContext({ db });
    const page = await call(getStrategy, ctx, {});
    expect(page).toMatchObject({
      version: 0,
      offers: [],
      icps: [],
      lessons: [],
      recent_changes: [],
    });
    expect(page.strategy).toEqual({ goals: "", qualified_meeting: "", agent_notes: "" });
  });
});
