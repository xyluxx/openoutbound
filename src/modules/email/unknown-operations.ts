/**
 * `messages.resolve_unknown`: a person settles a send whose outcome is unknown (the engine could
 * not tell whether it went out and will not send it again on its own). Exposed as the
 * `resolve_unknown` action of manage_messages, so the campaigns module registers it. Sending it
 * again is a gate (spec 2, rule 4): anyone but a person holding approve gets an approval of
 * kind `message` (payload action `resend`), which the campaigns message resolver applies with
 * `resendUnknownMessage`.
 */
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { CHANNELS, MESSAGE_STATUSES } from "../../core/enums.js";
import { forbidden, notFound, OpenOutboundError } from "../../core/errors.js";
import { idSchema } from "../../core/ids.js";
import {
  awaitingApproval,
  awaitingApprovalOutput,
  defineOperation,
  dryRun,
  dryRunOutput,
} from "../../core/operation.js";
import { enrollments, type Message, messages } from "../../db/schema/index.js";
import { mustRequestApproval } from "../../runtime/approval-rule.js";
import { enqueueAction } from "../linkedin/service.js";
import { confirmLinkedInSent } from "../linkedin/unknown-actions.js";
import { SEND_JOB, sendJobKey } from "./queue.js";
import { confirmEmailSent, planEmailResend } from "./send-job.js";
import {
  rescheduleUnknown,
  resolveSendUnknownProblem,
  wasResentAfterUnknown,
} from "./unknown-sends.js";

export const RESOLVE_OUTCOMES = ["sent", "resend", "cancel"] as const;
export type ResolveOutcome = (typeof RESOLVE_OUTCOMES)[number];

const EXAMPLE_MESSAGE_ID = "msg_01k6a3v0q8x3m2n4p5r6s7t8v9";

const resolvedOutput = z.object({
  message_id: z.string(),
  channel: z.enum(CHANNELS),
  outcome: z.enum(RESOLVE_OUTCOMES),
  status: z
    .enum(MESSAGE_STATUSES)
    .describe(
      "Status now: sent, scheduled (it goes out again at the next time its mailbox or account may send) or cancelled",
    ),
  changed: z.boolean().describe("False when the message was already settled this way"),
});

const resolvePreview = z.object({
  message_id: z.string(),
  channel: z.enum(CHANNELS),
  to: z.string().nullable().describe("Recipient address (null for LinkedIn)"),
  subject: z.string().nullable(),
  outcome: z.enum(RESOLVE_OUTCOMES),
  effect: z.string().describe("What resolving it this way does"),
});

const EFFECTS: Record<ResolveOutcome, string> = {
  sent: "Counts it as sent when its dispatch started; the sequence moves on and the problem is resolved.",
  resend:
    "Puts it back in the queue with the same Message-ID; it goes out again after the normal checks and limits, and the problem is resolved.",
  cancel: "Cancels it without sending; the sequence skips this step and the problem is resolved.",
};

export const resolveUnknownOperation = defineOperation({
  id: "messages.resolve_unknown",
  summary: "Settle a message the engine could not tell was sent",
  description:
    "Settles an outbound message with status unknown (the send got no clear answer, so the engine will not send it again on its own): outcome sent records it as sent, resend puts it back in the queue once more, cancel drops it. Use it after a person looked in the mailbox's Sent folder (or the LinkedIn conversation), as the send_unknown problem asks. Do not use it for drafts or scheduled messages: cancel those with manage_messages action cancel. Resending needs the send scope, can deliver the message twice if it did go out, and waits for a person's approval (awaiting_approval, kind message; the message stays unknown until then) unless a person holding the approve scope asks; try it with dry_run first.",
  effect: "write",
  input: z.object({
    message_id: idSchema("msg").describe("Message id (msg_...) with status unknown"),
    outcome: z
      .enum(RESOLVE_OUTCOMES)
      .describe("sent = it went out; resend = it did not, send it again; cancel = do not send it"),
    note: z.string().max(300).optional().describe("What was checked, kept with the resolution"),
  }),
  output: z.union([resolvedOutput, awaitingApprovalOutput, dryRunOutput(resolvePreview)]),
  http: { method: "POST", path: "/v1/messages/:message_id/resolve_unknown" },
  dryRun: "supported",
  idempotent: false,
  workspace: "required",
  examples: [
    {
      title: "Found in the Sent folder",
      input: {
        message_id: EXAMPLE_MESSAGE_ID,
        outcome: "sent",
        note: "It is in the Sent folder, sent at 10:02.",
      },
    },
    {
      title: "Not in the Sent folder: send it again",
      input: { message_id: EXAMPLE_MESSAGE_ID, outcome: "resend" },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const [message] = await ctx.db
      .select()
      .from(messages)
      .where(and(eq(messages.id, input.message_id), eq(messages.workspace_id, workspace.id)))
      .limit(1);
    if (!message) throw notFound("Message", input.message_id);
    if (message.direction !== "outbound" || message.origin !== "engine") {
      throw new OpenOutboundError(
        "unsupported",
        `Message ${message.id} was not sent by the engine, so it has no send to settle.`,
        { hint: "Use manage_messages action list with status unknown to find the ones to settle." },
      );
    }
    const outcome = input.outcome;
    if (message.status !== "unknown") {
      // Already settled the way asked: safe to repeat.
      if (settledAs(message, outcome)) return resolved(message, outcome, false);
      throw new OpenOutboundError(
        "conflict",
        `Message ${message.id} is ${message.status}, not unknown: only a send with an unknown outcome can be settled.`,
        {
          hint: "Find the ones to settle with manage_messages action list (status unknown), or cancel an unsent message with manage_messages action cancel.",
          details: { status: message.status },
        },
      );
    }
    if (outcome === "resend" && !ctx.principal.scopes.includes("send")) throw forbidden("send");
    // Sending again is a gate: only a person holding approve resends without asking.
    const ask = outcome === "resend" && mustRequestApproval(ctx.principal);

    if (ctx.request.dryRun) {
      const warnings: string[] = [];
      if (outcome === "resend") {
        warnings.push(
          "If the first send did go out, the person gets this message twice. Resend only after checking the Sent folder or the conversation.",
        );
        if (wasResentAfterUnknown(message)) {
          warnings.push("It was already sent again once after an earlier unknown outcome.");
        }
        if (ask) {
          warnings.push(
            "Sending it again waits for a person's approval (review_items): only a person holding the approve scope resends directly. The message stays unknown until then.",
          );
        }
      }
      return dryRun(
        {
          message_id: message.id,
          channel: message.channel,
          to: message.to_address,
          subject: message.subject,
          outcome,
          effect: EFFECTS[outcome],
        },
        { warnings },
      );
    }

    const by = input.note ? `${ctx.principal.name} (${input.note.trim()})` : ctx.principal.name;
    switch (outcome) {
      case "sent": {
        const resolution = `Confirmed as sent by ${by}.`;
        const confirmed =
          message.channel === "email"
            ? await confirmEmailSent(ctx, message.id, { resolution })
            : await confirmLinkedInSent(ctx, message.id, { resolution });
        if (!confirmed) throw changedMeanwhile(message);
        await cancelResendRequests(ctx, message, "settled as sent");
        return resolved({ ...message, status: "sent" }, outcome, true);
      }
      case "resend": {
        if (ask) return requestResendApproval(ctx, message);
        if (!(await resendUnknownMessage(ctx, message, by))) throw changedMeanwhile(message);
        return resolved({ ...message, status: "scheduled" }, outcome, true);
      }
      case "cancel": {
        const rows = await ctx.db
          .update(messages)
          .set({ status: "cancelled", error: `cancelled: outcome unknown, not sent again (${by})` })
          .where(and(eq(messages.id, message.id), eq(messages.status, "unknown")))
          .returning({ id: messages.id });
        if (rows.length === 0) throw changedMeanwhile(message);
        await resolveSendUnknownProblem(ctx, message.id, `Cancelled by ${by}; not sent again.`);
        await cancelResendRequests(ctx, message, "cancelled, not sent again");
        await wakeEnrollment(ctx, message);
        return resolved({ ...message, status: "cancelled" }, outcome, true);
      }
    }
  },
});

/**
 * Puts a message with an unknown outcome back in the queue once, at a person's decision: an
 * email when its mailbox may send next (the send window, the daily cap), a LinkedIn action at
 * once (its job keeps to the account's hours), with the same Message-ID. Resolves the
 * `send_unknown` problem. Shared by a person's direct resend and the approval of an agent's
 * request. False when the message is no longer unknown from the attempt read.
 */
export async function resendUnknownMessage(
  ctx: OpContext,
  message: Message,
  by: string,
): Promise<boolean> {
  const workspace = requireWorkspace(ctx);
  const at =
    message.channel === "email" ? await planEmailResend(ctx, workspace, message) : ctx.clock.now();
  if (!(await rescheduleUnknown(ctx, message, `requested by ${by}`, at))) return false;
  if (message.channel === "email") {
    await ctx.jobs.enqueue(
      SEND_JOB,
      { message_id: message.id },
      { workspaceId: workspace.id, runAt: at, singletonKey: sendJobKey(message.id) },
    );
  } else {
    await enqueueAction(ctx, message.id, at);
  }
  await resolveSendUnknownProblem(ctx, message.id, `Sent again at the request of ${by}.`);
  return true;
}

/**
 * Asks a person to approve sending an unknown message again (kind `message`, action `resend`,
 * for the attempt read). The message stays unknown and nothing is queued until they decide; a
 * newer request for the message replaces an older one.
 */
async function requestResendApproval(ctx: OpContext, message: Message) {
  const subject = (message.subject ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  const what =
    message.channel === "email"
      ? `the email to ${message.to_address ?? "the recipient"}${subject ? ` (subject "${subject}")` : ""}`
      : `the LinkedIn ${message.action}`;
  const check =
    message.channel === "email"
      ? "the Sent folder of its mailbox"
      : "the person's LinkedIn profile or conversation";
  const summary = `${ctx.principal.name} asked to send ${what} again. Its first try got no clear answer, so it may have arrived already: check ${check} first. Approve to queue it once more after the usual checks and limits; reject to leave it unknown.`;
  const { id } = await ctx.approvals.request({
    kind: "message",
    title:
      message.channel === "email"
        ? "Send an email again"
        : `Send a LinkedIn ${message.action} again`,
    summary,
    payload: { message_id: message.id, action: "resend", attempt: message.attempt },
    target: { type: "message", id: message.id },
    supersede: true,
  });
  return awaitingApproval(
    id,
    `Sending ${message.id} again waits for a person with the approve scope (review_items). It stays unknown and nothing is queued until then.`,
  );
}

/** A message settled another way: a resend request for it has nothing left to apply. */
async function cancelResendRequests(ctx: OpContext, message: Message, reason: string) {
  await ctx.approvals.cancel(
    { kind: "message", target: { type: "message", id: message.id } },
    reason,
  );
}

function settledAs(message: Message, outcome: ResolveOutcome): boolean {
  return (
    (outcome === "sent" && message.status === "sent") ||
    (outcome === "cancel" && message.status === "cancelled")
  );
}

function resolved(message: Message, outcome: ResolveOutcome, changed: boolean) {
  return {
    message_id: message.id,
    channel: message.channel,
    outcome,
    status: message.status,
    changed,
  };
}

function changedMeanwhile(message: Message): OpenOutboundError {
  return new OpenOutboundError(
    "conflict",
    `Message ${message.id} changed while it was being settled (it may have been confirmed from the Sent folder).`,
    { hint: "Check it with manage_messages action get before trying again." },
  );
}

/** A cancelled step message: the sequence skips the step at once instead of at its next check. */
async function wakeEnrollment(ctx: OpContext, message: Message): Promise<void> {
  if (!message.enrollment_id) return;
  await ctx.db
    .update(enrollments)
    .set({ next_run_at: ctx.clock.now() })
    .where(
      and(
        eq(enrollments.id, message.enrollment_id),
        inArray(enrollments.status, ["active", "waiting_review"]),
      ),
    );
}
