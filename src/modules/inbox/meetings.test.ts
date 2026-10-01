import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Engine } from "../../core/engine.js";
import type { ProblemKind } from "../../core/enums.js";
import { OpenOutboundError } from "../../core/errors.js";
import {
  enrollments,
  type Meeting,
  meeting_webhooks,
  meetings,
  type Opportunity,
  opportunities,
  people,
  problems,
  tasks,
} from "../../db/schema/index.js";
import { notify } from "../../runtime/notify.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import {
  seedApiKey,
  seedCampaign,
  seedCompany,
  seedEnrollment,
  seedPerson,
} from "../../testing/factories.js";
import { openProblem } from "../problems/service.js";
import { meetingToBookKey } from "./meeting-intent.js";
import { recordMeeting } from "./meeting-operations.js";
import { type MeetingBooking, parseMeetingPayload } from "./meeting-payloads.js";
import { recordMeetingBooked } from "./meeting-records.js";
import {
  createMeetingWebhook,
  findMeetingWebhook,
  handleMeetingBooking,
  hashMeetingToken,
  meetingsWebhookRoute,
} from "./meetings.js";

vi.mock("../../runtime/notify.js", () => ({ notify: vi.fn(async () => {}) }));

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});
beforeEach(() => {
  vi.clearAllMocks();
});

type Json = Record<string, unknown>;

const REF = "bkdana000001";
const CALENDLY_FIRST =
  "https://api.calendly.com/scheduled_events/EVENTA0000000001/invitees/INVITEEA00000001";
const CALENDLY_SECOND =
  "https://api.calendly.com/scheduled_events/EVENTB0000000002/invitees/INVITEEB00000002";

/** A webhook body from `fixtures/meetings` (a fresh copy each time). */
function fixture(name: string): Json {
  return JSON.parse(readFileSync(new URL(`./fixtures/meetings/${name}`, import.meta.url), "utf8"));
}

function payloadOf(body: Json): Json {
  return body.payload as Json;
}

function parsed(body: unknown): MeetingBooking {
  const result = parseMeetingPayload(body);
  if ("error" in result) throw new Error(result.error);
  return result;
}

/** Dana (booking code REF) with an active sequence and an interested opportunity. */
async function setup() {
  const ctx = await createTestContext({ db: testDb });
  const company = await seedCompany(ctx, {
    name: "Harbor Dental",
    domain: "harbor-dental.example.com",
  });
  const person = await seedPerson(ctx, {
    company_id: company.id,
    full_name: "Dana Reyes",
    email: "dana@harbor-dental.example.com",
    status: "interested",
    booking_ref: REF,
  });
  const { campaign } = await seedCampaign(ctx, { status: "active" });
  const enrollment = await seedEnrollment(ctx, {
    campaign_id: campaign.id,
    person_id: person.id,
  });
  const opportunity = await seedOpportunity(ctx, {
    person_id: person.id,
    company_id: company.id,
    campaign_id: campaign.id,
  });
  return { ctx, company, person, campaign, enrollment, opportunity };
}

async function seedOpportunity(
  ctx: TestContext,
  values: Partial<Opportunity> & { person_id: string },
): Promise<Opportunity> {
  const [row] = await ctx.db
    .insert(opportunities)
    .values({ workspace_id: ctx.workspace.id, stage: "interested", ...values })
    .returning();
  if (!row) throw new Error("no opportunity");
  return row;
}

async function opportunitiesOf(ctx: TestContext, personId: string) {
  return ctx.db.select().from(opportunities).where(eq(opportunities.person_id, personId));
}

async function meetingsOf(ctx: TestContext): Promise<Meeting[]> {
  return ctx.db.select().from(meetings).where(eq(meetings.workspace_id, ctx.workspace.id));
}

async function statusOfEnrollment(ctx: TestContext, id: string) {
  const [row] = await ctx.db.select().from(enrollments).where(eq(enrollments.id, id));
  return row ? { status: row.status, stop_reason: row.stop_reason } : null;
}

async function problemsOf(ctx: TestContext, kind: ProblemKind) {
  return ctx.db
    .select()
    .from(problems)
    .where(and(eq(problems.workspace_id, ctx.workspace.id), eq(problems.kind, kind)));
}

async function followUpTasks(ctx: TestContext) {
  return ctx.db.select().from(tasks).where(eq(tasks.workspace_id, ctx.workspace.id));
}

function notifyTitles(): string[] {
  return vi.mocked(notify).mock.calls.map((call) => String(call[1].title));
}

describe("parseMeetingPayload", () => {
  it("reads the generic shape", () => {
    expect(
      parseMeetingPayload({
        email: " Dana@Harbor-Dental.example.com ",
        ref: "BKDANA000001",
        id: "evt-1",
        previous_id: 7,
        name: "Dana Reyes",
        start_time: "2026-10-06T15:00:00Z",
        end_time: "2026-10-06T15:30:00Z",
        source: "savvycal",
        event: "rescheduled",
      }),
    ).toEqual({
      event: "rescheduled",
      emails: ["dana@harbor-dental.example.com"],
      name: "Dana Reyes",
      startTime: new Date("2026-10-06T15:00:00Z"),
      endTime: new Date("2026-10-06T15:30:00Z"),
      source: "savvycal",
      meetingSource: "generic",
      externalId: "evt-1",
      previousExternalId: "7",
      ref: REF,
      rawEvent: "rescheduled",
    });
    expect(parseMeetingPayload({ email: "dana@example.com", event: "canceled" })).toMatchObject({
      event: "cancelled",
      source: "webhook",
      startTime: null,
      endTime: null,
      externalId: null,
    });
    const events = ["booked", "no-show", "no_show_undone", "held", "meeting_ended"].map(
      (event) => parsed({ email: "dana@example.com", event }).event,
    );
    expect(events).toEqual(["booked", "no_show", "no_show_undone", "held", "ignored"]);
  });

  it("accepts a generic body with only a ref or only an id", () => {
    expect(parsed({ ref: REF })).toMatchObject({ event: "booked", emails: [], ref: REF });
    expect(parsed({ id: 42, event: "cancelled" })).toMatchObject({
      event: "cancelled",
      externalId: "42",
    });
    expect(parseMeetingPayload({ email: "not an email" })).toEqual({
      error: "email is not a valid address.",
    });
    expect(parseMeetingPayload({ ref: "  " })).toEqual({
      error: "Send an email, a ref or an id to identify the booking.",
    });
  });

  it("reads the Calendly fixtures: booking with tracking, reschedule, cancel and no-shows", () => {
    expect(parsed(fixture("calendly-invitee-created.json"))).toEqual({
      event: "booked",
      emails: ["office@harbor-dental.example.com"],
      name: "Front Desk",
      startTime: new Date("2026-10-06T15:00:00Z"),
      endTime: new Date("2026-10-06T15:30:00Z"),
      source: "calendly",
      meetingSource: "calendly",
      externalId: CALENDLY_FIRST,
      previousExternalId: null,
      ref: REF,
      rawEvent: "invitee.created",
    });
    expect(parsed(fixture("calendly-invitee-rescheduled.json"))).toMatchObject({
      event: "rescheduled",
      externalId: CALENDLY_SECOND,
      previousExternalId: CALENDLY_FIRST,
      startTime: new Date("2026-10-08T09:00:00Z"),
      endTime: new Date("2026-10-08T09:30:00Z"),
      ref: REF,
    });
    expect(parsed(fixture("calendly-invitee-canceled.json"))).toMatchObject({
      event: "cancelled",
      externalId: CALENDLY_SECOND,
      previousExternalId: null,
    });
    // The cancel half of a reschedule is skipped: the new invitee carries the change.
    const oldHalf = fixture("calendly-invitee-canceled.json");
    payloadOf(oldHalf).rescheduled = true;
    expect(parsed(oldHalf).event).toBe("ignored");

    expect(parsed(fixture("calendly-no-show-created.json"))).toMatchObject({
      event: "no_show",
      externalId: CALENDLY_FIRST,
      ref: REF,
    });
    expect(parsed(fixture("calendly-no-show-deleted.json"))).toMatchObject({
      event: "no_show_undone",
      externalId: CALENDLY_FIRST,
      emails: [],
    });
    // A no-show sent as the no-show record (not the invitee) still points at the invitee.
    const record = fixture("calendly-no-show-deleted.json");
    record.event = "invitee_no_show.created";
    expect(parsed(record)).toMatchObject({ event: "no_show", externalId: CALENDLY_FIRST });
    expect(parsed({ event: "routing_form_submission.created", payload: {} }).event).toBe("ignored");
  });

  it("reads the Cal.com fixtures: booking, reschedule, cancellation and no-show", () => {
    expect(parsed(fixture("calcom-booking-created.json"))).toEqual({
      event: "booked",
      emails: ["dana.private@example.net"],
      name: "Dana Reyes",
      startTime: new Date("2026-10-06T15:00:00Z"),
      endTime: new Date("2026-10-06T15:20:00Z"),
      source: "calcom",
      meetingSource: "cal_com",
      externalId: "calcom-uid-0001",
      previousExternalId: null,
      ref: REF,
      rawEvent: "BOOKING_CREATED",
    });
    expect(parsed(fixture("calcom-booking-rescheduled.json"))).toMatchObject({
      event: "rescheduled",
      externalId: "calcom-uid-0002",
      previousExternalId: "calcom-uid-0001",
      startTime: new Date("2026-10-09T10:00:00Z"),
    });
    expect(parsed(fixture("calcom-booking-cancelled.json"))).toMatchObject({
      event: "cancelled",
      externalId: "calcom-uid-0002",
      ref: REF,
    });
    expect(parsed(fixture("calcom-no-show-updated.json"))).toMatchObject({
      event: "no_show",
      externalId: "calcom-uid-0001",
      emails: ["dana.private@example.net"],
    });
    // Clearing every flag is an undo; a body without flags says nothing.
    const cleared = fixture("calcom-no-show-updated.json");
    payloadOf(cleared).attendees = [{ email: "dana.private@example.net", noShow: false }];
    expect(parsed(cleared).event).toBe("no_show_undone");
    payloadOf(cleared).attendees = [];
    expect(parsed(cleared).event).toBe("ignored");
    // A new booking made from an older one is a reschedule.
    const moved = fixture("calcom-booking-created.json");
    Object.assign(payloadOf(moved), { uid: "calcom-uid-0003", fromReschedule: "calcom-uid-0001" });
    expect(parsed(moved)).toMatchObject({
      event: "rescheduled",
      externalId: "calcom-uid-0003",
      previousExternalId: "calcom-uid-0001",
    });
    expect(parsed({ triggerEvent: "MEETING_ENDED", payload: {} }).event).toBe("ignored");
  });

  it("rejects bodies it does not recognize", () => {
    expect(parseMeetingPayload([])).toEqual({ error: "The body must be a JSON object." });
    expect(parseMeetingPayload({ hello: "world" })).toHaveProperty("error");
  });

  it("refuses overlong email addresses without slowing down", () => {
    const local = "a".repeat(64);
    const longest = `${local}@${"b".repeat(243)}.example.com`;
    expect(longest.length).toBe(320);
    expect(parsed({ email: longest }).emails).toEqual([longest]);
    expect(parseMeetingPayload({ email: `${local}@${"b".repeat(244)}.example.com` })).toEqual({
      error: "email is not a valid address.",
    });
    // Many dots and no valid end: a pattern that backtracks would take minutes on this.
    const crafted = `a@${".".repeat(200_000)} x`;
    const started = performance.now();
    expect(parseMeetingPayload({ email: crafted })).toEqual({
      error: "email is not a valid address.",
    });
    const calendly = fixture("calendly-invitee-created.json");
    Object.assign(payloadOf(calendly), { email: crafted });
    expect(parsed(calendly).emails).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("meetings.create_webhook", () => {
  it("stores only the token hash, refuses a second URL and rotates on request", async () => {
    const ctx = await createTestContext({ db: testDb });
    const first = await createMeetingWebhook.handler(ctx, { rotate: false });
    expect(first.url).toMatch(/^http:\/\/localhost:7331\/hooks\/meetings\/mtg_[A-Za-z0-9_-]+$/);
    expect(first.rotated).toBe(false);
    const token = first.url.split("/").pop() ?? "";
    expect(first.token_hint).toBe(token.slice(-4));

    const [row] = await ctx.db
      .select()
      .from(meeting_webhooks)
      .where(eq(meeting_webhooks.workspace_id, ctx.workspace.id));
    expect(row?.token_hash).toBe(hashMeetingToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect((await findMeetingWebhook(ctx.db, token))?.id).toBe(row?.id);

    const conflict = await createMeetingWebhook.handler(ctx, { rotate: false }).catch((e) => e);
    expect(conflict).toBeInstanceOf(OpenOutboundError);
    expect(conflict.code).toBe("conflict");

    const second = await createMeetingWebhook.handler(ctx, { rotate: true });
    expect(second.rotated).toBe(true);
    const newToken = second.url.split("/").pop() ?? "";
    expect(await findMeetingWebhook(ctx.db, token)).toBeNull();
    expect((await findMeetingWebhook(ctx.db, newToken))?.id).toBe(row?.id);
    expect(await findMeetingWebhook(ctx.db, "mtg_short")).toBeNull();
  });
});

describe("handleMeetingBooking: Calendly", () => {
  it("records a booking made by an assistant through the tagged link, once", async () => {
    const s = await setup();
    await openProblem(s.ctx, {
      kind: "meeting_to_book",
      severity: "normal",
      title: "Book a meeting with Dana Reyes (Harbor Dental)",
      reason: "Dana asked for a meeting.",
      remedy: "Check the calendar, book it, then record it with manage_meetings action record.",
      personId: s.person.id,
      dedupeKey: meetingToBookKey(s.person.id),
    });

    const result = await handleMeetingBooking(
      s.ctx,
      parsed(fixture("calendly-invitee-created.json")),
    );
    expect(result).toMatchObject({
      matched: true,
      event: "booked",
      person_id: s.person.id,
      opportunity_id: s.opportunity.id,
      stage: "meeting_booked",
      meeting_status: "scheduled",
      matched_by: "ref",
      changed: true,
    });
    const [meeting] = await meetingsOf(s.ctx);
    expect(meeting).toMatchObject({
      id: result.meeting_id,
      person_id: s.person.id,
      company_id: s.company.id,
      opportunity_id: s.opportunity.id,
      campaign_id: s.campaign.id,
      source: "calendly",
      external_id: CALENDLY_FIRST,
      status: "scheduled",
      matched_by: "ref",
    });
    expect(meeting?.start_at?.toISOString()).toBe("2026-10-06T15:00:00.000Z");
    expect(meeting?.end_at?.toISOString()).toBe("2026-10-06T15:30:00.000Z");

    const [opportunity] = await opportunitiesOf(s.ctx, s.person.id);
    expect(opportunity?.meeting_at?.toISOString()).toBe("2026-10-06T15:00:00.000Z");
    expect(await statusOfEnrollment(s.ctx, s.enrollment.id)).toEqual({
      status: "stopped",
      stop_reason: "meeting_booked",
    });
    const [person] = await s.ctx.db.select().from(people).where(eq(people.id, s.person.id));
    expect(person?.status).toBe("meeting");
    const [problem] = await problemsOf(s.ctx, "meeting_to_book");
    expect(problem?.status).toBe("resolved");
    expect(s.ctx.emitted("meeting.booked").map((event) => event.data)).toEqual([
      {
        meeting_id: result.meeting_id,
        person_id: s.person.id,
        opportunity_id: s.opportunity.id,
        source: "calendly",
        start_at: "2026-10-06T15:00:00.000Z",
        matched_by: "ref",
      },
    ]);
    expect(notifyTitles()).toEqual(["Meeting booked: Dana Reyes (Harbor Dental)"]);
    expect(s.ctx.recorded.audit.at(-1)).toMatchObject({
      operation: "meetings.webhook",
      target: { type: "meeting", id: result.meeting_id },
    });

    // The same delivery again changes nothing and stays quiet.
    vi.clearAllMocks();
    const again = await handleMeetingBooking(
      s.ctx,
      parsed(fixture("calendly-invitee-created.json")),
    );
    expect(again).toMatchObject({ meeting_id: result.meeting_id, changed: false });
    expect(notify).not.toHaveBeenCalled();
    expect(await meetingsOf(s.ctx)).toHaveLength(1);
    expect(await opportunitiesOf(s.ctx, s.person.id)).toHaveLength(1);
    expect(s.ctx.emitted("meeting.booked")).toHaveLength(1);
  });

  it("moves the meeting on a reschedule and cancels it without restarting the sequence", async () => {
    const s = await setup();
    const booked = await handleMeetingBooking(
      s.ctx,
      parsed(fixture("calendly-invitee-created.json")),
    );
    // Calendly first cancels the old invitee (flagged rescheduled), then creates the new one.
    const oldHalf = fixture("calendly-invitee-canceled.json");
    Object.assign(payloadOf(oldHalf), { rescheduled: true, uri: CALENDLY_FIRST });
    expect(await handleMeetingBooking(s.ctx, parsed(oldHalf))).toMatchObject({
      event: "ignored",
    });

    const moved = await handleMeetingBooking(
      s.ctx,
      parsed(fixture("calendly-invitee-rescheduled.json")),
    );
    expect(moved).toMatchObject({
      meeting_id: booked.meeting_id,
      meeting_status: "scheduled",
      changed: true,
    });
    const [meeting] = await meetingsOf(s.ctx);
    expect(meeting?.external_id).toBe(CALENDLY_SECOND);
    expect(meeting?.start_at?.toISOString()).toBe("2026-10-08T09:00:00.000Z");
    expect((await opportunitiesOf(s.ctx, s.person.id))[0]?.meeting_at?.toISOString()).toBe(
      "2026-10-08T09:00:00.000Z",
    );
    expect(s.ctx.emitted("meeting.rescheduled")[0]?.data).toMatchObject({
      meeting_id: booked.meeting_id,
      start_at: "2026-10-08T09:00:00.000Z",
      previous_start_at: "2026-10-06T15:00:00.000Z",
    });
    expect(notifyTitles().at(-1)).toBe("Meeting rescheduled: Dana Reyes (Harbor Dental)");
    const repeat = await handleMeetingBooking(
      s.ctx,
      parsed(fixture("calendly-invitee-rescheduled.json")),
    );
    expect(repeat.changed).toBe(false);
    expect(s.ctx.emitted("meeting.rescheduled")).toHaveLength(1);

    const cancelled = await handleMeetingBooking(
      s.ctx,
      parsed(fixture("calendly-invitee-canceled.json")),
    );
    expect(cancelled).toMatchObject({
      meeting_id: booked.meeting_id,
      meeting_status: "cancelled",
      stage: "interested",
      changed: true,
    });
    const [opportunity] = await opportunitiesOf(s.ctx, s.person.id);
    expect(opportunity).toMatchObject({ stage: "interested", meeting_at: null });
    expect(opportunity?.notes).toContain("Meeting cancelled (calendly).");
    // The stopped sequence stays stopped.
    expect(await statusOfEnrollment(s.ctx, s.enrollment.id)).toEqual({
      status: "stopped",
      stop_reason: "meeting_booked",
    });
    expect(s.ctx.emitted("meeting.cancelled")).toHaveLength(1);
    expect(vi.mocked(notify).mock.calls.at(-1)?.[1]).toMatchObject({
      title: "Meeting cancelled: Dana Reyes (Harbor Dental)",
      severity: "warning",
    });
    // booking.after_cancel defaults to a follow-up task.
    const [task] = await followUpTasks(s.ctx);
    expect(task).toMatchObject({
      title: "Dana Reyes (Harbor Dental) cancelled the meeting: follow up",
      type: "follow_up",
      status: "open",
      person_id: s.person.id,
      dedupe_key: `meeting_follow_up:${booked.meeting_id}`,
    });

    const twice = await handleMeetingBooking(
      s.ctx,
      parsed(fixture("calendly-invitee-canceled.json")),
    );
    expect(twice).toMatchObject({ meeting_status: "cancelled", changed: false });
    expect(s.ctx.emitted("meeting.cancelled")).toHaveLength(1);
    expect(await followUpTasks(s.ctx)).toHaveLength(1);
  });

  it("marks a no-show and undoes it", async () => {
    const s = await setup();
    const booked = await handleMeetingBooking(
      s.ctx,
      parsed(fixture("calendly-invitee-created.json")),
    );
    const noShow = await handleMeetingBooking(
      s.ctx,
      parsed(fixture("calendly-no-show-created.json")),
    );
    expect(noShow).toMatchObject({
      meeting_id: booked.meeting_id,
      meeting_status: "no_show",
      changed: true,
    });
    expect(s.ctx.emitted("meeting.no_show")).toHaveLength(1);
    expect(notifyTitles().at(-1)).toBe("No-show: Dana Reyes (Harbor Dental)");
    const [task] = await followUpTasks(s.ctx);
    expect(task).toMatchObject({
      title: "Dana Reyes (Harbor Dental) missed the meeting: follow up",
      status: "open",
    });
    const repeat = await handleMeetingBooking(
      s.ctx,
      parsed(fixture("calendly-no-show-created.json")),
    );
    expect(repeat.changed).toBe(false);
    expect(s.ctx.emitted("meeting.no_show")).toHaveLength(1);

    const undone = await handleMeetingBooking(
      s.ctx,
      parsed(fixture("calendly-no-show-deleted.json")),
    );
    expect(undone).toMatchObject({ meeting_status: "scheduled", changed: true });
    const [closed] = await followUpTasks(s.ctx);
    expect(closed?.status).toBe("skipped");
    const undoneAgain = await handleMeetingBooking(
      s.ctx,
      parsed(fixture("calendly-no-show-deleted.json")),
    );
    expect(undoneAgain.changed).toBe(false);
  });
});

describe("handleMeetingBooking: Cal.com", () => {
  it("matches a booking from another address by the code and follows its lifecycle", async () => {
    const s = await setup();
    const booked = await handleMeetingBooking(
      s.ctx,
      parsed(fixture("calcom-booking-created.json")),
    );
    expect(booked).toMatchObject({
      matched: true,
      person_id: s.person.id,
      matched_by: "ref",
      meeting_status: "scheduled",
    });

    const noShow = await handleMeetingBooking(
      s.ctx,
      parsed(fixture("calcom-no-show-updated.json")),
    );
    expect(noShow).toMatchObject({ meeting_id: booked.meeting_id, meeting_status: "no_show" });
    const cleared = fixture("calcom-no-show-updated.json");
    payloadOf(cleared).attendees = [{ email: "dana.private@example.net", noShow: false }];
    expect(await handleMeetingBooking(s.ctx, parsed(cleared))).toMatchObject({
      meeting_status: "scheduled",
      changed: true,
    });

    const moved = await handleMeetingBooking(
      s.ctx,
      parsed(fixture("calcom-booking-rescheduled.json")),
    );
    expect(moved).toMatchObject({ meeting_id: booked.meeting_id, changed: true });
    const [meeting] = await meetingsOf(s.ctx);
    expect(meeting).toMatchObject({ source: "cal_com", external_id: "calcom-uid-0002" });
    expect(meeting?.start_at?.toISOString()).toBe("2026-10-09T10:00:00.000Z");

    const cancelled = await handleMeetingBooking(
      s.ctx,
      parsed(fixture("calcom-booking-cancelled.json")),
    );
    expect(cancelled).toMatchObject({ meeting_id: booked.meeting_id, meeting_status: "cancelled" });
    expect(await meetingsOf(s.ctx)).toHaveLength(1);
  });
});

describe("handleMeetingBooking: matching", () => {
  it("the booking code beats the email, and the email is the fallback", async () => {
    const s = await setup();
    // The front desk is a lead too, but the tagged link says the meeting is Dana's.
    const frontDesk = await seedPerson(s.ctx, {
      company_id: s.company.id,
      full_name: "Front Desk",
      email: "Office@Harbor-Dental.example.com",
    });
    const byRef = await handleMeetingBooking(
      s.ctx,
      parsed(fixture("calendly-invitee-created.json")),
    );
    expect(byRef).toMatchObject({ person_id: s.person.id, matched_by: "ref" });

    const untagged = fixture("calendly-invitee-created.json");
    Object.assign(payloadOf(untagged), {
      uri: "https://api.calendly.com/scheduled_events/EVENTC0000000003/invitees/INVITEEC00000003",
      tracking: { utm_content: null },
    });
    const byEmail = await handleMeetingBooking(s.ctx, parsed(untagged));
    expect(byEmail).toMatchObject({ person_id: frontDesk.id, matched_by: "email" });

    // An unknown code falls back to the email.
    const unknownRef = await handleMeetingBooking(
      s.ctx,
      parsed({
        email: "dana@harbor-dental.example.com",
        ref: "bkzzzzzzzzzz",
        id: "evt-unknown-ref",
        start_time: "2026-10-12T09:00:00Z",
      }),
    );
    expect(unknownRef).toMatchObject({ person_id: s.person.id, matched_by: "email" });
  });

  it("never matches a booking code of another workspace", async () => {
    const s = await setup();
    const other = await createTestContext({ db: testDb });
    const result = await handleMeetingBooking(
      other,
      parsed({ ref: REF, email: "someone@unknown.example.org", id: "evt-other" }),
    );
    expect(result.matched).toBe(false);
    expect(await meetingsOf(other)).toHaveLength(0);
    expect(await meetingsOf(s.ctx)).toHaveLength(0);
  });

  it("opens one unmatched_booking problem for a stranger's booking and resolves it on cancel", async () => {
    const ctx = await createTestContext({ db: testDb });
    const body = {
      email: "someone@unknown.example.org",
      name: "Sam Park",
      id: "evt-9",
      start_time: "2026-10-06T15:00:00Z",
    };
    const first = await handleMeetingBooking(ctx, parsed(body));
    expect(first).toMatchObject({ matched: false, event: "booked" });
    const [problem] = await problemsOf(ctx, "unmatched_booking");
    expect(problem).toMatchObject({
      id: first.problem_id,
      severity: "normal",
      owner: "person",
      status: "open",
      title: "Meeting booked by someone@unknown.example.org, who is not a lead",
      remedy:
        "Find the lead and record the meeting with manage_meetings action record, or ignore it if this is not a lead",
      dedupe_key: "unmatched_booking:generic:evt-9",
    });
    expect(problem?.data).toMatchObject({
      meeting_source: "generic",
      external_id: "evt-9",
      start_at: "2026-10-06T15:00:00.000Z",
      email: "someone@unknown.example.org",
    });
    expect(notifyTitles()).toEqual(["Meeting booked by someone who is not a lead"]);

    // A repeated delivery keeps one problem and does not notify again.
    const again = await handleMeetingBooking(ctx, parsed(body));
    expect(again.problem_id).toBe(first.problem_id);
    expect(await problemsOf(ctx, "unmatched_booking")).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(await meetingsOf(ctx)).toHaveLength(0);

    const cancelled = await handleMeetingBooking(ctx, parsed({ ...body, event: "cancelled" }));
    expect(cancelled).toEqual({ matched: false, event: "cancelled" });
    expect((await problemsOf(ctx, "unmatched_booking"))[0]?.status).toBe("resolved");
  });

  it("ignores unknown events", async () => {
    const ctx = await createTestContext({ db: testDb });
    const ignored = await handleMeetingBooking(
      ctx,
      parsed({ triggerEvent: "MEETING_ENDED", payload: {} }),
    );
    expect(ignored).toEqual({ matched: false, event: "ignored", ignored: "MEETING_ENDED" });
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("handleMeetingBooking: generic and v0.1 records", () => {
  it("records, marks held and keeps email matching case-insensitive", async () => {
    const s = await setup();
    await s.ctx.db
      .update(people)
      .set({ email: "Dana@Harbor-Dental.example.com" })
      .where(eq(people.id, s.person.id));
    const booked = await handleMeetingBooking(
      s.ctx,
      parsed({
        email: "dana@harbor-dental.example.com",
        id: "evt-1",
        start_time: "2026-10-06T15:00:00Z",
      }),
    );
    expect(booked).toMatchObject({ person_id: s.person.id, matched_by: "email" });
    const held = await handleMeetingBooking(s.ctx, parsed({ id: "evt-1", event: "held" }));
    expect(held).toMatchObject({ meeting_status: "held", changed: true });
    expect(s.ctx.emitted("meeting.held")[0]?.data).toMatchObject({
      meeting_id: booked.meeting_id,
      qualified: null,
    });
  });

  it("records a reschedule of a booking it never saw as a new booking", async () => {
    const s = await setup();
    const result = await handleMeetingBooking(
      s.ctx,
      parsed({
        email: "dana@harbor-dental.example.com",
        event: "rescheduled",
        start_time: "2026-10-08T09:00:00Z",
      }),
    );
    expect(result).toMatchObject({ meeting_status: "scheduled", changed: true });
    expect(s.ctx.emitted("meeting.booked")).toHaveLength(1);
    expect(notifyTitles()).toEqual(["Meeting booked: Dana Reyes (Harbor Dental)"]);
  });

  it("a no-show for a person without meetings changes nothing", async () => {
    const s = await setup();
    const result = await handleMeetingBooking(
      s.ctx,
      parsed({ email: "dana@harbor-dental.example.com", event: "no_show" }),
    );
    expect(result).toEqual({
      matched: true,
      event: "no_show",
      person_id: s.person.id,
      changed: false,
    });
    expect(await meetingsOf(s.ctx)).toHaveLength(0);
  });

  it("a cancellation of a v0.1 booking without a meeting record reopens the opportunity", async () => {
    const ctx = await createTestContext({ db: testDb });
    const person = await seedPerson(ctx, { email: "lee@harbor-dental.example.com" });
    const open = await seedOpportunity(ctx, {
      person_id: person.id,
      stage: "meeting_booked",
      meeting_at: new Date("2026-10-06T15:00:00Z"),
    });
    const result = await handleMeetingBooking(
      ctx,
      parsed({ email: "lee@harbor-dental.example.com", event: "cancelled" }),
    );
    expect(result).toMatchObject({
      matched: true,
      opportunity_id: open.id,
      stage: "interested",
      changed: true,
    });
    const [row] = await opportunitiesOf(ctx, person.id);
    expect(row).toMatchObject({ stage: "interested", meeting_at: null });
    expect(row?.notes).toContain("Meeting cancelled (webhook).");
    expect(vi.mocked(notify).mock.calls.at(-1)?.[1]).toMatchObject({ severity: "warning" });
    const twice = await handleMeetingBooking(
      ctx,
      parsed({ email: "lee@harbor-dental.example.com", event: "cancelled" }),
    );
    expect(twice).toMatchObject({ matched: true, changed: false });
  });
});

describe("handleMeetingBooking: meetings recorded by hand", () => {
  const TUESDAY = "2026-10-06T15:00:00Z";

  it("a booking tool's report of a meeting recorded by hand takes over that record", async () => {
    const s = await setup();
    const manual = await recordMeeting.handler(s.ctx, {
      person_id: s.person.id,
      start_at: new Date(TUESDAY),
    });
    vi.clearAllMocks();
    const reported = await handleMeetingBooking(
      s.ctx,
      parsed({
        email: "dana@harbor-dental.example.com",
        id: "evt-21",
        start_time: "2026-10-06T15:00:30Z",
      }),
    );
    expect(reported).toMatchObject({ meeting_id: manual.id, changed: false });
    const [meeting] = await meetingsOf(s.ctx);
    expect(meeting).toMatchObject({ source: "generic", external_id: "evt-21" });
    expect(await meetingsOf(s.ctx)).toHaveLength(1);
    expect(s.ctx.emitted("meeting.booked")).toHaveLength(1);
    expect(notify).not.toHaveBeenCalled();

    // Later changes from the tool find the same meeting.
    const cancelled = await handleMeetingBooking(
      s.ctx,
      parsed({ id: "evt-21", event: "cancelled" }),
    );
    expect(cancelled).toMatchObject({ meeting_id: manual.id, meeting_status: "cancelled" });
  });

  it("a cancellation or no-show without a known id finds a meeting recorded by hand", async () => {
    const s = await setup();
    const THURSDAY = "2026-10-08T09:00:00Z";
    const first = await recordMeeting.handler(s.ctx, {
      person_id: s.person.id,
      start_at: new Date(TUESDAY),
    });
    const second = await recordMeeting.handler(s.ctx, {
      person_id: s.person.id,
      start_at: new Date(THURSDAY),
    });
    const noShow = await handleMeetingBooking(
      s.ctx,
      parsed({
        email: "dana@harbor-dental.example.com",
        id: "evt-unknown-1",
        event: "no_show",
        start_time: TUESDAY,
      }),
    );
    expect(noShow).toMatchObject({ meeting_id: first.id, meeting_status: "no_show" });
    const cancelled = await handleMeetingBooking(
      s.ctx,
      parsed({
        email: "dana@harbor-dental.example.com",
        id: "evt-unknown-2",
        event: "cancelled",
        start_time: THURSDAY,
      }),
    );
    expect(cancelled).toMatchObject({ meeting_id: second.id, meeting_status: "cancelled" });
    expect(await meetingsOf(s.ctx)).toHaveLength(2);
  });

  it("a cancellation without a record keeps the opportunity while another meeting is scheduled", async () => {
    const s = await setup();
    await recordMeetingBooked(s.ctx, {
      personId: s.person.id,
      source: "calendly",
      matchedBy: "ref",
      externalId: CALENDLY_FIRST,
      startAt: new Date(TUESDAY),
    });
    expect((await opportunitiesOf(s.ctx, s.person.id))[0]?.stage).toBe("meeting_booked");
    const result = await handleMeetingBooking(
      s.ctx,
      parsed({ email: "dana@harbor-dental.example.com", event: "cancelled" }),
    );
    expect(result).toMatchObject({ matched: true, changed: false });
    expect((await opportunitiesOf(s.ctx, s.person.id))[0]?.stage).toBe("meeting_booked");
    expect((await meetingsOf(s.ctx)).map((meeting) => meeting.status)).toEqual(["scheduled"]);
  });
});

describe("handleMeetingBooking: late, early and repeated deliveries", () => {
  it("a late reschedule never reopens a cancelled meeting", async () => {
    const s = await setup();
    const booked = await handleMeetingBooking(
      s.ctx,
      parsed(fixture("calendly-invitee-created.json")),
    );
    await handleMeetingBooking(s.ctx, parsed(fixture("calendly-invitee-rescheduled.json")));
    await handleMeetingBooking(s.ctx, parsed(fixture("calendly-invitee-canceled.json")));

    const late = await handleMeetingBooking(
      s.ctx,
      parsed(fixture("calendly-invitee-rescheduled.json")),
    );
    expect(late).toMatchObject({
      meeting_id: booked.meeting_id,
      meeting_status: "cancelled",
      stage: "interested",
      changed: false,
    });
    expect(s.ctx.emitted("meeting.rescheduled")).toHaveLength(1);
    expect((await followUpTasks(s.ctx))[0]?.status).toBe("open");
  });

  it("a late retry of a booking a reschedule replaced finds the same meeting", async () => {
    const s = await setup();
    const booked = await handleMeetingBooking(
      s.ctx,
      parsed(fixture("calendly-invitee-created.json")),
    );
    await handleMeetingBooking(s.ctx, parsed(fixture("calendly-invitee-rescheduled.json")));
    const [moved] = await meetingsOf(s.ctx);
    expect(moved).toMatchObject({
      external_id: CALENDLY_SECOND,
      previous_external_ids: [CALENDLY_FIRST],
    });

    const late = await handleMeetingBooking(
      s.ctx,
      parsed(fixture("calendly-invitee-created.json")),
    );
    expect(late).toMatchObject({ meeting_id: booked.meeting_id, changed: false });
    // A late cancellation or no-show of the replaced booking changes nothing either.
    const lateCancel = fixture("calendly-invitee-canceled.json");
    Object.assign(payloadOf(lateCancel), { uri: CALENDLY_FIRST, old_invitee: null });
    expect(await handleMeetingBooking(s.ctx, parsed(lateCancel))).toMatchObject({
      meeting_id: booked.meeting_id,
      meeting_status: "scheduled",
      changed: false,
    });
    expect(
      await handleMeetingBooking(s.ctx, parsed(fixture("calendly-no-show-created.json"))),
    ).toMatchObject({ meeting_status: "scheduled", changed: false });
    const meetingsNow = await meetingsOf(s.ctx);
    expect(meetingsNow).toHaveLength(1);
    expect(meetingsNow[0]?.start_at?.toISOString()).toBe("2026-10-08T09:00:00.000Z");
    expect(s.ctx.emitted("meeting.booked")).toHaveLength(1);
  });

  it("a cancellation that arrives before its booking keeps the booking from going live", async () => {
    const s = await setup();
    const body = {
      email: "dana@harbor-dental.example.com",
      id: "evt-31",
      start_time: "2026-10-06T15:00:00Z",
    };
    const cancelled = await handleMeetingBooking(s.ctx, parsed({ ...body, event: "cancelled" }));
    expect(cancelled).toMatchObject({
      matched: true,
      person_id: s.person.id,
      meeting_status: "cancelled",
      changed: true,
    });
    const booked = await handleMeetingBooking(s.ctx, parsed(body));
    expect(booked).toMatchObject({
      meeting_id: cancelled.meeting_id,
      meeting_status: "cancelled",
      changed: false,
    });
    const [meeting] = await meetingsOf(s.ctx);
    expect(meeting).toMatchObject({ status: "cancelled", external_id: "evt-31" });
    expect(await meetingsOf(s.ctx)).toHaveLength(1);
    // Nothing was ever booked: no events, no task, the sequence and the opportunity stay.
    expect(s.ctx.emitted("meeting.booked")).toHaveLength(0);
    expect(s.ctx.emitted("meeting.cancelled")).toHaveLength(0);
    expect(await followUpTasks(s.ctx)).toHaveLength(0);
    expect((await opportunitiesOf(s.ctx, s.person.id))[0]?.stage).toBe("interested");
    expect(await statusOfEnrollment(s.ctx, s.enrollment.id)).toEqual({
      status: "active",
      stop_reason: null,
    });
  });

  it("a repeated booked delivery never moves a rescheduled meeting back", async () => {
    const s = await setup();
    const body = {
      email: "dana@harbor-dental.example.com",
      id: "evt-41",
      start_time: "2026-10-06T15:00:00Z",
    };
    const booked = await handleMeetingBooking(s.ctx, parsed(body));
    const moved = await handleMeetingBooking(
      s.ctx,
      parsed({ ...body, event: "rescheduled", start_time: "2026-10-08T09:00:00Z" }),
    );
    expect(moved).toMatchObject({ meeting_id: booked.meeting_id, changed: true });
    const late = await handleMeetingBooking(s.ctx, parsed(body));
    expect(late).toMatchObject({ meeting_id: booked.meeting_id, changed: false });
    const [meeting] = await meetingsOf(s.ctx);
    expect(meeting?.start_at?.toISOString()).toBe("2026-10-08T09:00:00.000Z");
    expect(s.ctx.emitted("meeting.rescheduled")).toHaveLength(1);
  });

  it("a retry finishes a booking that was cut short after the meeting was stored", async () => {
    const s = await setup();
    // The process stopped right after storing the meeting: no opportunity, no stops, no event.
    await s.ctx.db.insert(meetings).values({
      workspace_id: s.ctx.workspace.id,
      person_id: s.person.id,
      company_id: s.company.id,
      source: "calendly",
      external_id: CALENDLY_FIRST,
      status: "scheduled",
      start_at: new Date("2026-10-06T15:00:00Z"),
      matched_by: "ref",
    });
    const retry = await handleMeetingBooking(
      s.ctx,
      parsed(fixture("calendly-invitee-created.json")),
    );
    expect(retry).toMatchObject({
      opportunity_id: s.opportunity.id,
      stage: "meeting_booked",
      changed: true,
    });
    expect(await statusOfEnrollment(s.ctx, s.enrollment.id)).toEqual({
      status: "stopped",
      stop_reason: "meeting_booked",
    });
    const [meeting] = await meetingsOf(s.ctx);
    expect(meeting).toMatchObject({ opportunity_id: s.opportunity.id, campaign_id: s.campaign.id });
    expect(s.ctx.emitted("meeting.booked").map((event) => event.data.opportunity_id)).toEqual([
      s.opportunity.id,
    ]);
    expect(notifyTitles()).toEqual(["Meeting booked: Dana Reyes (Harbor Dental)"]);

    // Finished now: the next delivery is a plain repeat.
    const again = await handleMeetingBooking(
      s.ctx,
      parsed(fixture("calendly-invitee-created.json")),
    );
    expect(again.changed).toBe(false);
    expect(s.ctx.emitted("meeting.booked")).toHaveLength(1);
  });
});

describe("POST /hooks/meetings/:token", () => {
  async function appFor(ctx: TestContext) {
    const app = new Hono();
    const engine = {
      db: ctx.db,
      log: ctx.log,
      systemContext: async () => ctx,
    } as unknown as Engine;
    meetingsWebhookRoute(app, { engine });
    const created = await createMeetingWebhook.handler(ctx, { rotate: true });
    const token = created.url.split("/").pop() ?? "";
    const post = (body: string, path = `/hooks/meetings/${token}`) =>
      app.request(path, { method: "POST", body, headers: { "content-type": "application/json" } });
    return { post, token };
  }

  it("refuses a URL whose creating key was revoked", async () => {
    const s = await setup();
    const key = await seedApiKey(s.ctx.db, { revoked_at: s.ctx.clock.now() });
    const ctx = s.ctx.with({
      principal: { ...s.ctx.principal, type: "agent", id: key.id, name: key.name },
    });
    const { post } = await appFor(ctx);
    const response = await post(JSON.stringify(fixture("calendly-invitee-created.json")));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ message: "Unknown meetings webhook URL." });
    expect(s.ctx.emitted("meeting.booked")).toHaveLength(0);
  });

  it("records a booking and stamps last_used_at", async () => {
    const s = await setup();
    const { post, token } = await appFor(s.ctx);
    const response = await post(JSON.stringify(fixture("calendly-invitee-created.json")));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      matched: true,
      person_id: s.person.id,
      stage: "meeting_booked",
      meeting_status: "scheduled",
      matched_by: "ref",
    });
    const hook = await findMeetingWebhook(s.ctx.db, token);
    expect(hook?.last_used_at?.toISOString()).toBe(s.ctx.clock.now().toISOString());
  });

  it("refuses a workspace that is archived", async () => {
    const ctx = await createTestContext({ db: testDb, workspace: { status: "archived" } });
    const { post } = await appFor(ctx);
    const response = await post(JSON.stringify(fixture("calendly-invitee-created.json")));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ message: "This workspace is archived." });
    expect(ctx.recorded.audit).toEqual([]);
  });

  it("rejects unknown tokens, bad JSON, unknown shapes and large bodies", async () => {
    const s = await setup();
    const { post } = await appFor(s.ctx);
    expect((await post("{}", "/hooks/meetings/mtg_AAAAAAAAAAAAAAAAAAAAAAAAAAAA")).status).toBe(404);
    expect((await post("{not json")).status).toBe(400);
    const unknown = await post(JSON.stringify({ hello: "world" }));
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: "unrecognized_payload" });
    expect(
      (await post(JSON.stringify({ email: "a@example.com", pad: "x".repeat(300_000) }))).status,
    ).toBe(413);
  });
});
