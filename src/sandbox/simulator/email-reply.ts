/**
 * Email side of the prospect simulator: decides and delivers the simulated reply or bounce for
 * one first-touch sandbox outbound email, through `ingestInboundEmail` (the single inbound
 * path), so threading, bounce handling and classification all run for real once those modules
 * land.
 */
import { and, eq } from "drizzle-orm";
import type { OpContext } from "../../core/context.js";
import { mailboxes, messages, people } from "../../db/schema/index.js";
import { type InboundEmail, ingestInboundEmail } from "../../modules/email/service.js";
import {
  buildBounceEmail,
  buildReplyBody,
  buildReplySubject,
  replyExtraHeaders,
} from "./content.js";
import { decideEmailOutcome, outOfOfficeReturnDate } from "./decide.js";

export interface EmailSimResult {
  delivered: boolean;
  /** Why nothing was delivered, when `delivered` is false. */
  reason?: "not_found" | "not_first_touch" | "already_handled" | "no_response";
  outcome?: "bounce" | "reply";
}

/** True when `threadId` has no prior outbound *sent* email (this message would be the first). */
export async function isFirstTouchEmail(
  ctx: Pick<OpContext, "db">,
  threadId: string | null,
): Promise<boolean> {
  if (!threadId) return true;
  const rows = await ctx.db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.thread_id, threadId),
        eq(messages.channel, "email"),
        eq(messages.action, "email"),
        eq(messages.direction, "outbound"),
        eq(messages.status, "sent"),
      ),
    );
  return rows.length <= 1;
}

/** True when `threadId` already has any inbound message (a reply or bounce was already delivered). */
async function threadHasInbound(
  ctx: Pick<OpContext, "db">,
  threadId: string | null,
): Promise<boolean> {
  if (!threadId) return false;
  const rows = await ctx.db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.thread_id, threadId), eq(messages.direction, "inbound")));
  return rows.length > 0;
}

/**
 * Message ids of every first-touch, still-unanswered outbound sandbox email in this workspace
 * (candidates for `sandbox.simulate` fast-forward, and for the `sandbox.status` pending count).
 */
export async function findPendingEmailCandidates(
  ctx: Pick<OpContext, "db">,
  workspaceId: string,
): Promise<string[]> {
  const rows = await ctx.db
    .select({
      id: messages.id,
      threadId: messages.thread_id,
      direction: messages.direction,
      action: messages.action,
      status: messages.status,
    })
    .from(messages)
    .where(and(eq(messages.workspace_id, workspaceId), eq(messages.channel, "email")));

  const byThread = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = row.threadId ?? row.id;
    const list = byThread.get(key) ?? [];
    list.push(row);
    byThread.set(key, list);
  }

  const candidates: string[] = [];
  for (const rowsInThread of byThread.values()) {
    const outboundSent = rowsInThread.filter(
      (r) => r.action === "email" && r.direction === "outbound" && r.status === "sent",
    );
    const inbound = rowsInThread.filter((r) => r.direction === "inbound");
    if (outboundSent.length === 1 && inbound.length === 0) {
      const only = outboundSent[0];
      if (only) candidates.push(only.id);
    }
  }
  return candidates;
}

/**
 * Decides and (when applicable) delivers the simulated outcome for one first-touch outbound
 * email message, calling `ingestInboundEmail` for a reply or a bounce. Safe to call more than
 * once for the same message (a job retry, or a fast-forward after the job already ran): a
 * thread that already has an inbound message is left alone.
 */
export async function processEmailMessage(
  ctx: OpContext,
  messageId: string,
): Promise<EmailSimResult> {
  const [message] = await ctx.db.select().from(messages).where(eq(messages.id, messageId));
  if (message?.direction !== "outbound" || message.status !== "sent") {
    return { delivered: false, reason: "not_found" };
  }
  if (!(await isFirstTouchEmail(ctx, message.thread_id))) {
    return { delivered: false, reason: "not_first_touch" };
  }
  if (await threadHasInbound(ctx, message.thread_id)) {
    return { delivered: false, reason: "already_handled" };
  }
  if (!message.person_id || !message.mailbox_id) {
    return { delivered: false, reason: "not_found" };
  }

  const [person] = await ctx.db.select().from(people).where(eq(people.id, message.person_id));
  if (!person?.email) return { delivered: false, reason: "not_found" };

  const outcome = decideEmailOutcome({
    personId: person.id,
    messageId: message.id,
    emailStatus: person.email_status,
  });
  if (outcome.kind === "none") return { delivered: false, reason: "no_response" };

  const [mailbox] = await ctx.db
    .select()
    .from(mailboxes)
    .where(eq(mailboxes.id, message.mailbox_id));
  if (!mailbox) return { delivered: false, reason: "not_found" };

  const originalSubject = message.subject ?? "";
  const references = [...(message.references ?? []), message.message_id_header].filter(
    (v): v is string => Boolean(v),
  );
  const replyMessageId = `<sbx_reply_${message.id}_${ctx.clock.now().getTime().toString(36)}@example.com>`;

  let subject: string;
  let text: string;
  let from: string;
  let extraHeaders: Record<string, string> = {};

  if (outcome.kind === "bounce") {
    const domain = person.email.slice(person.email.indexOf("@") + 1);
    const bounce = buildBounceEmail(person.email);
    subject = bounce.subject;
    text = bounce.text;
    from = `mailer-daemon@${domain}`;
    extraHeaders = { "Content-Type": "multipart/report; report-type=delivery-status" };
  } else {
    const language = person.language === "de" ? "de" : "en";
    subject = buildReplySubject(originalSubject, language);
    text = buildReplyBody(
      outcome.replyKind,
      {
        prospectFirstName: person.first_name ?? person.full_name?.split(" ")[0] ?? "there",
        senderName: mailbox.from_name ?? "there",
        originalSubject,
        returnDate:
          outcome.replyKind === "out_of_office"
            ? outOfOfficeReturnDate(person.id, message.id, ctx.clock.now())
            : undefined,
      },
      language,
    );
    from = person.email;
    extraHeaders = replyExtraHeaders(outcome.replyKind);
  }

  const input: InboundEmail = {
    mailboxId: mailbox.id,
    from,
    to: [mailbox.email],
    subject,
    text,
    headers: {
      From: from,
      To: mailbox.email,
      Subject: subject,
      "Message-ID": replyMessageId,
      ...(message.message_id_header ? { "In-Reply-To": message.message_id_header } : {}),
      ...(references.length > 0 ? { References: references.join(" ") } : {}),
      Date: ctx.clock.now().toUTCString(),
      ...extraHeaders,
    },
    messageIdHeader: replyMessageId,
    inReplyTo: message.message_id_header ?? undefined,
    references,
    receivedAt: ctx.clock.now(),
  };

  await ingestInboundEmail(ctx, input);
  return { delivered: true, outcome: outcome.kind === "bounce" ? "bounce" : "reply" };
}
