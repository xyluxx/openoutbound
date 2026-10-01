import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import { type OpContext, requireWorkspace } from "../../../core/context.js";
import { CHANNELS, MESSAGE_STATUSES, type MessageStatus } from "../../../core/enums.js";
import { OpenOutboundError } from "../../../core/errors.js";
import { idSchema } from "../../../core/ids.js";
import {
  awaitingApproval,
  awaitingApprovalOutput,
  defineOperation,
  paginated,
  paginationInput,
} from "../../../core/operation.js";
import { decodeCursor, toPage } from "../../../core/pagination.js";
import { approvals, enrollments, type Message, messages } from "../../../db/schema/index.js";
import { mustRequestApproval } from "../../../runtime/approval-rule.js";
import { withTransaction } from "../../../runtime/context.js";
import { findMessage, getMessage, loadCampaign } from "../repo.js";
import {
  EXAMPLE_CAMPAIGN_ID,
  EXAMPLE_MESSAGE_ID,
  messageOutput,
  toMessageOutput,
} from "../schemas.js";
import { requestReviewAgain, withOriginal } from "../sequencer/channel-step.js";
import { enqueueGeneration } from "../sequencer/generate.js";
import { loadStepStateForMessage } from "../sequencer/load.js";
import { checkEditedText } from "../writing/pipeline.js";

const messageId = idSchema("msg").describe("Message id (msg_...)");

const EDITABLE: MessageStatus[] = ["draft", "pending_review", "approved"];
const CANCELLABLE: MessageStatus[] = [
  "generating",
  "draft",
  "pending_review",
  "approved",
  "scheduled",
];

function notCampaignMessage(message: Message): OpenOutboundError {
  return new OpenOutboundError(
    "unsupported",
    `Message ${message.id} is not an outbound campaign message.`,
    { hint: "Replies to prospects are handled with reply_to_thread." },
  );
}

function changedWhileEditing(): OpenOutboundError {
  return new OpenOutboundError("conflict", "The message changed while editing.", {
    hint: "Get it again with manage_messages action get and retry.",
  });
}

async function pendingApprovalId(ctx: OpContext, id: string): Promise<string | null> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.workspace_id, workspace.id),
        eq(approvals.target_type, "message"),
        eq(approvals.target_id, id),
        eq(approvals.status, "pending"),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

async function wake(ctx: OpContext, message: Message): Promise<void> {
  if (!message.enrollment_id) return;
  await ctx.db
    .update(enrollments)
    .set({ next_run_at: ctx.clock.now(), status: "active" })
    .where(
      and(
        eq(enrollments.id, message.enrollment_id),
        inArray(enrollments.status, ["active", "waiting_review"]),
      ),
    );
}

const detailOutput = messageOutput.extend({
  approval_id: z.string().nullable().describe("Pending approval for this message, if any"),
});

export const listMessages = defineOperation({
  id: "messages.list",
  summary: "List campaign messages (drafts, reviews, scheduled, sent)",
  description:
    "Lists outbound campaign messages, newest first, filtered by campaign, enrollment, person, status or channel. Use it to find drafts waiting for review (status pending_review), check what was scheduled or sent, or audit a sequence. Concise format omits bodies; use response_format detailed or messages.get for text, why and check. Inbound replies live in list_threads.",
  effect: "read",
  input: paginationInput.extend({
    campaign_id: z.string().optional(),
    enrollment_id: z.string().optional(),
    person_id: z.string().optional(),
    status: z.array(z.enum(MESSAGE_STATUSES)).optional(),
    channel: z.enum(CHANNELS).optional(),
  }),
  output: paginated(messageOutput),
  http: { method: "GET", path: "/v1/messages" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Drafts waiting for review",
      input: { campaign_id: EXAMPLE_CAMPAIGN_ID, status: ["pending_review"] },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const conditions = [
      eq(messages.workspace_id, workspace.id),
      eq(messages.direction, "outbound"),
      // Emails a person wrote from the mailbox itself are in list_threads, not here.
      eq(messages.origin, "engine"),
    ];
    if (input.campaign_id) conditions.push(eq(messages.campaign_id, input.campaign_id));
    if (input.enrollment_id) conditions.push(eq(messages.enrollment_id, input.enrollment_id));
    if (input.person_id) conditions.push(eq(messages.person_id, input.person_id));
    if (input.status?.length) conditions.push(inArray(messages.status, input.status));
    if (input.channel) conditions.push(eq(messages.channel, input.channel));
    if (input.cursor) {
      conditions.push(lt(messages.id, String(decodeCursor<{ id: string }>(input.cursor).id)));
    }
    const rows = await ctx.db
      .select()
      .from(messages)
      .where(and(...conditions))
      .orderBy(desc(messages.id))
      .limit(input.limit + 1);
    const detailed = ctx.request.responseFormat === "detailed";
    return toPage(
      rows,
      input.limit,
      (row) => ({ id: row.id }),
      (row) => toMessageOutput(row, detailed),
    );
  },
});

export const getMessageOp = defineOperation({
  id: "messages.get",
  summary: "Get one campaign message with text, why and checks",
  description:
    "Returns one outbound campaign message with subject, body, why (angle, facts with sources, signals used) and the check result (verdict, confidence, issues), plus the pending approval id when it waits for review. Use it to review a draft before approving (review_items) or to understand why a message says what it says. For prospect replies use list_threads.",
  effect: "read",
  input: z.object({ message_id: messageId }),
  output: detailOutput,
  http: { method: "GET", path: "/v1/messages/:message_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "One message", input: { message_id: EXAMPLE_MESSAGE_ID } }],
  handler: async (ctx, input) => {
    const message = await getMessage(ctx, input.message_id);
    return {
      ...toMessageOutput(message, true),
      approval_id: await pendingApprovalId(ctx, message.id),
    };
  },
});

export const updateMessage = defineOperation({
  id: "messages.update",
  summary: "Edit a campaign message's subject or body before it is sent",
  description:
    "Edits the subject and/or body of a campaign message that is not scheduled yet (draft, pending_review or approved) and re-runs the automatic checks; the original AI draft is kept so preview_campaign action teach can learn from the edit. Use it to fix a draft instead of rejecting it. A new text from anyone but a person holding the approve scope goes to a person's review (awaiting_approval, kind message), and so does one whose checks fail: the message is back in pending_review, even when a person approved the earlier text, and nothing is sent meanwhile; a person holding approve updates a pending review in place. Scheduled or sent messages cannot be edited (cancel instead), and a reply in a thread that waits for review or was approved is changed with reply_to_thread action send.",
  effect: "write",
  input: z.object({
    message_id: messageId,
    subject: z.string().min(1).max(200).optional(),
    body: z.string().min(1).max(5000).optional(),
  }),
  output: z.union([detailOutput, awaitingApprovalOutput]),
  http: { method: "PATCH", path: "/v1/messages/:message_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Shorter subject",
      input: { message_id: EXAMPLE_MESSAGE_ID, subject: "missed calls at lunch" },
    },
  ],
  handler: async (ctx, input) => {
    const message = await getMessage(ctx, input.message_id);
    if (message.direction !== "outbound" || !message.campaign_id) throw notCampaignMessage(message);
    if (!EDITABLE.includes(message.status)) {
      throw new OpenOutboundError(
        "conflict",
        `Message ${message.id} is ${message.status} and can no longer be edited.`,
        { hint: "Cancel it with manage_messages action cancel, or regenerate a draft." },
      );
    }
    if (input.subject === undefined && input.body === undefined) {
      throw new OpenOutboundError("validation_failed", "Pass subject and/or body.", {
        hint: 'For example { message_id, body: "..." }.',
      });
    }
    const subject = input.subject ?? message.subject;
    const body = input.body ?? message.body_text ?? "";
    const changed = subject !== message.subject || body !== (message.body_text ?? "");
    // One approval rule (spec 2): only a person holding approve changes the text without a
    // person's review.
    const ask = changed && mustRequestApproval(ctx.principal);
    if (ask && !message.step_id && message.status !== "draft") {
      throw new OpenOutboundError(
        "conflict",
        `Message ${message.id} is a reply in a thread that ${message.status === "approved" ? "a person approved" : "waits for a person's review"}, so a new text needs a new approval.`,
        {
          hint: "Send the new text with reply_to_thread action send (thread_id, message_id and text): it asks a person to approve it.",
        },
      );
    }
    const loaded = await loadCampaign(ctx, message.campaign_id);
    const step = loaded.steps.find((candidate) => candidate.id === message.step_id);
    const check = step
      ? checkEditedText({
          step,
          settings: loaded.settings,
          subject,
          body,
          firstTouch: !(await hasEarlierText(ctx, message)),
          isReply: Boolean(message.thread_id || message.in_reply_to),
        })
      : message.check;
    const why = withOriginal(message, `edited by ${ctx.principal.name}`);
    // A step message goes back to review when someone who must ask changed its text, or when an
    // approved text was changed into one that fails its checks (a draft that fails them goes to
    // review at the sequencer's next look, and a pending one is in review already).
    const failed = changed && check?.passed === false && message.status === "approved";
    if (message.step_id && (ask || failed)) {
      const approvalId = await withTransaction(ctx, async (tx) => {
        const [held] = await tx.db
          .update(messages)
          .set({
            subject,
            body_text: body,
            check,
            why,
            status: "pending_review",
            scheduled_for: null,
          })
          .where(and(eq(messages.id, message.id), inArray(messages.status, EDITABLE)))
          .returning();
        if (!held) throw changedWhileEditing();
        return requestReviewAgain(
          tx,
          held,
          `${ctx.principal.name} changed the text${message.status === "approved" ? " after it was approved" : ""}.`,
        );
      });
      if (ask) {
        return awaitingApproval(
          approvalId,
          `The new text waits for a person's review (review_items) and is not sent until a person with the approve scope approves it. Checks: ${check?.passed === false ? `failed (${check.issues.length} issue(s))` : "passed"}.`,
        );
      }
      const current = await getMessage(ctx, message.id);
      return { ...toMessageOutput(current, true), approval_id: approvalId };
    }
    const [updated] = await ctx.db
      .update(messages)
      .set({ subject, body_text: body, check, why })
      .where(and(eq(messages.id, message.id), inArray(messages.status, EDITABLE)))
      .returning();
    if (!updated) throw changedWhileEditing();
    const approvalId = await pendingApprovalId(ctx, message.id);
    if (approvalId) {
      const [approval] = await ctx.db
        .select({ payload: approvals.payload })
        .from(approvals)
        .where(eq(approvals.id, approvalId));
      await ctx.db
        .update(approvals)
        .set({ payload: { ...(approval?.payload ?? {}), subject, body, check } })
        .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")));
    }
    return { ...toMessageOutput(updated, true), approval_id: approvalId };
  },
});

async function hasEarlierText(ctx: OpContext, message: Message): Promise<boolean> {
  if (!message.enrollment_id) return false;
  const rows = await ctx.db
    .select({ body: messages.body_text })
    .from(messages)
    .where(
      and(
        eq(messages.enrollment_id, message.enrollment_id),
        eq(messages.direction, "outbound"),
        eq(messages.status, "sent"),
      ),
    );
  return rows.some((row) => Boolean(row.body?.trim()));
}

export const regenerateMessage = defineOperation({
  id: "messages.regenerate",
  summary: "Rewrite a draft with the writing pipeline (optionally with an extra instruction)",
  description:
    "Discards the current text of a campaign message that is not scheduled yet and writes it again in the background (same lead, step and variant), with an optional extra instruction such as 'lead with the hiring post'. Any pending approval is cancelled; the new draft follows the review level again. Use it when a draft is off; for small fixes edit it with manage_messages action update. Costs one more AI run.",
  effect: "write",
  input: z.object({
    message_id: messageId,
    instruction: z.string().max(500).optional().describe("Extra instruction for this rewrite"),
  }),
  output: z.object({
    message_id: z.string(),
    status: z.enum(MESSAGE_STATUSES),
    job_id: z.string(),
  }),
  http: { method: "POST", path: "/v1/messages/:message_id/regenerate" },
  dryRun: "none",
  idempotent: false,
  workspace: "required",
  examples: [
    {
      title: "Different angle",
      input: { message_id: EXAMPLE_MESSAGE_ID, instruction: "Lead with the new location opening." },
    },
  ],
  handler: async (ctx, input) => {
    const message = await getMessage(ctx, input.message_id);
    if (message.direction !== "outbound" || !message.campaign_id) throw notCampaignMessage(message);
    if (
      !["draft", "pending_review", "approved", "generating", "skipped"].includes(message.status) ||
      message.scheduled_for
    ) {
      throw new OpenOutboundError(
        "conflict",
        `Message ${message.id} is ${message.status} and cannot be regenerated.`,
        { hint: "Only drafts, reviews and unscheduled approved messages can be rewritten." },
      );
    }
    if (message.status === "skipped" && !(await loadStepStateForMessage(ctx, message))) {
      throw new OpenOutboundError(
        "conflict",
        `Message ${message.id} was skipped and its sequence has moved on.`,
        { hint: "Fix the lead's data; the next steps will use it." },
      );
    }
    if (message.status === "pending_review") {
      await ctx.approvals.cancel({ target: { type: "message", id: message.id } }, "regenerated");
    }
    const isReply = Boolean(message.thread_id || message.in_reply_to);
    await ctx.db
      .update(messages)
      .set({
        status: "generating",
        body_text: null,
        check: null,
        variant: null,
        error: null,
        ...(isReply ? {} : { subject: null }),
      })
      .where(eq(messages.id, message.id));
    const { jobId } = await enqueueGeneration(ctx, message.id, input.instruction ?? null);
    await wake(ctx, message);
    return { message_id: message.id, status: "generating" as const, job_id: jobId };
  },
});

export const cancelMessage = defineOperation({
  id: "messages.cancel",
  summary: "Cancel a campaign message that has not been sent",
  description:
    "Cancels a campaign message before it is sent (generating, draft, pending review, approved or scheduled); its pending approval is cancelled and the sequence skips that step and continues. Use it to drop one touch for one person. To stop the whole sequence for them use enroll_leads action unenroll; to hold a campaign use launch_campaign action pause. A message already being sent cannot be recalled.",
  effect: "write",
  input: z.object({ message_id: messageId }),
  output: z.object({ message_id: z.string(), status: z.enum(MESSAGE_STATUSES) }),
  http: { method: "POST", path: "/v1/messages/:message_id/cancel" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Cancel", input: { message_id: EXAMPLE_MESSAGE_ID } }],
  handler: async (ctx, input) => {
    const message = await getMessage(ctx, input.message_id);
    if (message.direction !== "outbound" || !message.campaign_id) throw notCampaignMessage(message);
    if (message.status === "cancelled") return { message_id: message.id, status: message.status };
    if (!CANCELLABLE.includes(message.status)) {
      throw new OpenOutboundError(
        "conflict",
        `Message ${message.id} is ${message.status} and cannot be cancelled.`,
        { hint: "Sent messages cannot be recalled." },
      );
    }
    const updated = await ctx.db
      .update(messages)
      .set({ status: "cancelled", error: "cancelled_by_user" })
      .where(and(eq(messages.id, message.id), inArray(messages.status, CANCELLABLE)))
      .returning({ status: messages.status });
    if (message.status === "pending_review") {
      await ctx.approvals.cancel({ target: { type: "message", id: message.id } }, "cancelled");
    }
    await wake(ctx, message);
    const current =
      updated[0]?.status ?? (await findMessage(ctx, message.id))?.status ?? "cancelled";
    return { message_id: message.id, status: current };
  },
});
