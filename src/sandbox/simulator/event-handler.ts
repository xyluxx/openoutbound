/**
 * The prospect simulator's entry point: on every `message.sent` event, in sandbox workspaces
 * only, schedules the right delayed delivery job (or none, for messages this simulator does not
 * cover): replies to first-touch emails, LinkedIn acceptances and replies, and meetings booked
 * from our replies that carried the booking link. Deterministic per (person id, message id):
 * replays give the same outcomes.
 */
import { eq } from "drizzle-orm";
import { onEvent } from "../../core/operation.js";
import { messages } from "../../db/schema/index.js";
import { ACCEPT_DELAY_MS } from "../providers/linkedin.js";
import { simulatedDelayMs } from "./decide.js";
import { isFirstTouchEmail } from "./email-reply.js";
import {
  EMAIL_REPLY_JOB,
  LINKEDIN_ACCEPT_JOB,
  LINKEDIN_REPLY_JOB,
  MEETING_BOOKING_JOB,
} from "./jobs.js";
import { isBookingLinkReply } from "./meetings.js";

export const scheduleSimulatedReply = onEvent(
  "message.sent",
  "sandbox.schedule_simulated_reply",
  async (ctx, event) => {
    if (!ctx.workspace?.is_sandbox) return;
    const { message_id, person_id, channel, action, thread_id } = event.data;
    if (!person_id) return;

    if (channel === "email" && action === "email") {
      if (!(await isFirstTouchEmail(ctx, thread_id))) return;
      await ctx.jobs.enqueue(
        EMAIL_REPLY_JOB,
        { message_id },
        {
          delayMs: simulatedDelayMs(person_id, message_id),
          singletonKey: `sandbox_email_reply:${message_id}`,
        },
      );
      return;
    }

    // Our reply offered the booking link: the prospect may book a meeting with it.
    if (channel === "email" && action === "reply") {
      if (!(await isBookingLinkReply(ctx, message_id))) return;
      await ctx.jobs.enqueue(
        MEETING_BOOKING_JOB,
        { message_id },
        {
          delayMs: simulatedDelayMs(person_id, `${message_id}:meeting`),
          singletonKey: `sandbox_meeting_booking:${message_id}`,
        },
      );
      return;
    }

    if (channel === "linkedin" && action === "invite") {
      const [message] = await ctx.db
        .select({ linkedinAccountId: messages.linkedin_account_id })
        .from(messages)
        .where(eq(messages.id, message_id));
      const accountId = message?.linkedinAccountId;
      if (!accountId) return;
      await ctx.jobs.enqueue(
        LINKEDIN_ACCEPT_JOB,
        { account_id: accountId, person_id },
        {
          delayMs: ACCEPT_DELAY_MS,
          singletonKey: `sandbox_li_accept:${accountId}:${person_id}`,
        },
      );
      return;
    }

    if (channel === "linkedin" && action === "message") {
      await ctx.jobs.enqueue(
        LINKEDIN_REPLY_JOB,
        { message_id },
        {
          delayMs: simulatedDelayMs(person_id, message_id),
          singletonKey: `sandbox_li_reply:${message_id}`,
        },
      );
    }
  },
);
