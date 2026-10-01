/**
 * Acceptance scenario 5, cancelled meeting. Grace Okafor gets the first campaign email and books
 * a call through Calendly, which stops her sequence. A day later she cancels in Calendly. The
 * meeting turns cancelled, her opportunity goes back to interested, the default
 * booking.after_cancel rule puts a follow-up task in front of a person (it shows in the attention
 * queue and as her next action), meeting.cancelled fires once, and her stopped sequence stays
 * stopped: in the days after, nothing new is written, planned or sent to her.
 */
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { meetings, messages, opportunities, tasks } from "../../../src/db/schema/index.js";
import { getSandboxOutbox } from "../../../src/modules/email/sandbox-transport.js";
import {
  type Any,
  advance,
  calendlyDelivery,
  createCampaign,
  DAY,
  enrollAndLaunch,
  enrollmentsOf,
  eventsOf,
  firstEmailSent,
  HOUR,
  messagesOf,
  pathOf,
  postJson,
  startWorld,
  type World,
  webhookApp,
} from "./support.js";

let world: World;
afterAll(async () => {
  await world?.close();
});

const EMAIL = "grace.okafor@lakeside-ortho.example.com";

describe("acceptance: cancelled meeting", () => {
  it("records the cancellation, hands a follow-up to a person and keeps the sequence stopped", async () => {
    world = await startWorld();
    const { person, company } = await world.lead({
      person: { first_name: "Grace", last_name: "Okafor", full_name: "Grace Okafor", email: EMAIL },
      company: { name: "Lakeside Orthodontics", domain: "lakeside-ortho.example.com" },
    });
    const campaign = await createCampaign(world, { name: "Orthodontic practices" });
    await enrollAndLaunch(world, campaign.id, [person.id]);
    await firstEmailSent(world, person.id);

    // She books a call through Calendly: the sequence stops.
    const hook = await world.call<Any>("meetings.create_webhook", {});
    const app = webhookApp(world);
    const delivery = (event: "invitee.created" | "invitee.canceled") =>
      calendlyDelivery({
        event,
        email: EMAIL,
        name: "Grace Okafor",
        ref: null,
        eventId: "EVENTLAKESIDE001",
        start: "2026-09-25T16:00:00.000000Z",
        end: "2026-09-25T16:30:00.000000Z",
      });
    const booked = await postJson(app, pathOf(hook.url), delivery("invitee.created"));
    expect(booked.status).toBe(200);
    expect(booked.body).toMatchObject({
      ok: true,
      matched: true,
      event: "booked",
      person_id: person.id,
      matched_by: "email",
      changed: true,
    });
    const meetingId: string = booked.body.meeting_id;
    expect(await enrollmentsOf(world, person.id)).toMatchObject([
      { status: "stopped", stop_reason: "meeting_booked" },
    ]);
    const sentBefore = getSandboxOutbox({ workspaceId: world.workspaceId }).length;
    expect(sentBefore).toBe(1);
    const outboundBefore = (await messagesOf(world, { personId: person.id, direction: "outbound" }))
      .map((row) => [row.id, row.status])
      .sort();

    // A day later she cancels in Calendly.
    await advance(world.engine, DAY);
    const cancelled = await postJson(app, pathOf(hook.url), delivery("invitee.canceled"));
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({
      ok: true,
      matched: true,
      event: "cancelled",
      changed: true,
      meeting_id: meetingId,
      meeting_status: "cancelled",
      person_id: person.id,
      stage: "interested",
    });
    const cancelledAt = world.engine.clock.now();

    // The meeting is cancelled and the opportunity is back to interested.
    const [meeting] = await world.engine.db
      .select()
      .from(meetings)
      .where(eq(meetings.id, meetingId));
    expect(meeting).toMatchObject({ status: "cancelled", person_id: person.id });
    const opps = await world.engine.db
      .select()
      .from(opportunities)
      .where(eq(opportunities.person_id, person.id));
    expect(opps).toHaveLength(1);
    expect(opps[0]).toMatchObject({
      stage: "interested",
      meeting_at: null,
      company_id: company.id,
    });

    // meeting.cancelled fires once, after the one meeting.booked.
    expect(await eventsOf(world, "meeting.booked")).toHaveLength(1);
    const cancelEvents = await eventsOf(world, "meeting.cancelled");
    expect(cancelEvents).toHaveLength(1);
    expect(cancelEvents[0]?.data).toMatchObject({
      meeting_id: meetingId,
      person_id: person.id,
      opportunity_id: opps[0]?.id,
    });

    // booking.after_cancel (default task): one open follow-up task for a person, due now.
    const followUps = await world.engine.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.workspace_id, world.workspaceId), eq(tasks.person_id, person.id)));
    expect(followUps).toHaveLength(1);
    const task = followUps[0];
    expect(task).toMatchObject({
      type: "follow_up",
      status: "open",
      campaign_id: campaign.id,
      title: expect.stringContaining("cancelled the meeting: follow up"),
    });
    expect(task?.notes).toContain("Their sequences stay stopped.");
    expect(task?.due_at?.toISOString()).toBe(cancelledAt.toISOString());

    // The operator views: the attention queue and her next action both point at the task.
    const attention = await world.call<Any>("attention.get", {});
    expect(attention.counts.tasks_due).toBe(1);
    expect(attention.tasks_due.items[0]).toMatchObject({
      id: task?.id,
      type: "follow_up",
      person_id: person.id,
    });
    const lead = await world.call<Any>("leads.get", { person_id: person.id });
    expect(lead.relationship).toMatchObject({
      state: "in_conversation",
      opportunity_id: opps[0]?.id,
      next_action: { kind: "task", ref: { type: "task", id: task?.id } },
    });
    const next = await world.call<Any>("operating.next_actions", { hours: 24 });
    expect(next.items.map((item: Any) => [item.kind, item.ref.id])).toEqual([["task", task?.id]]);

    // Calendly retrying the cancellation changes nothing.
    const again = await postJson(app, pathOf(hook.url), delivery("invitee.canceled"));
    expect(again.body).toMatchObject({ ok: true, matched: true, changed: false });
    expect(await eventsOf(world, "meeting.cancelled")).toHaveLength(1);
    expect(
      await world.engine.db
        .select()
        .from(tasks)
        .where(and(eq(tasks.workspace_id, world.workspaceId), eq(tasks.person_id, person.id))),
    ).toHaveLength(1);

    // A week goes by (the second step was due three days after the first): the sequence stays
    // stopped and nothing new is written, planned or sent to her.
    for (let day = 0; day < 7; day += 1) await advance(world.engine, DAY);
    await advance(world.engine, 6 * HOUR);
    expect(await enrollmentsOf(world, person.id)).toMatchObject([
      { status: "stopped", stop_reason: "meeting_booked" },
    ]);
    const outboundAfter = (await messagesOf(world, { personId: person.id, direction: "outbound" }))
      .map((row) => [row.id, row.status])
      .sort();
    expect(outboundAfter).toEqual(outboundBefore);
    const planned = await world.engine.db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.workspace_id, world.workspaceId),
          inArray(messages.status, [
            "draft",
            "generating",
            "pending_review",
            "approved",
            "scheduled",
            "sending",
            "unknown",
          ]),
        ),
      );
    expect(planned).toEqual([]);
    expect(getSandboxOutbox({ workspaceId: world.workspaceId })).toHaveLength(sentBefore);
    const [meetingLater] = await world.engine.db
      .select()
      .from(meetings)
      .where(eq(meetings.id, meetingId));
    expect(meetingLater?.status).toBe("cancelled");
  });
});
