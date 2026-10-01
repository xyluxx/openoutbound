/**
 * Meeting records (spec 2.3 and 2.5): one path for every source, whether a booking webhook
 * (Calendly, Cal.com, generic), a person or an agent (`meetings.record`) or the sandbox.
 *
 * - Booked: a new `scheduled` meeting (a repeated delivery finds the first one, and a booking
 *   tool's first report of a meeting recorded by hand takes over that record). The person's
 *   opportunity moves to meeting_booked through the opportunity functions, so person status,
 *   sequence stops and CRM sync behave as for any stage change. The person's "book a meeting"
 *   problem resolves and `meeting.booked` fires. A retry finishes a booking cut short.
 * - Rescheduled: new times (and booking id; the replaced ids are kept, so late deliveries about
 *   them find the meeting and change nothing); the opportunity's meeting time follows.
 * - Cancelled: the opportunity goes back to interested unless another meeting is scheduled,
 *   then `booking.after_cancel` runs. A stopped sequence never restarts. A cancellation that
 *   arrives before its booking is kept as a cancelled meeting, so the booking stays cancelled.
 * - No-show: `booking.after_no_show` runs; an undo returns the meeting to scheduled.
 * - Held: marked by a person or agent, or assumed by the held job.
 * Repeated calls with the same outcome change nothing and emit nothing.
 */
import {
  and,
  arrayContains,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lte,
  ne,
  or,
  type SQL,
} from "drizzle-orm";
import { actorRef, type OpContext, requireWorkspace } from "../../core/context.js";
import {
  MEETING_SOURCES,
  type MeetingMatch,
  type MeetingSource,
  type MeetingStatus,
} from "../../core/enums.js";
import { notFound, OpenOutboundError } from "../../core/errors.js";
import { parseWorkspaceSettings } from "../../core/settings.js";
import {
  type Meeting,
  type Message,
  meetings,
  messages,
  type NewMeeting,
  type Opportunity,
  type Person,
  tasks,
} from "../../db/schema/index.js";
import { normalizeDomain } from "../../lib/web/extract.js";
import { isFreeMailDomain } from "../leads/normalize.js";
import { listProblems, resolveProblem, resolveProblemsFor } from "../problems/service.js";
import { replyBookingLink } from "./booking-links.js";
import { DRAFT_REPLY_JOB } from "./draft.js";
import { meetingToBookKey } from "./meeting-intent.js";
import { personLabel } from "./notifications.js";
import {
  bookOpportunityMeeting,
  findOpenOpportunity,
  getOpportunity,
  OPEN_STAGES,
  updateOpportunity,
} from "./opportunities.js";
import { findCampaign, findCompany, findPerson, findThread } from "./reply-context.js";
import { cancelDraftsForBookedMeeting, MEETING_BOOKED } from "./stale-replies.js";
import { isThreadOwnedByPerson } from "./takeover.js";
import { createTask } from "./tasks.js";

export interface RecordMeetingInput {
  personId: string | null;
  source: MeetingSource;
  matchedBy: MeetingMatch;
  /** The booking tool's id; repeated deliveries with the same source and id find one meeting. */
  externalId?: string | null;
  startAt?: Date | null;
  endAt?: Date | null;
  opportunityId?: string | null;
  threadId?: string | null;
  campaignId?: string | null;
  notes?: string | null;
}

/** Two starts within this much are the same meeting. */
const SAME_START_MS = 60_000;
const NOTES_MAX = 4000;
const EXTERNAL_ID_MAX = 300;
/** Superseded booking ids kept per meeting (a meeting is rarely moved more than a few times). */
const PREVIOUS_IDS_MAX = 20;

/** Short source names used in opportunity notes (kept from v0.1). */
export const MEETING_SOURCE_LABELS: Record<MeetingSource, string> = {
  calendly: "calendly",
  cal_com: "calcom",
  generic: "webhook",
  manual: "manual",
};

/** Status changes a meeting can make. A cancelled meeting only comes back by a reschedule. */
const TRANSITIONS: Record<MeetingStatus, readonly MeetingStatus[]> = {
  scheduled: ["held", "no_show", "cancelled"],
  held: ["no_show", "cancelled", "scheduled"],
  no_show: ["held", "cancelled", "scheduled"],
  cancelled: [],
};

/** Whether a meeting in `from` can move to `to` (the same status is always fine: a no-op). */
export function canChangeMeetingStatus(from: MeetingStatus, to: MeetingStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function validDate(value: Date | null | undefined): Date | null {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
}

/** A booking tool's id as stored: trimmed and capped, or null. */
function bookingId(value: string | null | undefined): string | null {
  return value?.trim().slice(0, EXTERNAL_ID_MAX) || null;
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

function closeStart(a: Date | null, b: Date | null): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.getTime() - b.getTime()) <= SAME_START_MS;
}

/** Appends a note once (a repeated call with the same note changes nothing). */
function mergeNotes(current: string | null, next: string | null | undefined): string | null {
  const note = next?.trim();
  if (!note) return current;
  if (current?.split("\n").includes(note)) return current;
  return [current, note].filter(Boolean).join("\n").slice(-NOTES_MAX);
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current === "object" && (current as { code?: unknown }).code === "23505") {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function workspaceScope(ctx: OpContext, meetingId: string): SQL {
  const workspace = requireWorkspace(ctx);
  return and(eq(meetings.workspace_id, workspace.id), eq(meetings.id, meetingId)) as SQL;
}

/** One meeting of the context workspace, or null. */
export async function getMeeting(ctx: OpContext, meetingId: string): Promise<Meeting | null> {
  const [row] = await ctx.db.select().from(meetings).where(workspaceScope(ctx, meetingId)).limit(1);
  return row ?? null;
}

async function requireMeeting(ctx: OpContext, meetingId: string): Promise<Meeting> {
  const row = await getMeeting(ctx, meetingId);
  if (!row) throw notFound("Meeting", meetingId);
  return row;
}

/**
 * The meeting a booking tool knows by this id, or null: the meeting that has the id now, else
 * one a reschedule took it from (`previous_external_ids`), so a late delivery about the old
 * booking finds the same meeting. `isSupersededId` tells the two apart.
 */
export async function findMeetingByExternalId(
  ctx: OpContext,
  source: MeetingSource,
  externalId: string,
): Promise<Meeting | null> {
  const workspace = requireWorkspace(ctx);
  const id = bookingId(externalId);
  if (!id) return null;
  const scope = and(eq(meetings.workspace_id, workspace.id), eq(meetings.source, source));
  const [current] = await ctx.db
    .select()
    .from(meetings)
    .where(and(scope, eq(meetings.external_id, id)))
    .limit(1);
  if (current) return current;
  const [replaced] = await ctx.db
    .select()
    .from(meetings)
    .where(and(scope, arrayContains(meetings.previous_external_ids, [id])))
    .orderBy(desc(meetings.created_at), desc(meetings.id))
    .limit(1);
  return replaced ?? null;
}

/**
 * True when the meeting was found by a booking id a reschedule replaced: the delivery is about
 * the old booking and arrived late, so it changes nothing.
 */
export function isSupersededId(meeting: Meeting, externalId: string | null): boolean {
  const id = bookingId(externalId);
  return id !== null && meeting.external_id !== id && meeting.previous_external_ids.includes(id);
}

/**
 * Meetings from this booking tool, or recorded by hand without a booking id (a person may have
 * recorded the booking before the tool reported it).
 */
function fromSourceOrManual(source: MeetingSource): SQL {
  if (source === "manual") return eq(meetings.source, "manual");
  return or(
    eq(meetings.source, source),
    and(eq(meetings.source, "manual"), isNull(meetings.external_id)),
  ) as SQL;
}

/**
 * A person's meeting for a booking event that carries no known id: the newest with one of the
 * statuses (and from the source or recorded by hand, when a source is given). With `startAt`,
 * only a meeting starting within a minute of it matches, so an event about another meeting
 * never touches this one.
 */
export async function findPersonMeeting(
  ctx: OpContext,
  personId: string,
  input: { statuses: MeetingStatus[]; source?: MeetingSource | null; startAt?: Date | null },
): Promise<Meeting | null> {
  const workspace = requireWorkspace(ctx);
  const conditions: SQL[] = [
    eq(meetings.workspace_id, workspace.id),
    eq(meetings.person_id, personId),
    inArray(meetings.status, input.statuses),
  ];
  if (input.source) conditions.push(fromSourceOrManual(input.source));
  const rows = await ctx.db
    .select()
    .from(meetings)
    .where(and(...conditions))
    .orderBy(desc(meetings.created_at), desc(meetings.id))
    .limit(20);
  const startAt = validDate(input.startAt);
  if (startAt) return rows.find((row) => closeStart(row.start_at, startAt)) ?? null;
  return rows[0] ?? null;
}

/**
 * The same meeting recorded again without an id: manual records match any source, a booking
 * tool matches its own meetings and those recorded by hand.
 */
async function findSameMeeting(
  ctx: OpContext,
  personId: string,
  source: MeetingSource,
  startAt: Date | null,
): Promise<Meeting | null> {
  const workspace = requireWorkspace(ctx);
  const conditions: SQL[] = [
    eq(meetings.workspace_id, workspace.id),
    eq(meetings.person_id, personId),
    eq(meetings.status, "scheduled"),
  ];
  if (source !== "manual") conditions.push(fromSourceOrManual(source));
  const rows = await ctx.db
    .select()
    .from(meetings)
    .where(and(...conditions))
    .orderBy(desc(meetings.created_at))
    .limit(20);
  return rows.find((row) => closeStart(row.start_at, startAt)) ?? null;
}

async function linkOpportunity(ctx: OpContext, meeting: Meeting, person: Person): Promise<Meeting> {
  const { opportunity } = await bookOpportunityMeeting(ctx, {
    person,
    meetingAt: meeting.start_at,
    source: MEETING_SOURCE_LABELS[meeting.source],
    opportunityId: meeting.opportunity_id,
    threadId: meeting.thread_id,
    campaignId: meeting.campaign_id,
  });
  if (
    opportunity.id === meeting.opportunity_id &&
    meeting.campaign_id !== null &&
    meeting.thread_id !== null
  ) {
    return meeting;
  }
  const [row] = await ctx.db
    .update(meetings)
    .set({
      opportunity_id: opportunity.id,
      campaign_id: meeting.campaign_id ?? opportunity.campaign_id,
      thread_id: meeting.thread_id ?? opportunity.thread_id,
    })
    .where(workspaceScope(ctx, meeting.id))
    .returning();
  return row ?? meeting;
}

function isBookingSource(value: unknown): value is Exclude<MeetingSource, "manual"> {
  return (
    typeof value === "string" &&
    value !== "manual" &&
    (MEETING_SOURCES as readonly string[]).includes(value)
  );
}

/**
 * Gives a meeting recorded by hand a booking tool's source and id, once: null when the meeting
 * has one already (a concurrent delivery won) or another meeting holds the id.
 */
async function takeBookingId(
  ctx: OpContext,
  meeting: Meeting,
  source: Exclude<MeetingSource, "manual">,
  externalId: string,
): Promise<Meeting | null> {
  try {
    const [row] = await ctx.db
      .update(meetings)
      .set({ source, external_id: externalId })
      .where(
        and(
          workspaceScope(ctx, meeting.id),
          eq(meetings.source, "manual"),
          isNull(meetings.external_id),
        ),
      )
      .returning();
    return row ?? null;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return null;
  }
}

/** The domains that make a booking email this person's: their own and their company's. */
async function domainsOf(ctx: OpContext, person: Person): Promise<Set<string>> {
  const company = await findCompany(ctx, person.company_id);
  const domains = new Set<string>();
  for (const value of [person.email, company?.domain]) {
    const domain = value ? normalizeDomain(value) : null;
    // A free mail domain (gmail.com, outlook.com) says nothing about who booked.
    if (domain && !isFreeMailDomain(domain)) domains.add(domain);
  }
  return domains;
}

/** Whether a booking's email can be the person's: their address, or their company's domain. */
function emailFits(email: unknown, person: Person, domains: Set<string>): boolean {
  if (typeof email !== "string" || !email.includes("@")) return false;
  const address = email.trim().toLowerCase();
  if (person.email && person.email.trim().toLowerCase() === address) return true;
  const domain = normalizeDomain(address);
  return domain !== null && domains.has(domain);
}

/**
 * A meeting recorded by hand for a booking that matched no lead: when exactly one open
 * `unmatched_booking` problem has the same start and an email that can be the person's (their
 * address, or their own or their company's domain), that problem is resolved and the meeting
 * takes over the booking's source and id, so later cancellations and reschedules find it.
 */
async function adoptUnmatchedBooking(
  ctx: OpContext,
  meeting: Meeting,
  person: Person,
): Promise<Meeting> {
  if (meeting.source !== "manual" || meeting.external_id || !meeting.start_at) return meeting;
  const { items } = await listProblems(ctx, {
    kinds: ["unmatched_booking"],
    statuses: ["open", "snoozed"],
    limit: 100,
  });
  const sameStart = items.filter((problem) => {
    const start = problem.data.start_at;
    return typeof start === "string" && closeStart(new Date(start), meeting.start_at);
  });
  if (sameStart.length === 0) return meeting;
  const domains = await domainsOf(ctx, person);
  const matches = sameStart.filter((problem) => emailFits(problem.data.email, person, domains));
  const [problem] = matches;
  if (!problem || matches.length !== 1) return meeting;
  const { meeting_source: source, external_id: externalId } = problem.data;
  const id = typeof externalId === "string" ? bookingId(externalId) : null;
  const adopted =
    isBookingSource(source) && id ? await takeBookingId(ctx, meeting, source, id) : null;
  await resolveProblem(ctx, problem.id, { resolution: `Recorded as meeting ${meeting.id}.` });
  return adopted ?? meeting;
}

async function emitBooked(ctx: OpContext, meeting: Meeting): Promise<void> {
  await ctx.events.emit("meeting.booked", {
    subject: { type: "meeting", id: meeting.id },
    data: {
      meeting_id: meeting.id,
      person_id: meeting.person_id,
      opportunity_id: meeting.opportunity_id,
      source: meeting.source,
      start_at: iso(meeting.start_at),
      matched_by: meeting.matched_by,
    },
  });
}

/**
 * A meeting answers the conversation: the engine's reply drafts still waiting for review in the
 * person's threads (which may offer the booking link or ask for a time) are cancelled with their
 * approvals (`meeting_booked`), the way a take-over cancels them. Safe to repeat.
 */
async function cancelStaleReplyDrafts(ctx: OpContext, personId: string): Promise<void> {
  for (const id of await cancelDraftsForBookedMeeting(ctx, personId)) {
    await ctx.approvals.cancel({ target: { type: "message", id } }, MEETING_BOOKED);
  }
}

/**
 * The effects of a new booking, each safe to repeat: the person's opportunity moves to
 * meeting_booked (sequences stop), their "book a meeting" problem resolves, the engine's reply
 * drafts waiting for review in their threads are cancelled, a matching unmatched booking is
 * adopted and `meeting.booked` fires. The opportunity is saved on the
 * meeting last, so a scheduled meeting without one is a booking whose effects were cut short
 * (the process stopped half way): `finishIfUnfinished` runs them again.
 */
async function finishBooking(
  ctx: OpContext,
  meeting: Meeting,
  person: Person,
  opportunityId: string | null,
): Promise<void> {
  const { opportunity } = await bookOpportunityMeeting(ctx, {
    person,
    meetingAt: meeting.start_at,
    source: MEETING_SOURCE_LABELS[meeting.source],
    opportunityId,
    threadId: meeting.thread_id,
    campaignId: meeting.campaign_id,
  });
  await resolveProblemsFor(ctx, { dedupeKey: meetingToBookKey(person.id) }, "Meeting booked.");
  await cancelStaleReplyDrafts(ctx, person.id);
  const adopted = await adoptUnmatchedBooking(ctx, meeting, person);
  const linked = {
    opportunity_id: opportunity.id,
    campaign_id: adopted.campaign_id ?? opportunity.campaign_id,
    thread_id: adopted.thread_id ?? opportunity.thread_id,
  };
  await emitBooked(ctx, { ...adopted, ...linked });
  await ctx.db.update(meetings).set(linked).where(workspaceScope(ctx, meeting.id));
}

type BookedResult = { meetingId: string; created: boolean; changed: boolean };

/**
 * A booking on record, returned as it is, unless its effects were cut short (scheduled, with a
 * person, no opportunity yet): then they run now and the result reads as a new booking, since
 * the earlier call never finished it.
 */
async function finishIfUnfinished(
  ctx: OpContext,
  meeting: Meeting,
  opportunityId: string | null,
): Promise<BookedResult> {
  const unchanged = { meetingId: meeting.id, created: false, changed: false };
  if (meeting.status !== "scheduled" || meeting.opportunity_id || !meeting.person_id) {
    return unchanged;
  }
  const person = await findPerson(ctx, meeting.person_id);
  if (!person) return unchanged;
  await finishBooking(ctx, meeting, person, opportunityId);
  return { meetingId: meeting.id, created: true, changed: true };
}

/**
 * Records a booked meeting (binding signature from the upgrade plan). A booking on record (the
 * same source and external id, also an id a reschedule replaced) is returned as it is: a
 * repeated or late delivery never moves or reopens a meeting, only a reschedule moves one. A
 * booking tool's first report of a meeting the person recorded by hand (scheduled, no booking
 * id, starting within a minute) gives that record the tool's source and id. Without an id, the
 * same person's scheduled meeting starting within a minute, from the same source or recorded
 * by hand (from any source for manual records), is the same meeting. Those return
 * `created: false`. Otherwise the meeting is stored as `scheduled`, the person's opportunity
 * moves to meeting_booked with the meeting time, the person's `meeting_to_book` problem
 * resolves and `meeting.booked` fires (`finishBooking`); a booking on record whose effects were
 * cut short gets them now. Throws `not_found` for a person outside the workspace.
 */
export async function recordMeetingBooked(
  ctx: OpContext,
  input: RecordMeetingInput,
): Promise<BookedResult> {
  const workspace = requireWorkspace(ctx);
  const externalId = bookingId(input.externalId);
  const startAt = validDate(input.startAt);
  const endAt = validDate(input.endAt);
  const opportunityId = input.opportunityId ?? null;
  if (externalId) {
    const existing = await findMeetingByExternalId(ctx, input.source, externalId);
    if (existing) return finishIfUnfinished(ctx, existing, opportunityId);
  }
  const person = input.personId ? await findPerson(ctx, input.personId) : null;
  if (input.personId && !person) throw notFound("Person", input.personId);
  if (person && externalId && isBookingSource(input.source) && startAt) {
    const manual = await findPersonMeeting(ctx, person.id, {
      statuses: ["scheduled"],
      source: "manual",
      startAt,
    });
    const adopted =
      manual && !manual.external_id
        ? await takeBookingId(ctx, manual, input.source, externalId)
        : null;
    if (adopted) return finishIfUnfinished(ctx, adopted, opportunityId);
  }
  if (person && !externalId) {
    const same = await findSameMeeting(ctx, person.id, input.source, startAt);
    if (same) {
      const result = await finishIfUnfinished(ctx, same, opportunityId);
      const notes = mergeNotes(same.notes, input.notes);
      if (notes === same.notes) return result;
      await ctx.db.update(meetings).set({ notes }).where(workspaceScope(ctx, same.id));
      return { ...result, changed: true };
    }
  }

  const [row] = await ctx.db
    .insert(meetings)
    .values({
      workspace_id: workspace.id,
      person_id: person?.id ?? null,
      company_id: person?.company_id ?? null,
      campaign_id: input.campaignId ?? null,
      thread_id: input.threadId ?? null,
      source: input.source,
      external_id: externalId,
      status: "scheduled",
      start_at: startAt,
      end_at: endAt,
      matched_by: input.matchedBy,
      notes: mergeNotes(null, input.notes),
      status_changed_at: ctx.clock.now(),
      created_by: actorRef(ctx.principal),
    })
    // A concurrent delivery of the same booking stored it first: that one wins.
    .onConflictDoNothing()
    .returning();
  if (!row) {
    const existing = externalId
      ? await findMeetingByExternalId(ctx, input.source, externalId)
      : null;
    if (!existing)
      throw new Error("recordMeetingBooked: the insert conflicted but no meeting exists");
    return { meetingId: existing.id, created: false, changed: false };
  }
  if (person) await finishBooking(ctx, row, person, opportunityId);
  else await emitBooked(ctx, row);
  return { meetingId: row.id, created: true, changed: true };
}

/**
 * Moves a meeting to a new time (binding signature from the upgrade plan), with the new booking
 * id when the tool issued one. The ids it replaces (the meeting's old one, and
 * `previousExternalId` when the tool names it) are kept in `previous_external_ids`, so late
 * deliveries about them find this meeting; a meeting recorded by hand takes the tool's
 * `source` with its first booking id. A held or no-show meeting that is rescheduled is
 * scheduled again, and so is a cancelled one unless `reviveCancelled` is false (booking tool
 * deliveries: a late reschedule never reopens a cancelled meeting). The opportunity's meeting
 * time follows (an open opportunity moves back to meeting_booked), and `meeting.rescheduled`
 * fires when the time or the status changed. Throws `not_found` for an unknown meeting and
 * `conflict` when another meeting of the same source already holds the new booking id.
 */
export async function rescheduleMeeting(
  ctx: OpContext,
  meetingId: string,
  input: {
    startAt: Date;
    endAt?: Date | null;
    externalId?: string | null;
    previousExternalId?: string | null;
    source?: MeetingSource;
    reviveCancelled?: boolean;
  },
): Promise<{ changed: boolean }> {
  const meeting = await requireMeeting(ctx, meetingId);
  if (meeting.status === "cancelled" && input.reviveCancelled === false) return { changed: false };
  const set: Partial<NewMeeting> = {};
  const startAt = validDate(input.startAt);
  if (!startAt) {
    throw new OpenOutboundError("validation_failed", "A reschedule needs a valid start time.", {
      hint: "Pass start_at as an ISO 8601 time with an offset, for example 2026-10-06T15:00:00Z.",
    });
  }
  if (!sameInstant(meeting.start_at, startAt)) set.start_at = startAt;
  if (input.endAt !== undefined && !sameInstant(meeting.end_at, validDate(input.endAt))) {
    set.end_at = validDate(input.endAt);
  }
  const externalId = bookingId(input.externalId);
  if (externalId && externalId !== meeting.external_id) {
    set.external_id = externalId;
    if (meeting.source === "manual" && !meeting.external_id && isBookingSource(input.source)) {
      set.source = input.source;
    }
  }
  const currentId = externalId ?? meeting.external_id;
  const replaced = [
    set.external_id ? meeting.external_id : null,
    bookingId(input.previousExternalId),
  ]
    .filter((id): id is string => id !== null && id !== currentId)
    .filter((id, index, ids) => ids.indexOf(id) === index)
    .filter((id) => !meeting.previous_external_ids.includes(id));
  if (replaced.length > 0) {
    set.previous_external_ids = [...meeting.previous_external_ids, ...replaced].slice(
      -PREVIOUS_IDS_MAX,
    );
  }
  const revived = meeting.status !== "scheduled";
  if (revived) {
    set.status = "scheduled";
    set.status_changed_at = ctx.clock.now();
  }
  if (Object.keys(set).length === 0) return { changed: false };

  let row: Meeting | undefined;
  try {
    [row] = await ctx.db
      .update(meetings)
      .set(set)
      .where(and(workspaceScope(ctx, meeting.id), eq(meetings.status, meeting.status)))
      .returning();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    throw new OpenOutboundError(
      "conflict",
      `Another ${meeting.source} meeting already has the booking id ${externalId}.`,
      {
        hint: "List the person's meetings with manage_meetings action list (person_id) and cancel the duplicate.",
        details: { meeting_id: meeting.id, external_id: externalId },
      },
    );
  }
  if (!row) return { changed: false };

  const timeChanged = set.start_at !== undefined || set.end_at !== undefined;
  const personId = row.person_id;
  if (personId && (timeChanged || revived)) {
    const person = await findPerson(ctx, personId);
    const current = row.opportunity_id ? await getOpportunity(ctx, row.opportunity_id) : null;
    if (person && (!current || OPEN_STAGES.includes(current.stage))) {
      row = await linkOpportunity(ctx, row, person);
    }
    if (revived) await closeFollowUpTask(ctx, row, "done");
    await resolveProblemsFor(ctx, { dedupeKey: meetingToBookKey(personId) }, "Meeting booked.");
    await cancelStaleReplyDrafts(ctx, personId);
  }
  if (timeChanged || revived) {
    await ctx.events.emit("meeting.rescheduled", {
      subject: { type: "meeting", id: row.id },
      data: {
        meeting_id: row.id,
        person_id: row.person_id,
        opportunity_id: row.opportunity_id,
        start_at: iso(row.start_at),
        previous_start_at: iso(meeting.start_at),
      },
    });
  }
  return { changed: true };
}

/**
 * Remembers a booking tool's cancellation of a booking it has not reported yet (deliveries can
 * arrive out of order): a `cancelled` meeting for the person with the booking's id and times,
 * so the booking delivered after it finds this record and never becomes a live meeting. No
 * effects and no event: nothing was booked on this side. Null when a meeting with that id was
 * stored meanwhile (a concurrent delivery of the booking).
 */
export async function recordCancelledBooking(
  ctx: OpContext,
  input: {
    person: Person;
    source: Exclude<MeetingSource, "manual">;
    matchedBy: MeetingMatch;
    externalId: string;
    startAt?: Date | null;
    endAt?: Date | null;
    notes?: string | null;
  },
): Promise<Meeting | null> {
  const workspace = requireWorkspace(ctx);
  const externalId = bookingId(input.externalId);
  if (!externalId) return null;
  const [row] = await ctx.db
    .insert(meetings)
    .values({
      workspace_id: workspace.id,
      person_id: input.person.id,
      company_id: input.person.company_id,
      source: input.source,
      external_id: externalId,
      status: "cancelled",
      start_at: validDate(input.startAt),
      end_at: validDate(input.endAt),
      matched_by: input.matchedBy,
      notes: mergeNotes(null, input.notes),
      status_changed_at: ctx.clock.now(),
      created_by: actorRef(ctx.principal),
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/**
 * The soonest scheduled meeting of the opportunity's person (or of the opportunity, without a
 * person) other than `exceptId`, or null: while there is one, the opportunity stays booked.
 */
export async function otherScheduledMeeting(
  ctx: OpContext,
  opportunity: Opportunity,
  exceptId: string | null,
): Promise<Meeting | null> {
  const workspace = requireWorkspace(ctx);
  const conditions: SQL[] = [
    eq(meetings.workspace_id, workspace.id),
    eq(meetings.status, "scheduled"),
    opportunity.person_id
      ? eq(meetings.person_id, opportunity.person_id)
      : eq(meetings.opportunity_id, opportunity.id),
  ];
  if (exceptId) conditions.push(ne(meetings.id, exceptId));
  const [next] = await ctx.db
    .select()
    .from(meetings)
    .where(and(...conditions))
    .orderBy(asc(meetings.start_at))
    .limit(1);
  return next ?? null;
}

/** A cancelled meeting frees the opportunity unless another meeting is still scheduled. */
async function releaseOpportunity(ctx: OpContext, meeting: Meeting): Promise<void> {
  const opportunity = meeting.opportunity_id
    ? await getOpportunity(ctx, meeting.opportunity_id)
    : meeting.person_id
      ? await findOpenOpportunity(ctx, meeting.person_id)
      : null;
  if (opportunity?.stage !== "meeting_booked") return;
  const next = await otherScheduledMeeting(ctx, opportunity, meeting.id);
  if (next) {
    if (next.start_at) await updateOpportunity(ctx, opportunity, { meeting_at: next.start_at });
    return;
  }
  await updateOpportunity(ctx, opportunity, {
    stage: "interested",
    meeting_at: null,
    notes: [opportunity.notes, `Meeting cancelled (${MEETING_SOURCE_LABELS[meeting.source]}).`]
      .filter(Boolean)
      .join("\n"),
  });
}

function followUpKey(meetingId: string): string {
  return `meeting_follow_up:${meetingId}`;
}

/** Closes the open follow-up task of a meeting (after an undo or a new booking). */
async function closeFollowUpTask(
  ctx: OpContext,
  meeting: Meeting,
  status: "done" | "skipped",
): Promise<void> {
  const workspace = requireWorkspace(ctx);
  await ctx.db
    .update(tasks)
    .set({ status, completed_at: ctx.clock.now() })
    .where(
      and(
        eq(tasks.workspace_id, workspace.id),
        eq(tasks.dedupe_key, followUpKey(meeting.id)),
        eq(tasks.status, "open"),
      ),
    );
}

type AfterKind = "no_show" | "cancelled";

async function followUpTask(
  ctx: OpContext,
  meeting: Meeting,
  person: Person,
  kind: AfterKind,
): Promise<string> {
  const company = await findCompany(ctx, person.company_id);
  const label = personLabel(person, company);
  const when = meeting.start_at ? ` on ${meeting.start_at.toISOString()}` : "";
  const now = ctx.clock.now();
  const title =
    kind === "no_show"
      ? `${label} missed the meeting: follow up`
      : `${label} cancelled the meeting: follow up`;
  const notes =
    kind === "no_show"
      ? `They did not show up to the meeting${when}. Offer a new time, or close the opportunity. Their sequences stay stopped.`
      : `They cancelled the meeting${when}. Offer a new time, or close the opportunity. Their sequences stay stopped.`;
  const { task, created } = await createTask(ctx, {
    title,
    type: "follow_up",
    notes,
    dueAt: now,
    personId: person.id,
    campaignId: meeting.campaign_id,
    threadId: meeting.thread_id,
    dedupeKey: followUpKey(meeting.id),
  });
  if (!created && task.status !== "open") {
    // Closed after an undo, needed again now.
    await ctx.db
      .update(tasks)
      .set({ status: "open", completed_at: null, due_at: now, title, notes })
      .where(and(eq(tasks.workspace_id, task.workspace_id), eq(tasks.id, task.id)));
  }
  return task.id;
}

async function latestInboundFor(
  ctx: OpContext,
  meeting: Meeting,
  personId: string,
): Promise<Message | null> {
  const workspace = requireWorkspace(ctx);
  const conditions: SQL[] = [
    eq(messages.workspace_id, workspace.id),
    eq(messages.person_id, personId),
    eq(messages.direction, "inbound"),
  ];
  const inThread = meeting.thread_id
    ? await ctx.db
        .select()
        .from(messages)
        .where(and(...conditions, eq(messages.thread_id, meeting.thread_id)))
        .orderBy(desc(messages.created_at), desc(messages.id))
        .limit(1)
    : [];
  if (inThread[0]) return inThread[0];
  const [latest] = await ctx.db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.created_at), desc(messages.id))
    .limit(1);
  return latest?.thread_id ? latest : null;
}

const DRAFT_INSTRUCTIONS: Record<AfterKind, string> = {
  no_show:
    "They missed the meeting. Write a short, friendly note without blame and offer the booking link so they can pick a new time. Never propose or confirm a time yourself.",
  cancelled:
    "They cancelled the meeting. Write a short, friendly note and offer the booking link so they can pick a new time if they still want to talk. Never propose or confirm a time yourself.",
};

/**
 * Asks for a follow-up reply draft in the person's latest thread (always reviewed, never sent
 * automatically). False when there is no inbound message to answer, a person owns its thread
 * (takeover.ts: the engine writes nothing there), or there is no booking link to offer (handoff
 * or off mode, or no link set): the caller creates a task instead. The job checks the owner
 * again when it runs.
 */
async function requestFollowUpDraft(
  ctx: OpContext,
  meeting: Meeting,
  person: Person,
  kind: AfterKind,
): Promise<boolean> {
  const inbound = await latestInboundFor(ctx, meeting, person.id);
  if (!inbound?.thread_id || (await isThreadOwnedByPerson(ctx, inbound.thread_id))) return false;
  // The campaign the draft answers in (as loadReplyContext picks it), so the link is the draft's.
  const thread = await findThread(ctx, inbound.thread_id);
  const campaign = await findCampaign(ctx, inbound.campaign_id ?? thread?.campaign_id ?? null);
  const { url: link } = await replyBookingLink(ctx, {
    personId: person.id,
    offerId: campaign?.offer_id ?? null,
  });
  if (!link) return false;
  await ctx.jobs.enqueue(
    DRAFT_REPLY_JOB,
    {
      message_id: inbound.id,
      auto_send: false,
      manual: true,
      automatic: true,
      instruction: DRAFT_INSTRUCTIONS[kind],
    },
    { singletonKey: `${DRAFT_REPLY_JOB}:meeting:${meeting.id}:${kind}` },
  );
  return true;
}

/** `booking.after_no_show` / `booking.after_cancel`: a task, a reviewed draft, or nothing. */
async function applyAfterRule(ctx: OpContext, meeting: Meeting, kind: AfterKind): Promise<void> {
  const booking = parseWorkspaceSettings(requireWorkspace(ctx).settings).booking;
  const rule = kind === "no_show" ? booking.after_no_show : booking.after_cancel;
  if (rule === "nothing" || !meeting.person_id) return;
  const person = await findPerson(ctx, meeting.person_id);
  if (!person) return;
  if (rule === "draft" && (await requestFollowUpDraft(ctx, meeting, person, kind))) return;
  await followUpTask(ctx, meeting, person, kind);
}

/** Runs the effects of a status change this call claimed, and fires its event. */
async function afterStatusChange(ctx: OpContext, previous: MeetingStatus, row: Meeting) {
  const base = {
    meeting_id: row.id,
    person_id: row.person_id,
    opportunity_id: row.opportunity_id,
  };
  const subject = { type: "meeting", id: row.id };
  if (row.status === "held") {
    await ctx.events.emit("meeting.held", { subject, data: { ...base, qualified: row.qualified } });
  } else if (row.status === "no_show") {
    await applyAfterRule(ctx, row, "no_show");
    await ctx.events.emit("meeting.no_show", { subject, data: base });
  } else if (row.status === "cancelled") {
    await releaseOpportunity(ctx, row);
    await applyAfterRule(ctx, row, "cancelled");
    await ctx.events.emit("meeting.cancelled", { subject, data: base });
  } else if (previous === "no_show") {
    await closeFollowUpTask(ctx, row, "skipped");
  }
}

/**
 * Sets a meeting's status (binding signature from the upgrade plan) with optional qualified
 * flag and notes. held fires `meeting.held`; no_show runs `booking.after_no_show` and fires
 * `meeting.no_show`; cancelled frees the opportunity, runs `booking.after_cancel` and fires
 * `meeting.cancelled`; scheduled (an undo of held or no_show) closes the no-show follow-up
 * task. The same status again only stores changed qualified or notes and fires nothing.
 * The change is claimed first (an update guarded by the old status) and only the call that
 * made it runs the effects, so two racing calls (the held job and a no-show webhook) never
 * leave the loser's task behind. An outcome that loses such a race is tried once more from the
 * new status when that change is allowed (a no-show webhook still wins over the held job);
 * `onlyFrom` (the held job: scheduled) refuses any other starting status instead. A crash
 * between the claim and the effects loses those effects (a missing task, never a double one).
 * Throws `not_found` for an unknown meeting and `conflict` for a change a meeting cannot make
 * (a cancelled meeting only comes back with a reschedule).
 */
export async function setMeetingStatus(
  ctx: OpContext,
  meetingId: string,
  status: MeetingStatus,
  opts: { qualified?: boolean | null; notes?: string | null; onlyFrom?: MeetingStatus } = {},
): Promise<{ changed: boolean }> {
  let meeting = await requireMeeting(ctx, meetingId);
  if (!canChangeMeetingStatus(meeting.status, status)) {
    throw new OpenOutboundError(
      "conflict",
      `Meeting ${meeting.id} is ${meeting.status}, so it cannot be marked ${status}.`,
      {
        hint:
          meeting.status === "cancelled"
            ? "A cancelled meeting stays cancelled: move it to a new time with manage_meetings action reschedule, or record a new one with action record."
            : "Check the meeting with manage_meetings action get first.",
        details: { meeting_id: meeting.id, status: meeting.status, requested: status },
      },
    );
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    if (opts.onlyFrom && meeting.status !== opts.onlyFrom) return { changed: false };
    const statusChanged = meeting.status !== status;
    const set: Partial<NewMeeting> = {};
    if (statusChanged) {
      set.status = status;
      set.status_changed_at = ctx.clock.now();
    }
    if (opts.qualified !== undefined && opts.qualified !== meeting.qualified) {
      set.qualified = opts.qualified;
    }
    const notes = mergeNotes(meeting.notes, opts.notes);
    if (notes !== meeting.notes) set.notes = notes;
    if (Object.keys(set).length === 0) return { changed: false };

    const [row] = await ctx.db
      .update(meetings)
      .set(set)
      .where(and(workspaceScope(ctx, meeting.id), eq(meetings.status, meeting.status)))
      .returning();
    if (row) {
      if (statusChanged) await afterStatusChange(ctx, meeting.status, row);
      return { changed: true };
    }
    // Another call changed the status meanwhile. Only an outcome (held, no_show, cancelled) is
    // tried again, and only when the new status allows it and is not already the one asked
    // for; an undo back to scheduled only ever applies to the status its caller saw.
    const fresh = await requireMeeting(ctx, meetingId);
    if (
      !statusChanged ||
      status === "scheduled" ||
      fresh.status === status ||
      !canChangeMeetingStatus(fresh.status, status)
    ) {
      return { changed: false };
    }
    meeting = fresh;
  }
  return { changed: false };
}

/**
 * Ids of the workspace's scheduled meetings that started at or before `cutoff`, oldest first
 * (for the held job). Meetings without a start time never qualify.
 */
export async function scheduledMeetingsStartedBy(
  ctx: OpContext,
  cutoff: Date,
  limit: number,
): Promise<string[]> {
  const workspace = requireWorkspace(ctx);
  const rows = await ctx.db
    .select({ id: meetings.id })
    .from(meetings)
    .where(
      and(
        eq(meetings.workspace_id, workspace.id),
        eq(meetings.status, "scheduled"),
        lte(meetings.start_at, cutoff),
      ),
    )
    .orderBy(asc(meetings.start_at), asc(meetings.id))
    .limit(limit);
  return rows.map((row) => row.id);
}
