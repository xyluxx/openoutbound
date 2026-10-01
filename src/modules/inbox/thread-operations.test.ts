import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { JobWaitError, OpenOutboundError } from "../../core/errors.js";
import type { AnyOperation } from "../../core/operation.js";
import { approvals, messages, opportunities, tasks } from "../../db/schema/index.js";
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
import { queueEmailSend } from "../email/service.js";
import { checkContactable } from "../leads/service.js";
import { CLASSIFY_JOB } from "./classify.js";
import { DRAFT_REPLY_JOB } from "./draft.js";
import type { CheckOutput } from "./prompts/check.js";
import type { DraftOutput } from "./prompts/draft.js";
import {
  classifyThread,
  draftThreadReply,
  getThread,
  listThreads,
  sendThreadReply,
  updateThread,
} from "./thread-operations.js";

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

const NOW = "2026-09-22T15:00:00.000Z";
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

async function setup(minutesAgo = 5) {
  const ctx = await createTestContext({ db: testDb, now: NOW });
  const now = ctx.clock.now().getTime();
  const company = await seedCompany(ctx, { name: "Harbor Dental" });
  const person = await seedPerson(ctx, {
    company_id: company.id,
    full_name: "Dana Reyes",
    email: `dana.${Math.round(Math.random() * 1e9)}@harbor-dental.example.com`,
  });
  const mailbox = await seedMailbox(ctx);
  const { campaign } = await seedCampaign(ctx, { status: "active" });
  const at = new Date(now - minutesAgo * 60_000);
  const thread = await seedThread(ctx, {
    person_id: person.id,
    company_id: company.id,
    campaign_id: campaign.id,
    mailbox_id: mailbox.id,
    subject: "Quick question",
    needs_attention: true,
    category: "interested",
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
    body_text:
      "Sounds interesting, tell me more.\n\nOn Mon, Sep 21, Sam wrote:\n> Hi Dana, we help",
    from_address: person.email,
    received_at: at,
    created_at: at,
    classification: { category: "interested", confidence: 0.9, source: "model" },
  });
  ctx.brain.on("inbox.reply.draft", DRAFT);
  ctx.brain.on("inbox.reply.check", PASS);
  return { ctx, company, person, mailbox, campaign, thread, inbound };
}

describe("threads.list", () => {
  it("returns summaries with an untrusted, unquoted snippet and paginates", async () => {
    const first = await setup(10);
    const ctx = first.ctx;
    const page = await run(listThreads, ctx, { needs_attention: true, limit: 1 });
    expect(page.items).toHaveLength(1);
    const summary = page.items[0];
    expect(summary).toMatchObject({
      needs_attention: true,
      person: { full_name: "Dana Reyes" },
      company: { name: "Harbor Dental" },
      latest_reply: {
        snippet: { text: "Sounds interesting, tell me more.", untrusted: true },
        suspicious: false,
      },
    });

    // A second thread in the same workspace, newer: first page shows it, second the older one.
    const newer = await seedThread(ctx, {
      person_id: first.person.id,
      subject: "Another",
      last_message_at: ctx.clock.now(),
      needs_attention: true,
    });
    const one = await run(listThreads, ctx, { needs_attention: true, limit: 1 });
    expect(one.items[0].id).toBe(newer.id);
    expect(one.has_more).toBe(true);
    const two = await run(listThreads, ctx, {
      needs_attention: true,
      limit: 1,
      cursor: one.next_cursor,
    });
    expect(two.items[0].id).toBe(first.thread.id);

    const filtered = await run(listThreads, ctx, { category: ["interested"] });
    expect(filtered.items.map((row: { id: string }) => row.id)).toEqual([first.thread.id]);
  });
});

describe("threads.get", () => {
  it("returns messages oldest first with untrusted inbound bodies, the opportunity, tasks and pending draft", async () => {
    const s = await setup();
    await s.ctx.db.insert(opportunities).values({
      workspace_id: s.ctx.workspace.id,
      person_id: s.person.id,
      stage: "interested",
    });
    await s.ctx.db.insert(tasks).values({
      workspace_id: s.ctx.workspace.id,
      person_id: s.person.id,
      title: "Call Dana",
      type: "call",
    });
    const drafted = await run(draftThreadReply, s.ctx, { thread_id: s.thread.id });

    const result = await run(getThread, s.ctx, { thread_id: s.thread.id });
    expect(result.messages.map((m: { direction: string }) => m.direction)).toEqual([
      "outbound",
      "inbound",
      "outbound",
    ]);
    expect(result.messages[1].body).toMatchObject({ untrusted: true });
    expect(result.messages[1].classification).toMatchObject({ category: "interested" });
    expect(result.messages[0].body).toMatchObject({ untrusted: false });
    expect(result.opportunity).toMatchObject({ stage: "interested" });
    expect(result.open_tasks).toHaveLength(1);
    expect(result.pending_reply).toMatchObject({
      message_id: drafted.message_id,
      approval_id: drafted.approval_id,
      status: "pending_review",
    });
    expect(result.note).toContain("untrusted");
  });
});

describe("threads.update and threads.classify", () => {
  it("clears the attention flag and queues a reclassification for a category correction", async () => {
    const s = await setup();
    const result = await run(updateThread, s.ctx, {
      thread_id: s.thread.id,
      needs_attention: false,
      status: "closed",
      category: "not_now",
    });
    expect(result).toMatchObject({ needs_attention: false, status: "closed" });
    expect(result.reclassify_job_id).toBeTruthy();
    expect(s.ctx.enqueued(CLASSIFY_JOB)[0]?.payload).toEqual({
      message_id: s.inbound.id,
      override_category: "not_now",
    });
  });

  it("refuses to reclassify threads without a reply", async () => {
    const ctx = await createTestContext({ db: testDb, now: NOW });
    const thread = await seedThread(ctx);
    const error = await run(updateThread, ctx, {
      thread_id: thread.id,
      category: "interested",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenOutboundError);
    expect((error as OpenOutboundError).code).toBe("validation_failed");
  });

  it("classifies the latest reply again as a singleton job", async () => {
    const s = await setup();
    const handle = await run(classifyThread, s.ctx, { thread_id: s.thread.id });
    const again = await run(classifyThread, s.ctx, { thread_id: s.thread.id });
    expect(again.job_id).toBe(handle.job_id);
    expect(s.ctx.enqueued(CLASSIFY_JOB)).toHaveLength(1);
    expect(s.ctx.enqueued(CLASSIFY_JOB)[0]?.payload).toEqual({
      message_id: s.inbound.id,
      force: true,
    });
    const outbound = await seedMessage(s.ctx, { thread_id: s.thread.id });
    await expect(
      run(classifyThread, s.ctx, { thread_id: s.thread.id, message_id: outbound.id }),
    ).rejects.toThrow(/not an inbound message/);
  });
});

describe("threads.draft_reply", () => {
  it("drafts for review with an approval", async () => {
    const s = await setup();
    const result = await run(draftThreadReply, s.ctx, {
      thread_id: s.thread.id,
      instruction: "Offer Tuesday",
    });
    expect(result).toMatchObject({
      status: "pending_review",
      body: DRAFT.body,
      subject: "Re: Quick question",
    });
    expect(result.approval_id).toBeTruthy();
    expect(result.next_step).toContain(result.approval_id);
    expect(
      s.ctx.recorded.brain.find((call) => call.promptId === "inbox.reply.draft")?.user,
    ).toContain("Offer Tuesday");
  });

  it("falls back to a background job when the brain must wait for an agent", async () => {
    const s = await setup();
    s.ctx.brain.on("inbox.reply.draft", () => {
      throw new JobWaitError("agent_brain");
    });
    const result = await run(draftThreadReply, s.ctx, {
      thread_id: s.thread.id,
      instruction: "Be brief",
    });
    expect(result.job_id).toBeTruthy();
    expect(s.ctx.enqueued(DRAFT_REPLY_JOB)[0]?.payload).toEqual({
      message_id: s.inbound.id,
      manual: true,
      instruction: "Be brief",
    });
  });
});

describe("threads.send_reply", () => {
  it("lets a human send text directly after the human-like delay", async () => {
    const s = await setup();
    const result = await run(sendThreadReply, s.ctx, {
      thread_id: s.thread.id,
      text: "Thanks Dana, Tuesday at 10 works. Talk soon.",
    });
    expect(result.status).toBe("scheduled");
    expect(new Date(result.send_at).getTime()).toBeGreaterThan(s.ctx.clock.now().getTime());
    // Queued inside the call's transaction: the context is the transaction's.
    expect(vi.mocked(queueEmailSend).mock.calls.map((call) => call[1])).toEqual([
      result.message_id,
    ]);
    const [row] = await s.ctx.db.select().from(messages).where(eq(messages.id, result.message_id));
    expect(row).toMatchObject({
      status: "approved",
      subject: "Re: Quick question",
      to_address: s.person.email,
      in_reply_to: s.inbound.message_id_header,
    });
    expect(s.ctx.recorded.approvals).toHaveLength(0);
  });

  it("sends a reviewed draft and cancels its pending approval", async () => {
    const s = await setup();
    const drafted = await run(draftThreadReply, s.ctx, { thread_id: s.thread.id });
    const result = await run(sendThreadReply, s.ctx, {
      thread_id: s.thread.id,
      message_id: drafted.message_id,
      text: "Edited: thanks Dana, Tuesday works.",
    });
    expect(result).toMatchObject({ status: "scheduled", message_id: drafted.message_id });
    const [approval] = await s.ctx.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, drafted.approval_id));
    expect(approval?.status).toBe("cancelled");
    const [row] = await s.ctx.db.select().from(messages).where(eq(messages.id, drafted.message_id));
    expect(row?.body_text).toBe("Edited: thanks Dana, Tuesday works.");
  });

  it("turns an agent's send into an approval, reusing a pending one", async () => {
    const s = await setup();
    const agent = s.ctx.with({ principal: { type: "agent", id: "key_agent", name: "Agent" } });
    const first = await run(sendThreadReply, agent, {
      thread_id: s.thread.id,
      text: "Thanks Dana, Tuesday works.",
    });
    expect(first).toMatchObject({ status: "awaiting_approval" });
    expect(queueEmailSend).not.toHaveBeenCalled();
    const [row] = await s.ctx.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, first.approval_id));
    expect(row).toMatchObject({ kind: "reply", status: "pending" });

    const again = await run(sendThreadReply, agent, {
      thread_id: s.thread.id,
      message_id: row?.target_id,
    });
    expect(again.approval_id).toBe(first.approval_id);
  });

  it("gives an agent's edited draft a new approval showing the new text", async () => {
    const s = await setup();
    const drafted = await run(draftThreadReply, s.ctx, { thread_id: s.thread.id });
    const agent = s.ctx.with({ principal: { type: "agent", id: "key_agent", name: "Agent" } });
    const edited = await run(sendThreadReply, agent, {
      thread_id: s.thread.id,
      message_id: drafted.message_id,
      text: "Thanks Dana, Tuesday at 3 works for us.",
    });
    expect(edited).toMatchObject({ status: "awaiting_approval" });
    expect(edited.approval_id).not.toBe(drafted.approval_id);
    const rows = await s.ctx.db
      .select()
      .from(approvals)
      .where(eq(approvals.target_id, drafted.message_id));
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    // The approval asked for the old text can no longer send the new one.
    expect(byId[drafted.approval_id]?.status).toBe("cancelled");
    expect(byId[edited.approval_id]).toMatchObject({ status: "pending", kind: "reply" });
    expect(byId[edited.approval_id]?.payload).toMatchObject({
      body: "Thanks Dana, Tuesday at 3 works for us.",
    });
    const [row] = await s.ctx.db.select().from(messages).where(eq(messages.id, drafted.message_id));
    expect(row).toMatchObject({
      status: "pending_review",
      body_text: "Thanks Dana, Tuesday at 3 works for us.",
    });
    expect(row?.why).toMatchObject({ notes: "edited by Agent" });

    // Sending it again unchanged keeps the new approval.
    const again = await run(sendThreadReply, agent, {
      thread_id: s.thread.id,
      message_id: drafted.message_id,
      text: "Thanks Dana, Tuesday at 3 works for us.",
    });
    expect(again.approval_id).toBe(edited.approval_id);
  });

  it("previews without writing on a dry run", async () => {
    const s = await setup();
    const preview = s.ctx.with({ request: { dryRun: true } });
    const result = await run(sendThreadReply, preview, {
      thread_id: s.thread.id,
      text: "Hi {{first_name}}, Tuesday works.",
    });
    expect(result).toMatchObject({
      dry_run: true,
      preview: { to: s.person.email, subject: "Re: Quick question", requires_approval: false },
    });
    expect(result.warnings.join(" ")).toMatch(/placeholder|template/i);
    const rows = await s.ctx.db.select().from(messages).where(eq(messages.thread_id, s.thread.id));
    expect(rows).toHaveLength(2);
  });

  it("refuses suppressed contacts and drafts that were already sent", async () => {
    const s = await setup();
    vi.mocked(checkContactable).mockResolvedValueOnce({ ok: false, reasons: ["suppressed:email"] });
    const blocked = await run(sendThreadReply, s.ctx, {
      thread_id: s.thread.id,
      text: "Hello again",
    }).catch((e: unknown) => e);
    expect((blocked as OpenOutboundError).code).toBe("suppressed");

    const sent = await seedMessage(s.ctx, { thread_id: s.thread.id, status: "sent" });
    const conflict = await run(sendThreadReply, s.ctx, {
      thread_id: s.thread.id,
      message_id: sent.id,
    }).catch((e: unknown) => e);
    expect((conflict as OpenOutboundError).code).toBe("conflict");
    await expect(run(sendThreadReply, s.ctx, { thread_id: s.thread.id })).rejects.toThrow(
      /Nothing to send/,
    );
  });

  it("makes a new reply for other text, a day later, or after the first was cancelled", async () => {
    const s = await setup();
    const text = "Thanks Dana, Tuesday at 10 works. Talk soon.";
    const first = await run(sendThreadReply, s.ctx, { thread_id: s.thread.id, text });
    expect(first.note).toBeUndefined();

    const other = await run(sendThreadReply, s.ctx, {
      thread_id: s.thread.id,
      text: "Thanks Dana, Wednesday at 10 works too.",
    });
    expect(other.message_id).not.toBe(first.message_id);
    expect(other.note).toBeUndefined();

    // Asked a day ago: a new request now.
    await s.ctx.db
      .update(messages)
      .set({ created_at: new Date(s.ctx.clock.now().getTime() - 25 * 3_600_000) })
      .where(eq(messages.id, first.message_id));
    const later = await run(sendThreadReply, s.ctx, { thread_id: s.thread.id, text });
    expect(later.message_id).not.toBe(first.message_id);

    // Cancelled replies did not go out: the same text asked again is a new reply.
    await s.ctx.db
      .update(messages)
      .set({ status: "cancelled" })
      .where(eq(messages.id, later.message_id));
    const afterCancel = await run(sendThreadReply, s.ctx, { thread_id: s.thread.id, text });
    expect(afterCancel.message_id).not.toBe(later.message_id);
    expect(afterCancel.note).toBeUndefined();
  });

  it("returns a reused reply that already went out as it is, without queueing it again", async () => {
    const s = await setup();
    const text = "Thanks Dana, Tuesday at 10 works. Talk soon.";
    const first = await run(sendThreadReply, s.ctx, { thread_id: s.thread.id, text });
    const sentAt = new Date(s.ctx.clock.now().getTime() + 120_000);
    await s.ctx.db
      .update(messages)
      .set({ status: "sent", sent_at: sentAt })
      .where(eq(messages.id, first.message_id));
    vi.mocked(queueEmailSend).mockClear();
    const again = await run(sendThreadReply, s.ctx, { thread_id: s.thread.id, text });
    expect(again).toMatchObject({ status: "sent", message_id: first.message_id, send_at: sentAt });
    expect(again.note).toMatch(/already asked for/);
    expect(queueEmailSend).not.toHaveBeenCalled();
  });
});
