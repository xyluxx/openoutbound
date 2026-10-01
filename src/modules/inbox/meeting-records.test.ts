/**
 * Meeting records against the real opportunity, campaign and problem services: manual records
 * behave like webhook bookings, cancellations never restart sequences, the after rules, the
 * status rules, the meetings.* operations and the held sweep.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProblemKind } from "../../core/enums.js";
import { OpenOutboundError } from "../../core/errors.js";
import type { WorkspaceSettingsInput } from "../../core/settings.js";
import {
  approvals,
  enrollments,
  meetings,
  messages,
  opportunities,
  people,
  problems,
  tasks,
} from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import {
  seedCampaign,
  seedCompany,
  seedEnrollment,
  seedMessage,
  seedPerson,
  seedThread,
} from "../../testing/factories.js";
import { openProblem } from "../problems/service.js";
import { DRAFT_REPLY_JOB } from "./draft.js";
import { meetingToBookKey } from "./meeting-intent.js";
import {
  cancelMeeting,
  getMeetingOperation,
  listMeetings,
  markMeetingHeld,
  markMeetingNoShow,
  qualifyMeeting,
  recordMeeting,
  rescheduleMeetingOperation,
} from "./meeting-operations.js";
import { parseMeetingPayload } from "./meeting-payloads.js";
import {
  canChangeMeetingStatus,
  getMeeting,
  recordMeetingBooked,
  rescheduleMeeting,
  setMeetingStatus,
} from "./meeting-records.js";
import { handleMeetingBooking } from "./meetings.js";
import { assumeHeldJob } from "./meetings-held-job.js";

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

const TUESDAY = new Date("2026-10-06T15:00:00Z");
const THURSDAY = new Date("2026-10-08T09:00:00Z");
const HOUR = 3_600_000;

/** Dana with an active sequence (default campaign stop rules) and nothing else. */
async function setup(settings: WorkspaceSettingsInput = {}) {
  const ctx = await createTestContext({ db: testDb, settings });
  const company = await seedCompany(ctx, {
    name: "Harbor Dental",
    domain: "harbor-dental.example.com",
  });
  const person = await seedPerson(ctx, {
    company_id: company.id,
    full_name: "Dana Reyes",
    email: "dana@harbor-dental.example.com",
    status: "interested",
  });
  const { campaign } = await seedCampaign(ctx, { status: "active" });
  const enrollment = await seedEnrollment(ctx, {
    campaign_id: campaign.id,
    person_id: person.id,
  });
  return { ctx, company, person, campaign, enrollment };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function record(s: Setup, startAt: Date = TUESDAY, notes?: string) {
  return recordMeeting.handler(s.ctx, {
    person_id: s.person.id,
    start_at: startAt,
    ...(notes ? { notes } : {}),
  });
}

async function enrollmentOf(s: Setup) {
  const [row] = await s.ctx.db
    .select()
    .from(enrollments)
    .where(eq(enrollments.id, s.enrollment.id));
  return { status: row?.status, stop_reason: row?.stop_reason };
}

async function opportunityOf(s: Setup) {
  const rows = await s.ctx.db
    .select()
    .from(opportunities)
    .where(eq(opportunities.person_id, s.person.id));
  expect(rows.length).toBeLessThanOrEqual(1);
  return rows[0];
}

async function problemsOf(ctx: TestContext, kind: ProblemKind) {
  return ctx.db
    .select()
    .from(problems)
    .where(and(eq(problems.workspace_id, ctx.workspace.id), eq(problems.kind, kind)));
}

async function tasksOf(ctx: TestContext) {
  return ctx.db.select().from(tasks).where(eq(tasks.workspace_id, ctx.workspace.id));
}

async function meetingRow(ctx: TestContext, id: string) {
  const row = await getMeeting(ctx, id);
  if (!row) throw new Error("meeting missing");
  return row;
}

async function conflictOf(promise: Promise<unknown>): Promise<OpenOutboundError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(OpenOutboundError);
  return error as OpenOutboundError;
}

describe("recording a meeting by hand", () => {
  it("has the same effects as a booking webhook", async () => {
    const s = await setup();
    await openProblem(s.ctx, {
      kind: "meeting_to_book",
      severity: "high",
      title: "Book a meeting with Dana Reyes (Harbor Dental)",
      reason: "Dana proposed Tuesday at 5pm.",
      remedy: "Check the calendar, book it, then record it with manage_meetings action record.",
      personId: s.person.id,
      dedupeKey: meetingToBookKey(s.person.id),
    });

    const result = await record(s, TUESDAY, "Booked by phone.");
    expect(result).toMatchObject({
      created: true,
      changed: true,
      status: "scheduled",
      source: "manual",
      matched_by: "manual",
      external_id: null,
      notes: "Booked by phone.",
      person: { id: s.person.id, full_name: "Dana Reyes" },
      opportunity: { stage: "meeting_booked" },
      start_at: TUESDAY,
    });
    const opportunity = await opportunityOf(s);
    expect(opportunity).toMatchObject({
      id: result.opportunity?.id,
      stage: "meeting_booked",
      notes: "Meeting booked (manual)",
    });
    expect(opportunity?.meeting_at?.toISOString()).toBe(TUESDAY.toISOString());
    expect(await enrollmentOf(s)).toEqual({ status: "stopped", stop_reason: "meeting_booked" });
    const [person] = await s.ctx.db.select().from(people).where(eq(people.id, s.person.id));
    expect(person?.status).toBe("meeting");
    expect((await problemsOf(s.ctx, "meeting_to_book"))[0]?.status).toBe("resolved");
    expect(s.ctx.emitted("meeting.booked").map((event) => event.data)).toEqual([
      {
        meeting_id: result.id,
        person_id: s.person.id,
        opportunity_id: result.opportunity?.id,
        source: "manual",
        start_at: TUESDAY.toISOString(),
        matched_by: "manual",
      },
    ]);
    expect(s.ctx.emitted("opportunity.updated").at(-1)?.data).toMatchObject({
      stage: "meeting_booked",
    });

    // The same meeting recorded again (within a minute of the start) is the same record.
    const again = await record(s, new Date(TUESDAY.getTime() + 30_000));
    expect(again).toMatchObject({ id: result.id, created: false, changed: false });
    const withNote = await record(s, TUESDAY, "Agenda: pricing for three locations.");
    expect(withNote).toMatchObject({ id: result.id, created: false, changed: true });
    expect(withNote.notes).toBe("Booked by phone.\nAgenda: pricing for three locations.");
    expect(s.ctx.emitted("meeting.booked")).toHaveLength(1);
  });

  it("cancels the engine's reply drafts waiting for review, never a person's text", async () => {
    const s = await setup();
    const thread = await seedThread(s.ctx, { person_id: s.person.id, company_id: s.company.id });
    const reply = (
      status: "draft" | "pending_review" | "approved" | "scheduled",
      checker: string | null,
      notes = "reply:meeting_request",
      more: { person_id?: string; origin?: "engine" | "external" } = {},
    ) =>
      seedMessage(s.ctx, {
        thread_id: thread.id,
        person_id: s.person.id,
        action: "reply",
        status,
        why: { notes },
        check: { passed: true, issues: [], revised: false, checker_model: checker },
        ...more,
      });
    const waiting = await reply("pending_review", "fake-model");
    const unsaved = await reply("draft", "fake-model", "reply:interested");
    // Exact text from a person or the agent (no checker), and a reply a person approved.
    const theirs = await reply("pending_review", null);
    const approved = await reply("approved", "fake-model");
    // Kept too: an answer to a question, a draft someone edited, one already on its way, one
    // a person wrote from the mailbox, and another person's draft.
    const answer = await reply("pending_review", "fake-model", "reply:question");
    const edited = await reply("pending_review", "fake-model", "edited by Agent");
    const queued = await reply("scheduled", "fake-model");
    const external = await reply("pending_review", "fake-model", "reply:meeting_request", {
      origin: "external",
    });
    const other = await seedPerson(s.ctx, { company_id: s.company.id });
    const otherThread = await seedThread(s.ctx, { person_id: other.id, company_id: s.company.id });
    const othersDraft = await seedMessage(s.ctx, {
      thread_id: otherThread.id,
      person_id: other.id,
      action: "reply",
      status: "pending_review",
      why: { notes: "reply:meeting_request" },
      check: { passed: true, issues: [], revised: false, checker_model: "fake-model" },
    });
    const approval = await s.ctx.approvals.request({
      kind: "reply",
      title: "Reply to Dana Reyes",
      summary: "Offers the booking link.",
      payload: { message_id: waiting.id },
      target: { type: "message", id: waiting.id },
    });

    await record(s);
    const rows = await s.ctx.db
      .select({ id: messages.id, status: messages.status, error: messages.error })
      .from(messages)
      .where(eq(messages.thread_id, thread.id));
    const byId = Object.fromEntries(rows.map((row) => [row.id, [row.status, row.error]]));
    expect(byId).toEqual({
      [waiting.id]: ["cancelled", "meeting_booked"],
      [unsaved.id]: ["cancelled", "meeting_booked"],
      [theirs.id]: ["pending_review", null],
      [approved.id]: ["approved", null],
      [answer.id]: ["pending_review", null],
      [edited.id]: ["pending_review", null],
      [queued.id]: ["scheduled", null],
      [external.id]: ["pending_review", null],
    });
    const [kept] = await s.ctx.db
      .select({ status: messages.status })
      .from(messages)
      .where(eq(messages.id, othersDraft.id));
    expect(kept?.status).toBe("pending_review");
    const [decision] = await s.ctx.db
      .select({ status: approvals.status })
      .from(approvals)
      .where(eq(approvals.id, approval.id));
    expect(decision?.status).toBe("cancelled");
  });

  it("finds the meeting a booking webhook already reported", async () => {
    const s = await setup();
    const webhook = await recordMeetingBooked(s.ctx, {
      personId: s.person.id,
      source: "calendly",
      matchedBy: "email",
      externalId: "https://api.calendly.com/scheduled_events/E1/invitees/I1",
      startAt: TUESDAY,
    });
    const manual = await record(s);
    expect(manual).toMatchObject({ id: webhook.meetingId, created: false, source: "calendly" });
    expect(
      await s.ctx.db.select().from(meetings).where(eq(meetings.person_id, s.person.id)),
    ).toHaveLength(1);
  });

  it("adopts the unmatched booking with the same start from the person's company only", async () => {
    const s = await setup();
    const booking = (email: string, id: string, start: Date = TUESDAY) => {
      const parsed = parseMeetingPayload({ email, id, start_time: start.toISOString() });
      if ("error" in parsed) throw new Error(parsed.error);
      return parsed;
    };
    // Same start, but from another company: never taken for Dana's meeting.
    const stranger = booking("assistant@elsewhere.example.org", "evt-8");
    const frontDesk = booking("frontdesk@harbor-dental.example.com", "evt-9");
    expect((await handleMeetingBooking(s.ctx, stranger)).matched).toBe(false);
    expect((await handleMeetingBooking(s.ctx, frontDesk)).matched).toBe(false);

    const recorded = await record(s);
    expect(recorded).toMatchObject({
      source: "generic",
      external_id: "evt-9",
      matched_by: "manual",
    });
    const unmatched = await problemsOf(s.ctx, "unmatched_booking");
    expect(unmatched.find((problem) => problem.data.external_id === "evt-9")).toMatchObject({
      status: "resolved",
      resolution: `Recorded as meeting ${recorded.id}.`,
    });
    expect(unmatched.find((problem) => problem.data.external_id === "evt-8")?.status).toBe("open");
    // Later changes from the booking tool now find the meeting.
    const cancelled = await handleMeetingBooking(s.ctx, { ...frontDesk, event: "cancelled" });
    expect(cancelled).toMatchObject({ meeting_id: recorded.id, meeting_status: "cancelled" });

    // A free mail domain says nothing: only the person's own address counts there.
    const lee = await seedPerson(s.ctx, { full_name: "Lee Park", email: "lee.park@gmail.com" });
    await handleMeetingBooking(s.ctx, booking("sam.other@gmail.com", "evt-10", THURSDAY));
    const leeMeeting = await recordMeeting.handler(s.ctx, {
      person_id: lee.id,
      start_at: THURSDAY,
    });
    expect(leeMeeting).toMatchObject({ source: "manual", external_id: null });
  });

  it("a second booking stops sequences started since the first one", async () => {
    const s = await setup();
    await record(s, TUESDAY);
    expect(await enrollmentOf(s)).toEqual({ status: "stopped", stop_reason: "meeting_booked" });
    // Enrolled again in another campaign while the opportunity stays at meeting_booked.
    const { campaign: other } = await seedCampaign(s.ctx, { status: "active" });
    const again = await seedEnrollment(s.ctx, { campaign_id: other.id, person_id: s.person.id });
    const second = await record(s, THURSDAY);
    expect(second).toMatchObject({ created: true, opportunity: { stage: "meeting_booked" } });
    const [row] = await s.ctx.db.select().from(enrollments).where(eq(enrollments.id, again.id));
    expect(row).toMatchObject({ status: "stopped", stop_reason: "meeting_booked" });
  });

  it("refuses unknown people and an end before the start", async () => {
    const s = await setup();
    const missing = await conflictOf(
      recordMeeting.handler(s.ctx, {
        person_id: "pe_01k6a3v0q8x3m2n4p5r6s7t8v9",
        start_at: TUESDAY,
      }),
    );
    expect(missing.code).toBe("not_found");
    expect(missing.hint).toContain("search_leads");
    const backwards = await conflictOf(
      recordMeeting.handler(s.ctx, {
        person_id: s.person.id,
        start_at: TUESDAY,
        end_at: new Date(TUESDAY.getTime() - HOUR),
      }),
    );
    expect(backwards.code).toBe("validation_failed");
  });

  it("keeps workspaces apart", async () => {
    const s = await setup();
    const result = await record(s);
    const other = await createTestContext({ db: testDb });
    expect(await getMeeting(other, result.id)).toBeNull();
    const error = await conflictOf(getMeetingOperation.handler(other, { meeting_id: result.id }));
    expect(error.code).toBe("not_found");
    expect(error.hint).toContain("manage_meetings action list");
    expect((await listMeetings.handler(other, { limit: 25 })).items.map((item) => item.id)).toEqual(
      [],
    );
  });
});

describe("cancellations", () => {
  it("free the opportunity only when no other meeting is scheduled, and never restart sequences", async () => {
    const s = await setup();
    const first = await record(s, TUESDAY);
    const second = await record(s, THURSDAY);
    expect(second.created).toBe(true);
    expect((await opportunityOf(s))?.meeting_at?.toISOString()).toBe(THURSDAY.toISOString());

    const one = await cancelMeeting.handler(s.ctx, { meeting_id: second.id });
    expect(one).toMatchObject({ status: "cancelled", changed: true });
    expect(await opportunityOf(s)).toMatchObject({ stage: "meeting_booked" });
    expect((await opportunityOf(s))?.meeting_at?.toISOString()).toBe(TUESDAY.toISOString());

    const both = await cancelMeeting.handler(s.ctx, {
      meeting_id: first.id,
      notes: "Budget freeze.",
    });
    expect(both).toMatchObject({ status: "cancelled", notes: "Budget freeze.", changed: true });
    expect(await opportunityOf(s)).toMatchObject({ stage: "interested", meeting_at: null });
    expect(await enrollmentOf(s)).toEqual({ status: "stopped", stop_reason: "meeting_booked" });
    expect(s.ctx.emitted("meeting.cancelled")).toHaveLength(2);

    const again = await cancelMeeting.handler(s.ctx, { meeting_id: first.id });
    expect(again.changed).toBe(false);
    expect(s.ctx.emitted("meeting.cancelled")).toHaveLength(2);
  });

  it("stay cancelled until a reschedule brings the meeting back", async () => {
    const s = await setup();
    const meeting = await record(s);
    await cancelMeeting.handler(s.ctx, { meeting_id: meeting.id });
    const refused = await conflictOf(setMeetingStatus(s.ctx, meeting.id, "held"));
    expect(refused.code).toBe("conflict");
    expect(refused.hint).toContain("reschedule");
    expect(canChangeMeetingStatus("cancelled", "scheduled")).toBe(false);

    const back = await rescheduleMeetingOperation.handler(s.ctx, {
      meeting_id: meeting.id,
      start_at: THURSDAY,
    });
    expect(back).toMatchObject({ status: "scheduled", changed: true });
    expect(await opportunityOf(s)).toMatchObject({ stage: "meeting_booked" });
    expect((await opportunityOf(s))?.meeting_at?.toISOString()).toBe(THURSDAY.toISOString());
    expect(s.ctx.emitted("meeting.rescheduled").at(-1)?.data).toMatchObject({
      meeting_id: meeting.id,
      start_at: THURSDAY.toISOString(),
      previous_start_at: TUESDAY.toISOString(),
    });
    // The cancellation's follow-up task is done now.
    expect((await tasksOf(s.ctx))[0]?.status).toBe("done");
  });
});

describe("after rules", () => {
  async function noShowOf(s: Setup) {
    const meeting = await record(s, TUESDAY);
    s.ctx.clock.set(new Date(TUESDAY.getTime() + HOUR));
    return markMeetingNoShow.handler(s.ctx, { meeting_id: meeting.id, undo: false });
  }

  it("task (default): one follow-up task, due now, reopened when needed again", async () => {
    const s = await setup();
    const noShow = await noShowOf(s);
    expect(noShow).toMatchObject({ status: "no_show", changed: true });
    expect(s.ctx.emitted("meeting.no_show").map((event) => event.data)).toEqual([
      { meeting_id: noShow.id, person_id: s.person.id, opportunity_id: noShow.opportunity?.id },
    ]);
    const [task] = await tasksOf(s.ctx);
    expect(task).toMatchObject({
      title: "Dana Reyes (Harbor Dental) missed the meeting: follow up",
      type: "follow_up",
      status: "open",
      person_id: s.person.id,
      dedupe_key: `meeting_follow_up:${noShow.id}`,
    });
    expect(task?.due_at?.toISOString()).toBe(s.ctx.clock.now().toISOString());
    expect(task?.notes).toContain("Their sequences stay stopped.");

    const undone = await markMeetingNoShow.handler(s.ctx, { meeting_id: noShow.id, undo: true });
    expect(undone).toMatchObject({ status: "scheduled", changed: true });
    expect((await tasksOf(s.ctx))[0]?.status).toBe("skipped");
    const again = await markMeetingNoShow.handler(s.ctx, { meeting_id: noShow.id, undo: false });
    expect(again.changed).toBe(true);
    const tasksNow = await tasksOf(s.ctx);
    expect(tasksNow).toHaveLength(1);
    expect(tasksNow[0]?.status).toBe("open");
    expect(s.ctx.enqueued(DRAFT_REPLY_JOB)).toHaveLength(0);
  });

  it("nothing: no task and no draft", async () => {
    const s = await setup({ booking: { after_no_show: "nothing", after_cancel: "nothing" } });
    const noShow = await noShowOf(s);
    expect(noShow.status).toBe("no_show");
    await cancelMeeting.handler(s.ctx, { meeting_id: noShow.id });
    expect(await tasksOf(s.ctx)).toHaveLength(0);
    expect(s.ctx.enqueued(DRAFT_REPLY_JOB)).toHaveLength(0);
    expect(s.ctx.emitted("meeting.cancelled")).toHaveLength(1);
  });

  it("draft: a reviewed follow-up draft in the latest thread, offering the booking link", async () => {
    const s = await setup({
      booking: { after_no_show: "draft", default_url: "https://calendly.com/helix/intro" },
    });
    const thread = await seedThread(s.ctx, {
      person_id: s.person.id,
      company_id: s.company.id,
      campaign_id: s.campaign.id,
    });
    const inbound = await seedMessage(s.ctx, {
      thread_id: thread.id,
      person_id: s.person.id,
      campaign_id: s.campaign.id,
      direction: "inbound",
      status: "received",
      action: "reply",
      body_text: "Tuesday works, send me a link.",
      created_at: new Date("2026-09-18T12:00:00Z"),
    });
    const noShow = await noShowOf(s);
    expect(await tasksOf(s.ctx)).toHaveLength(0);
    const [job] = s.ctx.enqueued(DRAFT_REPLY_JOB);
    expect(job?.payload).toMatchObject({
      message_id: inbound.id,
      auto_send: false,
      manual: true,
    });
    expect(String((job?.payload as { instruction?: string } | undefined)?.instruction)).toContain(
      "Never propose or confirm a time yourself.",
    );
    expect(job?.options.singletonKey).toBe(`${DRAFT_REPLY_JOB}:meeting:${noShow.id}:no_show`);
  });

  it("draft falls back to a task without a thread or without a link to offer", async () => {
    const noThread = await setup({
      booking: { after_no_show: "draft", default_url: "https://calendly.com/helix/intro" },
    });
    await noShowOf(noThread);
    expect(await tasksOf(noThread.ctx)).toHaveLength(1);
    expect(noThread.ctx.enqueued(DRAFT_REPLY_JOB)).toHaveLength(0);

    const handoff = await setup({
      booking: {
        mode: "handoff",
        after_no_show: "draft",
        default_url: "https://calendly.com/helix/intro",
      },
    });
    const thread = await seedThread(handoff.ctx, { person_id: handoff.person.id });
    await seedMessage(handoff.ctx, {
      thread_id: thread.id,
      person_id: handoff.person.id,
      direction: "inbound",
      status: "received",
      action: "reply",
    });
    await noShowOf(handoff);
    expect(await tasksOf(handoff.ctx)).toHaveLength(1);
    expect(handoff.ctx.enqueued(DRAFT_REPLY_JOB)).toHaveLength(0);
  });

  it("draft falls back to a task when a person owns the thread", async () => {
    const s = await setup({
      booking: { after_no_show: "draft", default_url: "https://calendly.com/helix/intro" },
    });
    const thread = await seedThread(s.ctx, { person_id: s.person.id, owner: "person" });
    await seedMessage(s.ctx, {
      thread_id: thread.id,
      person_id: s.person.id,
      direction: "inbound",
      status: "received",
      action: "reply",
    });
    await noShowOf(s);
    expect(await tasksOf(s.ctx)).toHaveLength(1);
    expect(s.ctx.enqueued(DRAFT_REPLY_JOB)).toHaveLength(0);
  });
});

describe("status rules and operations", () => {
  it("held, qualified and no-show marks follow the rules", async () => {
    const s = await setup();
    const meeting = await record(s, TUESDAY);
    const early = await conflictOf(
      markMeetingHeld.handler(s.ctx, { meeting_id: meeting.id, qualified: true }),
    );
    expect(early.code).toBe("conflict");
    expect(early.hint).toContain("reschedule");
    const earlyNoShow = await conflictOf(
      markMeetingNoShow.handler(s.ctx, { meeting_id: meeting.id, undo: false }),
    );
    expect(earlyNoShow.code).toBe("conflict");
    // Undoing a no-show that is not one changes nothing.
    expect(
      await markMeetingNoShow.handler(s.ctx, { meeting_id: meeting.id, undo: true }),
    ).toMatchObject({ status: "scheduled", changed: false });

    s.ctx.clock.set(new Date(TUESDAY.getTime() + HOUR));
    const held = await markMeetingHeld.handler(s.ctx, {
      meeting_id: meeting.id,
      qualified: true,
      notes: "Wants a pilot.",
    });
    expect(held).toMatchObject({ status: "held", qualified: true, changed: true });
    expect(s.ctx.emitted("meeting.held").map((event) => event.data)).toEqual([
      {
        meeting_id: meeting.id,
        person_id: s.person.id,
        opportunity_id: meeting.opportunity?.id,
        qualified: true,
      },
    ]);
    const repeat = await markMeetingHeld.handler(s.ctx, { meeting_id: meeting.id });
    expect(repeat.changed).toBe(false);

    const judged = await qualifyMeeting.handler(s.ctx, {
      meeting_id: meeting.id,
      qualified: false,
    });
    expect(judged).toMatchObject({ status: "held", qualified: false, changed: true });
    expect(
      (await qualifyMeeting.handler(s.ctx, { meeting_id: meeting.id, qualified: false })).changed,
    ).toBe(false);
    expect(s.ctx.emitted("meeting.held")).toHaveLength(1);

    // A meeting marked held by mistake can still be a no-show.
    const missed = await markMeetingNoShow.handler(s.ctx, { meeting_id: meeting.id, undo: false });
    expect(missed).toMatchObject({ status: "no_show", changed: true });
  });

  it("a reschedule keeps the length and moves the opportunity's meeting time", async () => {
    const s = await setup();
    const meeting = await recordMeeting.handler(s.ctx, {
      person_id: s.person.id,
      start_at: TUESDAY,
      end_at: new Date(TUESDAY.getTime() + 30 * 60_000),
    });
    const moved = await rescheduleMeetingOperation.handler(s.ctx, {
      meeting_id: meeting.id,
      start_at: THURSDAY,
    });
    expect(moved).toMatchObject({
      changed: true,
      start_at: THURSDAY,
      end_at: new Date(THURSDAY.getTime() + 30 * 60_000),
    });
    expect((await opportunityOf(s))?.meeting_at?.toISOString()).toBe(THURSDAY.toISOString());
    const same = await rescheduleMeeting(s.ctx, meeting.id, { startAt: THURSDAY });
    expect(same.changed).toBe(false);
    expect(s.ctx.emitted("meeting.rescheduled")).toHaveLength(1);
  });

  it("lists meetings by status, person and time, soonest first, page by page", async () => {
    const s = await setup();
    const tuesday = await record(s, TUESDAY);
    const thursday = await record(s, THURSDAY);
    const lee = await seedPerson(s.ctx, { full_name: "Lee Park" });
    const later = await recordMeeting.handler(s.ctx, {
      person_id: lee.id,
      start_at: new Date("2026-10-20T10:00:00Z"),
    });
    await cancelMeeting.handler(s.ctx, { meeting_id: thursday.id });

    const first = await listMeetings.handler(s.ctx, { limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual([tuesday.id, thursday.id]);
    expect(first.has_more).toBe(true);
    const rest = await listMeetings.handler(s.ctx, {
      limit: 2,
      cursor: first.next_cursor ?? undefined,
    });
    expect(rest.items.map((item) => item.id)).toEqual([later.id]);
    expect(rest.has_more).toBe(false);

    const scheduled = await listMeetings.handler(s.ctx, { limit: 25, status: ["scheduled"] });
    expect(scheduled.items.map((item) => item.id)).toEqual([tuesday.id, later.id]);
    const dana = await listMeetings.handler(s.ctx, { limit: 25, person_id: s.person.id });
    expect(dana.items.map((item) => item.id)).toEqual([tuesday.id, thursday.id]);
    const window = await listMeetings.handler(s.ctx, {
      limit: 25,
      from: new Date("2026-10-07T00:00:00Z"),
      to: new Date("2026-10-20T10:00:00Z"),
    });
    expect(window.items.map((item) => item.id)).toEqual([thursday.id]);
    expect(window.items[0]).toMatchObject({
      status: "cancelled",
      person: { id: s.person.id, full_name: "Dana Reyes" },
      opportunity: { stage: "meeting_booked" },
    });
  });
});

describe("held sweep", () => {
  async function sweep(ctx: TestContext) {
    return assumeHeldJob.handler(ctx.jobContext({ name: "meetings.assume_held" }), {});
  }

  it("counts scheduled meetings as held 24 hours after their start, once", async () => {
    const s = await setup();
    const due = await record(s, TUESDAY);
    const recent = await record(s, new Date(TUESDAY.getTime() + 3 * HOUR));
    const missed = await record(s, new Date(TUESDAY.getTime() - 48 * HOUR));
    const noTime = await recordMeetingBooked(s.ctx, {
      personId: s.person.id,
      source: "generic",
      matchedBy: "email",
      externalId: "evt-no-time",
    });
    s.ctx.clock.set(new Date(TUESDAY.getTime() + 25 * HOUR));
    await markMeetingNoShow.handler(s.ctx, { meeting_id: missed.id, undo: false });

    expect(await sweep(s.ctx)).toEqual({ after_hours: 24, marked_held: 1, more_left: false });
    expect((await meetingRow(s.ctx, due.id)).status).toBe("held");
    expect((await meetingRow(s.ctx, recent.id)).status).toBe("scheduled");
    expect((await meetingRow(s.ctx, missed.id)).status).toBe("no_show");
    expect((await meetingRow(s.ctx, noTime.meetingId)).status).toBe("scheduled");
    expect(s.ctx.emitted("meeting.held").map((event) => event.data.meeting_id)).toEqual([due.id]);
    expect(s.ctx.recorded.audit.at(-1)).toMatchObject({ operation: "meetings.assume_held" });

    expect(await sweep(s.ctx)).toMatchObject({ marked_held: 0 });
    expect(s.ctx.emitted("meeting.held")).toHaveLength(1);

    // An undone no-show is scheduled again, and the sweep looks at it again.
    await markMeetingNoShow.handler(s.ctx, { meeting_id: missed.id, undo: true });
    expect(await sweep(s.ctx)).toMatchObject({ marked_held: 1 });
    expect((await meetingRow(s.ctx, missed.id)).status).toBe("held");
  });

  it("a no-show that races the sweep wins, with exactly one follow-up task", async () => {
    const s = await setup();
    const meeting = await record(s, TUESDAY);
    s.ctx.clock.set(new Date(TUESDAY.getTime() + 25 * HOUR));
    await Promise.all([sweep(s.ctx), setMeetingStatus(s.ctx, meeting.id, "no_show")]);

    expect((await meetingRow(s.ctx, meeting.id)).status).toBe("no_show");
    const open = (await tasksOf(s.ctx)).filter((task) => task.status === "open");
    expect(open.map((task) => task.dedupe_key)).toEqual([`meeting_follow_up:${meeting.id}`]);
    expect(s.ctx.emitted("meeting.no_show")).toHaveLength(1);
  });

  it("never marks a meeting held once it is no longer scheduled", async () => {
    const s = await setup();
    const meeting = await record(s, TUESDAY);
    s.ctx.clock.set(new Date(TUESDAY.getTime() + 25 * HOUR));
    await setMeetingStatus(s.ctx, meeting.id, "no_show");

    expect(await setMeetingStatus(s.ctx, meeting.id, "held", { onlyFrom: "scheduled" })).toEqual({
      changed: false,
    });
    expect((await meetingRow(s.ctx, meeting.id)).status).toBe("no_show");
    expect(s.ctx.emitted("meeting.held")).toHaveLength(0);
  });

  it("does nothing with assume_held_after_hours 0", async () => {
    const s = await setup({ booking: { assume_held_after_hours: 0 } });
    const meeting = await record(s, TUESDAY);
    s.ctx.clock.set(new Date(TUESDAY.getTime() + 30 * 24 * HOUR));
    expect(await sweep(s.ctx)).toEqual({ skipped: "assume_held_off" });
    expect((await meetingRow(s.ctx, meeting.id)).status).toBe("scheduled");
    expect(s.ctx.emitted("meeting.held")).toHaveLength(0);
  });
});
