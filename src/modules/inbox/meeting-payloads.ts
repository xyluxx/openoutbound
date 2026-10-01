/**
 * Maps meeting webhook bodies to one shape. Three sources:
 * - generic JSON `{ email?, ref?, id?, previous_id?, name?, start_time?, end_time?, source?,
 *   event? }` with `event` in booked | rescheduled | cancelled | no_show | no_show_undone | held
 * - Cal.com webhooks (`triggerEvent` + `payload`: `uid`, `rescheduleUid`, `attendees[]`,
 *   `startTime`, `endTime`, `metadata.oo_ref`; `BOOKING_NO_SHOW_UPDATED` with `bookingUid` and
 *   `attendees[].noShow`)
 * - Calendly webhook subscriptions (`event` + `payload`: the invitee with `uri`, `email`,
 *   `old_invitee`, `tracking.utm_content`, `scheduled_event.start_time`; `invitee_no_show.*`)
 * Provider shapes come from the vendors' public webhook docs and are partly unverified, so each
 * mapping is one small function that reads defensively and is easy to adjust.
 */
import type { MeetingSource } from "../../core/enums.js";

export type MeetingEvent =
  | "booked"
  | "rescheduled"
  | "cancelled"
  | "no_show"
  | "no_show_undone"
  | "held"
  | "ignored";

export interface MeetingBooking {
  event: MeetingEvent;
  /** Candidate attendee emails, lowercase (first match wins). */
  emails: string[];
  name: string | null;
  startTime: Date | null;
  endTime: Date | null;
  /** Label for notes and notifications: "calcom", "calendly" or the generic `source` (default "webhook"). */
  source: string;
  /** Source stored on the meeting record. */
  meetingSource: Exclude<MeetingSource, "manual">;
  /** The booking tool's id for the booking: Calendly invitee URI, Cal.com uid, generic id. */
  externalId: string | null;
  /** The booking a reschedule replaces (Calendly old invitee, Cal.com rescheduleUid). */
  previousExternalId: string | null;
  /** The hidden per-person booking code from a tagged link, when the tool passed it back. */
  ref: string | null;
  /** Provider event name, for logs and ignored responses. */
  rawEvent: string;
}

type Json = Record<string, unknown>;

const MAX_ID_CHARS = 300;
/** Longest address accepted (the SMTP path limit). Longer strings are never pattern-tested. */
const MAX_EMAIL_CHARS = 320;
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** An id: a non-empty string or a finite number, capped. */
function id(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return str(value)?.slice(0, MAX_ID_CHARS) ?? null;
}

/** A lowercase address, or null. The length cap keeps the pattern's backtracking small. */
function email(value: unknown): string | null {
  const text = str(value)?.toLowerCase() ?? null;
  if (!text || text.length > MAX_EMAIL_CHARS) return null;
  return EMAIL_PATTERN.test(text) ? text : null;
}

function date(value: unknown): Date | null {
  const text = str(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function ref(value: unknown): string | null {
  return str(value)?.toLowerCase().slice(0, 64) ?? null;
}

function unique(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

const CALCOM_EVENTS: Record<string, MeetingEvent> = {
  BOOKING_CREATED: "booked",
  BOOKING_RESCHEDULED: "rescheduled",
  BOOKING_CANCELLED: "cancelled",
  BOOKING_REJECTED: "cancelled",
};

/** `BOOKING_NO_SHOW_UPDATED`: any attendee marked no-show, or every flag cleared (an undo). */
function calcomNoShow(attendees: Json[]): MeetingEvent {
  const flags = attendees
    .map((attendee) => attendee.noShow)
    .filter((flag): flag is boolean => typeof flag === "boolean");
  if (flags.some(Boolean)) return "no_show";
  return flags.length > 0 ? "no_show_undone" : "ignored";
}

export function fromCalcom(body: Json): MeetingBooking {
  const trigger = str(body.triggerEvent) ?? "UNKNOWN";
  const payload = isObject(body.payload) ? body.payload : {};
  const attendees = Array.isArray(payload.attendees) ? payload.attendees.filter(isObject) : [];
  const responses = isObject(payload.responses) ? payload.responses : {};
  const responseEmail = isObject(responses.email) ? responses.email.value : null;
  const responseName = isObject(responses.name) ? responses.name.value : null;
  const metadata = isObject(payload.metadata) ? payload.metadata : {};
  const previous = id(payload.rescheduleUid) ?? id(payload.fromReschedule);
  let event: MeetingEvent =
    trigger === "BOOKING_NO_SHOW_UPDATED"
      ? calcomNoShow(attendees)
      : (CALCOM_EVENTS[trigger] ?? "ignored");
  // A new booking that replaces an older one is a reschedule.
  if (event === "booked" && previous) event = "rescheduled";
  return {
    event,
    emails: unique([...attendees.map((attendee) => email(attendee.email)), email(responseEmail)]),
    name: str(attendees[0]?.name) ?? str(responseName),
    startTime: date(payload.startTime),
    endTime: date(payload.endTime),
    source: "calcom",
    meetingSource: "cal_com",
    externalId: id(payload.uid) ?? id(payload.bookingUid),
    previousExternalId: event === "rescheduled" ? previous : null,
    ref: ref(metadata.oo_ref),
    rawEvent: trigger,
  };
}

function uriOf(value: unknown): string | null {
  return str(value) ?? (isObject(value) ? str(value.uri) : null);
}

/**
 * The invitee URI of a Calendly no-show event. The payload is the invitee (its `uri`) or a
 * no-show record pointing at it (`invitee`), so look in the likely places for an invitee URI.
 */
function calendlyInviteeUri(payload: Json): string | null {
  const candidates = [
    uriOf(payload.invitee),
    isObject(payload.no_show) ? uriOf(payload.no_show.invitee) : null,
    str(payload.uri),
  ];
  return candidates.find((uri) => uri && /\/invitees\//.test(uri)) ?? null;
}

export function fromCalendly(body: Json): MeetingBooking {
  const name = str(body.event) ?? "unknown";
  const payload = isObject(body.payload) ? body.payload : {};
  const scheduled = isObject(payload.scheduled_event) ? payload.scheduled_event : {};
  const tracking = isObject(payload.tracking) ? payload.tracking : {};
  const invitee = isObject(payload.invitee) ? payload.invitee : {};
  const noShowEvent = name.startsWith("invitee_no_show.");
  let event: MeetingEvent = "ignored";
  if (name === "invitee.created") event = payload.old_invitee ? "rescheduled" : "booked";
  // A reschedule cancels the old invitee and creates a new one: only act on the new one.
  if (name === "invitee.canceled") event = payload.rescheduled === true ? "ignored" : "cancelled";
  if (name === "invitee_no_show.created") event = "no_show";
  if (name === "invitee_no_show.deleted") event = "no_show_undone";
  return {
    event,
    emails: unique([email(payload.email), email(invitee.email)]),
    name: str(payload.name) ?? str(invitee.name),
    startTime: date(scheduled.start_time),
    endTime: date(scheduled.end_time),
    source: "calendly",
    meetingSource: "calendly",
    externalId:
      (noShowEvent ? calendlyInviteeUri(payload) : str(payload.uri))?.slice(0, MAX_ID_CHARS) ??
      null,
    previousExternalId:
      event === "rescheduled" ? (uriOf(payload.old_invitee)?.slice(0, MAX_ID_CHARS) ?? null) : null,
    ref: ref(tracking.utm_content),
    rawEvent: name,
  };
}

const GENERIC_EVENTS: Record<string, MeetingEvent> = {
  booked: "booked",
  created: "booked",
  rescheduled: "rescheduled",
  cancelled: "cancelled",
  canceled: "cancelled",
  no_show: "no_show",
  "no-show": "no_show",
  noshow: "no_show",
  no_show_undone: "no_show_undone",
  held: "held",
};

export function fromGeneric(body: Json): MeetingBooking {
  const raw = str(body.event)?.toLowerCase() ?? "booked";
  return {
    event: GENERIC_EVENTS[raw] ?? "ignored",
    emails: unique([email(body.email)]),
    name: str(body.name),
    startTime: date(body.start_time),
    endTime: date(body.end_time),
    source: str(body.source)?.slice(0, 40) ?? "webhook",
    meetingSource: "generic",
    externalId: id(body.id),
    previousExternalId: id(body.previous_id),
    ref: ref(body.ref),
    rawEvent: raw,
  };
}

/** Recognizes the payload shape; returns an error message when none fits. */
export function parseMeetingPayload(body: unknown): MeetingBooking | { error: string } {
  if (!isObject(body)) return { error: "The body must be a JSON object." };
  if (typeof body.triggerEvent === "string") return fromCalcom(body);
  if (typeof body.event === "string" && isObject(body.payload)) return fromCalendly(body);
  const hasKey =
    typeof body.email === "string" ||
    typeof body.ref === "string" ||
    typeof body.id === "string" ||
    typeof body.id === "number";
  if (hasKey) {
    const booking = fromGeneric(body);
    if (typeof body.email === "string" && booking.emails.length === 0) {
      return { error: "email is not a valid address." };
    }
    if (booking.emails.length === 0 && !booking.ref && !booking.externalId) {
      return { error: "Send an email, a ref or an id to identify the booking." };
    }
    return booking;
  }
  return {
    error:
      "Unrecognized payload. Send { email, ref?, id?, name?, start_time?, end_time?, event? } or a Cal.com or Calendly webhook.",
  };
}
