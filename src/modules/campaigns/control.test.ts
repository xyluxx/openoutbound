/**
 * Stop rules, pauses and the event handlers that drive them (replies, bounces, unsubscribes),
 * the exported binding functions, enroll requests and campaign stats.
 */
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventData, EventHandlerDefinition, EventType } from "../../core/events.js";
import type { CampaignSettingsInput } from "../../core/settings.js";
import {
  approvals,
  campaigns,
  type Enrollment,
  enrollments,
  messages,
  opportunities,
  type Person,
} from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import {
  seedCampaign,
  seedCompany,
  seedEnrollment,
  seedMessage,
  seedPerson,
  seedThread,
} from "../../testing/factories.js";
import { checkContactable } from "../leads/service.js";
import { markSignalsUsed } from "../signals/service.js";
import { campaignLaunchResolver, enrollmentResolver } from "./approvals.js";
import {
  advanceOnSent,
  handleEnrollRequest,
  pauseOnReply,
  stopOnBounce,
  stopOnUnsubscribe,
} from "./events.js";
import { runTick } from "./sequencer/tick.js";
import {
  enrollPeople,
  getCampaignStats,
  pauseEnrollmentsForPerson,
  resumeEnrollmentsForPerson,
  stopEnrollmentsForPerson,
} from "./service.js";
import { refreshStatsJob, STATS_JOB } from "./stats.js";

vi.mock("../leads/service.js", () => ({ checkContactable: vi.fn(), resolvePeople: vi.fn() }));
vi.mock("../signals/service.js", () => ({ getActiveSignals: vi.fn(), markSignalsUsed: vi.fn() }));

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let db: TestDb;
const contexts: TestContext[] = [];
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await Promise.all(contexts.map((ctx) => ctx.close()));
  await db.close();
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkContactable).mockResolvedValue({ ok: true, reasons: [] });
  vi.mocked(markSignalsUsed).mockResolvedValue(undefined);
});

async function context(): Promise<TestContext> {
  const ctx = await createTestContext({ db });
  contexts.push(ctx);
  return ctx;
}

async function campaign(ctx: TestContext, settings: CampaignSettingsInput = {}) {
  const { campaign } = await seedCampaign(ctx, {
    status: "active",
    settings,
    steps: [
      { type: "task", config: { title: "Call" } },
      { type: "wait", delay_days: 2 },
    ],
  });
  return campaign;
}

async function enroll(
  ctx: TestContext,
  campaignId: string,
  person: Person,
  values: Partial<Enrollment> = {},
): Promise<Enrollment> {
  return seedEnrollment(ctx, {
    campaign_id: campaignId,
    person_id: person.id,
    status: "active",
    next_run_at: new Date(ctx.clock.now().getTime() + DAY),
    ...values,
  });
}

async function statusOf(ctx: TestContext, id: string) {
  const [row] = await ctx.db.select().from(enrollments).where(eq(enrollments.id, id));
  return row;
}

async function fire<T extends EventType>(
  ctx: TestContext,
  handler: EventHandlerDefinition<T>,
  data: EventData[T],
): Promise<void> {
  await handler.handler(ctx.jobContext(), {
    id: "evt_test",
    type: handler.event,
    workspaceId: ctx.workspace.id,
    subject: null,
    data,
    occurredAt: ctx.clock.now(),
  });
}

describe("stopEnrollmentsForPerson", () => {
  it("stops the person's enrollments, cancels pending messages and approvals", async () => {
    const ctx = await context();
    const person = await seedPerson(ctx);
    const cmp = await campaign(ctx);
    const enrollment = await enroll(ctx, cmp.id, person, { status: "waiting_review" });
    const draft = await seedMessage(ctx, {
      enrollment_id: enrollment.id,
      campaign_id: cmp.id,
      person_id: person.id,
      status: "pending_review",
    });
    const { id: approvalId } = await ctx.approvals.request({
      kind: "message",
      title: "Email",
      summary: "Review",
      payload: { message_id: draft.id },
      target: { type: "message", id: draft.id },
    });

    expect(
      await stopEnrollmentsForPerson(ctx, { personId: person.id, reason: "unsubscribed" }),
    ).toBe(1);
    expect(await statusOf(ctx, enrollment.id)).toMatchObject({
      status: "stopped",
      stop_reason: "unsubscribed",
      next_run_at: null,
    });
    const [message] = await ctx.db.select().from(messages).where(eq(messages.id, draft.id));
    expect(message).toMatchObject({
      status: "cancelled",
      error: "enrollment_stopped:unsubscribed",
    });
    const [approval] = await ctx.db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(approval?.status).toBe("cancelled");
    expect(ctx.emitted("enrollment.stopped")[0]?.data).toMatchObject({
      enrollment_id: enrollment.id,
      reason: "unsubscribed",
    });
    expect(ctx.enqueued(STATS_JOB)).toHaveLength(1);
  });

  it("follows stop rules for replies, meetings and colleagues", async () => {
    const ctx = await context();
    const company = await seedCompany(ctx);
    const replier = await seedPerson(ctx, { company_id: company.id });
    const colleague = await seedPerson(ctx, { company_id: company.id });
    const other = await seedPerson(ctx, { company_id: company.id });
    const stopsAll = await campaign(ctx);
    const keepsColleagues = await campaign(ctx, { stop: { on_company_reply: false } });
    const own = await enroll(ctx, stopsAll.id, replier);
    const colleagueRow = await enroll(ctx, stopsAll.id, colleague);
    const otherRow = await enroll(ctx, keepsColleagues.id, other);

    expect(
      await stopEnrollmentsForPerson(ctx, {
        personId: replier.id,
        reason: "replied",
        companyWide: true,
      }),
    ).toBe(2);
    expect(await statusOf(ctx, own.id)).toMatchObject({
      status: "stopped",
      stop_reason: "replied",
    });
    expect(await statusOf(ctx, colleagueRow.id)).toMatchObject({
      status: "stopped",
      stop_reason: "company_replied",
    });
    expect(await statusOf(ctx, otherRow.id)).toMatchObject({ status: "active" });
  });

  it("stops colleagues on a won deal even when company replies do not stop them", async () => {
    const ctx = await context();
    const company = await seedCompany(ctx);
    const buyer = await seedPerson(ctx, { company_id: company.id });
    const colleague = await seedPerson(ctx, { company_id: company.id });
    const cmp = await campaign(ctx, { stop: { on_company_reply: false } });
    await enroll(ctx, cmp.id, buyer);
    const colleagueRow = await enroll(ctx, cmp.id, colleague);
    expect(
      await stopEnrollmentsForPerson(ctx, { personId: buyer.id, reason: "won", companyWide: true }),
    ).toBe(2);
    expect(await statusOf(ctx, colleagueRow.id)).toMatchObject({
      status: "stopped",
      stop_reason: "company_won",
    });
  });

  it("keeps sequences running when the campaign does not stop on meetings", async () => {
    const ctx = await context();
    const person = await seedPerson(ctx);
    const cmp = await campaign(ctx, { stop: { on_meeting: false } });
    const row = await enroll(ctx, cmp.id, person, {
      status: "paused",
      stop_reason: "reply_pending_classification",
      paused_until: new Date(ctx.clock.now().getTime() + DAY),
    });
    expect(
      await stopEnrollmentsForPerson(ctx, { personId: person.id, reason: "meeting_booked" }),
    ).toBe(0);
    expect(await statusOf(ctx, row.id)).toMatchObject({ status: "active", stop_reason: null });
  });
});

describe("pause and resume for a person", () => {
  it("pauses, unschedules pending sends and resumes, leaving manual pauses alone", async () => {
    const ctx = await context();
    const person = await seedPerson(ctx);
    const cmp = await campaign(ctx);
    const cmp2 = await campaign(ctx);
    const row = await enroll(ctx, cmp.id, person);
    const manual = await enroll(ctx, cmp2.id, person, { status: "paused", stop_reason: "manual" });
    const scheduled = await seedMessage(ctx, {
      enrollment_id: row.id,
      campaign_id: cmp.id,
      person_id: person.id,
      status: "scheduled",
      scheduled_for: new Date(ctx.clock.now().getTime() + HOUR),
    });
    const until = new Date(ctx.clock.now().getTime() + 3 * DAY);

    expect(
      await pauseEnrollmentsForPerson(ctx, { personId: person.id, until, reason: "not_now" }),
    ).toBe(1);
    expect(await statusOf(ctx, row.id)).toMatchObject({
      status: "paused",
      stop_reason: "not_now",
      paused_until: until,
    });
    const [message] = await ctx.db.select().from(messages).where(eq(messages.id, scheduled.id));
    expect(message).toMatchObject({ status: "approved", scheduled_for: null });

    expect(await resumeEnrollmentsForPerson(ctx, { personId: person.id })).toBe(1);
    expect(await statusOf(ctx, row.id)).toMatchObject({ status: "active", stop_reason: null });
    expect(await statusOf(ctx, manual.id)).toMatchObject({
      status: "paused",
      stop_reason: "manual",
    });
  });
});

describe("reply handling", () => {
  it("pauses on a reply, then stops after 24h without classification", async () => {
    const ctx = await context();
    const person = await seedPerson(ctx);
    const cmp = await campaign(ctx);
    const row = await enroll(ctx, cmp.id, person);
    const thread = await seedThread(ctx, { person_id: person.id });
    const reply = await seedMessage(ctx, {
      person_id: person.id,
      thread_id: thread.id,
      direction: "inbound",
      status: "received",
      action: "reply",
    });
    await fire(ctx, pauseOnReply, {
      message_id: reply.id,
      thread_id: thread.id,
      person_id: person.id,
      campaign_id: cmp.id,
      channel: "email",
    });
    expect(await statusOf(ctx, row.id)).toMatchObject({
      status: "paused",
      stop_reason: "reply_pending_classification",
      paused_until: new Date(ctx.clock.now().getTime() + DAY),
    });

    ctx.clock.advanceBy({ hours: 23 });
    await runTick(ctx.jobContext());
    expect((await statusOf(ctx, row.id))?.status).toBe("paused");
    ctx.clock.advanceBy({ hours: 2 });
    await runTick(ctx.jobContext());
    expect(await statusOf(ctx, row.id)).toMatchObject({
      status: "stopped",
      stop_reason: "replied",
    });
  });

  it("resumes after 24h when the campaign does not stop on replies", async () => {
    const ctx = await context();
    const person = await seedPerson(ctx);
    const cmp = await campaign(ctx, { stop: { on_reply: false } });
    const row = await enroll(ctx, cmp.id, person, {
      status: "paused",
      stop_reason: "reply_pending_classification",
      paused_until: new Date(ctx.clock.now().getTime() - 1),
    });
    expect(await runTick(ctx.jobContext())).toMatchObject({ resumed: 1 });
    expect(await statusOf(ctx, row.id)).toMatchObject({ status: "active", stop_reason: null });
  });

  it("pauses until the day after an out-of-office return date", async () => {
    const ctx = await context();
    const person = await seedPerson(ctx);
    const cmp = await campaign(ctx);
    const row = await enroll(ctx, cmp.id, person);
    const thread = await seedThread(ctx, { person_id: person.id });
    const reply = await seedMessage(ctx, {
      person_id: person.id,
      thread_id: thread.id,
      direction: "inbound",
      status: "received",
      action: "reply",
      classification: {
        category: "out_of_office",
        confidence: 0.95,
        return_date: "2026-09-28",
      },
    });
    await fire(ctx, pauseOnReply, {
      message_id: reply.id,
      thread_id: thread.id,
      person_id: person.id,
      campaign_id: cmp.id,
      channel: "email",
    });
    expect(await statusOf(ctx, row.id)).toMatchObject({
      status: "paused",
      stop_reason: "out_of_office",
      paused_until: new Date("2026-09-29T00:00:00Z"),
    });
    ctx.clock.set("2026-09-29T01:00:00Z");
    await runTick(ctx.jobContext());
    expect(await statusOf(ctx, row.id)).toMatchObject({ status: "active" });
  });
});

describe("bounces and unsubscribes", () => {
  it("stops the enrollment of a hard-bounced message and ignores soft bounces", async () => {
    const ctx = await context();
    const person = await seedPerson(ctx);
    const cmp = await campaign(ctx);
    const row = await enroll(ctx, cmp.id, person);
    const sent = await seedMessage(ctx, {
      enrollment_id: row.id,
      campaign_id: cmp.id,
      person_id: person.id,
      status: "bounced",
    });
    const bounce = (type: "hard" | "soft") =>
      fire(ctx, stopOnBounce, {
        message_id: sent.id,
        person_id: person.id,
        email: person.email ?? "",
        bounce_type: type,
        reason: "mailbox unavailable",
      });
    await bounce("soft");
    expect((await statusOf(ctx, row.id))?.status).toBe("active");
    await bounce("hard");
    expect(await statusOf(ctx, row.id)).toMatchObject({
      status: "stopped",
      stop_reason: "bounced",
    });
  });

  it("stops every enrollment of someone who unsubscribed, found by email", async () => {
    const ctx = await context();
    const person = await seedPerson(ctx);
    const a = await enroll(ctx, (await campaign(ctx)).id, person);
    const b = await enroll(ctx, (await campaign(ctx)).id, person, { status: "queued" });
    await fire(ctx, stopOnUnsubscribe, {
      person_id: null,
      email: (person.email ?? "").toUpperCase(),
      source: "link",
      message_id: null,
    });
    expect((await statusOf(ctx, a.id))?.stop_reason).toBe("unsubscribed");
    expect((await statusOf(ctx, b.id))?.stop_reason).toBe("unsubscribed");
  });
});

describe("enrollment", () => {
  it("checks compliance per person and reports reasons (dry run writes nothing)", async () => {
    const ctx = await createTestContext({
      db,
      settings: { compliance: { contact_cap_per_company: 1, rest_days_after_campaign: 30 } },
    });
    contexts.push(ctx);
    const { campaign: target } = await seedCampaign(ctx, {
      status: "draft",
      settings: { missing_data: "skip_lead" },
      steps: [{ type: "email", config: { style: "exact", subject: "hi", body: "Hi, a look?" } }],
    });
    const other = await campaign(ctx);
    const full = await seedCompany(ctx);
    const ok = await seedPerson(ctx);
    const noEmail = await seedPerson(ctx, { email: null });
    const busy = await seedPerson(ctx);
    const resting = await seedPerson(ctx);
    const capped = await seedPerson(ctx, { company_id: full.id });
    const colleague = await seedPerson(ctx, { company_id: full.id });
    const blocked = await seedPerson(ctx);
    const already = await seedPerson(ctx);
    await enroll(ctx, other.id, busy);
    await enroll(ctx, other.id, colleague);
    await enroll(ctx, other.id, resting, {
      status: "completed",
      completed_at: new Date(ctx.clock.now().getTime() - 5 * DAY),
    });
    await enroll(ctx, target.id, already, { status: "queued" });
    vi.mocked(checkContactable).mockImplementation(async (_ctx, input) =>
      input.personId === blocked.id
        ? { ok: false, reasons: ["suppressed_email"] }
        : { ok: true, reasons: [] },
    );
    const ids = [ok, noEmail, busy, resting, capped, blocked, already].map((p) => p.id);

    const preview = await enrollPeople(ctx, {
      campaignId: target.id,
      personIds: [...ids, "pe_01k6a3v0q8x3m2n4p5r6s7t8zz"],
      dryRun: true,
    });
    expect(preview).toMatchObject({
      requested: 8,
      enrolled: 1,
      skipped: 7,
      dry_run: true,
      enrollment_ids: [],
      by_reason: {
        "missing_data:email": 1,
        active_in_other_campaign: 1,
        rest_period: 1,
        company_cap_reached: 1,
        "not_contactable:suppressed_email": 1,
        already_enrolled: 1,
        not_found: 1,
      },
    });
    const before = await ctx.db
      .select()
      .from(enrollments)
      .where(eq(enrollments.campaign_id, target.id));
    expect(before).toHaveLength(1);

    const result = await enrollPeople(ctx, { campaignId: target.id, personIds: ids });
    expect(result).toMatchObject({ enrolled: 1, skipped: 6 });
    const [row] = await ctx.db
      .select()
      .from(enrollments)
      .where(and(eq(enrollments.campaign_id, target.id), eq(enrollments.person_id, ok.id)));
    expect(row).toMatchObject({ status: "queued", current_step: 0 });
    expect(row?.variant_seed).toBeTypeOf("number");
  });

  it("enrolls people an automation asked for", async () => {
    const ctx = await context();
    const cmp = await campaign(ctx);
    const person = await seedPerson(ctx);
    const job = ctx.jobContext();
    expect(
      await handleEnrollRequest(job, {
        campaign_id: cmp.id,
        person_id: person.id,
        rule_id: "rul_01k6a3v0q8x3m2n4p5r6s7t8v9",
      }),
    ).toBe(1);
    const [row] = await ctx.db
      .select()
      .from(enrollments)
      .where(eq(enrollments.person_id, person.id));
    expect(row?.enrolled_by).toMatchObject({
      type: "system",
      id: "automation:rul_01k6a3v0q8x3m2n4p5r6s7t8v9",
    });
  });

  it("refuses archived campaigns", async () => {
    const ctx = await context();
    const { campaign: archived } = await seedCampaign(ctx, { status: "archived" });
    await expect(
      enrollPeople(ctx, { campaignId: archived.id, personIds: [(await seedPerson(ctx)).id] }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("approval resolvers", () => {
  it("enrolls people from an enrollment approval and does nothing on reject", async () => {
    const ctx = await context();
    const cmp = await campaign(ctx);
    const person = await seedPerson(ctx);
    const { id } = await ctx.approvals.request({
      kind: "enrollment",
      title: "Enroll a referral",
      summary: "Referred by a prospect",
      payload: { campaign_id: cmp.id, person_ids: [person.id], source: "referral" },
    });
    const [row] = await ctx.db.select().from(approvals).where(eq(approvals.id, id));
    if (!row) throw new Error("approval missing");
    const decidedBy = { type: "human" as const, id: "usr_test", name: "Test User" };
    expect(
      await enrollmentResolver.apply(ctx, row, { decision: "reject", decidedBy }),
    ).toMatchObject({ message: "Nobody was enrolled." });
    expect(
      await enrollmentResolver.apply(ctx, row, { decision: "approve", decidedBy }),
    ).toMatchObject({ data: { enrolled: 1, skipped: 0 } });
  });

  it("leaves the campaign alone when a launch is rejected", async () => {
    const ctx = await context();
    const { campaign: draft } = await seedCampaign(ctx, { status: "draft" });
    const { id } = await ctx.approvals.request({
      kind: "campaign_launch",
      title: "Launch",
      summary: "Launch it",
      payload: { campaign_id: draft.id },
      target: { type: "campaign", id: draft.id },
    });
    const [row] = await ctx.db.select().from(approvals).where(eq(approvals.id, id));
    if (!row) throw new Error("approval missing");
    const result = await campaignLaunchResolver.apply(ctx, row, {
      decision: "reject",
      decidedBy: { type: "human", id: "usr_test", name: "Test User" },
    });
    expect(result.message).toContain("rejected");
    const [after] = await ctx.db.select().from(campaigns).where(eq(campaigns.id, draft.id));
    expect(after?.status).toBe("draft");
  });
});

describe("stats", () => {
  it("counts sends, replies, positive replies, meetings and bounces per step and variant", async () => {
    const ctx = await context();
    const { campaign: cmp, steps } = await seedCampaign(ctx, {
      status: "active",
      steps: [{ type: "email" }, { type: "email", delay_days: 3 }],
    });
    const [first, second] = steps;
    const people = [await seedPerson(ctx), await seedPerson(ctx), await seedPerson(ctx)];
    const t0 = ctx.clock.now().getTime();
    const threads = [];
    for (const [index, person] of people.entries()) {
      const row = await enroll(ctx, cmp.id, person, {
        status: index === 2 ? "stopped" : "active",
      });
      const thread = await seedThread(ctx, { person_id: person.id });
      threads.push(thread);
      await seedMessage(ctx, {
        enrollment_id: row.id,
        campaign_id: cmp.id,
        person_id: person.id,
        step_id: first?.id,
        variant: index === 0 ? "A" : "B",
        thread_id: thread.id,
        status: index === 2 ? "bounced" : "sent",
        sent_at: new Date(t0 - 5 * DAY),
      });
    }
    await seedMessage(ctx, {
      campaign_id: cmp.id,
      person_id: people[0]?.id,
      step_id: second?.id,
      thread_id: threads[0]?.id,
      status: "sent",
      sent_at: new Date(t0 - 2 * DAY),
    });
    await seedMessage(ctx, {
      person_id: people[0]?.id,
      thread_id: threads[0]?.id,
      campaign_id: cmp.id,
      direction: "inbound",
      action: "reply",
      status: "received",
      received_at: new Date(t0 - DAY),
      classification: { category: "interested", confidence: 0.9 },
    });
    await seedMessage(ctx, {
      person_id: people[1]?.id,
      thread_id: threads[1]?.id,
      campaign_id: cmp.id,
      direction: "inbound",
      action: "reply",
      status: "received",
      received_at: new Date(t0 - 3 * DAY),
      classification: { category: "not_now", confidence: 0.9 },
    });
    await ctx.db.insert(opportunities).values({
      workspace_id: ctx.workspace.id,
      person_id: people[0]?.id,
      campaign_id: cmp.id,
      stage: "meeting_booked",
    });

    const stats = await getCampaignStats(ctx, cmp.id);
    expect(stats).toMatchObject({
      enrolled: 3,
      active: 2,
      stopped: 1,
      sent: 4,
      replies: 2,
      positive_replies: 1,
      meetings: 1,
      bounces: 1,
    });
    const byStep = (stats.by_step ?? []).map((row) => ({
      position: row.position,
      variant: row.variant,
      sent: row.sent,
      replies: row.replies,
      positive: row.positive_replies,
      meetings: row.meetings,
      bounces: row.bounces,
    }));
    expect(byStep).toEqual([
      { position: 0, variant: "A", sent: 1, replies: 0, positive: 0, meetings: 0, bounces: 0 },
      { position: 0, variant: "B", sent: 2, replies: 1, positive: 0, meetings: 0, bounces: 1 },
      { position: 1, variant: null, sent: 1, replies: 1, positive: 1, meetings: 1, bounces: 0 },
    ]);

    await refreshStatsJob.handler(ctx.jobContext({ name: STATS_JOB }), { campaign_id: cmp.id });
    const rows = await ctx.db.select().from(enrollments).orderBy(asc(enrollments.created_at));
    expect(rows.length).toBeGreaterThan(0);
  });

  it("marks the signals a sent message used", async () => {
    const ctx = await context();
    const person = await seedPerson(ctx);
    const message = await seedMessage(ctx, {
      person_id: person.id,
      status: "sent",
      why: { signal_ids: ["sig_01k6a3v0q8x3m2n4p5r6s7t8v1"] },
    });
    await fire(ctx, advanceOnSent, {
      message_id: message.id,
      thread_id: null,
      person_id: person.id,
      campaign_id: null,
      channel: "email",
      action: "email",
      sent_at: ctx.clock.now().toISOString(),
    });
    expect(markSignalsUsed).toHaveBeenCalledWith(
      expect.anything(),
      ["sig_01k6a3v0q8x3m2n4p5r6s7t8v1"],
      { messageId: message.id },
    );
  });
});
