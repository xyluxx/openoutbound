import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { AnyZodObject, OperationDefinition } from "../../core/operation.js";
import {
  approvals,
  companies,
  imports,
  messages,
  opportunities,
  people,
  research_briefs,
  suppressions,
  tasks,
  threads,
} from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { truncateAll } from "../../testing/db.js";
import {
  seedCampaign,
  seedCompany,
  seedEnrollment,
  seedMessage,
  seedPerson,
  seedThread,
  seedWorkspace,
} from "../../testing/factories.js";
import { stopEnrollmentsForPerson } from "../campaigns/service.js";
import { checkContactable } from "./contactable.js";
import { forgetLeadOp } from "./operations/forget.js";
import { importLeads } from "./operations/imports.js";
import { createLead, updateLead } from "./operations/people.js";
import { retentionSweepJob } from "./retention.js";
import { hashSuppressionValue } from "./suppressions.js";

vi.mock("../campaigns/service.js", () => ({
  stopEnrollmentsForPerson: vi.fn(async () => 1),
}));

async function call<In extends AnyZodObject, Out extends z.ZodType>(
  op: OperationDefinition<In, Out>,
  ctx: TestContext,
  input: unknown,
): Promise<z.output<Out>> {
  return op.output.parse(await op.handler(ctx, op.input.parse(input))) as z.output<Out>;
}

// biome-ignore lint/suspicious/noExplicitAny: test results are checked with expect
type Any = any;

const DAY = 86_400_000;
let ctx: TestContext;

function daysAgo(days: number): Date {
  return new Date(ctx.clock.now().getTime() - days * DAY);
}

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  ctx = ctx.with({ workspace: await seedWorkspace(ctx.db, { settings: {} }) });
  ctx.recorded.audit.length = 0;
});

describe("leads.forget", () => {
  async function seedHistory() {
    const person = await seedPerson(ctx, {
      email: "dana@brightsmile.example.com",
      linkedin_url: "https://www.linkedin.com/in/dana-rivers-example",
    });
    const thread = await seedThread(ctx, { person_id: person.id, subject: "Dana, quick question" });
    const sent = await seedMessage(ctx, {
      person_id: person.id,
      thread_id: thread.id,
      status: "sent",
      to_address: "dana@brightsmile.example.com",
    });
    const pending = await seedMessage(ctx, { person_id: person.id, status: "pending_review" });
    const approved = await seedMessage(ctx, { person_id: person.id, status: "approved" });
    const scheduled = await seedMessage(ctx, {
      person_id: person.id,
      status: "scheduled",
      scheduled_for: new Date(ctx.clock.now().getTime() + 3_600_000),
    });
    const { campaign } = await seedCampaign(ctx);
    await seedEnrollment(ctx, { campaign_id: campaign.id, person_id: person.id, status: "active" });
    await ctx.approvals.request({
      kind: "message",
      title: "Send email to Dana",
      summary: "Review",
      payload: { body: "Hi Dana" },
      target: { type: "message", id: pending.id },
    });
    await ctx.db.insert(research_briefs).values({
      workspace_id: ctx.workspace.id,
      person_id: person.id,
      status: "ready",
      summary: "Dana owns the practice",
    });
    await ctx.db.insert(tasks).values({
      workspace_id: ctx.workspace.id,
      person_id: person.id,
      title: "Call Dana",
    });
    await ctx.db.insert(opportunities).values({
      workspace_id: ctx.workspace.id,
      person_id: person.id,
      notes: "Dana wants a demo",
    });
    await ctx.db.insert(suppressions).values({
      workspace_id: ctx.workspace.id,
      type: "email",
      value: "dana@brightsmile.example.com",
      reason: "unsubscribed",
    });
    return { person, thread, sent, pending, approved, scheduled };
  }

  it("dry run counts what would be removed and changes nothing", async () => {
    const { person } = await seedHistory();
    const result: Any = await call(forgetLeadOp, ctx.with({ request: { dryRun: true } }), {
      person_id: person.id,
    });
    expect(result.preview).toMatchObject({
      person_id: person.id,
      hashed_suppressions: 2,
      messages_scrubbed: 4,
      messages_cancelled: 3,
      enrollments_stopped: 1,
      threads_scrubbed: 1,
      briefs_deleted: 1,
      tasks_deleted: 1,
      opportunities_unlinked: 1,
      person_deleted: false,
    });
    expect(await ctx.db.select().from(people)).toHaveLength(1);
  });

  it("erases the person, scrubs related data and keeps only hashed suppressions", async () => {
    const { person, thread, sent, pending, approved, scheduled } = await seedHistory();
    const result: Any = await call(forgetLeadOp, ctx, { person_id: person.id });
    expect(result).toMatchObject({
      person_deleted: true,
      hashed_suppressions: 2,
      enrollments_stopped: 1,
      approvals_cancelled: 1,
      messages_cancelled: 3,
      briefs_deleted: 1,
    });
    expect(stopEnrollmentsForPerson).toHaveBeenCalledWith(expect.anything(), {
      personId: person.id,
      reason: "gdpr_erasure",
    });
    for (const unsent of [approved, scheduled]) {
      const [row] = await ctx.db.select().from(messages).where(eq(messages.id, unsent.id));
      expect(row).toMatchObject({ status: "cancelled", body_text: null, person_id: null });
    }
    expect(await ctx.db.select().from(people)).toHaveLength(0);

    const [scrubbed] = await ctx.db.select().from(messages).where(eq(messages.id, sent.id));
    expect(scrubbed).toMatchObject({
      person_id: null,
      subject: null,
      body_text: null,
      to_address: null,
      status: "sent",
    });
    const [cancelled] = await ctx.db.select().from(messages).where(eq(messages.id, pending.id));
    expect(cancelled?.status).toBe("cancelled");
    const [thr] = await ctx.db.select().from(threads).where(eq(threads.id, thread.id));
    expect(thr).toMatchObject({ person_id: null, subject: null });
    expect(await ctx.db.select().from(research_briefs)).toHaveLength(0);
    expect(await ctx.db.select().from(tasks)).toHaveLength(0);
    const [opportunity] = await ctx.db.select().from(opportunities);
    expect(opportunity).toMatchObject({ person_id: null, notes: null });
    const [approval] = await ctx.db.select().from(approvals);
    expect(approval?.status).toBe("cancelled");

    const rows = await ctx.db.select().from(suppressions);
    expect(rows.map((r) => [r.type, r.value, r.reason]).sort()).toEqual(
      [
        ["email", hashSuppressionValue("dana@brightsmile.example.com"), "gdpr_erasure"],
        [
          "linkedin",
          hashSuppressionValue("https://www.linkedin.com/in/dana-rivers-example"),
          "gdpr_erasure",
        ],
      ].sort(),
    );
    expect(JSON.stringify(rows)).not.toContain("dana@");

    // The hashed entry blocks re-imports and contact.
    const again = await seedPerson(ctx, { email: "Dana@Brightsmile.example.com" });
    const check = await checkContactable(ctx, { personId: again.id, channel: "email" });
    expect(check.reasons).toContain("suppressed_email");
    const imported: Any = await call(importLeads, ctx, {
      source: "rows",
      rows: [{ Email: "dana@brightsmile.example.com", "First Name": "Dana" }],
    });
    expect(imported.stats.skipped_by_reason.suppressed).toBe(1);
    await expect(
      call(createLead, ctx, { full_name: "Dana Rivers", email: "dana@brightsmile.example.com" }),
    ).rejects.toMatchObject({ code: "suppressed" });
    const other = await seedPerson(ctx);
    await expect(
      call(updateLead, ctx, {
        person_id: other.id,
        linkedin_url: "https://linkedin.com/in/dana-rivers-example/",
      }),
    ).rejects.toMatchObject({ code: "suppressed" });
  });

  it("blocks an address without a record and validates the input", async () => {
    const result: Any = await call(forgetLeadOp, ctx, { email: "Nobody@Example.com" });
    expect(result).toMatchObject({
      person_id: null,
      person_deleted: false,
      hashed_suppressions: 1,
    });
    const [row] = await ctx.db.select().from(suppressions);
    expect(row?.value).toBe(hashSuppressionValue("nobody@example.com"));
    await expect(call(forgetLeadOp, ctx, {})).rejects.toMatchObject({ code: "validation_failed" });
    await expect(call(forgetLeadOp, ctx, { email: "not an email" })).rejects.toMatchObject({
      code: "validation_failed",
    });
  });
});

describe("leads.retention_sweep", () => {
  async function withRetention(days: number | null) {
    const workspace = await seedWorkspace(ctx.db, {
      settings: { compliance: { retention_days: days } },
    });
    ctx = ctx.with({ workspace });
  }

  it("deletes stale prospects and keeps customers, open deals, enrollments and suppressions", async () => {
    await withRetention(365);
    const old = daysAgo(400);
    const stale = await seedPerson(ctx, { updated_at: old, email: "stale@a.example.com" });
    const staleWithOldMail = await seedPerson(ctx, { updated_at: old, email: "o@b.example.com" });
    const oldMessage = await seedMessage(ctx, {
      person_id: staleWithOldMail.id,
      status: "sent",
      created_at: daysAgo(390),
      sent_at: daysAgo(390),
    });
    const recentMail = await seedPerson(ctx, { updated_at: old, email: "r@c.example.com" });
    await seedMessage(ctx, {
      person_id: recentMail.id,
      status: "received",
      created_at: daysAgo(10),
    });
    const customer = await seedPerson(ctx, { updated_at: old, status: "customer" });
    const customerCompany = await seedCompany(ctx, { status: "customer" });
    const atCustomer = await seedPerson(ctx, { updated_at: old, company_id: customerCompany.id });
    const withDeal = await seedPerson(ctx, { updated_at: old });
    await ctx.db
      .insert(opportunities)
      .values({ workspace_id: ctx.workspace.id, person_id: withDeal.id, stage: "meeting_booked" });
    const enrolled = await seedPerson(ctx, { updated_at: old });
    const { campaign } = await seedCampaign(ctx);
    await seedEnrollment(ctx, {
      campaign_id: campaign.id,
      person_id: enrolled.id,
      status: "queued",
    });
    const fresh = await seedPerson(ctx, { updated_at: daysAgo(10) });
    await ctx.db.insert(suppressions).values({
      workspace_id: ctx.workspace.id,
      type: "email",
      value: "stale@a.example.com",
      reason: "unsubscribed",
    });
    await ctx.db.insert(imports).values([
      {
        workspace_id: ctx.workspace.id,
        source: "apollo",
        status: "previewed",
        created_at: daysAgo(40),
      },
      { workspace_id: ctx.workspace.id, source: "apollo", status: "previewed" },
    ]);

    const summary: Any = await retentionSweepJob.handler(
      ctx.jobContext({ name: "leads.retention_sweep" }),
      {},
    );
    expect(summary).toMatchObject({ people_deleted: 2, previews_deleted: 1, more_left: false });
    const left = (await ctx.db.select({ id: people.id }).from(people)).map((p) => p.id).sort();
    expect(left).toEqual(
      [recentMail.id, customer.id, atCustomer.id, withDeal.id, enrolled.id, fresh.id].sort(),
    );
    expect(left).not.toContain(stale.id);
    const [message] = await ctx.db.select().from(messages).where(eq(messages.id, oldMessage.id));
    expect(message).toMatchObject({ person_id: null, body_text: null });
    expect(await ctx.db.select().from(suppressions)).toHaveLength(1);
    expect(await ctx.db.select().from(companies)).toHaveLength(1);
    expect(ctx.recorded.audit).toEqual([
      expect.objectContaining({
        operation: "leads.retention_sweep",
        effect: "destructive",
        input: expect.objectContaining({ people_deleted: 2, previews_deleted: 1 }),
      }),
    ]);
  });

  it("keeps everyone when retention_days is null", async () => {
    await withRetention(null);
    await seedPerson(ctx, { updated_at: daysAgo(5000) });
    const summary: Any = await retentionSweepJob.handler(
      ctx.jobContext({ name: "leads.retention_sweep" }),
      {},
    );
    expect(summary).toMatchObject({ retention_days: null, people_deleted: 0 });
    expect(await ctx.db.select().from(people)).toHaveLength(1);
    expect(ctx.recorded.audit[0]?.summary).toContain("Retention is off");
  });
});
