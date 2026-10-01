/**
 * Email channel service (cross-module binding functions): capacity planning, the sending
 * queue, the single inbound path and operational emails.
 */
import type { OpContext } from "../../core/context.js";
import type { CampaignSettings } from "../../core/settings.js";
import type { Mailbox } from "../../db/schema/index.js";
import { rampLimit } from "./capacity.js";
import { type PlanEmailSendResult, planEmailSendWith } from "./plan.js";
import { addDays, daysBetween, isValidTimeZone, localDate } from "./timezone.js";

export { applySenderRejectedReply } from "./bounce.js";
export { ingestInboundEmail } from "./inbound/ingest.js";
export type { InboundEmail, IngestResult } from "./inbound/types.js";
export type { PlanEmailSendResult } from "./plan.js";
export { SENDABLE_STATUSES } from "./plan.js";
export { queueEmailSend } from "./queue.js";
export {
  hasPublicBaseUrl,
  holdsForUnsubscribeLink,
  PUBLIC_BASE_URL_FIX,
  readsReplies,
} from "./sending-checks.js";
export { sendSystemEmail } from "./system-email.js";
export { usesSandboxTransport } from "./transport.js";
export { resendUnknownMessage } from "./unknown-operations.js";
export { unsubscribeReadiness } from "./unsubscribe-token.js";

/** Where a mailbox's ramp allows cold email: today's limit and the first day above zero. */
export interface MailboxRampOutlook {
  today_limit: number;
  /** Local date (sender time zone) of the first day with a limit above zero. */
  first_sending_day: string;
}

/**
 * Today's ramp limit for a mailbox, and when it first sends if the ramp still holds it at zero
 * (the quiet setup weeks of a new domain). Days are local to the workspace time zone.
 */
export function mailboxRampOutlook(
  mailbox: Pick<Mailbox, "daily_limit" | "ramp" | "created_at">,
  now: Date,
  timeZone: string,
): MailboxRampOutlook {
  const zone = isValidTimeZone(timeZone) ? timeZone : "UTC";
  const today = localDate(now, zone);
  const rampStart = localDate(mailbox.created_at, zone);
  const todayLimit = rampLimit(mailbox.daily_limit, mailbox.ramp, rampStart, today);
  if (todayLimit > 0 || !mailbox.ramp?.enabled || mailbox.daily_limit <= 0) {
    return { today_limit: todayLimit, first_sending_day: today };
  }
  const started = mailbox.ramp.started_at ? mailbox.ramp.started_at.slice(0, 10) : rampStart;
  const first = addDays(started, Math.max(0, mailbox.ramp.delay_days ?? 0));
  return {
    today_limit: 0,
    first_sending_day: daysBetween(today, first) > 0 ? first : today,
  };
}

/**
 * Picks a mailbox and a send time that respect daily limits, ramp, gaps, the send window in the
 * recipient timezone, working days, holidays and per-domain throttling.
 */
export async function planEmailSend(
  ctx: OpContext,
  input: {
    mailboxIds: string[];
    preferredMailboxId?: string | null;
    recipientEmail: string;
    recipientTimezone?: string | null;
    schedule: CampaignSettings["schedule"];
    notBefore?: Date;
  },
): Promise<PlanEmailSendResult> {
  return planEmailSendWith(ctx, input);
}
