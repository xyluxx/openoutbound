/**
 * Delivery invariant for replies (docs/concepts/delivery-guarantees.md), scenario S7: a caller
 * that repeats `threads.send_reply` (an agent retrying after a timeout) gets one reply row, never
 * a second outbound message. Sending itself (S1 to S6, S8) is the email and LinkedIn send
 * paths' work, tested next to them.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpContext } from "../../core/context.js";
import { approvals, messages } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import {
  seedCompany,
  seedLinkedInAccount,
  seedMailbox,
  seedMessage,
  seedPerson,
  seedThread,
} from "../../testing/factories.js";
import { queueEmailSend } from "../email/service.js";
import { checkContactable } from "../leads/service.js";
import { queueLinkedInAction } from "../linkedin/service.js";
import type { CheckOutput } from "./prompts/check.js";
import type { DraftOutput } from "./prompts/draft.js";
import { findRepeatedReply, REUSED_REPLY_NOTE } from "./reply-dedupe.js";
import { sendThreadReply } from "./thread-operations.js";

vi.mock("./reply-dedupe.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./reply-dedupe.js")>();
  return { ...original, findRepeatedReply: vi.fn(original.findRepeatedReply) };
});

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
  planLinkedInAction: vi.fn(
    async (_ctx: unknown, input: { accountIds: string[]; notBefore: Date }) => ({
      ok: true,
      accountId: input.accountIds[0],
      runAt: input.notBefore,
    }),
  ),
  queueLinkedInAction: vi.fn(async () => {}),
}));

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});

/** Queues like the real email and LinkedIn queues do: an approved reply becomes scheduled. */
async function queued(ctx: OpContext, messageId: string): Promise<void> {
  await ctx.db
    .update(messages)
    .set({ status: "scheduled" })
    .where(and(eq(messages.id, messageId), eq(messages.status, "approved")));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(queueEmailSend).mockImplementation(queued);
  vi.mocked(queueLinkedInAction).mockImplementation(queued);
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
const TEXT = "Thanks Dana, Tuesday at 10 works. Talk soon.";

async function setup(channel: "email" | "linkedin") {
  const ctx = await createTestContext({ db: testDb, now: NOW });
  const now = ctx.clock.now().getTime();
  const company = await seedCompany(ctx, { name: "Harbor Dental" });
  const person = await seedPerson(ctx, { company_id: company.id, full_name: "Dana Reyes" });
  const mailbox = await seedMailbox(ctx);
  const account = await seedLinkedInAccount(ctx);
  const thread = await seedThread(ctx, {
    channel,
    person_id: person.id,
    company_id: company.id,
    mailbox_id: channel === "email" ? mailbox.id : null,
    linkedin_account_id: channel === "linkedin" ? account.id : null,
    subject: "Quick question",
    last_inbound_at: new Date(now - 5 * 60_000),
  });
  await seedMessage(ctx, {
    thread_id: thread.id,
    person_id: person.id,
    channel,
    direction: "inbound",
    status: "received",
    action: channel === "email" ? "reply" : "message",
    subject: channel === "email" ? "Re: Quick question" : null,
    body_text: "Sounds interesting, tell me more.",
    from_address: person.email,
    received_at: new Date(now - 5 * 60_000),
    created_at: new Date(now - 5 * 60_000),
    classification: { category: "interested", confidence: 0.9, source: "model" },
  });
  ctx.brain.on("inbox.reply.draft", DRAFT);
  ctx.brain.on("inbox.reply.check", PASS);
  return { ctx, thread };
}

// biome-ignore lint/suspicious/noExplicitAny: the operation returns one of several outputs
async function send(ctx: TestContext, input: Record<string, unknown>): Promise<any> {
  return sendThreadReply.handler(ctx, sendThreadReply.input.parse(input));
}

async function outboundReplies(ctx: TestContext, threadId: string) {
  return ctx.db
    .select()
    .from(messages)
    .where(and(eq(messages.thread_id, threadId), eq(messages.direction, "outbound")));
}

/**
 * Holds the next two contact checks until both calls reached theirs, then lets them go on
 * together: every `threads.send_reply` checks the person before it looks for the same reply,
 * so two calls held here overlap from that look to their draft.
 */
function holdBothAtTheContactCheck(): void {
  let arrived = 0;
  let release: () => void = () => {};
  const both = new Promise<void>((resolve) => {
    release = resolve;
  });
  for (let call = 0; call < 2; call++) {
    vi.mocked(checkContactable).mockImplementationOnce(async () => {
      arrived += 1;
      if (arrived === 2) release();
      await both;
      return { ok: true, reasons: [] };
    });
  }
}

/** The same reply asked for twice at the same moment (parallel tool calls, a double submit). */
async function askedTwiceAtOnce(ctx: TestContext, threadId: string) {
  holdBothAtTheContactCheck();
  return Promise.all([
    send(ctx, { thread_id: threadId, text: TEXT }),
    send(ctx, { thread_id: threadId, text: TEXT }),
  ]);
}

async function askedTwice(channel: "email" | "linkedin") {
  const s = await setup(channel);
  const first = await send(s.ctx, { thread_id: s.thread.id, text: TEXT });
  // The same request again, as a client retrying after a timeout would send it.
  const again = await send(s.ctx, {
    thread_id: s.thread.id,
    text: ` ${TEXT.replace(". ", ".\n")} `,
  });
  return { ...s, first, again };
}

describe("delivery invariant: replies (B2, B4)", () => {
  it("B2 S7 an email reply asked for twice is one reply", async () => {
    const s = await askedTwice("email");
    expect(s.first).toMatchObject({ status: "scheduled" });
    expect(s.again).toMatchObject({
      status: "scheduled",
      message_id: s.first.message_id,
      note: REUSED_REPLY_NOTE,
    });
    expect(new Date(s.again.send_at).getTime()).toBe(new Date(s.first.send_at).getTime());
    const rows = await outboundReplies(s.ctx, s.thread.id);
    expect(rows.map((row) => [row.id, row.status])).toEqual([[s.first.message_id, "scheduled"]]);
    expect(queueEmailSend).toHaveBeenCalledTimes(1);
  });

  it("B4 S7 a LinkedIn reply asked for twice is one reply", async () => {
    const s = await askedTwice("linkedin");
    expect(s.first).toMatchObject({ status: "scheduled" });
    expect(s.again).toMatchObject({
      status: "scheduled",
      message_id: s.first.message_id,
      note: REUSED_REPLY_NOTE,
    });
    const rows = await outboundReplies(s.ctx, s.thread.id);
    expect(rows.map((row) => [row.id, row.status])).toEqual([[s.first.message_id, "scheduled"]]);
    expect(queueLinkedInAction).toHaveBeenCalledTimes(1);
  });

  it("B2 S7 an agent's reply asked for twice is one draft with one approval", async () => {
    const s = await setup("email");
    const agent = s.ctx.with({ principal: { type: "agent", id: "key_agent", name: "Agent" } });
    const first = await send(agent, { thread_id: s.thread.id, text: TEXT });
    const again = await send(agent, { thread_id: s.thread.id, text: TEXT });
    expect(first).toMatchObject({ status: "awaiting_approval" });
    expect(again).toMatchObject({ status: "awaiting_approval", approval_id: first.approval_id });
    expect(again.summary).toContain(REUSED_REPLY_NOTE);
    expect(await outboundReplies(s.ctx, s.thread.id)).toHaveLength(1);
    const asked = await s.ctx.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.kind, "reply"), eq(approvals.status, "pending")));
    expect(asked.filter((row) => row.payload.thread_id === s.thread.id)).toHaveLength(1);
  });

  it("B2 S7 an email reply asked for twice at the same moment is one reply, queued once", async () => {
    const s = await setup("email");
    const [first, second] = await askedTwiceAtOnce(s.ctx, s.thread.id);
    expect(first).toMatchObject({ status: "scheduled" });
    expect(second).toMatchObject({ status: "scheduled", message_id: first.message_id });
    expect([first.note, second.note].filter(Boolean)).toEqual([REUSED_REPLY_NOTE]);
    const rows = await outboundReplies(s.ctx, s.thread.id);
    expect(rows.map((row) => [row.id, row.status])).toEqual([[first.message_id, "scheduled"]]);
    expect(queueEmailSend).toHaveBeenCalledTimes(1);
  });

  it("B2 S7 an agent's reply asked for twice at the same moment is one draft with one approval", async () => {
    const s = await setup("email");
    const agent = s.ctx.with({ principal: { type: "agent", id: "key_agent", name: "Agent" } });
    const [first, second] = await askedTwiceAtOnce(agent, s.thread.id);
    expect(first).toMatchObject({ status: "awaiting_approval" });
    expect(second).toMatchObject({ status: "awaiting_approval", approval_id: first.approval_id });
    const rows = await outboundReplies(s.ctx, s.thread.id);
    expect(rows.map((row) => row.status)).toEqual(["pending_review"]);
    const asked = await s.ctx.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.kind, "reply"), eq(approvals.status, "pending")));
    expect(asked.filter((row) => row.payload.thread_id === s.thread.id)).toHaveLength(1);
  });

  it("B2 S7 an agent asking again leaves a reply that is being sent alone", async () => {
    const s = await setup("email");
    // A person's draft of this text, not sent for review yet.
    const draft = await seedMessage(s.ctx, {
      thread_id: s.thread.id,
      action: "reply",
      status: "draft",
      subject: "Re: Quick question",
      body_text: TEXT,
    });
    const { findRepeatedReply: lookUp } =
      await vi.importActual<typeof import("./reply-dedupe.js")>("./reply-dedupe.js");
    vi.mocked(findRepeatedReply).mockImplementationOnce(async (ctx, threadId, text) => {
      const found = await lookUp(ctx, threadId, text);
      // Right after the agent's call read it, the person's direct send queued it and the email
      // job claimed it.
      await ctx.db
        .update(messages)
        .set({ status: "sending", attempt: 1 })
        .where(eq(messages.id, draft.id));
      return found;
    });
    const agent = s.ctx.with({ principal: { type: "agent", id: "key_agent", name: "Agent" } });
    const again = await send(agent, { thread_id: s.thread.id, text: TEXT });
    expect(again).toMatchObject({
      status: "sending",
      message_id: draft.id,
      note: REUSED_REPLY_NOTE,
    });
    const rows = await outboundReplies(s.ctx, s.thread.id);
    expect(rows.map((row) => [row.id, row.status, row.attempt])).toEqual([
      [draft.id, "sending", 1],
    ]);
    const asked = await s.ctx.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.target_id, draft.id), eq(approvals.status, "pending")));
    expect(asked).toHaveLength(0);
  });

  it("B4 S7 a LinkedIn reply asked for twice at the same moment is one reply, queued once", async () => {
    const s = await setup("linkedin");
    const [first, second] = await askedTwiceAtOnce(s.ctx, s.thread.id);
    expect(first).toMatchObject({ status: "scheduled" });
    expect(second).toMatchObject({ status: "scheduled", message_id: first.message_id });
    const rows = await outboundReplies(s.ctx, s.thread.id);
    expect(rows.map((row) => [row.id, row.status])).toEqual([[first.message_id, "scheduled"]]);
    expect(queueLinkedInAction).toHaveBeenCalledTimes(1);
  });
});
