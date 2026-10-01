import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyOperation } from "../../core/operation.js";
import { approvals, messages, threads } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import {
  seedCampaign,
  seedCompany,
  seedMailbox,
  seedMessage,
  seedPerson,
  seedThread,
} from "../../testing/factories.js";
import { stopEnrollmentsForPerson } from "../campaigns/service.js";
import { queueEmailSend } from "../email/service.js";
import { draftReply } from "./draft.js";
import { draftReplyJob } from "./jobs.js";
import type { CheckOutput } from "./prompts/check.js";
import type { DraftOutput } from "./prompts/draft.js";
import { scheduleReplySend } from "./send.js";
import { markAutoReply } from "./stale-replies.js";
import { isThreadOwnedByPerson, releaseThread, takeOverThread } from "./takeover.js";
import { releaseThreadOp, takeOverThreadOp } from "./takeover-operations.js";
import { getThread, listThreads, sendThreadReply } from "./thread-operations.js";

vi.mock("../campaigns/service.js", () => ({
  stopEnrollmentsForPerson: vi.fn(async () => 1),
  pauseEnrollmentsForPerson: vi.fn(async () => 1),
  resumeEnrollmentsForPerson: vi.fn(async () => 1),
}));
vi.mock("../leads/service.js", () => ({
  addSuppression: vi.fn(async () => {}),
  setPersonStatus: vi.fn(async () => {}),
  checkContactable: vi.fn(async () => ({ ok: true, reasons: [] })),
  wrappedLeadContext: vi.fn(async () => null),
}));
vi.mock("../knowledge/service.js", () => ({
  searchKnowledge: vi.fn(async () => []),
  openKnowledgeGap: vi.fn(async () => ({ id: "gap_test" })),
  buildGroundingPack: vi.fn(async () => ({
    company: { name: "Helix Outbound", website: "https://helix.example.org" },
    offer: { id: "off_test", name: "Forecasting pilot", booking_url: null },
    rules: [],
    facts: [],
    voiceSamples: [],
    text: "Forecasting pilot for dental groups.",
  })),
}));
vi.mock("../../runtime/notify.js", () => ({ notify: vi.fn(async () => {}) }));
vi.mock("../email/service.js", () => ({
  planEmailSend: vi.fn(async (_ctx: unknown, input: { mailboxIds: string[]; notBefore: Date }) => ({
    ok: true,
    mailboxId: input.mailboxIds[0],
    sendAt: input.notBefore,
  })),
  queueEmailSend: vi.fn(async () => {}),
}));
vi.mock("../linkedin/service.js", () => ({
  planLinkedInAction: vi.fn(async () => ({ ok: false, reason: "no_active_account" })),
  queueLinkedInAction: vi.fn(async () => {}),
}));

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});
beforeEach(() => {
  vi.clearAllMocks();
});

const DRAFT: DraftOutput = {
  subject: null,
  body: "Hi Dana, happy to share how the pilot works. Does Tuesday suit you?",
  used_fact_ids: [],
  needs_human: false,
  needs_human_reason: null,
};
const PASS: CheckOutput = { verdict: "pass", confidence: 0.9, issues: [] };

// biome-ignore lint/suspicious/noExplicitAny: outputs differ per operation
type AnyOutput = any;

async function run(
  op: AnyOperation,
  ctx: TestContext,
  input: Record<string, unknown>,
): Promise<AnyOutput> {
  return op.handler(ctx, op.input.parse(input));
}

async function setup() {
  const ctx = await createTestContext({ db: testDb, now: "2026-09-22T15:00:00.000Z" });
  const now = ctx.clock.now().getTime();
  const company = await seedCompany(ctx);
  const person = await seedPerson(ctx, { company_id: company.id, full_name: "Dana Reyes" });
  const mailbox = await seedMailbox(ctx);
  const { campaign } = await seedCampaign(ctx, { status: "active" });
  const at = new Date(now - 5 * 60_000);
  const thread = await seedThread(ctx, {
    person_id: person.id,
    company_id: company.id,
    campaign_id: campaign.id,
    mailbox_id: mailbox.id,
    needs_attention: true,
    last_message_at: at,
    last_inbound_at: at,
  });
  await seedMessage(ctx, {
    thread_id: thread.id,
    person_id: person.id,
    status: "sent",
    body_text: "Hi Dana, we help dental groups forecast supplies.",
    sent_at: new Date(now - 86_400_000),
    created_at: new Date(now - 86_400_000),
  });
  const inbound = await seedMessage(ctx, {
    thread_id: thread.id,
    person_id: person.id,
    direction: "inbound",
    status: "received",
    action: "reply",
    subject: "Re: Quick question",
    body_text: "Sounds interesting, tell me more.",
    from_address: person.email,
    received_at: at,
    created_at: at,
    classification: { category: "interested", confidence: 0.95, source: "model" },
  });
  ctx.brain.on("inbox.reply.draft", DRAFT);
  ctx.brain.on("inbox.reply.check", PASS);
  return { ctx, person, mailbox, thread, inbound };
}

async function reload(ctx: TestContext, id: string) {
  const [row] = await ctx.db.select().from(messages).where(eq(messages.id, id));
  if (!row) throw new Error("message missing");
  return row;
}

describe("takeOverThread", () => {
  it("cancels unsent engine messages and their approvals, stops sequences, and says so", async () => {
    const s = await setup();
    const { ctx, thread } = s;
    const outbound = { thread_id: thread.id, person_id: s.person.id, mailbox_id: s.mailbox.id };
    const draft = await seedMessage(ctx, { ...outbound, action: "reply", status: "draft" });
    const review = await seedMessage(ctx, {
      ...outbound,
      action: "reply",
      status: "pending_review",
    });
    const approval = await ctx.approvals.request({
      kind: "reply",
      title: "Reply to Dana",
      summary: "Draft",
      payload: { message_id: review.id },
      target: { type: "message", id: review.id },
    });
    const scheduled = await seedMessage(ctx, {
      ...outbound,
      action: "reply",
      status: "scheduled",
      scheduled_for: ctx.clock.now(),
    });
    await markAutoReply(ctx, scheduled.id, s.inbound.id);
    const inFlight = await seedMessage(ctx, { ...outbound, status: "sending" });
    const external = await seedMessage(ctx, {
      ...outbound,
      status: "sent",
      origin: "external",
      sent_at: ctx.clock.now(),
    });

    const result = await takeOverThread(ctx, thread.id, { messageId: external.id });
    expect(result).toEqual({ changed: true, cancelled: 3 });
    for (const id of [draft.id, review.id, scheduled.id]) {
      expect(await reload(ctx, id)).toMatchObject({
        status: "cancelled",
        error: "superseded_by_person",
      });
    }
    // A send already under way is never touched, nor is anything already sent.
    expect((await reload(ctx, inFlight.id)).status).toBe("sending");
    expect((await reload(ctx, external.id)).status).toBe("sent");
    const [decided] = await ctx.db.select().from(approvals).where(eq(approvals.id, approval.id));
    expect(decided?.status).toBe("cancelled");
    expect(vi.mocked(stopEnrollmentsForPerson)).toHaveBeenCalledWith(expect.anything(), {
      personId: s.person.id,
      reason: "person_took_over",
    });
    const [row] = await ctx.db.select().from(threads).where(eq(threads.id, thread.id));
    expect(row).toMatchObject({ owner: "person" });
    expect(row?.owner_changed_at?.toISOString()).toBe(ctx.clock.now().toISOString());
    expect(ctx.emitted("thread.taken_over")).toEqual([
      expect.objectContaining({
        data: { thread_id: thread.id, person_id: s.person.id, message_id: external.id },
      }),
    ]);
    expect(await isThreadOwnedByPerson(ctx, thread.id)).toBe(true);

    // Each further message the person writes is announced; a bare repeat is not.
    expect(await takeOverThread(ctx, thread.id, { messageId: "msg_second" })).toEqual({
      changed: false,
      cancelled: 0,
    });
    expect(await takeOverThread(ctx, thread.id)).toEqual({ changed: false, cancelled: 0 });
    expect(ctx.emitted("thread.taken_over").map((event) => event.data.message_id)).toEqual([
      external.id,
      "msg_second",
    ]);
  });

  it("releases a thread back to the engine once", async () => {
    const { ctx, thread } = await setup();
    await takeOverThread(ctx, thread.id);
    expect(await releaseThread(ctx, thread.id)).toEqual({ changed: true });
    expect(await releaseThread(ctx, thread.id)).toEqual({ changed: false });
    expect(await isThreadOwnedByPerson(ctx, thread.id)).toBe(false);
    expect(ctx.emitted("thread.released")).toHaveLength(1);
    await expect(releaseThread(ctx, "thr_missing")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("a person-owned thread", () => {
  it("gets no AI draft or automatic reply, until it is released", async () => {
    const s = await setup();
    const { ctx, thread, inbound } = s;
    await takeOverThread(ctx, thread.id);

    const skipped = await draftReplyJob.handler(ctx.jobContext(), {
      message_id: inbound.id,
      auto_send: true,
    });
    expect(skipped).toEqual({ skipped: "thread_owned_by_person" });
    expect(ctx.recorded.brain).toHaveLength(0);

    // The person took over while a draft was being written: it is dropped, never sent.
    const late = await draftReply(ctx, {
      inboundMessageId: inbound.id,
      autoSend: true,
      automatic: true,
    });
    expect(late).toMatchObject({
      status: "cancelled",
      auto_sent: false,
      approval_id: null,
      blockers: ["thread_owned_by_person"],
    });
    expect(vi.mocked(queueEmailSend)).not.toHaveBeenCalled();
    const pending = await ctx.db
      .select()
      .from(approvals)
      .where(eq(approvals.workspace_id, ctx.workspace.id));
    expect(pending).toHaveLength(0);

    // An automatic answer waiting to be planned is cancelled as well.
    const waiting = await seedMessage(ctx, {
      thread_id: thread.id,
      person_id: s.person.id,
      mailbox_id: s.mailbox.id,
      action: "reply",
      status: "approved",
    });
    await markAutoReply(ctx, waiting.id, inbound.id);
    const blocked = await scheduleReplySend(ctx, waiting.id, { delay: true, respectWindow: true });
    expect(blocked).toMatchObject({ status: "blocked", reason: "thread_owned_by_person" });
    expect(await reload(ctx, waiting.id)).toMatchObject({
      status: "cancelled",
      error: "superseded_by_person",
    });

    await releaseThread(ctx, thread.id);
    const drafted = await draftReplyJob.handler(ctx.jobContext(), {
      message_id: inbound.id,
      auto_send: false,
    });
    expect(drafted).toMatchObject({ status: "pending_review" });
  });

  it("gets no follow-up draft the engine asked for itself, only one a person asked for", async () => {
    const s = await setup();
    await takeOverThread(s.ctx, s.thread.id);
    const skipped = await draftReplyJob.handler(s.ctx.jobContext(), {
      message_id: s.inbound.id,
      auto_send: false,
      manual: true,
      automatic: true,
      instruction: "They missed the meeting. Offer the booking link.",
    });
    expect(skipped).toEqual({ skipped: "thread_owned_by_person" });
    expect(s.ctx.recorded.brain).toHaveLength(0);

    const asked = await draftReplyJob.handler(s.ctx.jobContext(), {
      message_id: s.inbound.id,
      auto_send: false,
      manual: true,
    });
    expect(asked).toMatchObject({ status: "pending_review" });
  });

  it("still sends an explicit reply from a human", async () => {
    const s = await setup();
    await takeOverThread(s.ctx, s.thread.id);
    const sent = await run(sendThreadReply, s.ctx, {
      thread_id: s.thread.id,
      text: "Hi Dana, I will call you tomorrow at 10.",
    });
    expect(sent).toMatchObject({ status: "scheduled" });
    expect(vi.mocked(queueEmailSend)).toHaveBeenCalledWith(expect.anything(), sent.message_id);
  });
});

describe("threads.take_over and threads.release", () => {
  it("previews, takes over, lists by owner and hands back", async () => {
    const s = await setup();
    const { ctx, thread } = s;
    const draft = await seedMessage(ctx, {
      thread_id: thread.id,
      person_id: s.person.id,
      action: "reply",
      status: "draft",
    });

    const preview = await run(takeOverThreadOp, ctx.with({ request: { dryRun: true } }), {
      thread_id: thread.id,
    });
    expect(preview).toMatchObject({
      dry_run: true,
      preview: {
        thread_id: thread.id,
        owner: "engine",
        would_cancel: [{ id: draft.id, status: "draft", action: "reply" }],
      },
    });
    expect((await reload(ctx, draft.id)).status).toBe("draft");

    const taken = await run(takeOverThreadOp, ctx, { thread_id: thread.id });
    expect(taken).toMatchObject({ id: thread.id, owner: "person", changed: true, cancelled: 1 });
    expect(taken.owner_changed_at).toEqual(ctx.clock.now());

    const owned = await run(listThreads, ctx, { owner: "person" });
    expect(owned.items.map((item: { id: string }) => item.id)).toContain(thread.id);
    const engine = await run(listThreads, ctx, { owner: "engine" });
    expect(engine.items.map((item: { id: string }) => item.id)).not.toContain(thread.id);

    const released = await run(releaseThreadOp, ctx, { thread_id: thread.id });
    expect(released).toMatchObject({ owner: "engine", changed: true });
  });

  it("shows who wrote each message, with a person's own email marked untrusted", async () => {
    const s = await setup();
    await seedMessage(s.ctx, {
      thread_id: s.thread.id,
      person_id: s.person.id,
      status: "sent",
      origin: "external",
      body_text: "Happy to help, Dana.\n\n> Sounds interesting, tell me more.",
      sent_at: s.ctx.clock.now(),
    });
    const view = await run(getThread, s.ctx, { thread_id: s.thread.id });
    expect(view.thread.owner).toBe("engine");
    const last = view.messages.at(-1);
    expect(last).toMatchObject({ origin: "external", body: { untrusted: true } });
    expect(view.messages[0]).toMatchObject({ origin: "engine", body: { untrusted: false } });
  });
});
