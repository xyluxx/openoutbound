/** Recording a LinkedIn action that went out (the action job, and reconciled unknown actions). */
import { and, eq, sql } from "drizzle-orm";
import type { OpContext } from "../../core/context.js";
import type { MessageStatus } from "../../core/enums.js";
import {
  type LinkedInAccount,
  type Message,
  messages,
  people,
  threads,
} from "../../db/schema/index.js";
import { earlierAttemptWentOut, recordDuplicateSend } from "../email/duplicate-sends.js";
import { resolveSendUnknownProblem, withSendTransaction } from "../email/unknown-sends.js";
import { recordSuccess } from "./accounts.js";
import { bumpCounter } from "./capacity.js";
import type { LinkedInActionKind } from "./limits.js";
import { upsertRelation } from "./relations.js";
import { dayKey } from "./time.js";

export interface LinkedInSent {
  workspaceId: string;
  message: Message;
  /** The attempt this is about: the job's claim, or the attempt the caller read. */
  attempt: number;
  /**
   * The statuses it is recorded from, tried in this order: `sending` (the job's own claim),
   * `unknown` (a late success, or found on LinkedIn), or any status a late answer found the
   * message in (email/duplicate-sends.ts).
   */
  from: readonly MessageStatus[];
  /**
   * False when this attempt did not act itself and the message is recorded as sent because an
   * earlier attempt did (its late answer said so). Default true.
   */
  wentOut?: boolean;
  /** Null when the account was removed meanwhile (no counters, no health). */
  account: LinkedInAccount | null;
  personId: string;
  action: LinkedInActionKind;
  sentAt: Date;
  /** The account's timezone (daily counters). */
  timezone: string;
  /** The conversation thread, when known. */
  threadId: string | null;
  chatId?: string | null;
  providerMessageId?: string | null;
  postId?: string | null;
  memberId?: string | null;
  noteSent?: boolean;
  noteDropped?: boolean;
  /** An invite found accepted by reconciliation: the relation is connected. */
  connected?: boolean;
  /** Resolution of a `send_unknown` problem, when the action was unknown. */
  resolution?: string;
}

/**
 * Records a LinkedIn action that went out: the chat thread for messages, status `sent`, the
 * account's counters, the relation for invites, the person's last contact and `message.sent`,
 * all in one transaction (the event too, where the context's events can join it); then the
 * account's health, and an open `send_unknown` problem is resolved. When a late answer showed
 * that an earlier attempt went out as well, the duplicate is recorded. Only while the message is
 * still in one of the `from` statuses with the same attempt; returns null otherwise (nothing
 * changes).
 */
export async function recordLinkedInSent(
  ctx: OpContext,
  input: LinkedInSent,
): Promise<{ threadId: string | null; fromUnknown: boolean } | null> {
  const { message, account, action, sentAt, workspaceId } = input;
  const day = dayKey(sentAt, input.timezone);
  const sentEvent = (threadId: string | null) =>
    ({
      workspaceId,
      subject: { type: "message", id: message.id },
      data: {
        message_id: message.id,
        thread_id: threadId,
        person_id: input.personId,
        campaign_id: message.campaign_id,
        channel: "linkedin",
        action,
        sent_at: sentAt.toISOString(),
      },
    }) as const;
  const done = await withSendTransaction(ctx, async (txCtx, eventsJoin) => {
    const tx = txCtx.db;
    const values = {
      status: "sent" as const,
      sent_at: sentAt,
      error: null,
      provider_message_id: input.providerMessageId ?? null,
      in_reply_to: input.postId ?? message.in_reply_to,
      ...(input.noteDropped
        ? {
            why: sql`coalesce(${messages.why}, '{}'::jsonb) || jsonb_build_object('note_skipped', 'monthly_note_limit')`,
          }
        : {}),
    };
    let recorded: { status: MessageStatus; why: Message["why"] } | null = null;
    for (const status of input.from) {
      const [row] = await tx
        .update(messages)
        .set(values)
        .where(
          and(
            eq(messages.id, message.id),
            eq(messages.workspace_id, workspaceId),
            eq(messages.status, status),
            eq(messages.attempt, input.attempt),
          ),
        )
        .returning({ id: messages.id, why: messages.why });
      if (row) {
        recorded = { status, why: row.why };
        break;
      }
    }
    if (!recorded) return null;
    const fromUnknown = recorded.status !== "sending";

    let threadId = input.threadId;
    if (action === "message" && input.chatId) {
      if (threadId) {
        await tx
          .update(threads)
          .set({ external_ref: input.chatId, last_message_at: sentAt })
          .where(eq(threads.id, threadId));
      } else {
        const [created] = await tx
          .insert(threads)
          .values({
            workspace_id: workspaceId,
            person_id: input.personId,
            company_id: message.company_id,
            campaign_id: message.campaign_id,
            channel: "linkedin",
            linkedin_account_id: account?.id ?? message.linkedin_account_id,
            external_ref: input.chatId,
            status: "open",
            last_message_at: sentAt,
          })
          .returning({ id: threads.id });
        threadId = created?.id ?? null;
      }
    }
    await tx.update(messages).set({ thread_id: threadId }).where(eq(messages.id, message.id));
    if (account) {
      await bumpCounter(tx, account.id, day, action);
      if (input.noteSent) await bumpCounter(tx, account.id, day, "invite_note");
      if (action === "invite") {
        await upsertRelation(tx, {
          workspaceId,
          accountId: account.id,
          personId: input.personId,
          status: input.connected ? "connected" : "invited",
          invitedAt: sentAt,
          connectedAt: input.connected ? sentAt : null,
          providerRef: input.memberId ?? null,
        });
      }
    }
    if (action === "invite" || action === "message" || action === "comment") {
      await tx
        .update(people)
        .set({ last_contacted_at: sentAt })
        .where(and(eq(people.id, input.personId), eq(people.workspace_id, workspaceId)));
    }
    // The event commits with the status change, so a consumer never misses a send.
    if (eventsJoin) await txCtx.events.emit("message.sent", sentEvent(threadId));
    return { threadId, fromUnknown, recorded, eventsJoin };
  });
  if (!done) return null;
  if (!done.eventsJoin) await ctx.events.emit("message.sent", sentEvent(done.threadId));
  if (account) await recordSuccess(ctx.db, account);
  if (done.fromUnknown) {
    await resolveSendUnknownProblem(
      ctx,
      message.id,
      input.resolution ?? "The LinkedIn action went out after all.",
    );
  }
  const earlier = earlierAttemptWentOut({ why: done.recorded.why, attempt: input.attempt });
  if (earlier !== null && !done.fromUnknown && input.wentOut !== false) {
    // A late answer showed an earlier attempt went out while this one held the message, and
    // this one went out too.
    await recordDuplicateSend(
      ctx,
      { ...message, status: "sent", attempt: input.attempt, why: done.recorded.why },
      { attempts: [earlier, input.attempt], proven: true },
    );
  }
  return { threadId: done.threadId, fromUnknown: done.fromUnknown };
}
