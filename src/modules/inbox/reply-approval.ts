/**
 * Approval resolver for kind `reply`: approve (optionally with edited subject/body) sends
 * the reply through the email or LinkedIn service after the human-like delay; reject cancels
 * the draft. A person who opted out (or was suppressed or erased) while the reply waited gets
 * nothing: the reply is cancelled before it counts as approved. What goes out is the text the
 * approval shows (with the approver's edits), never a later change to the draft. Human-approved
 * replies never get the AI disclosure line.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { ApprovalResolver } from "../../core/operation.js";
import { messages } from "../../db/schema/index.js";
import { withOriginal } from "../campaigns/sequencer/channel-step.js";
import { checkReplyText } from "./checks.js";
import { findMessage } from "./reply-context.js";
import { cancelUncontactableReply, scheduleReplySend } from "./send.js";

/** A reply the approval may still act on: anything else was sent or cancelled meanwhile. */
const OPEN: Array<(typeof messages.$inferSelect)["status"]> = [
  "draft",
  "pending_review",
  "approved",
];

function editedText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** `text` when it differs from what the message holds now, else null. */
function changedText(text: string | null, current: string | null): string | null {
  return text !== null && text !== (current ?? "").trim() ? text : null;
}

export const replyResolver: ApprovalResolver = {
  kind: "reply",
  apply: async (ctx, approval, decision) => {
    // The target the request named (edits never change it), not a payload field.
    const messageId = String(approval.target_id ?? approval.payload.message_id ?? "");
    const message = messageId ? await findMessage(ctx, messageId) : null;
    if (!message || message.workspace_id !== approval.workspace_id) {
      return { message: "The draft no longer exists; nothing was sent." };
    }
    const target = { type: "message", id: message.id };
    if (decision.decision === "reject") {
      await ctx.db
        .update(messages)
        .set({ status: "cancelled" })
        .where(
          and(
            eq(messages.workspace_id, message.workspace_id),
            eq(messages.id, message.id),
            inArray(messages.status, OPEN),
          ),
        );
      return { message: "Reply discarded.", target };
    }
    if (["scheduled", "sending", "unknown", "sent"].includes(message.status)) {
      return { message: "Reply already scheduled.", target };
    }
    if (!OPEN.includes(message.status)) {
      return { message: `Reply not sent: the draft is ${message.status}.`, target };
    }
    // Before anything counts as approved (and message.approved fires): people opt out meanwhile.
    const blocked = await cancelUncontactableReply(ctx, message);
    if (blocked) return { message: `Reply not sent: ${blocked.reason}. ${blocked.hint}`, target };

    // The approver decided on the approval's text (their edits included): that text goes out,
    // also when the draft was changed after the approval was asked for.
    const body = changedText(
      editedText(decision.edits?.body) ?? editedText(approval.payload.body),
      message.body_text,
    );
    const subject =
      message.channel === "email"
        ? changedText(
            editedText(decision.edits?.subject) ?? editedText(approval.payload.subject),
            message.subject,
          )
        : null;
    const reviewerEdited = Boolean(
      editedText(decision.edits?.body) || editedText(decision.edits?.subject),
    );
    if (body || subject) {
      const issues = body
        ? checkReplyText({ body, maxWords: 400, allowedLinks: [], grounding: "" }).filter(
            (issue) =>
              issue.code === "empty" ||
              issue.code === "template_leftover" ||
              issue.code === "placeholder",
          )
        : [];
      await ctx.db
        .update(messages)
        .set({
          ...(body ? { body_text: body } : {}),
          ...(subject ? { subject } : {}),
          ...(reviewerEdited
            ? { why: withOriginal(message, `edited by ${decision.decidedBy.name}`) }
            : {}),
          check: {
            ...(message.check ?? { passed: true, issues: [] }),
            issues: [...(message.check?.issues ?? []), ...issues],
            passed: issues.length === 0,
          },
        })
        .where(
          and(
            eq(messages.workspace_id, message.workspace_id),
            eq(messages.id, message.id),
            inArray(messages.status, OPEN),
          ),
        );
    }
    // Only while the reply still waits: one cancelled meanwhile (a newer message arrived) stays
    // cancelled, and one already queued is never queued twice.
    const [approved] = await ctx.db
      .update(messages)
      .set({ status: "approved" })
      .where(
        and(
          eq(messages.workspace_id, message.workspace_id),
          eq(messages.id, message.id),
          inArray(messages.status, OPEN),
        ),
      )
      .returning({ id: messages.id });
    if (!approved) {
      const now = await findMessage(ctx, message.id);
      return { message: `Reply not sent: the draft is ${now?.status ?? "gone"}.`, target };
    }
    await ctx.events.emit("message.approved", {
      subject: target,
      data: { message_id: message.id, approval_id: approval.id },
    });
    const result = await scheduleReplySend(ctx, message.id, { delay: true, respectWindow: false });
    if (result.status === "scheduled") {
      return {
        message: `Reply scheduled for ${result.send_at.toISOString()}.`,
        target,
        data: { send_at: result.send_at.toISOString() },
      };
    }
    if (result.status === "waiting") {
      return {
        message: `Reply approved; it waits for sending capacity (${result.reason}) until ${result.retry_at.toISOString()}.`,
        target,
        data: { retry_at: result.retry_at.toISOString() },
      };
    }
    return { message: `Reply approved but not sent: ${result.reason}. ${result.hint}`, target };
  },
};
