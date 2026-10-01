/**
 * Deterministic decisions for the prospect simulator: pure functions of stable ids (never a
 * random draw), so the same world produces the same outcomes every time it is replayed.
 */
import type { EmailStatus } from "../../core/enums.js";
import { ACCEPT_RATE } from "../providers/linkedin.js";
import { hashBool, hashRatio } from "../world/rng.js";
import { pickReplyKind, type SimReplyKind } from "./content.js";

/** Share of first-touch emails (to a non-invalid address) that get any reply at all. */
export const FIRST_TOUCH_REPLY_RATE = 0.22;
/** Share of sends to an already-invalid address that come back as a hard bounce. */
export const BOUNCE_RATE_FOR_INVALID = 0.03;
/** Share of messages sent to an already-connected LinkedIn prospect that get a reply. */
export const LINKEDIN_MESSAGE_REPLY_RATE = 0.2;

const MIN_DELAY_MINUTES = 2;
const MAX_DELAY_MINUTES = 30;

export type EmailOutcome =
  | { kind: "none" }
  | { kind: "bounce" }
  | { kind: "reply"; replyKind: SimReplyKind };

/**
 * Decides what happens to one first-touch outbound email, purely from (personId, messageId)
 * and the address's known world validity. Invalid addresses only ever bounce or go silent
 * (a nonexistent mailbox cannot write back); everything else only ever bounces never, and
 * replies at `FIRST_TOUCH_REPLY_RATE`.
 */
export function decideEmailOutcome(input: {
  personId: string;
  messageId: string;
  emailStatus: EmailStatus;
}): EmailOutcome {
  const { personId, messageId, emailStatus } = input;
  if (emailStatus === "invalid") {
    const bounces = hashBool(`sbx_bounce:${personId}:${messageId}`, BOUNCE_RATE_FOR_INVALID);
    return bounces ? { kind: "bounce" } : { kind: "none" };
  }
  const replies = hashBool(`sbx_reply:${personId}:${messageId}`, FIRST_TOUCH_REPLY_RATE);
  if (!replies) return { kind: "none" };
  const ratio = hashRatio(`sbx_reply_kind:${personId}:${messageId}`);
  return { kind: "reply", replyKind: pickReplyKind(ratio) };
}

/** Whether a sent invite (already recorded in `linkedin_relations` as `invited`) is accepted. */
export function decideLinkedInAccept(personId: string): boolean {
  return hashBool(`accept:${personId}`, ACCEPT_RATE);
}

/** Whether a LinkedIn message to an already-connected prospect gets a reply. */
export function decideLinkedInMessageReply(personId: string, messageId: string): boolean {
  return hashBool(`sbx_li_reply:${personId}:${messageId}`, LINKEDIN_MESSAGE_REPLY_RATE);
}

/** Simulated delivery delay for a reply or bounce: 2-30 minutes, deterministic per message. */
export function simulatedDelayMs(personId: string, messageId: string): number {
  const ratio = hashRatio(`sbx_delay:${personId}:${messageId}`);
  const minutes = MIN_DELAY_MINUTES + ratio * (MAX_DELAY_MINUTES - MIN_DELAY_MINUTES);
  return Math.round(minutes) * 60_000;
}

/** Return date (YYYY-MM-DD) for an out-of-office reply: 5-10 days after `now`. */
export function outOfOfficeReturnDate(personId: string, messageId: string, now: Date): string {
  const ratio = hashRatio(`sbx_ooo_return:${personId}:${messageId}`);
  const days = 5 + Math.round(ratio * 5);
  const returned = new Date(now.getTime() + days * 86_400_000);
  return returned.toISOString().slice(0, 10);
}
