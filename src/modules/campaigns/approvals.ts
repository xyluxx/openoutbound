import { and, eq, inArray } from "drizzle-orm";
import { type ApprovalDecision, type OpContext, requireWorkspace } from "../../core/context.js";
import { REVIEW_LEVELS } from "../../core/enums.js";
import { OpenOutboundError } from "../../core/errors.js";
import type { ApprovalApplyResult, ApprovalResolver } from "../../core/operation.js";
import {
  type Approval,
  campaigns,
  enrollments,
  type Message,
  messages,
} from "../../db/schema/index.js";
import { resendUnknownMessage } from "../email/service.js";
import { enrollPeople } from "./enrollment.js";
import { activateCampaign } from "./launch.js";
import { applyCampaignUpdate, lowerCommentReview } from "./operations/campaigns.js";
import { launchFingerprint } from "./operations/lifecycle.js";
import { findMessage, loadCampaign } from "./repo.js";
import { approveAndSchedule, changedFields, skipForReview } from "./sequencer/channel-step.js";
import { loadStepStateForMessage } from "./sequencer/load.js";

function editsFrom(edits: Record<string, unknown> | undefined): {
  subject?: string;
  body?: string;
} {
  const out: { subject?: string; body?: string } = {};
  if (typeof edits?.subject === "string") out.subject = edits.subject;
  if (typeof edits?.body === "string") out.body = edits.body;
  return out;
}

/**
 * What happens to an approved message, from the status planning returned: scheduled now, or
 * waiting for a reason (`waiting:outside_window`, `waiting:no_capacity`, ...) that a person can
 * act on or simply wait out.
 */
export function approvedOutcome(status: string, messageId: string): string {
  if (status === "scheduled")
    return "Approved and scheduled inside the recipient's sending window.";
  const reason = status.replace(/^waiting:/, "");
  if (reason.startsWith("campaign_"))
    return "Approved; it will be scheduled when the campaign runs again.";
  switch (reason) {
    case "outside_window":
    case "outside_hours":
      return `Approved; the send window is closed now, so it goes out on its own when the window opens (${status}).`;
    case "no_capacity":
      return `Approved; it goes out on its own when a sender has capacity again (${status}).`;
    case "workspace_paused":
      return `Approved; the workspace is paused, so it goes out once the workspace is resumed (${status}).`;
    default:
      return `Approved, but not scheduled yet (${status}). See why with explain_blocker (message_id ${messageId}; CLI: openoutbound operating explain --message-id ${messageId}).`;
  }
}

/**
 * A request to send a message with an unknown outcome again (`messages.resolve_unknown`
 * outcome resend by someone who must ask): approve queues it once, as a person's own resend
 * would, while it is still unknown from the attempt the request was made for; reject leaves it
 * unknown. A resend sends the message as it is, so it takes no edits.
 */
async function applyResend(
  ctx: OpContext,
  approval: Approval,
  decision: ApprovalDecision,
  message: Message,
): Promise<ApprovalApplyResult> {
  const target = { type: "message", id: message.id };
  if (decision.decision === "edit") {
    throw new OpenOutboundError(
      "validation_failed",
      "A resend sends the message as it is, so there is nothing to edit.",
      { hint: "Approve or reject it with review_items action decide." },
    );
  }
  if (decision.decision === "reject") {
    return {
      message:
        "Not sent again: the message stays unknown. Settle it with manage_messages action resolve_unknown (outcome sent or cancel).",
      target,
    };
  }
  if (message.status !== "unknown" || message.attempt !== Number(approval.payload.attempt)) {
    return { message: `The message is ${message.status} now; nothing to apply.`, target };
  }
  const asker = approval.requested_by?.name ?? "someone";
  const by = `${asker}, approved by ${decision.decidedBy.name}`;
  if (!(await resendUnknownMessage(ctx, message, by))) {
    const now = await findMessage(ctx, message.id);
    return { message: `The message is ${now?.status ?? "gone"} now; nothing to apply.`, target };
  }
  return {
    message:
      "Queued again with the same Message-ID: it goes out at the next time its mailbox or account may send.",
    target,
    data: { status: "scheduled" },
  };
}

/**
 * `message` approvals: approve (optionally with subject/body edits) plans and queues the
 * message; reject cancels it and skips the step (the sequence continues). A `resend` request
 * sends an unknown message again (see `applyResend`). Idempotent.
 */
export const messageResolver: ApprovalResolver = {
  kind: "message",
  apply: async (ctx, approval, decision): Promise<ApprovalApplyResult> => {
    // The target the request named (edits never change it), not a payload field.
    const messageId = String(approval.target_id ?? approval.payload.message_id ?? "");
    const target = { type: "message", id: messageId };
    const message = messageId ? await findMessage(ctx, messageId) : null;
    if (!message) return { message: "The message no longer exists; nothing to do.", target };
    if (approval.payload.action === "resend") {
      return applyResend(ctx, approval, decision, message);
    }
    const state = await loadStepStateForMessage(ctx, message);
    if (decision.decision === "reject") {
      if (state) await skipForReview(ctx, state, message, "rejected");
      else {
        await ctx.db
          .update(messages)
          .set({ status: "cancelled", error: "rejected" })
          .where(
            and(
              eq(messages.id, message.id),
              inArray(messages.status, ["draft", "pending_review", "approved"]),
            ),
          );
      }
      return { message: "Rejected: the step is skipped and the sequence continues.", target };
    }
    if (!state) {
      const paused = await loadStepStateForMessage(ctx, message, { paused: true });
      if (paused) {
        // Paused (an out-of-office, for example): the sequencer applies this approval as soon as
        // the enrollment runs again.
        await ctx.db
          .update(enrollments)
          .set({ next_run_at: ctx.clock.now() })
          .where(and(eq(enrollments.id, paused.enrollment.id), eq(enrollments.status, "paused")));
        return {
          message:
            "Approved; the person's sequence is paused, so it is scheduled when it runs again.",
          target,
        };
      }
      return {
        message: `The enrollment is no longer waiting for this message (status ${message.status}); nothing was sent.`,
        target,
      };
    }
    // What goes out is the text the approval shows, with the approver's edits: never a change
    // made to the message after the request (an edit asks again with a new request).
    const edits = { ...editsFrom(approval.payload), ...editsFrom(decision.edits) };
    const edited = Object.keys(changedFields(message, editsFrom(decision.edits))).length > 0;
    const status = await approveAndSchedule(ctx, state, message, {
      approvalId: approval.id,
      edits,
    });
    const outcome = approvedOutcome(status, message.id);
    return {
      message: edited
        ? `${outcome} Teach the campaign from this edit with preview_campaign action teach (message_ids).`
        : outcome,
      target,
      data: { status, edited },
    };
  },
};

/**
 * `campaign_launch` approvals (agents launching when the workspace requires approval). The
 * approval launches the campaign only as the request showed it: a change to its settings, steps,
 * offer, senders or enrolled people since answers `conflict` and launches nothing.
 */
export const campaignLaunchResolver: ApprovalResolver = {
  kind: "campaign_launch",
  apply: async (ctx, approval, decision): Promise<ApprovalApplyResult> => {
    const campaignId = String(approval.target_id ?? approval.payload.campaign_id ?? "");
    const target = { type: "campaign", id: campaignId };
    if (decision.decision === "reject") {
      return { message: "Launch rejected; the campaign stays as it was.", target };
    }
    const loaded = await loadCampaign(ctx, campaignId);
    if (approval.payload.fingerprint !== (await launchFingerprint(ctx, loaded))) {
      throw new OpenOutboundError(
        "conflict",
        `Campaign "${loaded.campaign.name}" changed since the launch was requested (its settings, steps, offer, senders or enrolled people), so this approval no longer shows it; ask again.`,
        {
          hint: "Reject this approval, then launch it again with launch_campaign (dry_run: true first): the new request shows the campaign as it is now.",
          details: { campaign_id: loaded.campaign.id },
        },
      );
    }
    const result = await activateCampaign(ctx, campaignId);
    return {
      message: result.launched
        ? "Campaign launched; queued leads start within a minute."
        : `Not launched: ${result.reason}`,
      target,
      data: { launched: result.launched, status: result.status },
    };
  },
};

/**
 * `review_level` approvals: someone who must ask lowered a campaign's review level and the rest
 * of their update already applied. Approve (or edit review_level first) applies the level as a
 * campaign update by the decider; reject keeps the current level. One that targets a step
 * (`campaign_step`) switches a LinkedIn comment step from review always to level.
 */
export const reviewLevelResolver: ApprovalResolver = {
  kind: "review_level",
  apply: async (ctx, approval, decision): Promise<ApprovalApplyResult> => {
    if (approval.target_type === "campaign_step") {
      const stepId = String(approval.target_id ?? "");
      const target = { type: "campaign_step", id: stepId };
      if (decision.decision === "reject") {
        return { message: "Rejected: every comment of the step is still reviewed.", target };
      }
      return { message: await lowerCommentReview(ctx, stepId), target };
    }
    const campaignId = String(approval.target_id ?? approval.payload.campaign_id ?? "");
    const target = { type: "campaign", id: campaignId };
    if (decision.decision === "reject") {
      return { message: "Rejected: the campaign keeps its review level.", target };
    }
    const level = approval.payload.review_level;
    if (typeof level !== "string" || !(REVIEW_LEVELS as readonly string[]).includes(level)) {
      throw new OpenOutboundError(
        "validation_failed",
        `review_level must be one of ${REVIEW_LEVELS.join(", ")}.`,
        {
          hint: "Edit review_level to every, first or unsure, then decide again with review_items.",
          details: { field: "review_level" },
        },
      );
    }
    const workspace = requireWorkspace(ctx);
    const [campaign] = await ctx.db
      .select({ id: campaigns.id, status: campaigns.status })
      .from(campaigns)
      .where(and(eq(campaigns.workspace_id, workspace.id), eq(campaigns.id, campaignId)));
    if (!campaign) return { message: "The campaign no longer exists; nothing changed.", target };
    if (campaign.status === "archived" || campaign.status === "completed") {
      return { message: `The campaign is ${campaign.status}; nothing changed.`, target };
    }
    await applyCampaignUpdate(
      ctx,
      campaign.id,
      { settings: { review_level: level } },
      { approved: true },
    );
    return {
      message: `The campaign's review level is now ${level}.`,
      target,
      data: { campaign_id: campaign.id, review_level: level },
    };
  },
};

/** `enrollment` approvals (automations or referrals asking to enroll people). */
export const enrollmentResolver: ApprovalResolver = {
  kind: "enrollment",
  apply: async (ctx, approval, decision): Promise<ApprovalApplyResult> => {
    const campaignId = String(approval.target_id ?? approval.payload.campaign_id ?? "");
    const ids = Array.isArray(approval.payload.person_ids)
      ? approval.payload.person_ids.map(String)
      : approval.payload.person_id
        ? [String(approval.payload.person_id)]
        : [];
    const target = { type: "campaign", id: campaignId };
    if (decision.decision === "reject" || !campaignId || ids.length === 0) {
      return { message: "Nobody was enrolled.", target };
    }
    const outcome = await enrollPeople(ctx, {
      campaignId,
      personIds: ids,
      source: typeof approval.payload.source === "string" ? approval.payload.source : "approval",
    });
    return {
      message: `Enrolled ${outcome.enrolled}, skipped ${outcome.skipped}.`,
      target,
      data: { enrolled: outcome.enrolled, skipped: outcome.skipped, by_reason: outcome.by_reason },
    };
  },
};
