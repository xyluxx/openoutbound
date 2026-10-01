/**
 * The next action of a relationship: the earliest of the next scheduled or approved message,
 * the next due sequence step, a pending draft or approval, an open task (promises included) or
 * an upcoming meeting. Items without a time come last.
 */
import type { Channel, MessageAction, StepType, TaskType } from "../../core/enums.js";
import type { Message } from "../../db/schema/index.js";
import { stepChannel } from "../campaigns/steps.js";
import { whenInWords } from "./blockers.js";
import type { EnrollmentWithCampaign, RelationshipFacts } from "./relationship-data.js";

export const NEXT_ACTION_KINDS = [
  "send_message",
  "review",
  "send_draft",
  "write_message",
  "campaign_step",
  "task",
  "meeting",
] as const;
export type NextActionKind = (typeof NEXT_ACTION_KINDS)[number];

/** What happens next for a person (binding shape from the upgrade plan, plus `ref`). */
export interface NextAction {
  kind: NextActionKind;
  /** ISO 8601, or null when it waits for something without a time. */
  due_at: string | null;
  channel: Channel | null;
  campaign_id: string | null;
  /** Plain words. */
  reason: string;
  /** The record behind it (message, enrollment, task, meeting or opportunity). */
  ref: { type: string; id: string } | null;
}

const RANK: Record<NextActionKind, number> = {
  send_message: 0,
  review: 1,
  send_draft: 2,
  write_message: 3,
  campaign_step: 4,
  task: 5,
  meeting: 6,
};

const STEP_WORDS: Record<StepType, string> = {
  email: "email",
  linkedin_visit: "LinkedIn profile visit",
  linkedin_like: "LinkedIn like",
  linkedin_comment: "LinkedIn comment",
  linkedin_invite: "LinkedIn invitation",
  linkedin_message: "LinkedIn message",
  wait: "wait",
  condition: "condition",
  task: "task",
  webhook: "webhook",
};

const LINKEDIN_WORDS: Partial<Record<MessageAction, string>> = {
  invite: "LinkedIn invitation",
  message: "LinkedIn message",
  visit: "LinkedIn profile visit",
  like: "LinkedIn like",
  comment: "LinkedIn comment",
};

const TASK_CHANNELS: Partial<Record<TaskType, Channel>> = {
  manual_email: "email",
  linkedin: "linkedin",
};

interface Candidate extends NextAction {
  at: number | null;
}

function messageWords(message: Message, campaign: string | null): string {
  const what =
    message.channel === "email"
      ? message.action === "reply"
        ? "A reply"
        : "An email"
      : `A ${LINKEDIN_WORDS[message.action] ?? "LinkedIn action"}`;
  return campaign ? `${what} (campaign ${campaign})` : what;
}

function campaignName(facts: RelationshipFacts, campaignId: string | null): string | null {
  if (!campaignId) return null;
  return facts.enrollments.find((row) => row.campaign.id === campaignId)?.campaign.name ?? null;
}

function messageCandidate(
  facts: RelationshipFacts,
  message: Message,
  now: Date,
  zone: string,
): Candidate {
  const what = messageWords(message, campaignName(facts, message.campaign_id));
  const base = {
    channel: message.channel,
    campaign_id: message.campaign_id,
    ref: { type: "message", id: message.id },
  };
  const when = (at: Date) => whenInWords(at, zone, now);
  switch (message.status) {
    case "scheduled":
    case "sending":
    case "unknown": {
      const at = message.scheduled_for ?? message.updated_at;
      const reason =
        message.status === "scheduled"
          ? `${what} is scheduled for ${when(at)}.`
          : message.status === "sending"
            ? `${what} is being sent.`
            : `${what} may have gone out; it is checked before any new try.`;
      return { ...base, kind: "send_message", at: at.getTime(), due_at: null, reason };
    }
    case "approved": {
      const paused = facts.enrollments.find(
        (row) => row.enrollment.id === message.enrollment_id && row.enrollment.status === "paused",
      )?.enrollment;
      const at = message.scheduled_for ?? paused?.paused_until ?? null;
      const reason = paused
        ? `${what} is approved and waits for the paused sequence${paused.paused_until ? ` (until ${when(paused.paused_until)})` : ""}.`
        : `${what} is approved and waits to be scheduled.`;
      return { ...base, kind: "send_message", at: at?.getTime() ?? null, due_at: null, reason };
    }
    case "pending_review": {
      const approval = facts.approvals.get(message.id);
      const at = approval?.created_at ?? message.created_at;
      return {
        ...base,
        kind: "review",
        at: at.getTime(),
        due_at: null,
        reason: `${what} waits for approval since ${when(at)}.`,
        ref: approval ? { type: "approval", id: approval.id } : base.ref,
      };
    }
    case "draft":
      return {
        ...base,
        kind: "send_draft",
        at: message.created_at.getTime(),
        due_at: null,
        reason: `${what} is a draft nobody has sent or submitted.`,
      };
    default:
      return {
        ...base,
        kind: "write_message",
        at: message.created_at.getTime(),
        due_at: null,
        reason: `${what} is being written.`,
      };
  }
}

function stepCandidate(row: EnrollmentWithCampaign, now: Date, zone: string): Candidate | null {
  const { enrollment, campaign, step } = row;
  const words = step ? STEP_WORDS[step.type] : "next step";
  const position = enrollment.current_step + 1;
  const base = {
    kind: "campaign_step" as const,
    channel: step ? stepChannel(step.type) : null,
    campaign_id: campaign.id,
    due_at: null,
    ref: { type: "enrollment", id: enrollment.id },
  };
  const when = (at: Date) => whenInWords(at, zone, now);
  switch (enrollment.status) {
    case "active": {
      const at = enrollment.next_run_at;
      return {
        ...base,
        at: at?.getTime() ?? null,
        reason: at
          ? `Step ${position} (${words}) of campaign ${campaign.name} is due ${when(at)}.`
          : `Step ${position} (${words}) of campaign ${campaign.name} has no time set.`,
      };
    }
    case "paused": {
      const at = enrollment.paused_until;
      return {
        ...base,
        at: at?.getTime() ?? null,
        reason: `Step ${position} (${words}) of campaign ${campaign.name} waits for the paused sequence${at ? ` (until ${when(at)})` : ""}.`,
      };
    }
    case "queued":
      return {
        ...base,
        at: null,
        reason: `Waits to start campaign ${campaign.name}, which adds a limited number of new leads each day.`,
      };
    default:
      return null;
  }
}

/** The next action of a relationship, or null when nothing is planned. */
export function pickNextAction(
  facts: RelationshipFacts,
  now: Date,
  zone: string,
): NextAction | null {
  const candidates: Candidate[] = [];
  for (const message of facts.openMessages) {
    candidates.push(messageCandidate(facts, message, now, zone));
  }
  const withMessage = new Set(facts.openMessages.map((message) => message.enrollment_id));
  for (const row of facts.enrollments) {
    if (withMessage.has(row.enrollment.id)) continue;
    const candidate = stepCandidate(row, now, zone);
    if (candidate) candidates.push(candidate);
  }
  for (const task of facts.tasks) {
    candidates.push({
      kind: "task",
      at: task.due_at?.getTime() ?? null,
      due_at: null,
      channel: TASK_CHANNELS[task.type] ?? null,
      campaign_id: task.campaign_id,
      reason: `${task.type === "promise" ? "Promise" : "Task"}: ${task.title}${task.due_at ? ` (due ${whenInWords(task.due_at, zone, now)})` : ""}.`,
      ref: { type: "task", id: task.id },
    });
  }
  if (facts.meetings.length > 0) {
    for (const meeting of facts.meetings) {
      if (meeting.status !== "scheduled" || !meeting.start_at || meeting.start_at <= now) continue;
      candidates.push({
        kind: "meeting",
        at: meeting.start_at.getTime(),
        due_at: null,
        channel: null,
        campaign_id: meeting.campaign_id,
        reason: `Meeting ${whenInWords(meeting.start_at, zone, now)}.`,
        ref: { type: "meeting", id: meeting.id },
      });
    }
  } else {
    // v0.1 data: the booked time lives on the opportunity.
    for (const opportunity of facts.opportunities) {
      const at = opportunity.meeting_at;
      if (opportunity.stage !== "meeting_booked" || !at || at <= now) continue;
      candidates.push({
        kind: "meeting",
        at: at.getTime(),
        due_at: null,
        channel: null,
        campaign_id: opportunity.campaign_id,
        reason: `Meeting ${whenInWords(at, zone, now)}.`,
        ref: { type: "opportunity", id: opportunity.id },
      });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort(
    (a, b) =>
      (a.at ?? Number.POSITIVE_INFINITY) - (b.at ?? Number.POSITIVE_INFINITY) ||
      RANK[a.kind] - RANK[b.kind],
  );
  const { at, ...best } = candidates[0] as Candidate;
  return { ...best, due_at: at === null ? null : new Date(at).toISOString() };
}
