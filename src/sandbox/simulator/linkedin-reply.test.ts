import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { linkedin_relations } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import {
  seedLinkedInAccount,
  seedMessage,
  seedPerson,
  seedThread,
} from "../../testing/factories.js";
import { decideLinkedInAccept, decideLinkedInMessageReply } from "./decide.js";
import {
  findPendingLinkedInAccepts,
  findPendingLinkedInMessageReplies,
  processLinkedInAccept,
  processLinkedInMessage,
} from "./linkedin-reply.js";

function idWithAccept(prefix: string, want: boolean): string {
  for (let i = 0; i < 5000; i++) {
    const id = `${prefix}_${i}`;
    if (decideLinkedInAccept(id) === want) return id;
  }
  throw new Error(`no id found with accept=${want}`);
}

function idsWithMessageReply(
  prefix: string,
  want: boolean,
): { personId: string; messageId: string } {
  const personId = `${prefix}_pe`;
  for (let i = 0; i < 5000; i++) {
    const messageId = `${prefix}_msg_${i}`;
    if (decideLinkedInMessageReply(personId, messageId) === want) return { personId, messageId };
  }
  throw new Error(`no ids found with reply=${want}`);
}

describe("linkedin simulator", () => {
  let ctx: TestContext;
  afterEach(async () => {
    await ctx?.close();
  });

  describe("processLinkedInAccept", () => {
    it("connects and emits linkedin.connected for a person in the accept bucket", async () => {
      ctx = await createTestContext({ sandbox: true });
      const account = await seedLinkedInAccount(ctx);
      const personId = idWithAccept("li_accept", true);
      const person = await seedPerson(ctx, { id: personId });
      await ctx.db.insert(linkedin_relations).values({
        workspace_id: ctx.workspace.id,
        account_id: account.id,
        person_id: person.id,
        status: "invited",
        invited_at: ctx.clock.now(),
      });

      const result = await processLinkedInAccept(ctx, account.id, person.id);
      expect(result).toEqual({ connected: true });

      const [relation] = await ctx.db
        .select()
        .from(linkedin_relations)
        .where(
          and(
            eq(linkedin_relations.account_id, account.id),
            eq(linkedin_relations.person_id, person.id),
          ),
        );
      expect(relation?.status).toBe("connected");
      expect(relation?.connected_at).toBeInstanceOf(Date);
      expect(ctx.emitted("linkedin.connected")).toHaveLength(1);
      expect(ctx.emitted("linkedin.connected")[0]?.data).toMatchObject({
        account_id: account.id,
        person_id: person.id,
      });
    });

    it("leaves the relation invited and emits nothing for the reject bucket", async () => {
      ctx = await createTestContext({ sandbox: true });
      const account = await seedLinkedInAccount(ctx);
      const personId = idWithAccept("li_reject", false);
      const person = await seedPerson(ctx, { id: personId });
      await ctx.db.insert(linkedin_relations).values({
        workspace_id: ctx.workspace.id,
        account_id: account.id,
        person_id: person.id,
        status: "invited",
        invited_at: ctx.clock.now(),
      });

      const result = await processLinkedInAccept(ctx, account.id, person.id);
      expect(result).toEqual({ connected: false });
      expect(ctx.emitted("linkedin.connected")).toHaveLength(0);
    });

    it("is idempotent: a relation that is not invited is left alone", async () => {
      ctx = await createTestContext({ sandbox: true });
      const account = await seedLinkedInAccount(ctx);
      const personId = idWithAccept("li_already", true);
      const person = await seedPerson(ctx, { id: personId });
      await ctx.db.insert(linkedin_relations).values({
        workspace_id: ctx.workspace.id,
        account_id: account.id,
        person_id: person.id,
        status: "connected",
        connected_at: ctx.clock.now(),
      });

      const result = await processLinkedInAccept(ctx, account.id, person.id);
      expect(result).toEqual({ connected: false });
      expect(ctx.emitted("linkedin.connected")).toHaveLength(0);
    });

    it("reports no relation as not connected", async () => {
      ctx = await createTestContext({ sandbox: true });
      const result = await processLinkedInAccept(ctx, "lia_missing", "pe_missing");
      expect(result).toEqual({ connected: false });
    });
  });

  describe("findPendingLinkedInAccepts", () => {
    it("lists only invited relations for the workspace", async () => {
      ctx = await createTestContext({ sandbox: true });
      const account = await seedLinkedInAccount(ctx);
      const invited = await seedPerson(ctx);
      const connected = await seedPerson(ctx);
      await ctx.db.insert(linkedin_relations).values([
        {
          workspace_id: ctx.workspace.id,
          account_id: account.id,
          person_id: invited.id,
          status: "invited",
          invited_at: ctx.clock.now(),
        },
        {
          workspace_id: ctx.workspace.id,
          account_id: account.id,
          person_id: connected.id,
          status: "connected",
          connected_at: ctx.clock.now(),
        },
      ]);
      const pending = await findPendingLinkedInAccepts(ctx, ctx.workspace.id);
      expect(pending).toEqual([{ accountId: account.id, personId: invited.id }]);
    });
  });

  describe("processLinkedInMessage", () => {
    it("delivers a reply, threads it and emits reply.received for the reply bucket", async () => {
      ctx = await createTestContext({ sandbox: true });
      const { personId, messageId } = idsWithMessageReply("li_msg_reply", true);
      const thread = await seedThread(ctx, { channel: "linkedin" });
      const person = await seedPerson(ctx, { id: personId });
      const outbound = await seedMessage(ctx, {
        id: messageId,
        channel: "linkedin",
        action: "message",
        thread_id: thread.id,
        person_id: person.id,
        status: "sent",
      });

      const result = await processLinkedInMessage(ctx, outbound.id);
      expect(result).toEqual({ delivered: true });
      expect(ctx.emitted("reply.received")).toHaveLength(1);
      expect(ctx.emitted("reply.received")[0]?.data).toMatchObject({
        thread_id: thread.id,
        person_id: person.id,
        channel: "linkedin",
      });
    });

    it("delivers nothing for the no-reply bucket", async () => {
      ctx = await createTestContext({ sandbox: true });
      const { personId, messageId } = idsWithMessageReply("li_msg_noreply", false);
      const thread = await seedThread(ctx, { channel: "linkedin" });
      const person = await seedPerson(ctx, { id: personId });
      const outbound = await seedMessage(ctx, {
        id: messageId,
        channel: "linkedin",
        action: "message",
        thread_id: thread.id,
        person_id: person.id,
        status: "sent",
      });

      const result = await processLinkedInMessage(ctx, outbound.id);
      expect(result).toEqual({ delivered: false });
      expect(ctx.emitted("reply.received")).toHaveLength(0);
    });

    it("is idempotent: a thread that already has an inbound message is left alone", async () => {
      ctx = await createTestContext({ sandbox: true });
      const { personId, messageId } = idsWithMessageReply("li_msg_already", true);
      const thread = await seedThread(ctx, { channel: "linkedin" });
      const person = await seedPerson(ctx, { id: personId });
      const outbound = await seedMessage(ctx, {
        id: messageId,
        channel: "linkedin",
        action: "message",
        thread_id: thread.id,
        person_id: person.id,
        status: "sent",
      });
      await seedMessage(ctx, {
        channel: "linkedin",
        action: "message",
        direction: "inbound",
        status: "received",
        thread_id: thread.id,
        person_id: person.id,
      });

      const result = await processLinkedInMessage(ctx, outbound.id);
      expect(result).toEqual({ delivered: false });
      expect(ctx.emitted("reply.received")).toHaveLength(0);
    });
  });

  describe("findPendingLinkedInMessageReplies", () => {
    it("only lists the latest unanswered outbound message per thread", async () => {
      ctx = await createTestContext({ sandbox: true });
      const thread = await seedThread(ctx, { channel: "linkedin" });
      const person = await seedPerson(ctx);
      const first = await seedMessage(ctx, {
        channel: "linkedin",
        action: "message",
        thread_id: thread.id,
        person_id: person.id,
        status: "sent",
      });
      const second = await seedMessage(ctx, {
        channel: "linkedin",
        action: "message",
        thread_id: thread.id,
        person_id: person.id,
        status: "sent",
      });
      const pending = await findPendingLinkedInMessageReplies(ctx, ctx.workspace.id);
      expect(pending).toEqual([second.id]);
      expect(pending).not.toContain(first.id);
    });
  });
});
