import { and, desc, eq, gte, inArray, like, ne } from "drizzle-orm";
import type { OpContext } from "../../core/context.js";
import { requireWorkspace } from "../../core/context.js";
import { type Mailbox, type Message, mailboxes, messages, people } from "../../db/schema/index.js";
import { addSuppression, setPersonStatus } from "../leads/service.js";
import { parseBounce } from "./inbound/dsn.js";
import { pauseSendingDomain, recordSendFailure, throttleMailbox } from "./mailbox-state.js";
import { type SenderRejectionKind, senderRejection } from "./send-errors.js";
import { isValidTimeZone } from "./timezone.js";

/** Prefixes stored in messages.error so health checks can count hard bounces. */
export const HARD_BOUNCE_PREFIX = "hard_bounce: ";
export const SOFT_BOUNCE_PREFIX = "soft_bounce: ";
/** A bounce that refused our sender, not the address: never part of the recipient's record. */
export const SENDER_REJECTION_PREFIX = "sender_rejected: ";
const SOFT_TO_HARD_WINDOW_MS = 14 * 86_400_000;

export interface BounceInput {
  /** The outbound message that bounced, when known. */
  message: Message | null;
  /** The address that failed. */
  email: string;
  bounceType: "hard" | "soft";
  reason: string | null;
  /**
   * The send job's refusal of its own attempt: the bounce applies only while that attempt still
   * holds the message (`sending` with this attempt number).
   */
  claimedAttempt?: number;
}

/**
 * Applies a bounce: message `bounced`, and for hard bounces (or a second soft bounce within 14
 * days) person email_status `invalid`, person status `bounced` and an email suppression. Emits
 * `message.bounced`. Idempotent: a message already `bounced` is left alone, and so is one a
 * later send attempt claimed (with `claimedAttempt`; nothing is applied then).
 */
export async function applyBounce(
  ctx: OpContext,
  input: BounceInput,
): Promise<{ applied: boolean; bounceType: "hard" | "soft" }> {
  const workspace = requireWorkspace(ctx);
  const email = input.email.trim().toLowerCase();
  const now = ctx.clock.now();
  const message = input.message;
  if (message?.status === "bounced") return { applied: false, bounceType: input.bounceType };

  let personId = message?.person_id ?? null;
  if (!personId && email) {
    const [person] = await ctx.db
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.workspace_id, workspace.id), eq(people.email, email)))
      .limit(1);
    personId = person?.id ?? null;
  }

  let bounceType = input.bounceType;
  if (bounceType === "soft" && personId) {
    const [previous] = await ctx.db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.workspace_id, workspace.id),
          eq(messages.person_id, personId),
          eq(messages.status, "bounced"),
          like(messages.error, `${SOFT_BOUNCE_PREFIX}%`),
          gte(messages.updated_at, new Date(now.getTime() - SOFT_TO_HARD_WINDOW_MS)),
          ...(message ? [ne(messages.id, message.id)] : []),
        ),
      )
      .limit(1);
    if (previous) bounceType = "hard";
  }

  const reason = (input.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 500) || null;
  if (message) {
    const claimed =
      input.claimedAttempt === undefined
        ? []
        : [eq(messages.status, "sending"), eq(messages.attempt, input.claimedAttempt)];
    const rows = await ctx.db
      .update(messages)
      .set({
        status: "bounced",
        error: `${bounceType === "hard" ? HARD_BOUNCE_PREFIX : SOFT_BOUNCE_PREFIX}${reason ?? "bounced"}`,
      })
      .where(and(eq(messages.id, message.id), eq(messages.workspace_id, workspace.id), ...claimed))
      .returning({ id: messages.id });
    if (rows.length === 0 && input.claimedAttempt !== undefined) {
      return { applied: false, bounceType };
    }
  }

  if (bounceType === "hard" && email) {
    if (personId) {
      await ctx.db
        .update(people)
        .set({ email_status: "invalid", email_checked_at: now })
        .where(
          and(
            eq(people.id, personId),
            eq(people.workspace_id, workspace.id),
            eq(people.email, email),
          ),
        );
      await setPersonStatus(ctx, personId, "bounced");
    }
    await addSuppression(ctx, {
      type: "email",
      value: email,
      reason: "bounced",
      source: "bounce",
      ...(reason ? { note: reason.slice(0, 200) } : {}),
    });
  }

  await ctx.events.emit("message.bounced", {
    subject: message
      ? { type: "message", id: message.id }
      : personId
        ? { type: "person", id: personId }
        : null,
    data: {
      message_id: message?.id ?? null,
      person_id: personId,
      email,
      bounce_type: bounceType,
      reason,
    },
  });
  return { applied: true, bounceType };
}

export interface SenderRejectionInput {
  /** The mailbox that sent the message (the one the bounce came back to). */
  mailbox: Mailbox;
  /** The outbound message that bounced, when known. */
  message: Message | null;
  kind: SenderRejectionKind;
  /** Enhanced status code, e.g. "5.7.26". */
  status: string | null;
  /** Status and the server's answer, for messages.error and the mailbox health. */
  reason: string | null;
}

/**
 * A bounce that refused our sender rather than the address (authentication, reputation,
 * policy, rate limits; see `senderRejection`). Only the sending mailbox pays: provider blocks
 * pause every mailbox on its domain, rate limits stop it until tomorrow, other rejections count
 * as a send failure (5 in a row pause it), like the same answers during SMTP. The message is
 * marked `bounced` with SENDER_REJECTION_PREFIX; the recipient's bounce tally, email status,
 * person status and suppressions stay untouched and no `message.bounced` is emitted.
 * Idempotent per message: false when the message was already marked bounced.
 */
export async function applySenderRejection(
  ctx: OpContext,
  input: SenderRejectionInput,
): Promise<boolean> {
  const workspace = requireWorkspace(ctx);
  const reason = (input.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 500) || "rejected";
  if (input.message) {
    const marked = await ctx.db
      .update(messages)
      .set({ status: "bounced", error: `${SENDER_REJECTION_PREFIX}${reason}` })
      .where(
        and(
          eq(messages.id, input.message.id),
          eq(messages.workspace_id, workspace.id),
          ne(messages.status, "bounced"),
        ),
      )
      .returning({ id: messages.id });
    if (marked.length === 0) return false;
  }
  if (input.kind === "blocked") {
    await pauseSendingDomain(ctx, input.mailbox, input.status ?? "5.7.26", reason);
  } else if (input.kind === "throttled") {
    const timezone = isValidTimeZone(workspace.timezone) ? workspace.timezone : "UTC";
    await throttleMailbox(ctx, input.mailbox, timezone, `Provider throttling: ${reason}`);
  } else {
    await recordSendFailure(ctx, input.mailbox, `Rejected by the receiving server: ${reason}`);
  }
  return true;
}

/** A line where a bounce's own explanation ends and the returned message (or its headers) begins. */
const RETURNED_MESSAGE =
  /^\s*(?:.*\b(?:original message|returned message|undelivered message|copy of (?:the|your) message|message headers|below this line)\b|(?:received|return-path|from|to|subject|date|message-id|content-type)\s*:)/i;

/**
 * The server's own words in a bounce: the text before the returned message, quoted lines left
 * out, so words from our own email (say "reputation") never decide who is to blame.
 */
export function bounceExplanation(text: string): string {
  const own: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (RETURNED_MESSAGE.test(line)) break;
    if (!line.trimStart().startsWith(">")) own.push(line);
  }
  return own.join("\n").trim().slice(0, 2000);
}

/** Our outbound email a bounce refers to, by the Message-ID it names or answers. */
async function bouncedMessageOf(
  ctx: OpContext,
  reply: Message,
  originalMessageId: string | null,
): Promise<Message | null> {
  const ids = [
    ...new Set(
      [originalMessageId, reply.in_reply_to, ...(reply.references ?? [])].filter(
        (id): id is string => Boolean(id),
      ),
    ),
  ];
  if (ids.length === 0) return null;
  const [row] = await ctx.db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, reply.workspace_id),
        eq(messages.direction, "outbound"),
        eq(messages.channel, "email"),
        inArray(messages.message_id_header, ids),
      ),
    )
    .orderBy(desc(messages.sent_at))
    .limit(1);
  return row ?? null;
}

export interface SenderRejectedReply {
  kind: SenderRejectionKind;
  /** Enhanced status code of the answer, when the bounce has one. */
  status: string | null;
}

/**
 * An inbound email the DSN parser did not take for a bounce (an unknown mailer daemon, a plain
 * "Undeliverable" subject) but the inbox classified as one. When it refused our sender rather
 * than the address (status and answer line when it has codes, else the server's own words),
 * it is handled like a parsed bounce that did: `applySenderRejection` on the mailbox it came
 * back to, and the recipient's record stays clean. Returns null for a bounce about the address.
 */
export async function applySenderRejectedReply(
  ctx: OpContext,
  reply: Message,
): Promise<SenderRejectedReply | null> {
  if (reply.channel !== "email" || reply.direction !== "inbound") return null;
  const text = reply.body_text ?? "";
  const report = parseBounce({
    from: reply.from_address ?? "",
    subject: reply.subject ?? "",
    headers: reply.headers ?? {},
    text,
  });
  const explanation = bounceExplanation(text);
  const coded = report.status !== null || report.responseCode !== null;
  const kind = coded ? report.senderRejection : senderRejection(null, null, explanation);
  if (!kind) return null;
  const [mailbox] = reply.mailbox_id
    ? await ctx.db
        .select()
        .from(mailboxes)
        .where(
          and(eq(mailboxes.workspace_id, reply.workspace_id), eq(mailboxes.id, reply.mailbox_id)),
        )
        .limit(1)
    : [];
  if (mailbox) {
    const answer = report.diagnostic ?? explanation.replace(/\s+/g, " ").slice(0, 300);
    await applySenderRejection(ctx, {
      mailbox,
      message: await bouncedMessageOf(ctx, reply, report.originalMessageId),
      kind,
      status: report.status,
      reason: [report.status, answer].filter(Boolean).join(" ") || null,
    });
  }
  return { kind, status: report.status };
}
