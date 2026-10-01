/**
 * Meeting side of the prospect simulator: some prospects who get a reply with the booking link
 * book a meeting through it, and a small share of those do not show up. Bookings and no-shows
 * go through `handleMeetingBooking`, the path behind the generic meetings webhook, with the
 * person's booking code as `ref`; the held sweep (`meetings.assume_held`) counts the others as
 * held once their time has passed. Meeting times follow the reply's send time and every
 * decision is a pure function of stable ids, so replays give the same outcomes.
 */
import { and, eq, isNotNull, like } from "drizzle-orm";
import type { OpContext } from "../../core/context.js";
import { parseWorkspaceSettings } from "../../core/settings.js";
import { type Message, meetings, messages, offers, people } from "../../db/schema/index.js";
import { ensureBookingRef } from "../../modules/inbox/booking-links.js";
import type { MeetingBooking } from "../../modules/inbox/meeting-payloads.js";
import { findMeetingByExternalId } from "../../modules/inbox/meeting-records.js";
import { handleMeetingBooking } from "../../modules/inbox/meetings.js";
import { hashBool, hashRatio } from "../world/rng.js";

export const MEETING_BOOKING_JOB = "sandbox.simulate_meeting_booking";
export const MEETING_NO_SHOW_JOB = "sandbox.simulate_meeting_no_show";

/** Share of replies with the booking link that end in a booked meeting. */
export const MEETING_BOOKING_RATE = 0.6;
/** Share of booked meetings the prospect does not show up to. */
export const MEETING_NO_SHOW_RATE = 0.2;
/** A no-show is reported this long after the meeting was due to start. */
export const NO_SHOW_REPORT_DELAY_MS = 20 * 60_000;
const MIN_LEAD_DAYS = 1;
const MAX_LEAD_DAYS = 3;
const FIRST_HOUR_UTC = 14;
const HOURS = 4;
const MEETING_MINUTES = 30;
const EXTERNAL_PREFIX = "sbx_meeting_";

export interface MeetingDecision {
  books: boolean;
  noShow: boolean;
  startAt: Date;
  endAt: Date;
}

export interface MeetingSimResult {
  delivered: boolean;
  reason?: "not_found" | "no_link" | "no_booking" | "already_handled" | "not_yet";
  meeting_id?: string;
}

/** The booking id the simulated booking tool gives the meeting booked from one reply. */
export function sandboxMeetingExternalId(replyMessageId: string): string {
  return `${EXTERNAL_PREFIX}${replyMessageId}`;
}

/** Whether the prospect misses the meeting booked from this reply. */
export function decideMeetingNoShow(personId: string, replyMessageId: string): boolean {
  return hashBool(`sbx_meeting_no_show:${personId}:${replyMessageId}`, MEETING_NO_SHOW_RATE);
}

/**
 * Whether a prospect books a meeting from a reply that carried the booking link, and when: a
 * 30-minute slot 1 to 3 days after the reply was sent, starting on the hour between 14:00 and
 * 17:00 UTC.
 */
export function decideMeeting(input: {
  personId: string;
  replyMessageId: string;
  sentAt: Date;
}): MeetingDecision {
  const { personId, replyMessageId, sentAt } = input;
  const books = hashBool(`sbx_meeting_book:${personId}:${replyMessageId}`, MEETING_BOOKING_RATE);
  const dayRatio = hashRatio(`sbx_meeting_day:${personId}:${replyMessageId}`);
  const hourRatio = hashRatio(`sbx_meeting_hour:${personId}:${replyMessageId}`);
  const days = MIN_LEAD_DAYS + Math.floor(dayRatio * (MAX_LEAD_DAYS - MIN_LEAD_DAYS + 1));
  const hour = FIRST_HOUR_UTC + Math.floor(hourRatio * HOURS);
  const startAt = new Date(
    Date.UTC(sentAt.getUTCFullYear(), sentAt.getUTCMonth(), sentAt.getUTCDate() + days, hour),
  );
  return {
    books,
    noShow: books && decideMeetingNoShow(personId, replyMessageId),
    startAt,
    endAt: new Date(startAt.getTime() + MEETING_MINUTES * 60_000),
  };
}

/** The workspace's plain booking links: every offer's link and booking.default_url. */
async function bookingLinks(ctx: Pick<OpContext, "db">, workspaceId: string, settings: unknown) {
  const rows = await ctx.db
    .select({ url: offers.booking_url })
    .from(offers)
    .where(and(eq(offers.workspace_id, workspaceId), isNotNull(offers.booking_url)));
  const defaultUrl = parseWorkspaceSettings(settings).booking.default_url;
  return [...rows.map((row) => row.url), defaultUrl]
    .filter((url): url is string => Boolean(url?.trim()))
    .map((url) => url.trim().replace(/\/+$/, "").toLowerCase());
}

function carriesLink(body: string | null, links: string[]): boolean {
  const text = (body ?? "").toLowerCase();
  return links.some((link) => text.includes(link));
}

/** A sent email reply of ours to a known person, in the workspace. */
async function sentReply(
  ctx: Pick<OpContext, "db">,
  workspaceId: string,
  messageId: string,
): Promise<(Message & { person_id: string }) | null> {
  const [message] = await ctx.db
    .select()
    .from(messages)
    .where(and(eq(messages.workspace_id, workspaceId), eq(messages.id, messageId)))
    .limit(1);
  if (
    message?.direction !== "outbound" ||
    message.channel !== "email" ||
    message.action !== "reply" ||
    message.status !== "sent" ||
    !message.person_id
  ) {
    return null;
  }
  return message as Message & { person_id: string };
}

/**
 * Whether a sent message is a reply of ours that carried a booking link (the event handler
 * only schedules a booking for those).
 */
export async function isBookingLinkReply(ctx: OpContext, messageId: string): Promise<boolean> {
  const workspace = ctx.workspace;
  if (!workspace) return false;
  const message = await sentReply(ctx, workspace.id, messageId);
  if (!message) return false;
  return carriesLink(message.body_text, await bookingLinks(ctx, workspace.id, workspace.settings));
}

/**
 * Books the meeting for one reply that carried the booking link, when the prospect decides to,
 * through the generic booking path (repeat-safe: a second call finds the meeting already
 * booked). A prospect who will not show up gets a no-show job for after the meeting's start.
 */
export async function processMeetingBooking(
  ctx: OpContext,
  replyMessageId: string,
): Promise<MeetingSimResult> {
  const workspace = ctx.workspace;
  if (!workspace) return { delivered: false, reason: "not_found" };
  const message = await sentReply(ctx, workspace.id, replyMessageId);
  if (!message) return { delivered: false, reason: "not_found" };
  const [person] = await ctx.db
    .select()
    .from(people)
    .where(and(eq(people.workspace_id, workspace.id), eq(people.id, message.person_id)))
    .limit(1);
  if (!person) return { delivered: false, reason: "not_found" };
  if (!carriesLink(message.body_text, await bookingLinks(ctx, workspace.id, workspace.settings))) {
    return { delivered: false, reason: "no_link" };
  }
  const decision = decideMeeting({
    personId: person.id,
    replyMessageId: message.id,
    sentAt: message.sent_at ?? message.created_at,
  });
  if (!decision.books) return { delivered: false, reason: "no_booking" };

  const booking: MeetingBooking = {
    event: "booked",
    emails: person.email ? [person.email.toLowerCase()] : [],
    name: person.full_name,
    startTime: decision.startAt,
    endTime: decision.endAt,
    source: "sandbox",
    meetingSource: "generic",
    externalId: sandboxMeetingExternalId(message.id),
    previousExternalId: null,
    ref: await ensureBookingRef(ctx, person.id),
    rawEvent: "booked",
  };
  const result = await handleMeetingBooking(ctx, booking);
  if (!result.changed) {
    return {
      delivered: false,
      reason: "already_handled",
      ...(result.meeting_id ? { meeting_id: result.meeting_id } : {}),
    };
  }
  if (decision.noShow) {
    const reportAt = decision.startAt.getTime() + NO_SHOW_REPORT_DELAY_MS;
    await ctx.jobs.enqueue(
      MEETING_NO_SHOW_JOB,
      { message_id: message.id },
      {
        delayMs: Math.max(0, reportAt - ctx.clock.now().getTime()),
        singletonKey: `sandbox_meeting_no_show:${message.id}`,
      },
    );
  }
  return { delivered: true, ...(result.meeting_id ? { meeting_id: result.meeting_id } : {}) };
}

/**
 * Reports the no-show for the meeting booked from one reply, once its start has passed and
 * only while it is still scheduled (a person may have moved, cancelled or marked it already).
 */
export async function processMeetingNoShow(
  ctx: OpContext,
  replyMessageId: string,
): Promise<MeetingSimResult> {
  if (!ctx.workspace) return { delivered: false, reason: "not_found" };
  const externalId = sandboxMeetingExternalId(replyMessageId);
  const meeting = await findMeetingByExternalId(ctx, "generic", externalId);
  if (!meeting?.person_id || !decideMeetingNoShow(meeting.person_id, replyMessageId)) {
    return { delivered: false, reason: "not_found" };
  }
  if (meeting.status !== "scheduled") {
    return { delivered: false, reason: "already_handled", meeting_id: meeting.id };
  }
  const due = (meeting.start_at?.getTime() ?? Number.POSITIVE_INFINITY) + NO_SHOW_REPORT_DELAY_MS;
  if (due > ctx.clock.now().getTime()) {
    return { delivered: false, reason: "not_yet", meeting_id: meeting.id };
  }
  const result = await handleMeetingBooking(ctx, {
    event: "no_show",
    emails: [],
    name: null,
    startTime: null,
    endTime: null,
    source: "sandbox",
    meetingSource: "generic",
    externalId,
    previousExternalId: null,
    ref: null,
    rawEvent: "no_show",
  });
  return { delivered: result.changed === true, meeting_id: meeting.id };
}

/**
 * Replies with the booking link whose prospect decided to book but has no meeting yet
 * (candidates for `sandbox.simulate` and the `sandbox.status` pending count).
 */
export async function findPendingMeetingBookings(
  ctx: Pick<OpContext, "db">,
  workspace: { id: string; settings: unknown },
): Promise<string[]> {
  const links = await bookingLinks(ctx, workspace.id, workspace.settings);
  if (links.length === 0) return [];
  const replies = await ctx.db
    .select({
      id: messages.id,
      person_id: messages.person_id,
      body_text: messages.body_text,
      sent_at: messages.sent_at,
      created_at: messages.created_at,
    })
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, workspace.id),
        eq(messages.channel, "email"),
        eq(messages.direction, "outbound"),
        eq(messages.action, "reply"),
        eq(messages.status, "sent"),
        isNotNull(messages.person_id),
      ),
    );
  const booked = new Set(
    (
      await ctx.db
        .select({ external_id: meetings.external_id })
        .from(meetings)
        .where(
          and(
            eq(meetings.workspace_id, workspace.id),
            eq(meetings.source, "generic"),
            like(meetings.external_id, `${EXTERNAL_PREFIX}%`),
          ),
        )
    ).map((row) => row.external_id),
  );
  return replies
    .filter(
      (reply) =>
        reply.person_id &&
        carriesLink(reply.body_text, links) &&
        !booked.has(sandboxMeetingExternalId(reply.id)) &&
        decideMeeting({
          personId: reply.person_id,
          replyMessageId: reply.id,
          sentAt: reply.sent_at ?? reply.created_at,
        }).books,
    )
    .map((reply) => reply.id);
}

/** Reply ids whose simulated meeting is a no-show that is due now and not reported yet. */
export async function findPendingMeetingNoShows(
  ctx: Pick<OpContext, "db" | "clock">,
  workspaceId: string,
): Promise<string[]> {
  const rows = await ctx.db
    .select({
      external_id: meetings.external_id,
      person_id: meetings.person_id,
      start_at: meetings.start_at,
    })
    .from(meetings)
    .where(
      and(
        eq(meetings.workspace_id, workspaceId),
        eq(meetings.source, "generic"),
        eq(meetings.status, "scheduled"),
        like(meetings.external_id, `${EXTERNAL_PREFIX}%`),
      ),
    );
  const now = ctx.clock.now().getTime();
  return rows
    .filter(
      (row) =>
        row.external_id?.startsWith(EXTERNAL_PREFIX) &&
        row.person_id &&
        row.start_at &&
        row.start_at.getTime() + NO_SHOW_REPORT_DELAY_MS <= now &&
        decideMeetingNoShow(row.person_id, row.external_id.slice(EXTERNAL_PREFIX.length)),
    )
    .map((row) => (row.external_id ?? "").slice(EXTERNAL_PREFIX.length));
}
