import { and, eq, inArray } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { notFound, OpenOutboundError } from "../../core/errors.js";
import { mailboxes, messages, people } from "../../db/schema/index.js";

export const SEND_JOB = "email.send";

/**
 * Wait key of send jobs held on a mailbox that cannot send (paused, in error, disconnected):
 * woken when it sends again (a resume, a clean test, an OAuth reconnect) or is removed.
 */
export function mailboxActiveKey(mailboxId: string): string {
  return `mailbox_active:${mailboxId}`;
}

/** Singleton key of a message's send job (namespaced: other jobs may key on message ids). */
export function sendJobKey(messageId: string): string {
  return `${SEND_JOB}:${messageId}`;
}

/**
 * Queues an `approved` email that has `mailbox_id` and `scheduled_for`: fills the from and to
 * addresses, sets status `scheduled` (which reserves the mailbox capacity for that day) and
 * enqueues `email.send` at the scheduled time. Idempotent for messages already scheduled.
 */
export async function queueEmailSend(ctx: OpContext, messageId: string): Promise<void> {
  const workspace = requireWorkspace(ctx);
  const [message] = await ctx.db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.workspace_id, workspace.id)))
    .limit(1);
  if (!message) throw notFound("Message", messageId);
  if (message.channel !== "email" || message.direction !== "outbound") {
    throw new OpenOutboundError(
      "validation_failed",
      `Message ${messageId} is not an outbound email.`,
      {
        hint: "Only outbound email messages can be queued for sending.",
      },
    );
  }
  if (["sending", "unknown", "sent"].includes(message.status)) return;
  if (message.status === "scheduled") {
    await enqueueSend(ctx, workspace.id, message.id, message.scheduled_for ?? ctx.clock.now());
    return;
  }
  if (message.status !== "approved") {
    throw new OpenOutboundError(
      "conflict",
      `Message ${messageId} is ${message.status}; only approved messages can be queued.`,
      {
        hint: "Approve the message first (review_items), then queue it again.",
        details: { status: message.status },
      },
    );
  }
  if (!message.mailbox_id || !message.scheduled_for) {
    throw new OpenOutboundError(
      "validation_failed",
      `Message ${messageId} has no mailbox or send time.`,
      {
        hint: "Plan the send with planEmailSend and set mailbox_id and scheduled_for before queueing.",
      },
    );
  }
  const [mailbox] = await ctx.db
    .select()
    .from(mailboxes)
    .where(and(eq(mailboxes.id, message.mailbox_id), eq(mailboxes.workspace_id, workspace.id)))
    .limit(1);
  if (!mailbox) throw notFound("Mailbox", message.mailbox_id);

  let to = message.to_address?.trim().toLowerCase() || null;
  if (!to && message.person_id) {
    const [person] = await ctx.db
      .select({ email: people.email })
      .from(people)
      .where(and(eq(people.id, message.person_id), eq(people.workspace_id, workspace.id)))
      .limit(1);
    to = person?.email?.trim().toLowerCase() || null;
  }
  if (!to) {
    throw new OpenOutboundError(
      "validation_failed",
      `Message ${messageId} has no recipient address.`,
      {
        hint: "Set to_address on the message or give the person an email (enrich_leads) first.",
      },
    );
  }

  const [updated] = await ctx.db
    .update(messages)
    .set({ status: "scheduled", to_address: to, from_address: mailbox.email, error: null })
    .where(and(eq(messages.id, message.id), inArray(messages.status, ["approved"])))
    .returning({ id: messages.id, scheduled_for: messages.scheduled_for });
  if (!updated) return; // queued concurrently
  await enqueueSend(ctx, workspace.id, message.id, message.scheduled_for);
}

async function enqueueSend(
  ctx: OpContext,
  workspaceId: string,
  messageId: string,
  runAt: Date,
): Promise<void> {
  await ctx.jobs.enqueue(
    SEND_JOB,
    { message_id: messageId },
    { workspaceId, runAt, singletonKey: sendJobKey(messageId) },
  );
}
