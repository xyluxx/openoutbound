/**
 * Sends with an unknown outcome (never send twice). A send that may have reached the provider
 * without a clear answer (a timeout or a dropped connection during or after the message data,
 * or a worker that stopped mid-send) becomes `unknown` instead of being retried. It is then
 * reconciled: the email reconcile job looks for its Message-ID in the mailbox's Sent folder,
 * LinkedIn reads the live profile or conversation. When that cannot tell, a `send_unknown`
 * problem asks a person, who settles it with `manage_messages` action `resolve_unknown`.
 *
 * These helpers are shared by the email and LinkedIn paths.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { OpContext } from "../../core/context.js";
import type { MessageStatus } from "../../core/enums.js";
import { type Mailbox, type Message, messages, type Workspace } from "../../db/schema/index.js";
import { withTransaction } from "../../runtime/context.js";
import { openProblem, resolveProblemsFor } from "../problems/service.js";

/** Lookups (one per reconcile run, about 10 minutes apart) before the engine decides. */
export const RECONCILE_CHECKS = 3;

/** Why a message found `sending` when its job starts became `unknown`. */
export const INTERRUPTED_REASON = "the previous attempt stopped while sending";

/** Dedupe key of a message's `send_unknown` problem. */
export function sendUnknownKey(messageId: string): string {
  return `send_unknown:${messageId}`;
}

/** Google Workspace's SMTP relay: it never saves what it relays in the sender's Sent folder. */
const NEVER_KEEPS_COPIES = new Set(["smtp-relay.gmail.com"]);

/**
 * Whether the mailbox's server is proven to keep a copy of what it sends in the Sent folder:
 * true once the engine found one of its own emails there (`sent_copies_seen_at`), false for
 * servers known never to (smtp-relay.gmail.com), else null (not proven). Only a proven server
 * makes a copy that is still missing after the lookups a proof that the email never left; the
 * provider alone (Google, Microsoft) is a hint, never a proof.
 */
export function savesSentCopies(
  mailbox: Pick<Mailbox, "sent_copies_seen_at" | "smtp">,
): boolean | null {
  const host = (mailbox.smtp?.host ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (NEVER_KEEPS_COPIES.has(host)) return false;
  return mailbox.sent_copies_seen_at ? true : null;
}

/**
 * The `why` of a message whose send failed, with `failed_before_handover` set: true when
 * nothing was handed over or the provider refused it (it did not go out), false when it may
 * have gone out (only visits and likes, which are done at least once by design).
 */
export function failedWhy(beforeHandover: boolean) {
  return sql`coalesce(${messages.why}, '{}'::jsonb) || jsonb_build_object('failed_before_handover', ${beforeHandover}::boolean)`;
}

/**
 * Runs the writes that record a send in one transaction. `eventsJoin` tells `fn` whether its
 * context's events are written in that transaction too (engine and test contexts), so
 * `message.sent` commits with the status change; otherwise `fn` emits after the commit.
 */
export async function withSendTransaction<T>(
  ctx: OpContext,
  fn: (tx: OpContext, eventsJoin: boolean) => Promise<T>,
): Promise<T> {
  return withTransaction(ctx, (tx) => fn(tx, tx.events !== ctx.events));
}

/** The context itself, or a copy scoped to `workspace` (problems need `ctx.workspace`). */
export function inWorkspace<T extends OpContext>(ctx: T, workspace: Workspace): T {
  return ctx.workspace?.id === workspace.id ? ctx : { ...ctx, workspace };
}

/**
 * What a send job's write expects the message to still be: queued (`scheduled`), or claimed by
 * one send attempt (`sending` with that attempt number). Every write of the email and LinkedIn
 * send jobs checks it, so a late result of an earlier attempt never lands on a message another
 * attempt claimed, and a message that moved on (cancelled, sent) is never brought back.
 */
export type SendHold = { status: "scheduled" } | SendClaim;

/** The claim of one send attempt. */
export type SendClaim = { status: "sending"; attempt: number };

export const QUEUED: SendHold = { status: "scheduled" };

/**
 * Matches the message only while it is still as the writer expects (see `SendHold`). A claim no
 * longer holds once a late answer showed an earlier attempt went out
 * (`why.earlier_attempt_went_out`): only recording the send applies then (duplicate-sends.ts).
 */
export function stillHeld(messageId: string, hold: SendHold) {
  return and(
    eq(messages.id, messageId),
    eq(messages.status, hold.status),
    ...(hold.status === "sending"
      ? [
          eq(messages.attempt, hold.attempt),
          sql`(${messages.why} ->> 'earlier_attempt_went_out') is null`,
        ]
      : []),
  );
}

/** The message to mark, with the send attempt the caller claimed or read (`attempt`). */
type UnknownTarget = Pick<Message, "id" | "workspace_id" | "channel" | "attempt">;

/**
 * Moves a message to `unknown` (only from the `from` statuses, default `sending`, and only
 * while its `attempt` is still the one the caller claimed or read), restarts its reconcile
 * count and emits `message.unknown`. Returns false when the message had already moved on
 * (settled, or claimed by another attempt meanwhile), so callers never act twice, and when a
 * late answer showed an earlier attempt went out (`why.earlier_attempt_went_out`): the message
 * is not unknown then, the caller records it as sent (duplicate-sends.ts).
 */
export async function markSendUnknown(
  ctx: OpContext,
  message: UnknownTarget,
  reason: string,
  from: readonly MessageStatus[] = ["sending"],
): Promise<boolean> {
  const rows = await ctx.db
    .update(messages)
    .set({ status: "unknown", error: `unknown: ${reason}`.slice(0, 1000), reconcile_checks: 0 })
    .where(
      and(
        eq(messages.id, message.id),
        inArray(messages.status, [...from]),
        eq(messages.attempt, message.attempt),
        sql`(${messages.why} ->> 'earlier_attempt_went_out') is null`,
      ),
    )
    .returning({ id: messages.id });
  if (rows.length === 0) return false;
  await ctx.events.emit("message.unknown", {
    workspaceId: message.workspace_id,
    subject: { type: "message", id: message.id },
    data: { message_id: message.id, channel: message.channel, reason: reason.slice(0, 500) },
  });
  return true;
}

/** Counts one more lookup of an `unknown` message and returns the new count (0 when it moved on). */
export async function countReconcileCheck(ctx: OpContext, messageId: string): Promise<number> {
  const [row] = await ctx.db
    .update(messages)
    .set({ reconcile_checks: sql`${messages.reconcile_checks} + 1` })
    .where(and(eq(messages.id, messageId), eq(messages.status, "unknown")))
    .returning({ checks: messages.reconcile_checks });
  return row?.checks ?? 0;
}

/** Stops further automatic lookups of an `unknown` message (a person decides now). */
export async function stopReconciling(ctx: OpContext, messageId: string): Promise<void> {
  await ctx.db
    .update(messages)
    .set({ reconcile_checks: sql`greatest(${messages.reconcile_checks}, ${RECONCILE_CHECKS})` })
    .where(and(eq(messages.id, messageId), eq(messages.status, "unknown")));
}

/** True when the engine already sent this message again once after an unknown outcome. */
export function wasResentAfterUnknown(message: Pick<Message, "why">): boolean {
  return Boolean(message.why?.resent_after_unknown);
}

/**
 * A resend after an unknown outcome that still waits in the queue: a copy of the earlier try
 * found now confirms that try as sent, and the resend is dropped.
 */
export function isQueuedResend(message: Pick<Message, "status" | "why">): boolean {
  return message.status === "scheduled" && wasResentAfterUnknown(message);
}

/**
 * Puts an `unknown` message back to `scheduled` (at `at`, default now: email plans it with
 * `planEmailResend`) and marks the resend in `why.resent_after_unknown`; the caller enqueues
 * the channel's job. The Message-ID and the time the try that may have gone out was handed over
 * (`dispatch_started_at`) stay, so a copy of that try that turns up while the resend waits still
 * confirms it (`isQueuedResend`). False when the message is no longer unknown from the attempt
 * the caller read.
 */
export async function rescheduleUnknown(
  ctx: OpContext,
  message: Pick<Message, "id" | "why" | "attempt">,
  note: string,
  at?: Date,
): Promise<boolean> {
  const now = ctx.clock.now();
  const rows = await ctx.db
    .update(messages)
    .set({
      status: "scheduled",
      scheduled_for: at ?? now,
      reconcile_checks: 0,
      why: sql`coalesce(${messages.why}, '{}'::jsonb) || jsonb_build_object('resent_after_unknown', ${now.toISOString()}::text)`,
      error: `resend: ${note}`.slice(0, 1000),
    })
    .where(
      and(
        eq(messages.id, message.id),
        eq(messages.status, "unknown"),
        eq(messages.attempt, message.attempt),
      ),
    )
    .returning({ id: messages.id });
  return rows.length > 0;
}

/** Plain words of a `send_unknown` problem. */
export interface UnknownProblemText {
  title: string;
  reason: string;
  remedy: string;
}

/** Opens (or refreshes) the message's `send_unknown` problem: high severity, for a person. */
export async function openSendUnknownProblem(
  ctx: OpContext,
  message: Pick<Message, "id" | "person_id" | "company_id" | "channel">,
  text: UnknownProblemText,
  data: Record<string, unknown> = {},
): Promise<{ id: string; created: boolean }> {
  return openProblem(ctx, {
    kind: "send_unknown",
    severity: "high",
    owner: "person",
    ...text,
    subject: { type: "message", id: message.id },
    personId: message.person_id,
    companyId: message.company_id,
    data: { message_id: message.id, channel: message.channel, ...data },
    dedupeKey: sendUnknownKey(message.id),
  });
}

/** The email `send_unknown` problem: which mailbox, recipient and subject, and what to check. */
export async function openEmailUnknownProblem(
  ctx: OpContext,
  message: Pick<
    Message,
    "id" | "person_id" | "company_id" | "channel" | "to_address" | "subject" | "mailbox_id"
  >,
  mailboxEmail: string,
  detail: string,
): Promise<{ id: string; created: boolean }> {
  const to = message.to_address ?? "the recipient";
  const subject = (message.subject ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  return openSendUnknownProblem(
    ctx,
    message,
    {
      title: "Check whether an email went out",
      reason: `The email from ${mailboxEmail} to ${to} (subject "${subject || "no subject"}") may or may not have gone out: ${detail}. The engine will not send it again on its own.`,
      remedy: `Look in the Sent folder of ${mailboxEmail}, then use manage_messages action resolve_unknown with outcome sent or resend (message_id ${message.id}).`,
    },
    { mailbox_id: message.mailbox_id, to_address: message.to_address },
  );
}

/** Resolves the message's `send_unknown` problem, if one is open. Returns how many were resolved. */
export async function resolveSendUnknownProblem(
  ctx: OpContext,
  messageId: string,
  resolution: string,
): Promise<number> {
  return resolveProblemsFor(ctx, { dedupeKey: sendUnknownKey(messageId) }, resolution);
}
