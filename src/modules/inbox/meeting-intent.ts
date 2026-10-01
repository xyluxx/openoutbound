/**
 * Booking mode and proposed times for classified replies (spec 2.1 and 2.2). The engine never
 * proposes, accepts or confirms a meeting time itself:
 * - link: replies offer the booking link. An automatic reply about scheduling is allowed only
 *   when the final draft contains the booking link and names no day or time
 *   (`meetingAutoSendBlockers`).
 * - handoff: a person or the agent books. Nothing about scheduling is drafted: no draft at all
 *   for a meeting request or a reply with a proposed time.
 * - off: no links and no meeting offers; meeting-related replies always go to review.
 * A reply counts as scheduling when it is a meeting request or has a proposed time, and for the
 * auto-send guard also when an earlier message since our last one proposed a time, or the
 * person still has a meeting to book (`schedulingConversation`).
 * In every mode a proposed time, or a meeting request with no booking link available, opens a
 * `meeting_to_book` problem for the person (resolved when a meeting is recorded or booked).
 */
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import type { BookingMode, MessageStatus, ReplyCategory } from "../../core/enums.js";
import { meetings, messages, type ReplyClassification } from "../../db/schema/index.js";
import { listProblems, openProblem } from "../problems/service.js";
import type { ActionOutcome, ClassifiedReply } from "./actions.js";
import { replyBookingLink } from "./booking-links.js";
import { linkKey, linksIn } from "./link-match.js";
import { personLabel } from "./notifications.js";
import { namesMeetingTime } from "./time-mentions.js";

export type ProposedTime = NonNullable<ReplyClassification["proposed_time"]>;

/** The proposed time is quoted from the prospect (untrusted): kept short in problems. */
const TIME_TEXT_MAX = 60;
/** Thread messages read back to find the prospect's messages since our last one. */
const CONVERSATION_SCAN = 50;
/** Our messages that answer what came before them: sent, or on their way. */
const ANSWER_STATUSES: ReadonlySet<MessageStatus> = new Set([
  "approved",
  "scheduled",
  "sending",
  "unknown",
  "sent",
]);

/** Dedupe key of the open "book a meeting" problem of a person. */
export function meetingToBookKey(personId: string): string {
  return `meeting_to_book:${personId}`;
}

/** A proposed time worth acting on (with text), or null. */
export function proposedTimeOf(
  classification: Pick<ReplyClassification, "proposed_time"> | null | undefined,
): ProposedTime | null {
  const proposed = classification?.proposed_time;
  return proposed?.text?.trim() ? proposed : null;
}

/** A reply about scheduling: a meeting request or any reply with a proposed time. */
export function isSchedulingReply(category: ReplyCategory, proposed: ProposedTime | null): boolean {
  return category === "meeting_request" || proposed !== null;
}

/**
 * Whether the text contains exactly this booking link, tag included (case, trailing
 * punctuation and trailing slashes ignored; a longer link that starts with it does not count).
 */
export function containsBookingLink(body: string, url: string): boolean {
  const target = linkKey(url);
  if (!target) return false;
  return linksIn(body).some((link) => linkKey(link) === target);
}

/**
 * The deterministic guard for automatic replies about scheduling (a meeting request, a proposed
 * time, or `scheduling` for a conversation that is about scheduling). Such a reply may go out
 * without review only in `link` mode, with a booking link, when the draft contains that link
 * and names no day or time (so the prospect picks the slot and the engine never proposes or
 * confirms one). Returns the reasons it may not (empty = allowed).
 */
export function meetingAutoSendBlockers(input: {
  mode: BookingMode;
  category: ReplyCategory;
  proposedTime: ProposedTime | null;
  /** The conversation is about scheduling even if this message is not (`schedulingConversation`). */
  scheduling?: boolean;
  bookingUrl: string | null;
  body: string;
}): string[] {
  if (!input.scheduling && !isSchedulingReply(input.category, input.proposedTime)) return [];
  if (input.mode === "handoff") return ["booking_handoff"];
  if (input.mode === "off") return ["booking_off"];
  if (!input.bookingUrl) return ["no_booking_link"];
  const blockers: string[] = [];
  if (!containsBookingLink(input.body, input.bookingUrl)) {
    blockers.push(input.proposedTime ? "proposed_time_without_link" : "scheduling_without_link");
  }
  if (namesMeetingTime(input.body)) blockers.push("names_meeting_time");
  return blockers;
}

export interface SchedulingConversation {
  /** The latest time the prospect proposed since our last message in the thread, or null. */
  proposedTime: ProposedTime | null;
  /** The person still has an open (or snoozed) `meeting_to_book` problem. */
  meetingToBook: boolean;
}

/**
 * Whether a thread is in the middle of scheduling, beyond the message being answered: a time the
 * prospect proposed in any message since our last one (sent or on its way, a person's own reply
 * included), or a meeting still to book for the person. A follow-up such as "Calendly is
 * blocked, just send an invite" is then still treated as a scheduling reply.
 */
export async function schedulingConversation(
  ctx: OpContext,
  input: { threadId: string; personId: string | null },
): Promise<SchedulingConversation> {
  const workspace = requireWorkspace(ctx);
  const rows = await ctx.db
    .select({
      direction: messages.direction,
      status: messages.status,
      classification: messages.classification,
    })
    .from(messages)
    .where(and(eq(messages.workspace_id, workspace.id), eq(messages.thread_id, input.threadId)))
    .orderBy(desc(messages.created_at), desc(messages.id))
    .limit(CONVERSATION_SCAN);
  let proposedTime: ProposedTime | null = null;
  for (const row of rows) {
    if (row.direction === "outbound") {
      if (ANSWER_STATUSES.has(row.status)) break;
      continue;
    }
    proposedTime = proposedTimeOf(row.classification);
    if (proposedTime) break;
  }
  const open = input.personId
    ? await listProblems(ctx, {
        kinds: ["meeting_to_book"],
        statuses: ["open", "snoozed"],
        personId: input.personId,
        limit: 1,
      })
    : null;
  return { proposedTime, meetingToBook: (open?.items.length ?? 0) > 0 };
}

async function upcomingMeeting(ctx: OpContext, reply: ClassifiedReply, personId: string) {
  const [row] = await ctx.db
    .select({ id: meetings.id, start_at: meetings.start_at })
    .from(meetings)
    .where(
      and(
        eq(meetings.workspace_id, reply.workspace.id),
        eq(meetings.person_id, personId),
        eq(meetings.status, "scheduled"),
        gt(meetings.start_at, ctx.clock.now()),
      ),
    )
    .orderBy(asc(meetings.start_at))
    .limit(1);
  return row ?? null;
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

function futureDate(iso: string | null | undefined, now: Date): Date | null {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) || at <= now ? null : at;
}

function modeLine(mode: BookingMode, link: boolean, offerIssue: string | null): string {
  if (mode === "handoff") {
    return "Booking mode is handoff: a person or the agent books meetings, the engine never shares a link or confirms a time, so no reply was drafted.";
  }
  if (mode === "off") return "Booking mode is off: the engine does not offer meetings.";
  if (offerIssue) {
    return `${offerIssue} Until the campaign has an active offer, no reply is drafted and none offers a booking link.`;
  }
  if (!link) {
    return "No booking link is set (the offer replies use has none, or there is no offer, and booking.default_url is empty), so the reply cannot offer one.";
  }
  return "The reply offers the booking link so they can pick the slot themselves; the engine never confirms a time. If they do not book with it, confirm the time on your calendar.";
}

/**
 * Applies the booking mode to a classified reply that is about scheduling (a meeting request
 * or a proposed time): adjusts the outcome's draft (none, or review instead of automatic) and
 * opens the person's `meeting_to_book` problem when someone has to book. Called by
 * `applyReplyActions` after the category's action; protective and suspicious replies never get
 * here, and a rule set to `ignore` is left alone.
 */
export async function applyMeetingIntent(
  ctx: OpContext,
  reply: ClassifiedReply,
  outcome: ActionOutcome,
): Promise<void> {
  const { classification, rule, person, company, thread, message, settings } = reply;
  if (rule.action === "ignore") return;
  const proposed = proposedTimeOf(classification);
  if (!isSchedulingReply(rule.category, proposed)) return;

  const mode = settings.booking.mode;
  // The same offer and link as the reply draft (replyBookingLink), so this never disagrees.
  const { url: link, offerIssue } = await replyBookingLink(ctx, {
    personId: person?.id ?? null,
    offerId: reply.campaign?.offer_id ?? null,
  });

  if (mode === "handoff") {
    // A person or the agent books: no reply about scheduling is drafted at all.
    if (outcome.draft !== "none") outcome.effects.push("draft_skipped:booking_handoff");
    outcome.draft = "none";
  } else if (outcome.draft === "auto" && (mode !== "link" || !link)) {
    outcome.draft = "review";
    outcome.effects.push(`draft_review:booking_${mode === "link" ? "no_link" : mode}`);
  }

  // A meeting request answered with the booking link needs nobody; everything else does.
  if (!proposed && link) return;
  outcome.attention.push("meeting_to_book");
  if (!person) return;

  const label = personLabel(person, company);
  const now = ctx.clock.now();
  const upcoming = await upcomingMeeting(ctx, reply, person.id);
  const asked = proposed
    ? `${label} proposed a meeting time, quoted from their reply: "${clip(proposed.text, TIME_TEXT_MAX)}"${
        proposed.timezone ? ` (${proposed.timezone})` : ""
      }${proposed.start ? `, read as ${proposed.start}` : ""}.`
    : `${label} asked for a meeting.`;
  const reason = [
    asked,
    modeLine(mode, Boolean(link), offerIssue),
    upcoming?.start_at
      ? `They already have a meeting booked for ${upcoming.start_at.toISOString()}; check whether this moves it.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  const problem = await openProblem(ctx, {
    kind: "meeting_to_book",
    severity: mode === "handoff" || !link ? "high" : "normal",
    owner: "anyone",
    title: `Book a meeting with ${label}`,
    reason,
    remedy: `Check the calendar, book it, then record it with manage_meetings action record (person_id ${person.id}, start_at).`,
    subject: { type: "person", id: person.id },
    personId: person.id,
    companyId: company?.id ?? person.company_id ?? null,
    data: {
      thread_id: thread?.id ?? null,
      message_id: message.id,
      category: rule.category,
      booking_mode: mode,
      booking_link: link,
      proposed_time: proposed
        ? {
            text: clip(proposed.text, TIME_TEXT_MAX),
            start: proposed.start,
            timezone: proposed.timezone,
          }
        : null,
    },
    dueAt: futureDate(proposed?.start, now),
    dedupeKey: meetingToBookKey(person.id),
  });
  outcome.effects.push(
    `${problem.created ? "problem_opened" : "problem_updated"}:meeting_to_book:${problem.id}`,
  );
}
