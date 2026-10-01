/**
 * Meeting webhook `/hooks/meetings/:token`: a per-workspace URL (only the token's SHA-256 is
 * stored) that booking tools call. Bookings, reschedules, cancellations and no-shows become
 * meeting records through `meeting-records.ts` (the same path as `meetings.record`), matched to
 * the lead by the hidden booking code first, then by email.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
import { actorRef, type OpContext, requireWorkspace } from "../../core/context.js";
import type { MeetingMatch, MeetingStatus } from "../../core/enums.js";
import { OpenOutboundError } from "../../core/errors.js";
import type { EventType } from "../../core/events.js";
import { defineOperation, type HttpRouteRegistrar, isoDateTime } from "../../core/operation.js";
import type { Db } from "../../db/client.js";
import {
  type Meeting,
  type MeetingWebhook,
  meeting_webhooks,
  type Person,
  people,
} from "../../db/schema/index.js";
import { creatorKeyEnded } from "../../runtime/api-keys.js";
import { openProblem, resolveProblemsFor } from "../problems/service.js";
import { findPersonByBookingRef } from "./booking-links.js";
import { type MeetingBooking, parseMeetingPayload } from "./meeting-payloads.js";
import {
  canChangeMeetingStatus,
  findMeetingByExternalId,
  findPersonMeeting,
  getMeeting,
  isSupersededId,
  otherScheduledMeeting,
  recordCancelledBooking,
  recordMeetingBooked,
  rescheduleMeeting,
  setMeetingStatus,
} from "./meeting-records.js";
import { personLabel, safeNotify } from "./notifications.js";
import { findOpenOpportunity, getOpportunity, updateOpportunity } from "./opportunities.js";
import { findCompany, findPerson } from "./reply-context.js";

const TOKEN_PATTERN = /^mtg_[A-Za-z0-9_-]{20,64}$/;
const MAX_BODY_CHARS = 256 * 1024;

export function hashMeetingToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateMeetingToken(): string {
  return `mtg_${randomBytes(24).toString("base64url")}`;
}

export function meetingWebhookUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/hooks/meetings/${token}`;
}

/** The webhook row for a URL token, or null (malformed, unknown or rotated). */
export async function findMeetingWebhook(db: Db, token: string): Promise<MeetingWebhook | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const [row] = await db
    .select()
    .from(meeting_webhooks)
    .where(eq(meeting_webhooks.token_hash, hashMeetingToken(token)))
    .limit(1);
  return row ?? null;
}

export const createMeetingWebhook = defineOperation({
  id: "meetings.create_webhook",
  summary: "Create (or rotate) the meeting-booked webhook URL",
  description:
    "Creates this workspace's secret meeting webhook URL for Cal.com, Calendly or any tool that can POST { email or ref, start_time?, event? }. A booking by a known lead (matched by the hidden code in tagged booking links, then by email) becomes a meeting record, moves their opportunity to meeting_booked, stops their sequences and notifies you; reschedules, cancellations and no-shows update it. The URL is shown only once; call again with rotate: true to replace it (the old URL stops working). Use manage_meetings action record to record a meeting by hand instead.",
  effect: "admin",
  input: z.object({
    rotate: z.boolean().default(false).describe("Replace the existing URL"),
  }),
  output: z.object({
    url: z.string().describe("Secret: anyone with it can report meetings for this workspace"),
    token_hint: z.string(),
    rotated: z.boolean(),
    created_at: isoDateTime(),
    accepts: z.array(z.string()),
  }),
  http: { method: "POST", path: "/v1/meetings/webhook" },
  dryRun: "none",
  idempotent: false,
  workspace: "required",
  examples: [{ title: "Create the URL", input: {} }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const [existing] = await ctx.db
      .select()
      .from(meeting_webhooks)
      .where(eq(meeting_webhooks.workspace_id, workspace.id))
      .limit(1);
    if (existing && !input.rotate) {
      throw new OpenOutboundError(
        "conflict",
        `This workspace already has a meetings webhook URL (ending in ${existing.token_hint}).`,
        {
          hint: "Pass rotate: true to issue a new URL; the old one stops working at once.",
          details: { token_hint: existing.token_hint },
        },
      );
    }
    const token = generateMeetingToken();
    const values = {
      token_hash: hashMeetingToken(token),
      token_hint: token.slice(-4),
      created_by: actorRef(ctx.principal),
      last_used_at: null,
    };
    if (existing) {
      await ctx.db.update(meeting_webhooks).set(values).where(eq(meeting_webhooks.id, existing.id));
    } else {
      await ctx.db.insert(meeting_webhooks).values({ ...values, workspace_id: workspace.id });
    }
    return {
      url: meetingWebhookUrl(ctx.config.baseUrl, token),
      token_hint: values.token_hint,
      rotated: Boolean(existing),
      created_at: ctx.clock.now(),
      accepts: [
        "generic JSON { email?, ref?, id?, name?, start_time?, end_time?, source?, event?: booked | rescheduled | cancelled | no_show | held }",
        "Cal.com webhooks (BOOKING_CREATED, BOOKING_RESCHEDULED, BOOKING_CANCELLED, BOOKING_REJECTED, BOOKING_NO_SHOW_UPDATED)",
        "Calendly webhook subscriptions (invitee.created, invitee.canceled, invitee_no_show.created, invitee_no_show.deleted)",
      ],
    };
  },
});

export interface MeetingWebhookResult {
  matched: boolean;
  event: MeetingBooking["event"];
  ignored?: string;
  person_id?: string;
  meeting_id?: string;
  meeting_status?: MeetingStatus;
  matched_by?: MeetingMatch;
  opportunity_id?: string;
  stage?: string;
  changed?: boolean;
  /** The `unmatched_booking` problem opened for a booking that matched no lead. */
  problem_id?: string;
}

interface PersonMatch {
  person: Person;
  matchedBy: MeetingMatch;
}

/** The booking code first (an assistant or another address still matches), then the email. */
async function matchPerson(ctx: OpContext, booking: MeetingBooking): Promise<PersonMatch | null> {
  const workspace = requireWorkspace(ctx);
  if (booking.ref) {
    const person = await findPerson(ctx, await findPersonByBookingRef(ctx, booking.ref));
    if (person) return { person, matchedBy: "ref" };
  }
  if (booking.emails.length === 0) return null;
  const [person] = await ctx.db
    .select()
    .from(people)
    .where(
      and(
        eq(people.workspace_id, workspace.id),
        inArray(sql`lower(${people.email})`, booking.emails),
      ),
    )
    .limit(1);
  return person ? { person, matchedBy: "email" } : null;
}

async function knownMeeting(ctx: OpContext, booking: MeetingBooking): Promise<Meeting | null> {
  return booking.externalId
    ? findMeetingByExternalId(ctx, booking.meetingSource, booking.externalId)
    : null;
}

async function resultFor(
  ctx: OpContext,
  booking: MeetingBooking,
  meetingId: string,
  changed: boolean,
): Promise<MeetingWebhookResult> {
  const meeting = await getMeeting(ctx, meetingId);
  const opportunity = meeting?.opportunity_id
    ? await getOpportunity(ctx, meeting.opportunity_id)
    : null;
  const result: MeetingWebhookResult = { matched: true, event: booking.event, changed };
  if (meeting) {
    result.meeting_id = meeting.id;
    result.meeting_status = meeting.status;
    result.matched_by = meeting.matched_by;
    if (meeting.person_id) result.person_id = meeting.person_id;
  }
  if (opportunity) {
    result.opportunity_id = opportunity.id;
    result.stage = opportunity.stage;
  }
  return result;
}

type Announcement = "booked" | "rescheduled" | "cancelled" | "no_show";

const ANNOUNCEMENT_EVENTS: Record<Announcement, EventType> = {
  booked: "meeting.booked",
  rescheduled: "meeting.rescheduled",
  cancelled: "meeting.cancelled",
  no_show: "meeting.no_show",
};

/** Notifies people about a change made by a booking tool and records it in the audit log. */
async function announce(
  ctx: OpContext,
  meetingId: string,
  what: Announcement,
  booking: MeetingBooking,
): Promise<void> {
  const meeting = await getMeeting(ctx, meetingId);
  if (!meeting) return;
  const person = await findPerson(ctx, meeting.person_id);
  const label = personLabel(person, await findCompany(ctx, person?.company_id ?? null));
  const opportunity = meeting.opportunity_id
    ? await getOpportunity(ctx, meeting.opportunity_id)
    : null;
  const titles: Record<Announcement, string> = {
    booked: `Meeting booked: ${label}`,
    rescheduled: `Meeting rescheduled: ${label}`,
    cancelled: `Meeting cancelled: ${label}`,
    no_show: `No-show: ${label}`,
  };
  const lines = [meeting.start_at?.toISOString() ?? "time not given", `Source: ${booking.source}`];
  if (what === "cancelled" && opportunity?.stage === "interested") {
    lines.push("The opportunity is back to interested.");
  }
  await safeNotify(ctx, {
    title: titles[what],
    lines,
    severity: what === "cancelled" || what === "no_show" ? "warning" : "info",
    event: ANNOUNCEMENT_EVENTS[what],
  });
  await ctx.audit.record({
    operation: "meetings.webhook",
    effect: "write",
    status: "ok",
    target: { type: "meeting", id: meeting.id },
    summary: `Meeting ${what.replace("_", "-")} via ${booking.source}`,
  });
}

function unmatchedKey(booking: MeetingBooking): string {
  const id =
    booking.externalId ??
    `${booking.emails[0] ?? booking.ref ?? "unknown"}:${booking.startTime?.toISOString() ?? "no_time"}`;
  return `unmatched_booking:${booking.meetingSource}:${id}`;
}

/** A booking nobody matches: one `unmatched_booking` problem per booking, one notification. */
async function unmatched(ctx: OpContext, booking: MeetingBooking): Promise<MeetingWebhookResult> {
  const who = booking.emails[0] ?? "someone without an email address";
  const when = booking.startTime?.toISOString() ?? null;
  const problem = await openProblem(ctx, {
    kind: "unmatched_booking",
    severity: "normal",
    owner: "person",
    title: `Meeting booked by ${who}, who is not a lead`,
    reason: `A meeting${when ? ` for ${when}` : ""} was booked through ${booking.source} by ${who}, but no lead has that email address${booking.ref ? " or booking code" : ""}.`,
    remedy:
      "Find the lead and record the meeting with manage_meetings action record, or ignore it if this is not a lead",
    data: {
      meeting_source: booking.meetingSource,
      external_id: booking.externalId,
      start_at: when,
      end_at: booking.endTime?.toISOString() ?? null,
      email: booking.emails[0] ?? null,
      name: booking.name,
      ref: booking.ref,
      source: booking.source,
    },
    dueAt: booking.startTime && booking.startTime > ctx.clock.now() ? booking.startTime : null,
    dedupeKey: unmatchedKey(booking),
  });
  if (problem.created) {
    await safeNotify(ctx, {
      title: "Meeting booked by someone who is not a lead",
      lines: [
        `${booking.name ?? "Unknown"} <${booking.emails[0] ?? "no email"}>`,
        when ?? "time not given",
        `Source: ${booking.source}`,
      ],
      severity: "info",
      event: "problem.opened",
    });
  }
  return { matched: false, event: booking.event, problem_id: problem.id };
}

async function handleBooked(
  ctx: OpContext,
  booking: MeetingBooking,
  match: PersonMatch | null,
): Promise<MeetingWebhookResult> {
  const known = await knownMeeting(ctx, booking);
  if (!known && !match) return unmatched(ctx, booking);
  const result = await recordMeetingBooked(ctx, {
    personId: known ? known.person_id : (match?.person.id ?? null),
    source: booking.meetingSource,
    matchedBy: known?.matched_by ?? match?.matchedBy ?? "email",
    externalId: booking.externalId,
    startAt: booking.startTime,
    endAt: booking.endTime,
  });
  if (result.created) await announce(ctx, result.meetingId, "booked", booking);
  return resultFor(ctx, booking, result.meetingId, result.changed);
}

/** The person of a meeting on record, as a match, or null. */
async function matchOf(ctx: OpContext, meeting: Meeting): Promise<PersonMatch | null> {
  const person = await findPerson(ctx, meeting.person_id);
  return person ? { person, matchedBy: meeting.matched_by } : null;
}

async function handleRescheduled(
  ctx: OpContext,
  booking: MeetingBooking,
  match: PersonMatch | null,
): Promise<MeetingWebhookResult> {
  const byNewId = await knownMeeting(ctx, booking);
  // A late delivery: a later reschedule already replaced this booking, or it was cancelled
  // since. A reschedule never reopens a cancelled meeting.
  if (byNewId && (isSupersededId(byNewId, booking.externalId) || byNewId.status === "cancelled")) {
    return resultFor(ctx, booking, byNewId.id, false);
  }
  const byPreviousId =
    !byNewId && booking.previousExternalId
      ? await findMeetingByExternalId(ctx, booking.meetingSource, booking.previousExternalId)
      : null;
  if (byPreviousId && isSupersededId(byPreviousId, booking.previousExternalId)) {
    return resultFor(ctx, booking, byPreviousId.id, false);
  }
  if (byPreviousId?.status === "cancelled") {
    // The booking it replaces was cancelled: the new one is booked as a meeting of its own.
    const owner = match ?? (await matchOf(ctx, byPreviousId));
    return owner ? handleBooked(ctx, booking, owner) : unmatched(ctx, booking);
  }
  const current =
    byNewId ??
    byPreviousId ??
    (match
      ? await findPersonMeeting(ctx, match.person.id, {
          statuses: ["scheduled"],
          source: booking.meetingSource,
        })
      : null);
  if (!current) {
    // Nothing on record to move (booked before meetings were recorded, say): record it now.
    return match ? handleBooked(ctx, booking, match) : unmatched(ctx, booking);
  }
  if (!booking.startTime) return resultFor(ctx, booking, current.id, false);
  const { changed } = await rescheduleMeeting(ctx, current.id, {
    startAt: booking.startTime,
    endAt: booking.endTime,
    externalId: booking.externalId,
    previousExternalId: booking.previousExternalId,
    source: booking.meetingSource,
    reviveCancelled: false,
  });
  if (changed) await announce(ctx, current.id, "rescheduled", booking);
  return resultFor(ctx, booking, current.id, changed);
}

/**
 * v0.1 rule for an opportunity booked before meetings were recorded: back to interested, unless
 * one of the person's meetings is still scheduled (the cancellation is about another booking).
 */
async function cancelWithoutRecord(
  ctx: OpContext,
  booking: MeetingBooking,
  person: Person,
): Promise<MeetingWebhookResult> {
  const open = await findOpenOpportunity(ctx, person.id);
  if (open?.stage !== "meeting_booked" || (await otherScheduledMeeting(ctx, open, null))) {
    return { matched: true, event: booking.event, person_id: person.id, changed: false };
  }
  const { opportunity, changed } = await updateOpportunity(ctx, open, {
    stage: "interested",
    meeting_at: null,
    notes: [open.notes, `Meeting cancelled (${booking.source}).`].filter(Boolean).join("\n"),
  });
  const label = personLabel(person, await findCompany(ctx, person.company_id));
  await safeNotify(ctx, {
    title: `Meeting cancelled: ${label}`,
    lines: [`Source: ${booking.source}`, "The opportunity is back to interested."],
    severity: "warning",
    event: "opportunity.updated",
  });
  await ctx.audit.record({
    operation: "meetings.webhook",
    effect: "write",
    status: "ok",
    target: { type: "opportunity", id: opportunity.id },
    summary: `Meeting cancelled via ${booking.source}`,
  });
  return {
    matched: true,
    event: booking.event,
    person_id: person.id,
    opportunity_id: opportunity.id,
    stage: opportunity.stage,
    changed,
  };
}

async function cancelOnRecord(
  ctx: OpContext,
  booking: MeetingBooking,
  current: Meeting,
): Promise<MeetingWebhookResult> {
  if (!canChangeMeetingStatus(current.status, "cancelled")) {
    return resultFor(ctx, booking, current.id, false);
  }
  const { changed } = await setMeetingStatus(ctx, current.id, "cancelled");
  if (changed) await announce(ctx, current.id, "cancelled", booking);
  return resultFor(ctx, booking, current.id, changed);
}

async function handleCancelled(
  ctx: OpContext,
  booking: MeetingBooking,
  match: PersonMatch | null,
): Promise<MeetingWebhookResult> {
  const known = await knownMeeting(ctx, booking);
  // The cancellation of a booking a reschedule replaced: the meeting moved on, it stays.
  if (known && isSupersededId(known, booking.externalId)) {
    return resultFor(ctx, booking, known.id, false);
  }
  const current =
    known ??
    (match
      ? await findPersonMeeting(ctx, match.person.id, {
          statuses: ["scheduled"],
          source: booking.meetingSource,
          startAt: booking.startTime,
        })
      : null);
  if (current) return cancelOnRecord(ctx, booking, current);
  if (!match) {
    // A booking nobody matched was called off: its problem needs nobody any more.
    await resolveProblemsFor(
      ctx,
      { dedupeKey: unmatchedKey(booking) },
      "The booking was cancelled.",
    );
    return { matched: false, event: booking.event };
  }
  const result = await cancelWithoutRecord(ctx, booking, match.person);
  if (result.changed || !booking.externalId) return result;
  // Not on record yet (the booking itself may still be on its way): remember the cancellation,
  // so that booking never becomes a live meeting.
  const remembered = await recordCancelledBooking(ctx, {
    person: match.person,
    source: booking.meetingSource,
    matchedBy: match.matchedBy,
    externalId: booking.externalId,
    startAt: booking.startTime,
    endAt: booking.endTime,
    notes: `Cancelled in ${booking.source} before the booking reached OpenOutbound.`,
  });
  if (!remembered) {
    const stored = await knownMeeting(ctx, booking);
    return stored ? cancelOnRecord(ctx, booking, stored) : result;
  }
  await ctx.audit.record({
    operation: "meetings.webhook",
    effect: "write",
    status: "ok",
    target: { type: "meeting", id: remembered.id },
    summary: `Meeting cancelled via ${booking.source} before its booking arrived`,
  });
  return resultFor(ctx, booking, remembered.id, true);
}

/** no_show, no_show_undone and held: a status change on a meeting on record. */
async function handleOutcome(
  ctx: OpContext,
  booking: MeetingBooking,
  match: PersonMatch | null,
): Promise<MeetingWebhookResult> {
  const undo = booking.event === "no_show_undone";
  const target: MeetingStatus =
    booking.event === "no_show" ? "no_show" : booking.event === "held" ? "held" : "scheduled";
  const known = await knownMeeting(ctx, booking);
  if (known && isSupersededId(known, booking.externalId)) {
    return resultFor(ctx, booking, known.id, false);
  }
  const current =
    known ??
    (match
      ? await findPersonMeeting(ctx, match.person.id, {
          statuses: undo ? ["no_show"] : ["scheduled", "held", "no_show"],
          source: booking.meetingSource,
          startAt: booking.startTime,
        })
      : null);
  if (!current) {
    return {
      matched: Boolean(match),
      event: booking.event,
      ...(match ? { person_id: match.person.id } : {}),
      changed: false,
    };
  }
  if ((undo && current.status !== "no_show") || !canChangeMeetingStatus(current.status, target)) {
    return resultFor(ctx, booking, current.id, false);
  }
  const { changed } = await setMeetingStatus(ctx, current.id, target);
  if (changed && target === "no_show") await announce(ctx, current.id, "no_show", booking);
  return resultFor(ctx, booking, current.id, changed);
}

/**
 * Records a parsed booking event in the context workspace: the one path behind the webhook and
 * the sandbox simulator. The person is matched by the booking code first, then by email;
 * repeated deliveries change nothing. A booking nobody matches opens an `unmatched_booking`
 * problem (and one notification).
 */
export async function handleMeetingBooking(
  ctx: OpContext,
  booking: MeetingBooking,
): Promise<MeetingWebhookResult> {
  requireWorkspace(ctx);
  if (booking.event === "ignored") {
    return { matched: false, event: booking.event, ignored: booking.rawEvent };
  }
  const match = await matchPerson(ctx, booking);
  switch (booking.event) {
    case "booked":
      return handleBooked(ctx, booking, match);
    case "rescheduled":
      return handleRescheduled(ctx, booking, match);
    case "cancelled":
      return handleCancelled(ctx, booking, match);
    default:
      return handleOutcome(ctx, booking, match);
  }
}

function unknownMeetingUrl(c: Context) {
  return c.json(
    {
      error: "not_found",
      message: "Unknown meetings webhook URL.",
      hint: "Create a new URL with manage_pipeline (action meeting_webhook).",
    },
    404,
  );
}

/** `POST /hooks/meetings/:token` (public route: authenticated by the secret token). */
export const meetingsWebhookRoute: HttpRouteRegistrar = (app, { engine }) => {
  app.post("/hooks/meetings/:token", async (c) => {
    const hook = await findMeetingWebhook(engine.db, c.req.param("token"));
    if (!hook) return unknownMeetingUrl(c);
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > MAX_BODY_CHARS) {
      return c.json({ error: "too_large", message: "The body is larger than 256 KB." }, 413);
    }
    const raw = await c.req.text();
    if (raw.length > MAX_BODY_CHARS) {
      return c.json({ error: "too_large", message: "The body is larger than 256 KB." }, 413);
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid_json", message: "The body is not valid JSON." }, 400);
    }
    const booking = parseMeetingPayload(body);
    if ("error" in booking) {
      return c.json({ error: "unrecognized_payload", message: booking.error }, 400);
    }
    try {
      const ctx = await engine.systemContext(hook.workspace_id);
      // A URL made by a key stops working with that key (revoked or expired).
      if (await creatorKeyEnded(ctx.db, hook.created_by, ctx.clock.now())) {
        return unknownMeetingUrl(c);
      }
      // Public routes leave an archived workspace alone (unsubscribes excepted).
      if (ctx.workspace?.status === "archived") {
        return c.json(
          {
            error: "not_found",
            message: "This workspace is archived.",
            hint: "Ask the workspace owner to restore it (openoutbound workspaces update --no-archived) to record bookings again.",
          },
          404,
        );
      }
      const result = await handleMeetingBooking(ctx, booking);
      await engine.db
        .update(meeting_webhooks)
        .set({ last_used_at: ctx.clock.now() })
        .where(eq(meeting_webhooks.id, hook.id));
      return c.json({ ok: true, ...result }, 200);
    } catch (error) {
      engine.log.error({ err: error, webhook: hook.id }, "meetings webhook failed");
      return c.json(
        { error: "internal", message: "The booking could not be recorded; please retry." },
        500,
      );
    }
  });
};
