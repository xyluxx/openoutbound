import { afterEach, describe, expect, it, vi } from "vitest";
import { linkedin_relations } from "../../db/schema/index.js";
import { ingestInboundEmail } from "../../modules/email/service.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import {
  seedLinkedInAccount,
  seedMailbox,
  seedMessage,
  seedPerson,
  seedThread,
} from "../../testing/factories.js";
import { decideEmailOutcome, decideLinkedInAccept, decideLinkedInMessageReply } from "./decide.js";
import { countPendingSimulations, fastForwardSandbox } from "./fast-forward.js";

vi.mock("../../modules/email/service.js", () => ({
  ingestInboundEmail: vi.fn(async () => ({
    messageId: "msg_ingested",
    threadId: null,
    kind: "reply" as const,
  })),
}));

const ingestMock = vi.mocked(ingestInboundEmail);

function findEmailReplyIds(prefix: string): { personId: string; messageId: string } {
  const personId = `${prefix}_pe`;
  for (let i = 0; i < 20_000; i++) {
    const messageId = `${prefix}_msg_${i}`;
    const outcome = decideEmailOutcome({ personId, messageId, emailStatus: "valid" });
    if (outcome.kind === "reply") return { personId, messageId };
  }
  throw new Error("no reply-bucket ids found");
}

function idWithAccept(prefix: string): string {
  for (let i = 0; i < 5000; i++) {
    const id = `${prefix}_${i}`;
    if (decideLinkedInAccept(id)) return id;
  }
  throw new Error("no accept-bucket id found");
}

function findLinkedInReplyIds(prefix: string): { personId: string; messageId: string } {
  const personId = `${prefix}_pe`;
  for (let i = 0; i < 5000; i++) {
    const messageId = `${prefix}_msg_${i}`;
    if (decideLinkedInMessageReply(personId, messageId)) return { personId, messageId };
  }
  throw new Error("no reply-bucket ids found");
}

/** Ids the simulator decides to leave unanswered (no reply, no acceptance). */
function findSilentEmailIds(prefix: string): { personId: string; messageId: string } {
  const personId = `${prefix}_pe`;
  for (let i = 0; i < 20_000; i++) {
    const messageId = `${prefix}_msg_${i}`;
    if (decideEmailOutcome({ personId, messageId, emailStatus: "valid" }).kind === "none") {
      return { personId, messageId };
    }
  }
  throw new Error("no silent ids found");
}

function idWithoutAccept(prefix: string): string {
  for (let i = 0; i < 5000; i++) {
    const id = `${prefix}_${i}`;
    if (!decideLinkedInAccept(id)) return id;
  }
  throw new Error("no silent accept id found");
}

function findSilentLinkedInIds(prefix: string): { personId: string; messageId: string } {
  const personId = `${prefix}_pe`;
  for (let i = 0; i < 5000; i++) {
    const messageId = `${prefix}_msg_${i}`;
    if (!decideLinkedInMessageReply(personId, messageId)) return { personId, messageId };
  }
  throw new Error("no silent LinkedIn ids found");
}

describe("fastForwardSandbox", () => {
  let ctx: TestContext;
  afterEach(async () => {
    ingestMock.mockClear();
    await ctx?.close();
  });

  it("reports pending counts, delivers everything pending, then reports zero", async () => {
    ctx = await createTestContext({ sandbox: true });

    // A first-touch email that lands in the reply bucket.
    const emailIds = findEmailReplyIds("ff_email");
    const thread = await seedThread(ctx);
    const mailbox = await seedMailbox(ctx);
    const emailPerson = await seedPerson(ctx, { id: emailIds.personId, email_status: "valid" });
    await seedMessage(ctx, {
      id: emailIds.messageId,
      thread_id: thread.id,
      mailbox_id: mailbox.id,
      person_id: emailPerson.id,
      status: "sent",
    });

    // A pending LinkedIn invite in the accept bucket.
    const account = await seedLinkedInAccount(ctx);
    const acceptPersonId = idWithAccept("ff_accept");
    const acceptPerson = await seedPerson(ctx, { id: acceptPersonId });
    await ctx.db.insert(linkedin_relations).values({
      workspace_id: ctx.workspace.id,
      account_id: account.id,
      person_id: acceptPerson.id,
      status: "invited",
      invited_at: ctx.clock.now(),
    });

    // A LinkedIn message in the reply bucket.
    const liIds = findLinkedInReplyIds("ff_li_msg");
    const liThread = await seedThread(ctx, { channel: "linkedin" });
    const liPerson = await seedPerson(ctx, { id: liIds.personId });
    await seedMessage(ctx, {
      id: liIds.messageId,
      channel: "linkedin",
      action: "message",
      thread_id: liThread.id,
      person_id: liPerson.id,
      status: "sent",
    });

    const before = await countPendingSimulations(ctx, ctx.workspace.id);
    expect(before).toEqual({
      email_replies: 1,
      linkedin_accepts: 1,
      linkedin_replies: 1,
      meeting_bookings: 0,
      meeting_no_shows: 0,
    });

    const result = await fastForwardSandbox(ctx, ctx.workspace.id);
    expect(result.email_replies).toBe(1);
    expect(result.linkedin_accepts).toBe(1);
    expect(result.linkedin_replies).toBe(1);
    expect(result.delivered).toEqual({
      email_replies: 1,
      linkedin_accepts: 1,
      linkedin_replies: 1,
      meeting_bookings: 0,
      meeting_no_shows: 0,
    });
    expect(ingestMock).toHaveBeenCalledTimes(1);
    expect(ctx.emitted("linkedin.connected")).toHaveLength(1);
    expect(ctx.emitted("reply.received")).toHaveLength(1);

    // The LinkedIn sides write their own rows, so their pending counts really drop to zero.
    // The email side's "already answered" check looks for an inbound message in the thread,
    // which only the real (not-yet-built) ingestInboundEmail writes; the mock used here returns
    // a result without inserting one, so email_replies still shows pending. Email idempotency
    // itself (a thread that already has an inbound message is left alone) is covered directly in
    // email-reply.test.ts by inserting that row and calling processEmailMessage again.
    const after = await countPendingSimulations(ctx, ctx.workspace.id);
    expect(after).toEqual({
      email_replies: 1,
      linkedin_accepts: 0,
      linkedin_replies: 0,
      meeting_bookings: 0,
      meeting_no_shows: 0,
    });
  });

  it("counts only what will arrive, so the pending count matches what it delivers", async () => {
    ctx = await createTestContext({ sandbox: true });
    const mailbox = await seedMailbox(ctx);
    const account = await seedLinkedInAccount(ctx);
    for (const ids of [findEmailReplyIds("pc_reply"), findSilentEmailIds("pc_silent")]) {
      const thread = await seedThread(ctx);
      const person = await seedPerson(ctx, { id: ids.personId, email_status: "valid" });
      await seedMessage(ctx, {
        id: ids.messageId,
        thread_id: thread.id,
        mailbox_id: mailbox.id,
        person_id: person.id,
        status: "sent",
      });
    }
    for (const personId of [idWithAccept("pc_accept"), idWithoutAccept("pc_ignore")]) {
      const person = await seedPerson(ctx, { id: personId });
      await ctx.db.insert(linkedin_relations).values({
        workspace_id: ctx.workspace.id,
        account_id: account.id,
        person_id: person.id,
        status: "invited",
        invited_at: ctx.clock.now(),
      });
    }
    for (const ids of [findLinkedInReplyIds("pc_li"), findSilentLinkedInIds("pc_li_silent")]) {
      const thread = await seedThread(ctx, { channel: "linkedin" });
      const person = await seedPerson(ctx, { id: ids.personId });
      await seedMessage(ctx, {
        id: ids.messageId,
        channel: "linkedin",
        action: "message",
        thread_id: thread.id,
        person_id: person.id,
        status: "sent",
      });
    }

    const pending = await countPendingSimulations(ctx, ctx.workspace.id);
    expect(pending).toEqual({
      email_replies: 1,
      linkedin_accepts: 1,
      linkedin_replies: 1,
      meeting_bookings: 0,
      meeting_no_shows: 0,
    });
    const result = await fastForwardSandbox(ctx, ctx.workspace.id);
    const { delivered, ...before } = result;
    expect(before).toEqual(pending);
    expect(delivered).toEqual(pending);
  });

  it("reports zero for a workspace with nothing pending", async () => {
    ctx = await createTestContext({ sandbox: true });
    const result = await fastForwardSandbox(ctx, ctx.workspace.id);
    expect(result.delivered).toEqual({
      email_replies: 0,
      linkedin_accepts: 0,
      linkedin_replies: 0,
      meeting_bookings: 0,
      meeting_no_shows: 0,
    });
  });
});
