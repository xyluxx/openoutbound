/**
 * explain_blocker: why a message has not gone out, or where a person stands, in plain words.
 * Never "unknown reason": a closed message shows its stored reason, and when nothing blocks,
 * the answer says so and says what happens next.
 */
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { CHANNELS, MESSAGE_ACTIONS, MESSAGE_STATUSES } from "../../core/enums.js";
import { OpenOutboundError } from "../../core/errors.js";
import { idSchema } from "../../core/ids.js";
import { isoDateTime } from "../../core/operation.js";
import { approvals, type Message, messages, people } from "../../db/schema/index.js";
import { isValidTimeZone } from "../email/timezone.js";
import {
  BLOCKER_TEMPLATES,
  type Blocker,
  type BlockerFacts,
  blocker,
  whenInWords,
} from "./blockers.js";
import { checkEligibility, personName } from "./eligibility.js";
import { getRelationship, type RelationshipState, type RelationshipView } from "./relationship.js";
import { blockerSchema, relationshipViewSchema } from "./schemas.js";

export const explainInput = z.object({
  message_id: idSchema("msg")
    .optional()
    .describe("Explain one outbound message: why it has not gone out (yet)"),
  person_id: idSchema("pe")
    .optional()
    .describe("Explain a person: where they stand, what happens next and what blocks it"),
});

export const explainOutput = z.object({
  subject: z.object({ type: z.enum(["person", "message"]), id: z.string() }),
  summary: z.string().describe("The answer in plain words"),
  blocked: z.boolean(),
  blockers: z.array(blockerSchema),
  next: z.string().describe("What happens next, or what to do"),
  message: z
    .object({
      id: z.string(),
      channel: z.enum(CHANNELS),
      action: z.enum(MESSAGE_ACTIONS),
      status: z.enum(MESSAGE_STATUSES),
      person_id: z.string().nullable(),
      campaign_id: z.string().nullable(),
      scheduled_for: isoDateTime().nullable(),
      sent_at: isoDateTime().nullable(),
      error: z
        .string()
        .nullable()
        .describe("Stored reason as written by the sender; can quote a remote server (untrusted)"),
    })
    .nullable(),
  relationship: relationshipViewSchema.nullable(),
});
type ExplainOutput = z.input<typeof explainOutput>;

const STATE_WORDS: Record<RelationshipState, string> = {
  new: "new: never contacted",
  in_sequence: "in a sequence",
  waiting: "waiting (for a review, a paused sequence or a company hold)",
  in_conversation: "in a conversation",
  meeting_scheduled: "booked for a meeting",
  meeting_held: "past a meeting",
  won: "won",
  lost: "lost",
  not_now: "a not-now: they asked to be contacted later",
  stopped: "stopped: they are never contacted again",
  finished: "finished: the last sequence ended",
};

/** Why a sequence stopped (the reason stored as `enrollment_stopped:<reason>`). */
const STOP_REASONS: Record<string, string> = {
  replied: "they replied",
  company_replied: "someone else at the company replied",
  meeting_booked: "a meeting was booked",
  unsubscribed: "they unsubscribed",
  bounced: "an email bounced",
  unenrolled: "they were taken out of the campaign",
  campaign_stopped: "the campaign was stopped",
  campaign_completed: "the campaign was completed",
  campaign_archived: "the campaign was archived",
  person_took_over: "a person took over the conversation",
  completed: "it had run all its steps",
  missing_data: "data the step needs was missing",
  person_removed: "the person was deleted or forgotten",
  manual: "someone stopped it",
};

/** Short reason codes the sequencer, the review flow and the senders store on a message. */
const STORED_REASONS: Record<string, string> = {
  rejected: "a reviewer rejected it",
  approval_rejected: "a reviewer rejected it",
  approval_expired: "the review expired before anyone decided",
  approval_cancelled: "the review was cancelled",
  cancelled_by_user: "someone cancelled it",
  generation_failed: "the AI could not write it",
  reply_not_sent_in_time: "the reply was not sent in time, so it was dropped",
  "account removed": "its LinkedIn account was removed",
  no_recent_post: "the person has no recent post to comment on",
  superseded_by_person: "a person took over the conversation",
  campaign_completed: "its campaign had ended",
  campaign_archived: "its campaign was archived",
};

const BOUNCES: Array<{ prefix: string; detail: string | null; fix?: string }> = [
  { prefix: "hard_bounce: ", detail: null },
  {
    prefix: "soft_bounce: ",
    detail: "a temporary delivery failure; the engine does not send it again",
  },
  {
    prefix: "sender_rejected: ",
    detail: "the receiving server refused the sending mailbox, not the address",
    fix: "Check the sending mailbox with manage_mailboxes action check_dns (mailbox_id of the message).",
  },
];

function stopWords(reason: string): string {
  const known = STOP_REASONS[reason];
  if (known) return known;
  if (reason.startsWith("company_")) {
    return `of a colleague at the company (${reason.slice("company_".length).replace(/_/g, " ")})`;
  }
  return reason.replace(/_/g, " ");
}

/**
 * A closed message's stored reason in words: the blocker codes the senders write, the short
 * reason codes, else the stored text itself. Never empty, never "unknown reason".
 */
export function errorBlockers(
  message: Message,
  facts: BlockerFacts,
  inferred: string | null = null,
): Blocker[] {
  const stored = (message.error ?? "").trim();
  const error = stored.replace(/^(?:skipped|cancelled):\s*/, "");
  const closed: BlockerFacts = { ...facts, until: null };
  const hard = { hard: true } as const;
  const fallback = (detail: string | null) =>
    blocker(`message_${message.status}`, { ...closed, detail }, hard);

  const contact = /^not_contactable:\s*(.*)$/.exec(error);
  if (contact) {
    const codes = (contact[1] ?? "")
      .split(/[,\s]+/)
      .filter((code) => code.length > 0 && code !== "unknown");
    if (codes.length === 0) return [fallback("the person could not be contacted when it was due")];
    return codes.map((code) => blocker(code, closed, hard));
  }
  if (message.status === "bounced") {
    const bounce = BOUNCES.find((item) => error.startsWith(item.prefix));
    return [
      blocker(
        "message_bounced",
        { ...closed, detail: bounce?.detail ?? null },
        bounce?.fix ? { hard: true, fix: bounce.fix } : hard,
      ),
    ];
  }
  const stopped = /^enrollment_stopped:(.+)$/.exec(error);
  if (stopped?.[1]) return [fallback(`the sequence stopped because ${stopWords(stopped[1])}`)];
  if (error.startsWith("superseded_by:")) {
    return [
      fallback("the prospect wrote again before it went out, so the newer message gets the answer"),
    ];
  }
  const variables = /^Unresolved template variables:\s*([^.]+)/.exec(error);
  if (variables?.[1]) {
    return [blocker("unresolved_variables", { ...closed, detail: variables[1] }, hard)];
  }
  if (error === "The message has no subject.") return [blocker("message_no_subject", closed, hard)];
  if (error === "The message body is empty.") return [blocker("empty_message", closed, hard)];
  const note = /^note_too_long:\s*(.+)$/.exec(error);
  if (note?.[1]) return [blocker("note_too_long", { ...closed, detail: note[1] }, hard)];
  if (BLOCKER_TEMPLATES[error]) return [blocker(error, closed, hard)];
  const words = STORED_REASONS[error];
  if (words) return [fallback(words)];
  return [fallback(error || inferred || "no reason was stored with it")];
}

/** Words for a closed message that has no stored reason (reviews and forgets store none). */
async function missingReason(
  ctx: OpContext,
  message: Message,
  personKnown: boolean,
): Promise<string | null> {
  if (message.error?.trim()) return null;
  const [approval] = await ctx.db
    .select({ status: approvals.status })
    .from(approvals)
    .where(
      and(
        eq(approvals.workspace_id, message.workspace_id),
        eq(approvals.target_type, "message"),
        eq(approvals.target_id, message.id),
      ),
    )
    .orderBy(desc(approvals.created_at))
    .limit(1);
  if (approval?.status === "rejected") return "a reviewer rejected it";
  if (approval?.status === "expired") return "the review expired before anyone decided";
  if (approval?.status === "cancelled") return "a newer draft replaced it";
  if (message.person_id && !personKnown) return "the person was deleted or forgotten";
  return null;
}

function zoneOf(ctx: OpContext): string {
  const zone = requireWorkspace(ctx).timezone;
  return isValidTimeZone(zone) ? zone : "UTC";
}

function messageSummary(message: Message) {
  return {
    id: message.id,
    channel: message.channel,
    action: message.action,
    status: message.status,
    person_id: message.person_id,
    campaign_id: message.campaign_id,
    scheduled_for: message.scheduled_for,
    sent_at: message.sent_at,
    error: message.error,
  };
}

const CLOSED = new Set(["failed", "skipped", "bounced", "cancelled"]);

async function explainMessage(ctx: OpContext, messageId: string): Promise<ExplainOutput> {
  const workspace = requireWorkspace(ctx);
  const [message] = await ctx.db
    .select()
    .from(messages)
    .where(and(eq(messages.workspace_id, workspace.id), eq(messages.id, messageId)))
    .limit(1);
  if (!message) {
    throw new OpenOutboundError("not_found", `Message ${messageId} not found in this workspace.`, {
      hint: "Use a message id starting with msg_ from manage_messages action list or list_threads action get.",
      details: { what: "Message", id: messageId },
    });
  }
  const now = ctx.clock.now();
  const zone = zoneOf(ctx);
  const when = (at: Date) => whenInWords(at, zone, now);
  const [person] = message.person_id
    ? await ctx.db
        .select()
        .from(people)
        .where(and(eq(people.workspace_id, workspace.id), eq(people.id, message.person_id)))
    : [];
  const facts: BlockerFacts = {
    now,
    zone,
    person: person ? personName(person) : null,
    personId: message.person_id,
    messageId: message.id,
    threadId: message.thread_id,
    campaignId: message.campaign_id,
  };
  const base = {
    subject: { type: "message" as const, id: message.id },
    message: messageSummary(message),
    relationship: null,
  };

  if (message.direction === "inbound") {
    return {
      ...base,
      summary: `This message came from the prospect${message.received_at ? ` (${when(message.received_at)})` : ""}; the engine sends nothing for it.`,
      blocked: false,
      blockers: [],
      next: message.thread_id
        ? `To answer it, draft a reply with reply_to_thread action draft (thread_id ${message.thread_id}).`
        : "Nothing to do.",
    };
  }
  if (message.status === "sent") {
    return {
      ...base,
      summary: `Sent${message.sent_at ? ` ${when(message.sent_at)}` : ""}. Nothing blocked it.`,
      blocked: false,
      blockers: [],
      next: "Nothing more happens with this message; replies show up in list_threads.",
    };
  }
  if (CLOSED.has(message.status)) {
    const inferred = await missingReason(ctx, message, Boolean(person));
    const blockers = errorBlockers(message, facts, inferred);
    const first = blockers[0];
    return {
      ...base,
      summary: `Not sent, and it will not go out: ${blockers.map((item) => item.message).join(" ")}`,
      blocked: true,
      blockers,
      next:
        first?.fix ?? "Nothing to do for this message: it stays closed and nothing sends it again.",
    };
  }

  const result = await checkEligibility(ctx, {
    personId: message.person_id ?? "",
    channel: message.channel,
    messageId: message.id,
  });
  if (result.ok) {
    const planned = message.scheduled_for;
    const next =
      message.status === "scheduled" && planned
        ? `It goes out ${when(planned > now ? planned : now)}.`
        : message.status === "approved"
          ? "It is approved; the sequence schedules it at the step's time within the send window."
          : "It goes out as soon as it is scheduled.";
    return {
      ...base,
      summary: `Nothing blocks it. ${next}`,
      blocked: false,
      blockers: [],
      next,
    };
  }
  const first = result.blockers[0];
  const soft = result.blockers.every((item) => !item.hard);
  const until = result.blockers
    .map((item) => item.until)
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1);
  return {
    ...base,
    summary: `Not sent yet: ${result.blockers.map((item) => item.message).join(" ")}`,
    blocked: true,
    blockers: result.blockers,
    next: soft
      ? until
        ? `Nothing to do: it goes out on its own ${when(new Date(until))} at the earliest.`
        : "Nothing to do: it moves on by itself shortly."
      : (first?.fix ??
        "When it is due, the sender does not send it for the reason above; nothing needs doing unless that reason is wrong."),
  };
}

async function explainPerson(ctx: OpContext, personId: string): Promise<ExplainOutput> {
  const workspace = requireWorkspace(ctx);
  const view: RelationshipView = await getRelationship(ctx, personId);
  const [person] = await ctx.db
    .select()
    .from(people)
    .where(and(eq(people.workspace_id, workspace.id), eq(people.id, personId)));
  const now = ctx.clock.now();
  const zone = zoneOf(ctx);
  const name = person ? personName(person) : "This person";
  const since = view.state_since
    ? ` since ${whenInWords(new Date(view.state_since), zone, now)}`
    : "";
  const parts = [`${name} is ${STATE_WORDS[view.state]}${since}.`];
  parts.push(view.next_action ? `Next: ${view.next_action.reason}` : "Nothing is planned.");
  parts.push(
    view.blockers.length > 0
      ? `Blocked: ${view.blockers.map((item) => item.message).join(" ")}`
      : "Nothing blocks it.",
  );
  if (view.stuck && view.stuck_reason) parts.push(`Stuck: ${view.stuck_reason}`);
  const fix = view.blockers.find((item) => item.fix)?.fix;
  const next =
    fix ??
    (view.next_action
      ? view.next_action.reason
      : view.state === "new" || view.state === "finished"
        ? "Nothing happens until you enroll them with enroll_leads action enroll."
        : "Nothing happens on its own until they write or you act.");
  return {
    subject: { type: "person", id: personId },
    summary: parts.join(" "),
    blocked: view.blockers.length > 0,
    blockers: view.blockers,
    next,
    message: null,
    relationship: view,
  };
}

/** Explains a message or a person (exactly one). */
export async function explain(
  ctx: OpContext,
  input: z.output<typeof explainInput>,
): Promise<ExplainOutput> {
  const personId = input.person_id?.trim();
  const messageId = input.message_id?.trim();
  if (Boolean(personId) === Boolean(messageId)) {
    throw new OpenOutboundError(
      "validation_failed",
      "Pass exactly one of message_id or person_id.",
      {
        hint: "Use message_id (msg_...) to ask why one message has not gone out, or person_id (pe_...) for where a person stands.",
        details: { message_id: messageId ?? null, person_id: personId ?? null },
      },
    );
  }
  return messageId ? explainMessage(ctx, messageId) : explainPerson(ctx, personId as string);
}
