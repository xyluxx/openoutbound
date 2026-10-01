/**
 * meetings.* operations (manage_meetings). The engine never books calendars or confirms times:
 * the agent or a person books the meeting in a real calendar or booking tool, then records it
 * here; booking webhooks record their own bookings. Every change goes through
 * `meeting-records.ts`, the one path shared with the webhooks and the sandbox.
 */
import { and, asc, eq, gt, gte, inArray, lt, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import {
  MEETING_MATCHES,
  MEETING_SOURCES,
  MEETING_STATUSES,
  OPPORTUNITY_STAGES,
} from "../../core/enums.js";
import { OpenOutboundError } from "../../core/errors.js";
import { idSchema } from "../../core/ids.js";
import {
  dateTimeInput,
  defineOperation,
  isoDateTime,
  paginated,
  paginationInput,
} from "../../core/operation.js";
import { decodeCursor, toPage } from "../../core/pagination.js";
import { type Meeting, meetings, opportunities, people } from "../../db/schema/index.js";
import {
  getMeeting,
  recordMeetingBooked,
  rescheduleMeeting,
  setMeetingStatus,
} from "./meeting-records.js";
import { findPerson } from "./reply-context.js";
import { personRef } from "./schemas.js";

const MEETING_EXAMPLE_ID = "mt_01k6a3v0q8x3m2n4p5r6s7t8v9";
const PERSON_EXAMPLE_ID = "pe_01k6a3v0q8x3m2n4p5r6s7t8v9";
const NOTES_MAX = 4000;

export const meetingView = z.object({
  id: z.string(),
  status: z.enum(MEETING_STATUSES),
  start_at: isoDateTime().nullable(),
  end_at: isoDateTime().nullable(),
  person: personRef,
  company_id: z.string().nullable(),
  opportunity: z
    .object({ id: z.string(), stage: z.enum(OPPORTUNITY_STAGES) })
    .nullable()
    .describe("The pipeline opportunity the meeting belongs to"),
  campaign_id: z.string().nullable(),
  thread_id: z.string().nullable(),
  source: z
    .enum(MEETING_SOURCES)
    .describe("calendly, cal_com, generic (a booking webhook) or manual (recorded by hand)"),
  external_id: z.string().nullable().describe("The booking tool's id for the booking"),
  matched_by: z
    .enum(MEETING_MATCHES)
    .describe("ref (the hidden code in a tagged booking link), email, or manual"),
  qualified: z
    .boolean()
    .nullable()
    .describe("Whether it met the client's definition of a qualified meeting; null until judged"),
  notes: z.string().nullable(),
  status_changed_at: isoDateTime().nullable(),
  created_at: isoDateTime(),
});

type MeetingViewInput = z.input<typeof meetingView>;

const changeOutput = meetingView.extend({
  changed: z.boolean().describe("False when the meeting already looked like this"),
});

const meetingIdInput = idSchema("mt").describe("Meeting id (mt_...), from the list action");
const notesInput = z.string().max(NOTES_MAX).describe("A note added to the meeting");

/** Sort key of the list: start time (meetings without one last), then id. */
const startKey = sql`coalesce(date_trunc('milliseconds', ${meetings.start_at}), 'infinity'::timestamptz)`;

function meetingNotFound(id: string): OpenOutboundError {
  return new OpenOutboundError("not_found", `Meeting ${id} not found.`, {
    hint: "List meetings with manage_meetings action list (person_id or status) to find the id.",
    details: { what: "Meeting", id },
  });
}

async function requireMeeting(ctx: OpContext, id: string): Promise<Meeting> {
  const row = await getMeeting(ctx, id);
  if (!row) throw meetingNotFound(id);
  return row;
}

function ids(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

/** Output rows for meetings, with the person and the opportunity stage loaded in batches. */
async function meetingViews(ctx: OpContext, rows: Meeting[]): Promise<MeetingViewInput[]> {
  const workspace = requireWorkspace(ctx);
  const personIds = ids(rows.map((row) => row.person_id));
  const opportunityIds = ids(rows.map((row) => row.opportunity_id));
  const persons = personIds.length
    ? await ctx.db
        .select({
          id: people.id,
          full_name: people.full_name,
          email: people.email,
          title: people.title,
        })
        .from(people)
        .where(and(eq(people.workspace_id, workspace.id), inArray(people.id, personIds)))
    : [];
  const deals = opportunityIds.length
    ? await ctx.db
        .select({ id: opportunities.id, stage: opportunities.stage })
        .from(opportunities)
        .where(
          and(
            eq(opportunities.workspace_id, workspace.id),
            inArray(opportunities.id, opportunityIds),
          ),
        )
    : [];
  const personById = new Map(persons.map((person) => [person.id, person]));
  const dealById = new Map(deals.map((deal) => [deal.id, deal]));
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    start_at: row.start_at,
    end_at: row.end_at,
    person: (row.person_id && personById.get(row.person_id)) || null,
    company_id: row.company_id,
    opportunity: (row.opportunity_id && dealById.get(row.opportunity_id)) || null,
    campaign_id: row.campaign_id,
    thread_id: row.thread_id,
    source: row.source,
    external_id: row.external_id,
    matched_by: row.matched_by,
    qualified: row.qualified,
    notes: row.notes,
    status_changed_at: row.status_changed_at,
    created_at: row.created_at,
  }));
}

async function viewOf(ctx: OpContext, id: string): Promise<MeetingViewInput> {
  const [view] = await meetingViews(ctx, [await requireMeeting(ctx, id)]);
  if (!view) throw meetingNotFound(id);
  return view;
}

function assertEndAfterStart(start: Date, end: Date | null | undefined): void {
  if (end && end.getTime() <= start.getTime()) {
    throw new OpenOutboundError("validation_failed", "end_at must be after start_at.", {
      hint: "Pass an end_at later than start_at, or leave end_at out.",
      details: { start_at: start.toISOString(), end_at: end.toISOString() },
    });
  }
}

/** A meeting cannot be held or missed before it starts. */
function assertStarted(ctx: OpContext, meeting: Meeting, what: "held" | "a no-show"): void {
  if (meeting.start_at && meeting.start_at.getTime() > ctx.clock.now().getTime()) {
    throw new OpenOutboundError(
      "conflict",
      `Meeting ${meeting.id} starts at ${meeting.start_at.toISOString()}, so it cannot be marked ${what} yet.`,
      {
        hint: "If it took place at another time, move it first with manage_meetings action reschedule (meeting_id, start_at).",
        details: { meeting_id: meeting.id, start_at: meeting.start_at.toISOString() },
      },
    );
  }
}

export const listMeetings = defineOperation({
  id: "meetings.list",
  summary: "List meetings, soonest first",
  description:
    "Lists meetings with leads (scheduled, held, no_show, cancelled), soonest first, with the person, the opportunity stage, the source (booking webhook or manual) and the qualified flag. Use status scheduled and from (now) for what is coming up, or person_id for one lead's history. Use get_report (pipeline) for counts and held rates instead. Meetings come from booking webhooks and from the record action; the engine never books calendars itself.",
  effect: "read",
  input: paginationInput.extend({
    status: z
      .array(z.enum(MEETING_STATUSES))
      .optional()
      .describe("Only meetings with these statuses (scheduled, held, no_show, cancelled)"),
    person_id: idSchema("pe").optional(),
    from: dateTimeInput().optional().describe("Only meetings starting at or after this time"),
    to: dateTimeInput().optional().describe("Only meetings starting before this time"),
  }),
  output: paginated(meetingView),
  http: { method: "GET", path: "/v1/meetings" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Coming up",
      input: { status: ["scheduled"], from: "2026-09-28T00:00:00Z" },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const conditions: SQL[] = [eq(meetings.workspace_id, workspace.id)];
    if (input.status?.length) conditions.push(inArray(meetings.status, input.status));
    if (input.person_id) conditions.push(eq(meetings.person_id, input.person_id));
    if (input.from) conditions.push(gte(meetings.start_at, input.from));
    if (input.to) conditions.push(lt(meetings.start_at, input.to));
    if (input.cursor) {
      const cursor = decodeCursor<{ s?: unknown; id?: unknown }>(input.cursor);
      if (typeof cursor.s !== "string" || typeof cursor.id !== "string") {
        throw new OpenOutboundError("validation_failed", "Invalid cursor.", {
          hint: "Pass next_cursor exactly as returned by the previous page, or omit it to start over.",
        });
      }
      const after = or(
        sql`${startKey} > ${cursor.s}::timestamptz`,
        and(sql`${startKey} = ${cursor.s}::timestamptz`, gt(meetings.id, cursor.id)),
      );
      if (after) conditions.push(after);
    }
    const rows = await ctx.db
      .select()
      .from(meetings)
      .where(and(...conditions))
      .orderBy(asc(startKey), asc(meetings.id))
      .limit(input.limit + 1);
    const page = toPage(rows, input.limit, (row) => ({
      s: row.start_at ? row.start_at.toISOString() : "infinity",
      id: row.id,
    }));
    return { ...page, items: await meetingViews(ctx, page.items) };
  },
});

export const getMeetingOperation = defineOperation({
  id: "meetings.get",
  summary: "Get one meeting",
  description:
    "Returns one meeting with its status, times, person, opportunity stage, source, booking id, qualified flag and notes. Use it to check a meeting before changing it. Use the list action to find meetings by person, status or time. Booking webhooks keep it up to date for Calendly, Cal.com and generic bookings.",
  effect: "read",
  input: z.object({ meeting_id: meetingIdInput }),
  output: meetingView,
  http: { method: "GET", path: "/v1/meetings/:meeting_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "One meeting", input: { meeting_id: MEETING_EXAMPLE_ID } }],
  handler: (ctx, input) => viewOf(ctx, input.meeting_id),
});

export const recordMeeting = defineOperation({
  id: "meetings.record",
  summary: "Record a meeting that was booked",
  description:
    "Records a meeting you or a person booked with a lead (person_id, start_at, optional end_at and notes), with the same effects as a booking webhook: the opportunity moves to meeting_booked, the person's active sequences stop (campaign stop.on_meeting), their book-a-meeting problem resolves, the CRM syncs and meeting.booked fires. The engine never books calendars or confirms times: book it in a real calendar first, then record it here. Do not record meetings a booking webhook already reported (list first); recording the same person and start again returns the existing meeting.",
  effect: "write",
  input: z.object({
    person_id: idSchema("pe"),
    start_at: dateTimeInput().describe("When the meeting starts (ISO 8601 with offset)"),
    end_at: dateTimeInput().optional().describe("When it ends (optional)"),
    notes: notesInput.optional(),
  }),
  output: meetingView.extend({
    created: z.boolean().describe("False when the same meeting was already on record"),
    changed: z.boolean(),
  }),
  http: { method: "POST", path: "/v1/meetings" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Booked for Tuesday 15:00",
      input: {
        person_id: PERSON_EXAMPLE_ID,
        start_at: "2026-10-06T15:00:00+02:00",
        notes: "Booked by phone after she proposed Tuesday afternoon.",
      },
    },
  ],
  handler: async (ctx, input) => {
    assertEndAfterStart(input.start_at, input.end_at);
    if (!(await findPerson(ctx, input.person_id))) {
      throw new OpenOutboundError("not_found", `Person ${input.person_id} not found.`, {
        hint: "Find the lead with search_leads and pass its id as person_id.",
        details: { what: "Person", id: input.person_id },
      });
    }
    const result = await recordMeetingBooked(ctx, {
      personId: input.person_id,
      source: "manual",
      matchedBy: "manual",
      startAt: input.start_at,
      endAt: input.end_at ?? null,
      notes: input.notes ?? null,
    });
    return {
      ...(await viewOf(ctx, result.meetingId)),
      created: result.created,
      changed: result.changed,
    };
  },
});

export const rescheduleMeetingOperation = defineOperation({
  id: "meetings.reschedule",
  summary: "Move a meeting to a new time",
  description:
    "Moves a meeting to a new start (and end; without end_at the length stays the same), keeps or makes it scheduled, updates the opportunity's meeting time and fires meeting.rescheduled. Use it when a meeting was moved outside a booking tool, or to bring back a cancelled meeting at a new time. This changes the record only: move the booking in the calendar or booking tool too (a Calendly or Cal.com reschedule updates the record by itself). The engine never confirms times with the lead.",
  effect: "write",
  input: z.object({
    meeting_id: meetingIdInput,
    start_at: dateTimeInput().describe("When the meeting starts (ISO 8601 with offset)"),
    end_at: dateTimeInput().optional().describe("When it ends (optional)"),
  }),
  output: changeOutput,
  http: { method: "POST", path: "/v1/meetings/:meeting_id/reschedule" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Moved to Thursday",
      input: { meeting_id: MEETING_EXAMPLE_ID, start_at: "2026-10-08T09:00:00Z" },
    },
  ],
  handler: async (ctx, input) => {
    const meeting = await requireMeeting(ctx, input.meeting_id);
    assertEndAfterStart(input.start_at, input.end_at);
    let endAt = input.end_at;
    if (endAt === undefined && meeting.start_at && meeting.end_at) {
      const length = meeting.end_at.getTime() - meeting.start_at.getTime();
      endAt = new Date(input.start_at.getTime() + length);
    }
    const { changed } = await rescheduleMeeting(ctx, meeting.id, {
      startAt: input.start_at,
      ...(endAt !== undefined ? { endAt } : {}),
    });
    return { ...(await viewOf(ctx, meeting.id)), changed };
  },
});

export const cancelMeeting = defineOperation({
  id: "meetings.cancel",
  summary: "Cancel a meeting",
  description:
    "Marks a meeting cancelled: the opportunity goes back to interested unless another meeting is scheduled, booking.after_cancel runs (a follow-up task by default, or a reviewed draft offering the booking link) and meeting.cancelled fires. A cancellation never restarts a stopped sequence. Use it when the lead or you called the meeting off outside a booking tool; a Calendly or Cal.com cancellation is recorded by itself. To move a meeting instead, use the reschedule action.",
  effect: "write",
  input: z.object({ meeting_id: meetingIdInput, notes: notesInput.optional() }),
  output: changeOutput,
  http: { method: "POST", path: "/v1/meetings/:meeting_id/cancel" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Called off",
      input: { meeting_id: MEETING_EXAMPLE_ID, notes: "Budget freeze until January." },
    },
  ],
  handler: async (ctx, input) => {
    const meeting = await requireMeeting(ctx, input.meeting_id);
    const { changed } = await setMeetingStatus(ctx, meeting.id, "cancelled", {
      notes: input.notes ?? null,
    });
    return { ...(await viewOf(ctx, meeting.id)), changed };
  },
});

export const markMeetingHeld = defineOperation({
  id: "meetings.mark_held",
  summary: "Mark a meeting held",
  description:
    "Marks a meeting that took place as held, optionally with qualified (did it meet the client's definition in strategy.qualified_meeting) and notes, and fires meeting.held. Use it right after the call; otherwise scheduled meetings count as held booking.assume_held_after_hours after their start (0 turns that off). A meeting cannot be held before it starts, and a cancelled one only comes back with the reschedule action. Use mark_no_show when the lead did not show up.",
  effect: "write",
  input: z.object({
    meeting_id: meetingIdInput,
    qualified: z
      .boolean()
      .optional()
      .describe("Whether it met the client's definition of a qualified meeting"),
    notes: notesInput.optional(),
  }),
  output: changeOutput,
  http: { method: "POST", path: "/v1/meetings/:meeting_id/held" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Good first call",
      input: { meeting_id: MEETING_EXAMPLE_ID, qualified: true, notes: "Wants a pilot in Q1." },
    },
  ],
  handler: async (ctx, input) => {
    const meeting = await requireMeeting(ctx, input.meeting_id);
    if (meeting.status !== "held") assertStarted(ctx, meeting, "held");
    const { changed } = await setMeetingStatus(ctx, meeting.id, "held", {
      ...(input.qualified !== undefined ? { qualified: input.qualified } : {}),
      notes: input.notes ?? null,
    });
    return { ...(await viewOf(ctx, meeting.id)), changed };
  },
});

export const markMeetingNoShow = defineOperation({
  id: "meetings.mark_no_show",
  summary: "Mark a meeting a no-show, or undo that",
  description:
    "Marks a meeting the lead did not attend as no_show: booking.after_no_show runs (a follow-up task by default, or a reviewed draft offering the booking link for a new time) and meeting.no_show fires. undo: true returns a no-show to scheduled (for a mistake), and the held rule applies again. Use it only after the start time; Calendly and Cal.com no-show marks are recorded by themselves. Their sequences stay stopped either way.",
  effect: "write",
  input: z.object({
    meeting_id: meetingIdInput,
    undo: z.boolean().default(false).describe("Return a no-show to scheduled"),
    notes: notesInput.optional(),
  }),
  output: changeOutput,
  http: { method: "POST", path: "/v1/meetings/:meeting_id/no_show" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    { title: "Did not show up", input: { meeting_id: MEETING_EXAMPLE_ID } },
    { title: "Undo a mistaken no-show", input: { meeting_id: MEETING_EXAMPLE_ID, undo: true } },
  ],
  handler: async (ctx, input) => {
    const meeting = await requireMeeting(ctx, input.meeting_id);
    const notes = { notes: input.notes ?? null };
    if (input.undo) {
      // Only a no-show can be undone; anything else is already not one.
      const { changed } =
        meeting.status === "no_show"
          ? await setMeetingStatus(ctx, meeting.id, "scheduled", notes)
          : { changed: false };
      return { ...(await viewOf(ctx, meeting.id)), changed };
    }
    if (meeting.status !== "no_show") assertStarted(ctx, meeting, "a no-show");
    const { changed } = await setMeetingStatus(ctx, meeting.id, "no_show", notes);
    return { ...(await viewOf(ctx, meeting.id)), changed };
  },
});

export const qualifyMeeting = defineOperation({
  id: "meetings.qualify",
  summary: "Mark a meeting qualified or not",
  description:
    "Sets whether a meeting met the client's definition of a qualified meeting (strategy.qualified_meeting), with optional notes; reports count qualified held meetings. Use it after the call, or use mark_held with qualified to do both at once. It does not change the meeting's status. Judge from what happened in the meeting, never from the lead's own claims alone.",
  effect: "write",
  input: z.object({
    meeting_id: meetingIdInput,
    qualified: z
      .boolean()
      .describe("Whether it met the client's definition of a qualified meeting"),
    notes: notesInput.optional(),
  }),
  output: changeOutput,
  http: { method: "POST", path: "/v1/meetings/:meeting_id/qualify" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Not a fit",
      input: { meeting_id: MEETING_EXAMPLE_ID, qualified: false, notes: "Single location only." },
    },
  ],
  handler: async (ctx, input) => {
    const meeting = await requireMeeting(ctx, input.meeting_id);
    const { changed } = await setMeetingStatus(ctx, meeting.id, meeting.status, {
      qualified: input.qualified,
      notes: input.notes ?? null,
    });
    return { ...(await viewOf(ctx, meeting.id)), changed };
  },
});

export const meetingOperations = [
  listMeetings,
  getMeetingOperation,
  recordMeeting,
  rescheduleMeetingOperation,
  cancelMeeting,
  markMeetingHeld,
  markMeetingNoShow,
  qualifyMeeting,
];
