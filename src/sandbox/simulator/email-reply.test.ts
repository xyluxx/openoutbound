import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestInboundEmail } from "../../modules/email/service.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { seedMailbox, seedMessage, seedPerson, seedThread } from "../../testing/factories.js";
import { decideEmailOutcome } from "./decide.js";
import { isFirstTouchEmail, processEmailMessage } from "./email-reply.js";

vi.mock("../../modules/email/service.js", () => ({
  ingestInboundEmail: vi.fn(async () => ({
    messageId: "msg_ingested",
    threadId: null,
    kind: "reply" as const,
  })),
}));

const ingestMock = vi.mocked(ingestInboundEmail);

/** Brute-forces a (personId, messageId) pair whose decideEmailOutcome matches `want`. */
function findIdsForOutcome(
  prefix: string,
  emailStatus: "valid" | "invalid",
  want: (outcome: ReturnType<typeof decideEmailOutcome>) => boolean,
): { personId: string; messageId: string } {
  const personId = `${prefix}_pe`;
  for (let i = 0; i < 20_000; i++) {
    const messageId = `${prefix}_msg_${i}`;
    if (want(decideEmailOutcome({ personId, messageId, emailStatus })))
      return { personId, messageId };
  }
  throw new Error(`no ids found matching the wanted outcome for ${prefix}`);
}

describe("email simulator", () => {
  let ctx: TestContext;
  afterEach(async () => {
    ingestMock.mockClear();
    await ctx?.close();
  });

  describe("isFirstTouchEmail", () => {
    it("is true for a thread with exactly one sent outbound email", async () => {
      ctx = await createTestContext({ sandbox: true });
      const thread = await seedThread(ctx);
      const mailbox = await seedMailbox(ctx);
      await seedMessage(ctx, { thread_id: thread.id, mailbox_id: mailbox.id, status: "sent" });
      expect(await isFirstTouchEmail(ctx, thread.id)).toBe(true);
    });

    it("is false once the thread already has a second sent outbound email", async () => {
      ctx = await createTestContext({ sandbox: true });
      const thread = await seedThread(ctx);
      const mailbox = await seedMailbox(ctx);
      await seedMessage(ctx, { thread_id: thread.id, mailbox_id: mailbox.id, status: "sent" });
      await seedMessage(ctx, { thread_id: thread.id, mailbox_id: mailbox.id, status: "sent" });
      expect(await isFirstTouchEmail(ctx, thread.id)).toBe(false);
    });
  });

  describe("processEmailMessage", () => {
    it("returns not_found for an unknown message id and never calls ingestInboundEmail", async () => {
      ctx = await createTestContext({ sandbox: true });
      const result = await processEmailMessage(ctx, "msg_missing");
      expect(result).toEqual({ delivered: false, reason: "not_found" });
      expect(ingestMock).not.toHaveBeenCalled();
    });

    it("does nothing once the thread already has an inbound message (idempotent)", async () => {
      ctx = await createTestContext({ sandbox: true });
      const thread = await seedThread(ctx);
      const mailbox = await seedMailbox(ctx);
      const person = await seedPerson(ctx, { email_status: "valid" });
      const outbound = await seedMessage(ctx, {
        thread_id: thread.id,
        mailbox_id: mailbox.id,
        person_id: person.id,
        status: "sent",
      });
      await seedMessage(ctx, {
        thread_id: thread.id,
        direction: "inbound",
        status: "received",
      });

      const result = await processEmailMessage(ctx, outbound.id);
      expect(result).toEqual({ delivered: false, reason: "already_handled" });
      expect(ingestMock).not.toHaveBeenCalled();
    });

    it("delivers no response for a valid address that lands in the silent bucket", async () => {
      ctx = await createTestContext({ sandbox: true });
      const { personId, messageId } = findIdsForOutcome(
        "silent",
        "valid",
        (o) => o.kind === "none",
      );
      const thread = await seedThread(ctx);
      const mailbox = await seedMailbox(ctx);
      const person = await seedPerson(ctx, { id: personId, email_status: "valid" });
      const outbound = await seedMessage(ctx, {
        id: messageId,
        thread_id: thread.id,
        mailbox_id: mailbox.id,
        person_id: person.id,
        status: "sent",
      });

      const result = await processEmailMessage(ctx, outbound.id);
      expect(result).toEqual({ delivered: false, reason: "no_response" });
      expect(ingestMock).not.toHaveBeenCalled();
    });

    it("delivers a reply threaded to the sent message, referencing the subject", async () => {
      ctx = await createTestContext({ sandbox: true });
      const { personId, messageId } = findIdsForOutcome(
        "replytest",
        "valid",
        (o) => o.kind === "reply",
      );
      const thread = await seedThread(ctx, { subject: "Cutting fulfillment costs" });
      const mailbox = await seedMailbox(ctx, { from_name: "Sam" });
      const person = await seedPerson(ctx, {
        id: personId,
        email: "dana@example.com",
        email_status: "valid",
        first_name: "Dana",
        language: "en",
      });
      const outbound = await seedMessage(ctx, {
        id: messageId,
        thread_id: thread.id,
        mailbox_id: mailbox.id,
        person_id: person.id,
        status: "sent",
        subject: "Cutting fulfillment costs",
        message_id_header: "<orig123@example.com>",
      });

      const result = await processEmailMessage(ctx, outbound.id);
      expect(result.delivered).toBe(true);
      expect(result.outcome).toBe("reply");
      expect(ingestMock).toHaveBeenCalledTimes(1);
      const input = ingestMock.mock.calls[0]?.[1];
      expect(input?.mailboxId).toBe(mailbox.id);
      expect(input?.from).toBe("dana@example.com");
      expect(input?.to).toEqual([mailbox.email]);
      expect(input?.inReplyTo).toBe("<orig123@example.com>");
      expect(input?.references).toContain("<orig123@example.com>");
      expect(input?.text).toContain("Cutting fulfillment costs");
      expect(outbound.thread_id).toBe(thread.id);
    });

    it("delivers a hard bounce DSN for an address the world marks invalid", async () => {
      ctx = await createTestContext({ sandbox: true });
      const { personId, messageId } = findIdsForOutcome(
        "bouncetest",
        "invalid",
        (o) => o.kind === "bounce",
      );
      const thread = await seedThread(ctx);
      const mailbox = await seedMailbox(ctx);
      const person = await seedPerson(ctx, {
        id: personId,
        email: "ghost@example.com",
        email_status: "invalid",
      });
      const outbound = await seedMessage(ctx, {
        id: messageId,
        thread_id: thread.id,
        mailbox_id: mailbox.id,
        person_id: person.id,
        status: "sent",
      });

      const result = await processEmailMessage(ctx, outbound.id);
      expect(result).toEqual({ delivered: true, outcome: "bounce" });
      const input = ingestMock.mock.calls[0]?.[1];
      expect(input?.from).toBe("mailer-daemon@example.com");
      expect(input?.subject).toMatch(/undelivered/i);
    });
  });
});
