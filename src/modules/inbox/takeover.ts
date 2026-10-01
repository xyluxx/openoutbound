/**
 * Thread ownership. A person who answers a thread themselves (a reply found in the mailbox's
 * Sent folder, or `reply_to_thread` action `take_over`) takes it over and the engine steps
 * back: the thread's unsent engine messages are cancelled (`superseded_by_person`) with their
 * approvals, the person's running sequences stop, and no AI draft or automatic reply is made
 * until the thread is handed back (`releaseThread`). Classification, stop rules and the
 * attention flag keep working, and an explicit reply (reply_to_thread action send) still goes.
 */
import { and, eq, ne } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { notFound } from "../../core/errors.js";
import { type Thread, threads } from "../../db/schema/index.js";
import { stopEnrollmentsForPerson } from "../campaigns/service.js";
import { cancelUnsentForThread, SUPERSEDED_BY_PERSON } from "./stale-replies.js";

/** Stop reason of the sequences of a person whose thread was taken over. */
export const PERSON_TOOK_OVER = "person_took_over";
/** Why the engine made no draft or automatic reply: a person answers this thread. */
export const THREAD_OWNED_BY_PERSON = "thread_owned_by_person";

async function loadThread(ctx: OpContext, threadId: string): Promise<Thread> {
  const workspace = requireWorkspace(ctx);
  const [thread] = await ctx.db
    .select()
    .from(threads)
    .where(and(eq(threads.id, threadId), eq(threads.workspace_id, workspace.id)))
    .limit(1);
  if (!thread) throw notFound("Thread", threadId);
  return thread;
}

/**
 * A person takes the thread over (see module doc). `messageId` is the message they wrote, when
 * one triggered it. Emits `thread.taken_over` when the owner changes and for every message a
 * person wrote, so listeners see each one. Returns whether the owner changed and how many
 * unsent engine messages were cancelled. Safe to call again.
 */
export async function takeOverThread(
  ctx: OpContext,
  threadId: string,
  input: { messageId?: string | null; reason?: string } = {},
): Promise<{ changed: boolean; cancelled: number }> {
  const thread = await loadThread(ctx, threadId);
  const changedRows = await ctx.db
    .update(threads)
    .set({ owner: "person", owner_changed_at: ctx.clock.now() })
    .where(and(eq(threads.id, thread.id), ne(threads.owner, "person")))
    .returning({ id: threads.id });
  const changed = changedRows.length > 0;

  const cancelled = await cancelUnsentForThread(ctx, thread.id);
  for (const id of cancelled) {
    await ctx.approvals.cancel({ target: { type: "message", id } }, SUPERSEDED_BY_PERSON);
  }
  // Follow-ups of a sequence would talk over the person: their running sequences stop too.
  const stopped = thread.person_id
    ? await stopEnrollmentsForPerson(ctx, { personId: thread.person_id, reason: PERSON_TOOK_OVER })
    : 0;

  const messageId = input.messageId ?? null;
  if (changed || messageId) {
    await ctx.events.emit("thread.taken_over", {
      subject: { type: "thread", id: thread.id },
      data: { thread_id: thread.id, person_id: thread.person_id, message_id: messageId },
    });
  }
  if (changed || cancelled.length > 0 || stopped > 0) {
    ctx.log.info(
      {
        thread_id: thread.id,
        reason: input.reason ?? null,
        cancelled: cancelled.length,
        stopped_enrollments: stopped,
      },
      "inbox: a person took the thread over",
    );
  }
  return { changed, cancelled: cancelled.length };
}

/**
 * Hands a thread back to the engine: AI drafts and automatic replies resume with the next
 * message from the prospect. Emits `thread.released` when the owner changed. Stopped
 * sequences stay stopped.
 */
export async function releaseThread(
  ctx: OpContext,
  threadId: string,
): Promise<{ changed: boolean }> {
  const thread = await loadThread(ctx, threadId);
  const rows = await ctx.db
    .update(threads)
    .set({ owner: "engine", owner_changed_at: ctx.clock.now() })
    .where(and(eq(threads.id, thread.id), eq(threads.owner, "person")))
    .returning({ id: threads.id });
  if (rows.length === 0) return { changed: false };
  await ctx.events.emit("thread.released", {
    subject: { type: "thread", id: thread.id },
    data: { thread_id: thread.id },
  });
  return { changed: true };
}

/** True when a person owns the thread (read fresh, for checks right before acting). */
export async function isThreadOwnedByPerson(ctx: OpContext, threadId: string): Promise<boolean> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select({ owner: threads.owner })
    .from(threads)
    .where(and(eq(threads.id, threadId), eq(threads.workspace_id, workspace.id)))
    .limit(1);
  return row?.owner === "person";
}
