/**
 * Delayed delivery jobs for the prospect simulator. Each is enqueued once, by the `message.sent`
 * handler (or, for no-shows, by the booking), with a simulated delay; `sandbox.simulate`
 * (fast-forward) calls the same processing functions directly, without waiting for the job to
 * run.
 */
import { z } from "zod";
import { defineJob } from "../../core/operation.js";
import { processEmailMessage } from "./email-reply.js";
import { processLinkedInAccept, processLinkedInMessage } from "./linkedin-reply.js";
import {
  MEETING_BOOKING_JOB,
  MEETING_NO_SHOW_JOB,
  processMeetingBooking,
  processMeetingNoShow,
} from "./meetings.js";

export const EMAIL_REPLY_JOB = "sandbox.simulate_email_reply";
export const LINKEDIN_ACCEPT_JOB = "sandbox.simulate_linkedin_accept";
export const LINKEDIN_REPLY_JOB = "sandbox.simulate_linkedin_reply";
export { MEETING_BOOKING_JOB, MEETING_NO_SHOW_JOB };

export const simulateEmailReplyJob = defineJob({
  name: EMAIL_REPLY_JOB,
  payload: z.object({ message_id: z.string() }),
  maxAttempts: 3,
  handler: (ctx, payload) => processEmailMessage(ctx, payload.message_id),
});

export const simulateLinkedInAcceptJob = defineJob({
  name: LINKEDIN_ACCEPT_JOB,
  payload: z.object({ account_id: z.string(), person_id: z.string() }),
  maxAttempts: 3,
  handler: (ctx, payload) => processLinkedInAccept(ctx, payload.account_id, payload.person_id),
});

export const simulateLinkedInReplyJob = defineJob({
  name: LINKEDIN_REPLY_JOB,
  payload: z.object({ message_id: z.string() }),
  maxAttempts: 3,
  handler: (ctx, payload) => processLinkedInMessage(ctx, payload.message_id),
});

export const simulateMeetingBookingJob = defineJob({
  name: MEETING_BOOKING_JOB,
  payload: z.object({ message_id: z.string() }),
  maxAttempts: 3,
  handler: (ctx, payload) => processMeetingBooking(ctx, payload.message_id),
});

export const simulateMeetingNoShowJob = defineJob({
  name: MEETING_NO_SHOW_JOB,
  payload: z.object({ message_id: z.string() }),
  maxAttempts: 3,
  handler: (ctx, payload) => processMeetingNoShow(ctx, payload.message_id),
});
