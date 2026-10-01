/** Inbox jobs and event handlers (reply pipeline). CRM sync lives in crm-sync.ts. */
import { and, eq, gt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { REPLY_CATEGORIES } from "../../core/enums.js";
import { defineJob, onEvent } from "../../core/operation.js";
import { messages, threads } from "../../db/schema/index.js";
import { CLASSIFY_JOB, classifyInboundMessage } from "./classify.js";
import { DRAFT_REPLY_JOB, draftReply } from "./draft.js";
import { findMessage, findThread, latestInbound } from "./reply-context.js";
import { REPLY_SEND_MAX_AGE_MS, replyBlockers, SEND_REPLY_JOB, scheduleReplySend } from "./send.js";
import { cancelStaleAutoReplies } from "./stale-replies.js";
import { THREAD_OWNED_BY_PERSON } from "./takeover.js";

export const classifyJob = defineJob({
  name: CLASSIFY_JOB,
  payload: z.object({
    message_id: z.string(),
    force: z.boolean().optional(),
    override_category: z.enum(REPLY_CATEGORIES).optional(),
  }),
  maxAttempts: 5,
  handler: (ctx, payload) =>
    classifyInboundMessage(ctx, payload.message_id, {
      ...(payload.force ? { force: true } : {}),
      ...(payload.override_category ? { overrideCategory: payload.override_category } : {}),
    }),
});

export const draftReplyJob = defineJob({
  name: DRAFT_REPLY_JOB,
  payload: z.object({
    message_id: z.string(),
    auto_send: z.boolean().default(false),
    /** Set by threads.draft_reply when the brain had to wait (agent brain). */
    manual: z.boolean().optional(),
    /**
     * With manual: asked for by the engine itself (a follow-up after a no-show or a cancelled
     * meeting), not by a person, so it steps back when a person owns the thread.
     */
    automatic: z.boolean().optional(),
    instruction: z.string().nullable().optional(),
  }),
  maxAttempts: 4,
  handler: async (ctx, payload) => {
    const inbound = await findMessage(ctx, payload.message_id);
    if (!inbound?.thread_id) return { skipped: "not_found" };
    // They may have opted out (or been erased) since the reply was classified.
    const thread = await findThread(ctx, inbound.thread_id);
    const blockers = await replyBlockers(
      ctx,
      inbound.person_id ?? thread?.person_id,
      inbound.channel,
    );
    if (blockers.length > 0) {
      ctx.log.info(
        { message_id: inbound.id, thread_id: inbound.thread_id, reasons: blockers },
        "inbox: no reply drafted, the person may not be contacted",
      );
      return { skipped: "not_contactable", reasons: blockers };
    }
    if (payload.manual) {
      if (payload.automatic && thread?.owner === "person") {
        return { skipped: THREAD_OWNED_BY_PERSON };
      }
      const result = await draftReply(ctx, {
        inboundMessageId: inbound.id,
        instruction: payload.instruction ?? null,
        autoSend: false,
        ...(payload.automatic ? { automatic: true } : {}),
      });
      return {
        message_id: result.message_id,
        status: result.status,
        approval_id: result.approval_id,
      };
    }
    // A person answers this thread: the engine writes nothing on its own.
    if (thread?.owner === "person") return { skipped: THREAD_OWNED_BY_PERSON };
    const latest = await latestInbound(ctx, inbound.thread_id);
    if (latest && latest.id !== inbound.id) return { skipped: "newer_reply" };
    const [existing] = await ctx.db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.thread_id, inbound.thread_id),
          eq(messages.direction, "outbound"),
          sql`coalesce(${messages.why}->>'notes', '') like 'reply:%'`,
          gt(messages.created_at, inbound.created_at),
          ne(messages.status, "cancelled"),
        ),
      )
      .limit(1);
    if (existing) return { skipped: "already_drafted", message_id: existing.id };
    const result = await draftReply(ctx, {
      inboundMessageId: inbound.id,
      autoSend: payload.auto_send,
      automatic: true,
    });
    return {
      message_id: result.message_id,
      status: result.status,
      approval_id: result.approval_id,
      auto_sent: result.auto_sent,
      blockers: result.blockers,
    };
  },
});

export const sendReplyJob = defineJob({
  name: SEND_REPLY_JOB,
  payload: z.object({ message_id: z.string() }),
  maxAttempts: 5,
  handler: async (ctx, payload) => {
    const message = await findMessage(ctx, payload.message_id);
    if (!message) return { skipped: "not_found" };
    if (message.status !== "approved") return { skipped: `status_${message.status}` };
    if (ctx.clock.now().getTime() - message.updated_at.getTime() > REPLY_SEND_MAX_AGE_MS) {
      // Only while it still waits: a reply planned, sent or cancelled meanwhile stays as it is.
      const expired = await ctx.db
        .update(messages)
        .set({
          status: "failed",
          error: "reply_not_sent_in_time",
          why: sql`coalesce(${messages.why}, '{}'::jsonb) || jsonb_build_object('failed_before_handover', true)`,
        })
        .where(
          and(
            eq(messages.id, message.id),
            eq(messages.workspace_id, message.workspace_id),
            eq(messages.status, "approved"),
          ),
        )
        .returning({ id: messages.id });
      if (expired.length === 0) return { skipped: "status_changed" };
      if (message.thread_id) {
        await ctx.db
          .update(threads)
          .set({ needs_attention: true })
          .where(eq(threads.id, message.thread_id));
      }
      return { status: "failed", reason: "reply_not_sent_in_time" };
    }
    return scheduleReplySend(ctx, message.id, { delay: false, respectWindow: false });
  },
});

export const classifyOnReply = onEvent(
  "reply.received",
  "inbox.classify_reply",
  async (ctx, event) => {
    // Unsent automatic answers to earlier messages are stale now: cancel them before the new
    // message is classified, so it gets a fresh answer (or a human).
    const cancelled = await cancelStaleAutoReplies(ctx, {
      threadId: event.data.thread_id,
      newInboundId: event.data.message_id,
    });
    if (cancelled.length > 0) {
      ctx.log.info(
        { thread: event.data.thread_id, cancelled },
        "inbox: cancelled stale automatic replies after a newer message",
      );
    }
    await ctx.jobs.enqueue(
      CLASSIFY_JOB,
      { message_id: event.data.message_id },
      { singletonKey: `${CLASSIFY_JOB}:${event.data.message_id}` },
    );
  },
);

/** Our message went out after the prospect's last reply: the thread no longer needs attention. */
export const markAnsweredOnSend = onEvent(
  "message.sent",
  "inbox.mark_answered",
  async (ctx, event) => {
    if (!event.data.thread_id) return;
    const thread = await findThread(ctx, event.data.thread_id);
    if (!thread?.needs_attention || !thread.last_inbound_at) return;
    const sentAt = new Date(event.data.sent_at);
    if (Number.isNaN(sentAt.getTime()) || sentAt < thread.last_inbound_at) return;
    await ctx.db
      .update(threads)
      .set({ needs_attention: false, status: "waiting", last_message_at: sentAt })
      .where(eq(threads.id, thread.id));
  },
);
