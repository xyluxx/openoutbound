/**
 * Automatic replies answer one inbound message and may wait for the human-like delay and the
 * next sending window (over a weekend, say). When the prospect writes again before the answer
 * goes out, it is stale: it is cancelled so the new message is classified and answered fresh
 * (a later "is this a bot?" must never get the old AI answer). Replies a human approved or
 * sent are left alone.
 *
 * Automatic replies carry `messages.why.auto_reply_for`: the id of the inbound message they
 * answer. A cancelled one gets `error = "superseded_by:<newer inbound id>"`.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { type Message, messages } from "../../db/schema/index.js";

/** Statuses of an automatic reply that has not started sending. */
const UNSENT = ["draft", "approved", "scheduled"] as const;

export function supersededError(inboundMessageId: string): string {
  return `superseded_by:${inboundMessageId}`;
}

/** Marks an outgoing reply as automatic (sent without human review) for this inbound message. */
export async function markAutoReply(
  ctx: OpContext,
  messageId: string,
  inboundMessageId: string,
): Promise<void> {
  await ctx.db
    .update(messages)
    .set({
      why: sql`coalesce(${messages.why}, '{}'::jsonb) || jsonb_build_object('auto_reply_for', ${inboundMessageId}::text)`,
    })
    .where(eq(messages.id, messageId));
}

/** Removes the automatic marker (the reply goes to human review instead). */
export async function unmarkAutoReply(ctx: OpContext, messageId: string): Promise<void> {
  await ctx.db
    .update(messages)
    .set({ why: sql`${messages.why} - 'auto_reply_for'` })
    .where(eq(messages.id, messageId));
}

/**
 * Cancels the thread's unsent automatic replies that answer an older message than
 * `newInboundId`. One conditional update, so a reply the send job already moved to `sending`
 * is never touched. Returns the cancelled message ids.
 */
export async function cancelStaleAutoReplies(
  ctx: OpContext,
  input: { threadId: string; newInboundId: string },
): Promise<string[]> {
  const workspace = requireWorkspace(ctx);
  const rows = await ctx.db
    .update(messages)
    .set({ status: "cancelled", error: supersededError(input.newInboundId) })
    .where(
      and(
        eq(messages.workspace_id, workspace.id),
        eq(messages.thread_id, input.threadId),
        eq(messages.direction, "outbound"),
        inArray(messages.status, [...UNSENT]),
        sql`${messages.why}->>'auto_reply_for' is not null`,
        // Kept only when it answers this message or a newer one (latestInbound order), so a
        // late or repeated event for an earlier message never cancels the newest answer.
        sql`not exists (
          select 1 from ${messages} as answered, ${messages} as newer
          where answered.id = ${messages.why}->>'auto_reply_for'
            and newer.id = ${input.newInboundId}
            and (answered.created_at, answered.id) >= (newer.created_at, newer.id)
        )`,
      ),
    )
    .returning({ id: messages.id });
  return rows.map((row) => row.id);
}

/** Error of engine messages cancelled because a person took their thread over. */
export const SUPERSEDED_BY_PERSON = "superseded_by_person";

/** Statuses of an engine message that has not started sending. */
const NOT_STARTED = ["generating", "draft", "pending_review", "approved", "scheduled"] as const;

/**
 * Cancels every engine message of the thread that has not started sending (drafts, pending
 * reviews, approved and scheduled messages) with error `superseded_by_person`. One conditional
 * update, so a message the send job already moved to `sending` is never touched. Returns the
 * cancelled message ids.
 */
export async function cancelUnsentForThread(ctx: OpContext, threadId: string): Promise<string[]> {
  const workspace = requireWorkspace(ctx);
  const rows = await ctx.db
    .update(messages)
    .set({ status: "cancelled", error: SUPERSEDED_BY_PERSON })
    .where(
      and(
        eq(messages.workspace_id, workspace.id),
        eq(messages.thread_id, threadId),
        eq(messages.direction, "outbound"),
        eq(messages.origin, "engine"),
        inArray(messages.status, [...NOT_STARTED]),
      ),
    )
    .returning({ id: messages.id });
  return rows.map((row) => row.id);
}

/** Error of reply drafts cancelled because a meeting with the person was recorded or booked. */
export const MEETING_BOOKED = "meeting_booked";

/** Reply drafts that answer a wish to meet, the ones that offer a meeting (`why.notes`). */
const SCHEDULING_DRAFT_NOTES = ["reply:interested", "reply:meeting_request"];

/**
 * Cancels the engine's own reply drafts that wait for review in the person's threads and answer
 * a wish to meet (interested or meeting_request replies), with error `meeting_booked`: a meeting
 * was recorded, booked or moved, so a draft that still offers one is stale. Answers to anything
 * else (a question, an objection) stay for review. Only what the AI wrote and nobody edited (a
 * checker model is stored): never text a person or an agent gave, and never a reply already
 * approved or on its way. One conditional update, like `cancelUnsentForThread`. Returns the
 * cancelled message ids; the caller cancels their approvals.
 */
export async function cancelDraftsForBookedMeeting(
  ctx: OpContext,
  personId: string,
): Promise<string[]> {
  const workspace = requireWorkspace(ctx);
  const rows = await ctx.db
    .update(messages)
    .set({ status: "cancelled", error: MEETING_BOOKED })
    .where(
      and(
        eq(messages.workspace_id, workspace.id),
        eq(messages.person_id, personId),
        eq(messages.direction, "outbound"),
        eq(messages.origin, "engine"),
        inArray(messages.status, ["draft", "pending_review"]),
        inArray(sql<string>`${messages.why}->>'notes'`, SCHEDULING_DRAFT_NOTES),
        sql`${messages.check}->>'checker_model' is not null`,
      ),
    )
    .returning({ id: messages.id });
  return rows.map((row) => row.id);
}

/** The engine messages of the thread that `cancelUnsentForThread` would cancel (dry runs). */
export async function unsentForThread(
  ctx: OpContext,
  threadId: string,
): Promise<Array<Pick<Message, "id" | "status" | "action">>> {
  const workspace = requireWorkspace(ctx);
  return ctx.db
    .select({ id: messages.id, status: messages.status, action: messages.action })
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, workspace.id),
        eq(messages.thread_id, threadId),
        eq(messages.direction, "outbound"),
        eq(messages.origin, "engine"),
        inArray(messages.status, [...NOT_STARTED]),
      ),
    );
}

/** Automatic replies cancelled because this inbound message arrived. */
export async function repliesSupersededBy(
  ctx: OpContext,
  input: { threadId: string; inboundMessageId: string },
): Promise<string[]> {
  const workspace = requireWorkspace(ctx);
  const rows = await ctx.db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, workspace.id),
        eq(messages.thread_id, input.threadId),
        eq(messages.direction, "outbound"),
        eq(messages.status, "cancelled"),
        eq(messages.error, supersededError(input.inboundMessageId)),
      ),
    );
  return rows.map((row) => row.id);
}
