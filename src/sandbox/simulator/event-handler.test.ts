import { afterEach, describe, expect, it } from "vitest";
import type { EmittedEvent } from "../../core/events.js";
import { newId } from "../../core/ids.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import {
  seedLinkedInAccount,
  seedMailbox,
  seedMessage,
  seedPerson,
  seedThread,
} from "../../testing/factories.js";
import { ACCEPT_DELAY_MS } from "../providers/linkedin.js";
import { scheduleSimulatedReply } from "./event-handler.js";
import { EMAIL_REPLY_JOB, LINKEDIN_ACCEPT_JOB, LINKEDIN_REPLY_JOB } from "./jobs.js";

function sentEvent(
  ctx: TestContext,
  data: Partial<EmittedEvent<"message.sent">["data"]> & { message_id: string },
): EmittedEvent<"message.sent"> {
  return {
    id: newId("evt"),
    type: "message.sent",
    workspaceId: ctx.workspace.id,
    subject: { type: "message", id: data.message_id },
    data: {
      message_id: data.message_id,
      thread_id: data.thread_id ?? null,
      person_id: data.person_id ?? null,
      campaign_id: data.campaign_id ?? null,
      channel: data.channel ?? "email",
      action: data.action ?? "email",
      sent_at: ctx.clock.now().toISOString(),
    },
    occurredAt: ctx.clock.now(),
  };
}

describe("scheduleSimulatedReply (message.sent)", () => {
  let ctx: TestContext;
  afterEach(async () => {
    await ctx?.close();
  });

  it("does nothing outside sandbox workspaces", async () => {
    ctx = await createTestContext({ sandbox: false });
    const thread = await seedThread(ctx);
    const mailbox = await seedMailbox(ctx);
    const person = await seedPerson(ctx);
    const message = await seedMessage(ctx, {
      thread_id: thread.id,
      mailbox_id: mailbox.id,
      person_id: person.id,
      status: "sent",
    });

    await scheduleSimulatedReply.handler(
      ctx.jobContext(),
      sentEvent(ctx, { message_id: message.id, thread_id: thread.id, person_id: person.id }),
    );
    expect(ctx.enqueued()).toHaveLength(0);
  });

  it("schedules the email reply job for a first-touch email, with a 2-30 minute delay", async () => {
    ctx = await createTestContext({ sandbox: true });
    const thread = await seedThread(ctx);
    const mailbox = await seedMailbox(ctx);
    const person = await seedPerson(ctx);
    const message = await seedMessage(ctx, {
      thread_id: thread.id,
      mailbox_id: mailbox.id,
      person_id: person.id,
      status: "sent",
    });

    await scheduleSimulatedReply.handler(
      ctx.jobContext(),
      sentEvent(ctx, { message_id: message.id, thread_id: thread.id, person_id: person.id }),
    );
    const jobs = ctx.enqueued(EMAIL_REPLY_JOB);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toEqual({ message_id: message.id });
    expect(jobs[0]?.options.singletonKey).toBe(`sandbox_email_reply:${message.id}`);
    const delay = jobs[0]?.options.delayMs ?? -1;
    expect(delay).toBeGreaterThanOrEqual(2 * 60_000);
    expect(delay).toBeLessThanOrEqual(30 * 60_000);
  });

  it("does not schedule anything for a follow-up email in a thread that already has one", async () => {
    ctx = await createTestContext({ sandbox: true });
    const thread = await seedThread(ctx);
    const mailbox = await seedMailbox(ctx);
    const person = await seedPerson(ctx);
    await seedMessage(ctx, {
      thread_id: thread.id,
      mailbox_id: mailbox.id,
      person_id: person.id,
      status: "sent",
    });
    const followUp = await seedMessage(ctx, {
      thread_id: thread.id,
      mailbox_id: mailbox.id,
      person_id: person.id,
      status: "sent",
    });

    await scheduleSimulatedReply.handler(
      ctx.jobContext(),
      sentEvent(ctx, { message_id: followUp.id, thread_id: thread.id, person_id: person.id }),
    );
    expect(ctx.enqueued()).toHaveLength(0);
  });

  it("schedules the LinkedIn accept job for an invite, with the provider's own accept delay", async () => {
    ctx = await createTestContext({ sandbox: true });
    const account = await seedLinkedInAccount(ctx);
    const person = await seedPerson(ctx);
    const message = await seedMessage(ctx, {
      channel: "linkedin",
      action: "invite",
      linkedin_account_id: account.id,
      person_id: person.id,
      status: "sent",
    });

    await scheduleSimulatedReply.handler(
      ctx.jobContext(),
      sentEvent(ctx, {
        message_id: message.id,
        person_id: person.id,
        channel: "linkedin",
        action: "invite",
      }),
    );
    const jobs = ctx.enqueued(LINKEDIN_ACCEPT_JOB);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toEqual({ account_id: account.id, person_id: person.id });
    expect(jobs[0]?.options.delayMs).toBe(ACCEPT_DELAY_MS);
  });

  it("schedules the LinkedIn reply job for a message action, with a 2-30 minute delay", async () => {
    ctx = await createTestContext({ sandbox: true });
    const account = await seedLinkedInAccount(ctx);
    const person = await seedPerson(ctx);
    const message = await seedMessage(ctx, {
      channel: "linkedin",
      action: "message",
      linkedin_account_id: account.id,
      person_id: person.id,
      status: "sent",
    });

    await scheduleSimulatedReply.handler(
      ctx.jobContext(),
      sentEvent(ctx, {
        message_id: message.id,
        person_id: person.id,
        channel: "linkedin",
        action: "message",
      }),
    );
    const jobs = ctx.enqueued(LINKEDIN_REPLY_JOB);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toEqual({ message_id: message.id });
    const delay = jobs[0]?.options.delayMs ?? -1;
    expect(delay).toBeGreaterThanOrEqual(2 * 60_000);
    expect(delay).toBeLessThanOrEqual(30 * 60_000);
  });

  it("ignores actions it does not simulate (e.g. a LinkedIn visit) and events without a person", async () => {
    ctx = await createTestContext({ sandbox: true });
    const thread = await seedThread(ctx);
    const mailbox = await seedMailbox(ctx);
    const message = await seedMessage(ctx, {
      thread_id: thread.id,
      mailbox_id: mailbox.id,
      status: "sent",
    });

    await scheduleSimulatedReply.handler(
      ctx.jobContext(),
      sentEvent(ctx, { message_id: message.id, thread_id: thread.id, person_id: null }),
    );
    await scheduleSimulatedReply.handler(
      ctx.jobContext(),
      sentEvent(ctx, {
        message_id: message.id,
        person_id: "pe_someone",
        channel: "linkedin",
        action: "visit",
      }),
    );
    expect(ctx.enqueued()).toHaveLength(0);
  });
});
