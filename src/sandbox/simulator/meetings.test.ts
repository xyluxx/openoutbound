import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newId } from "../../core/ids.js";
import { meetings, offers, opportunities, people } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { seedMailbox, seedMessage, seedPerson, seedThread } from "../../testing/factories.js";
import { scheduleSimulatedReply } from "./event-handler.js";
import { countPendingSimulations, fastForwardSandbox } from "./fast-forward.js";
import {
  decideMeeting,
  MEETING_BOOKING_JOB,
  MEETING_BOOKING_RATE,
  MEETING_NO_SHOW_JOB,
  MEETING_NO_SHOW_RATE,
  NO_SHOW_REPORT_DELAY_MS,
  processMeetingBooking,
  processMeetingNoShow,
  sandboxMeetingExternalId,
} from "./meetings.js";

vi.mock("../../runtime/notify.js", () => ({ notify: vi.fn(async () => {}) }));

const LINK = "https://cal.example.com/helix/intro";
const SENT_AT = new Date("2026-09-19T12:00:00Z");

/** Person and reply ids whose simulated prospect books (and shows up or not, as asked). */
function idsFor(prefix: string, noShow: boolean): { personId: string; messageId: string } {
  const personId = `${prefix}_pe`;
  for (let i = 0; i < 20_000; i++) {
    const messageId = `${prefix}_msg_${i}`;
    const decision = decideMeeting({ personId, replyMessageId: messageId, sentAt: SENT_AT });
    if (decision.books && decision.noShow === noShow) return { personId, messageId };
  }
  throw new Error("no ids in the bucket");
}

async function world(ctx: TestContext, ids: { personId: string; messageId: string }, body: string) {
  await ctx.db
    .insert(offers)
    .values({ workspace_id: ctx.workspace.id, name: "Intro call", booking_url: LINK });
  const mailbox = await seedMailbox(ctx);
  const person = await seedPerson(ctx, {
    id: ids.personId,
    full_name: "Dana Reyes",
    email: `${ids.personId}@harbor-dental.example.com`,
  });
  const thread = await seedThread(ctx, { person_id: person.id, mailbox_id: mailbox.id });
  const reply = await seedMessage(ctx, {
    id: ids.messageId,
    thread_id: thread.id,
    person_id: person.id,
    mailbox_id: mailbox.id,
    action: "reply",
    status: "sent",
    body_text: body,
    sent_at: SENT_AT,
  });
  return { person, reply };
}

describe("decideMeeting", () => {
  it("is deterministic, books 1 to 3 days after the reply, on the hour in the afternoon", () => {
    const input = { personId: "pe_x", replyMessageId: "msg_y", sentAt: SENT_AT };
    expect(decideMeeting(input)).toEqual(decideMeeting(input));
    let booked = 0;
    let noShows = 0;
    for (let i = 0; i < 4000; i++) {
      const decision = decideMeeting({ ...input, replyMessageId: `msg_${i}` });
      const days = (decision.startAt.getTime() - Date.UTC(2026, 8, 19)) / 86_400_000;
      expect(Math.floor(days)).toBeGreaterThanOrEqual(1);
      expect(Math.floor(days)).toBeLessThanOrEqual(3);
      expect(decision.startAt.getUTCHours()).toBeGreaterThanOrEqual(14);
      expect(decision.startAt.getUTCHours()).toBeLessThanOrEqual(17);
      expect(decision.startAt.getUTCMinutes()).toBe(0);
      expect(decision.endAt.getTime() - decision.startAt.getTime()).toBe(30 * 60_000);
      if (decision.books) booked++;
      if (decision.noShow) {
        expect(decision.books).toBe(true);
        noShows++;
      }
    }
    expect(booked / 4000).toBeCloseTo(MEETING_BOOKING_RATE, 1);
    expect(noShows / booked).toBeCloseTo(MEETING_NO_SHOW_RATE, 1);
  });
});

describe("simulated meetings", () => {
  let ctx: TestContext;
  afterEach(async () => {
    await ctx?.close();
  });

  it("books a meeting from a reply with the booking link, through the booking path, once", async () => {
    ctx = await createTestContext({ sandbox: true, now: SENT_AT });
    const ids = idsFor("book", false);
    const { person, reply } = await world(ctx, ids, `Grab a slot here: ${LINK}`);

    const result = await processMeetingBooking(ctx, reply.id);
    expect(result.delivered).toBe(true);
    const [meeting] = await ctx.db.select().from(meetings).where(eq(meetings.person_id, person.id));
    const decision = decideMeeting({
      personId: person.id,
      replyMessageId: reply.id,
      sentAt: SENT_AT,
    });
    expect(meeting).toMatchObject({
      id: result.meeting_id,
      source: "generic",
      external_id: sandboxMeetingExternalId(reply.id),
      matched_by: "ref",
      status: "scheduled",
    });
    expect(meeting?.start_at?.toISOString()).toBe(decision.startAt.toISOString());
    const [stored] = await ctx.db.select().from(people).where(eq(people.id, person.id));
    expect(stored?.booking_ref).toMatch(/^bk/);
    const [opportunity] = await ctx.db
      .select()
      .from(opportunities)
      .where(eq(opportunities.person_id, person.id));
    expect(opportunity?.stage).toBe("meeting_booked");
    expect(ctx.enqueued(MEETING_NO_SHOW_JOB)).toHaveLength(0);

    expect(await processMeetingBooking(ctx, reply.id)).toMatchObject({
      delivered: false,
      reason: "already_handled",
    });
    expect(ctx.emitted("meeting.booked")).toHaveLength(1);
  });

  it("reports a no-show only once the meeting was due, and only once", async () => {
    ctx = await createTestContext({ sandbox: true, now: SENT_AT });
    const ids = idsFor("noshow", true);
    const { reply } = await world(ctx, ids, `Grab a slot here: ${LINK}`);
    const booked = await processMeetingBooking(ctx, reply.id);
    expect(booked.delivered).toBe(true);
    const decision = decideMeeting({
      personId: ids.personId,
      replyMessageId: reply.id,
      sentAt: SENT_AT,
    });
    const [job] = ctx.enqueued(MEETING_NO_SHOW_JOB);
    expect(job?.options.delayMs).toBe(
      decision.startAt.getTime() + NO_SHOW_REPORT_DELAY_MS - SENT_AT.getTime(),
    );

    expect(await processMeetingNoShow(ctx, reply.id)).toMatchObject({ reason: "not_yet" });
    ctx.clock.set(new Date(decision.startAt.getTime() + NO_SHOW_REPORT_DELAY_MS));
    expect(await processMeetingNoShow(ctx, reply.id)).toMatchObject({ delivered: true });
    expect(ctx.emitted("meeting.no_show")).toHaveLength(1);
    expect(await processMeetingNoShow(ctx, reply.id)).toMatchObject({
      reason: "already_handled",
    });
  });

  it("ignores replies without the booking link", async () => {
    ctx = await createTestContext({ sandbox: true, now: SENT_AT });
    const ids = idsFor("nolink", false);
    const { reply } = await world(ctx, ids, "Happy to share more details by email.");
    expect(await processMeetingBooking(ctx, reply.id)).toMatchObject({ reason: "no_link" });
    await scheduleSimulatedReply.handler(ctx.jobContext(), {
      id: newId("evt"),
      type: "message.sent",
      workspaceId: ctx.workspace.id,
      subject: { type: "message", id: reply.id },
      data: {
        message_id: reply.id,
        thread_id: reply.thread_id,
        person_id: ids.personId,
        campaign_id: null,
        channel: "email",
        action: "reply",
        sent_at: SENT_AT.toISOString(),
      },
      occurredAt: SENT_AT,
    });
    expect(ctx.enqueued(MEETING_BOOKING_JOB)).toHaveLength(0);
  });

  it("schedules a booking for a sent reply with the link", async () => {
    ctx = await createTestContext({ sandbox: true, now: SENT_AT });
    const ids = idsFor("event", false);
    const { reply } = await world(ctx, ids, `Pick any slot: ${LINK}?month=2026-10`);
    await scheduleSimulatedReply.handler(ctx.jobContext(), {
      id: newId("evt"),
      type: "message.sent",
      workspaceId: ctx.workspace.id,
      subject: { type: "message", id: reply.id },
      data: {
        message_id: reply.id,
        thread_id: reply.thread_id,
        person_id: ids.personId,
        campaign_id: null,
        channel: "email",
        action: "reply",
        sent_at: SENT_AT.toISOString(),
      },
      occurredAt: SENT_AT,
    });
    const [job] = ctx.enqueued(MEETING_BOOKING_JOB);
    expect(job?.payload).toEqual({ message_id: reply.id });
    expect(job?.options.singletonKey).toBe(`sandbox_meeting_booking:${reply.id}`);
  });

  it("fast-forward books pending meetings now and reports due no-shows", async () => {
    ctx = await createTestContext({ sandbox: true, now: SENT_AT });
    const ids = idsFor("ff", true);
    const { reply } = await world(ctx, ids, `Grab a slot here: ${LINK}`);

    expect(await countPendingSimulations(ctx, ctx.workspace.id)).toMatchObject({
      meeting_bookings: 1,
      meeting_no_shows: 0,
    });
    const first = await fastForwardSandbox(ctx, ctx.workspace.id);
    expect(first.delivered).toMatchObject({ meeting_bookings: 1, meeting_no_shows: 0 });
    expect(await countPendingSimulations(ctx, ctx.workspace.id)).toMatchObject({
      meeting_bookings: 0,
      meeting_no_shows: 0,
    });

    const decision = decideMeeting({
      personId: ids.personId,
      replyMessageId: reply.id,
      sentAt: SENT_AT,
    });
    ctx.clock.set(new Date(decision.startAt.getTime() + NO_SHOW_REPORT_DELAY_MS + 60_000));
    expect(await countPendingSimulations(ctx, ctx.workspace.id)).toMatchObject({
      meeting_no_shows: 1,
    });
    const second = await fastForwardSandbox(ctx, ctx.workspace.id);
    expect(second.delivered).toMatchObject({ meeting_bookings: 0, meeting_no_shows: 1 });
    const [meeting] = await ctx.db
      .select()
      .from(meetings)
      .where(eq(meetings.external_id, sandboxMeetingExternalId(reply.id)));
    expect(meeting?.status).toBe("no_show");
  });
});
