/**
 * Acceptance scenario 3, meeting booked by an assistant. Priya Nair's campaign email carries the
 * client's Calendly link, tagged with her hidden booking code. Her assistant books the call
 * from assistant@<the same domain>, an address the engine has never seen, and Calendly posts
 * the booking to the meetings webhook with the code in tracking.utm_content. The engine matches
 * the booking to Priya by the code, records one meeting, moves her opportunity to
 * meeting_booked, stops every sequence and fires meeting.booked once. Calendly delivering the
 * same webhook again changes nothing.
 */
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { meetings, opportunities, people } from "../../../src/db/schema/index.js";
import { getSandboxOutbox } from "../../../src/modules/email/sandbox-transport.js";
import {
  type Any,
  BOOKING_URL,
  calendlyDelivery,
  createCampaign,
  enrollAndLaunch,
  enrollmentsOf,
  eventsOf,
  firstEmailSent,
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

const LINKEDIN_URL = "https://www.linkedin.com/in/priya-nair-example";

describe("acceptance: assistant booking", () => {
  it("matches a booking from another address by the hidden code, once", async () => {
    world = await startWorld({
      settings: { compliance: { one_active_campaign_per_person: false } },
    });
    const { person } = await world.lead({
      person: {
        first_name: "Priya",
        last_name: "Nair",
        full_name: "Priya Nair",
        email: "priya.nair@summit-dental.example.com",
        linkedin_url: LINKEDIN_URL,
      },
      company: { name: "Summit Dental Partners", domain: "summit-dental.example.com" },
    });
    const campaign = await createCampaign(world, {
      name: "Summit follow-up",
      steps: [
        {
          type: "email",
          config: {
            style: "exact",
            subject: "front desk coverage",
            body: "Hi {{first_name}}, we answer overflow and lunch-time calls for dental groups so patients never hit voicemail. If a short walkthrough helps, pick any time that suits you here: {{booking_url}}",
          },
        },
        { type: "email", delay_days: 3, config: { mode: "reply", style: "free", max_words: 70 } },
      ],
    });
    const other = await createCampaign(world, {
      name: "Summit second touch",
      steps: [{ type: "email", delay_days: 5, config: { style: "free" } }],
    });
    await enrollAndLaunch(world, campaign.id, [person.id]);
    await enrollAndLaunch(world, other.id, [person.id]);
    const first = await firstEmailSent(world, person.id);

    // The email she got carries the booking link with her own hidden code.
    const [row] = await world.engine.db.select().from(people).where(eq(people.id, person.id));
    const ref = row?.booking_ref ?? "";
    expect(ref).toMatch(/^bk[0-9a-z]{10}$/);
    const tagged = `${BOOKING_URL}?utm_content=${ref}&utm_source=openoutbound`;
    expect(first.body_text).toContain(tagged);
    const delivered = getSandboxOutbox({ workspaceId: world.workspaceId });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.email.text).toContain(tagged);

    // Her assistant books from an address the engine does not know.
    const hook = await world.call<Any>("meetings.create_webhook", {});
    const app = webhookApp(world);
    const booking = calendlyDelivery({
      event: "invitee.created",
      email: "assistant@summit-dental.example.com",
      name: "Front Desk",
      ref,
      eventId: "EVENTSUMMIT0001",
      start: "2026-09-29T15:00:00.000000Z",
      end: "2026-09-29T15:30:00.000000Z",
    });
    const answer = await postJson(app, pathOf(hook.url), booking);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      ok: true,
      matched: true,
      event: "booked",
      person_id: person.id,
      matched_by: "ref",
      changed: true,
    });

    const recorded = await world.engine.db
      .select()
      .from(meetings)
      .where(eq(meetings.workspace_id, world.workspaceId));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      person_id: person.id,
      source: "calendly",
      matched_by: "ref",
      status: "scheduled",
      campaign_id: campaign.id,
    });
    expect(recorded[0]?.start_at?.toISOString()).toBe("2026-09-29T15:00:00.000Z");
    expect(recorded[0]?.external_id).toContain("EVENTSUMMIT0001");

    const opps = await world.engine.db
      .select()
      .from(opportunities)
      .where(eq(opportunities.person_id, person.id));
    expect(opps).toHaveLength(1);
    expect(opps[0]).toMatchObject({ stage: "meeting_booked", person_id: person.id });
    expect(recorded[0]?.opportunity_id).toBe(opps[0]?.id);

    const stopped = await enrollmentsOf(world, person.id);
    expect(stopped.map((item) => [item.status, item.stop_reason])).toEqual([
      ["stopped", "meeting_booked"],
      ["stopped", "meeting_booked"],
    ]);
    const booked = await eventsOf(world, "meeting.booked");
    expect(booked).toHaveLength(1);
    expect(booked[0]?.data).toMatchObject({
      meeting_id: recorded[0]?.id,
      person_id: person.id,
      source: "calendly",
      matched_by: "ref",
      start_at: "2026-09-29T15:00:00.000Z",
    });
    // The assistant's address did not become a lead.
    const leads = await world.engine.db
      .select({ email: people.email })
      .from(people)
      .where(eq(people.workspace_id, world.workspaceId));
    expect(leads.map((lead) => lead.email)).not.toContain("assistant@summit-dental.example.com");

    // The same delivery again (Calendly retries) changes nothing.
    const eventsBefore = await eventsOf(world);
    const again = await postJson(app, pathOf(hook.url), booking);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ ok: true, matched: true, changed: false });
    expect(
      await world.engine.db
        .select()
        .from(meetings)
        .where(eq(meetings.workspace_id, world.workspaceId)),
    ).toHaveLength(1);
    expect(await eventsOf(world, "meeting.booked")).toHaveLength(1);
    expect(await eventsOf(world)).toHaveLength(eventsBefore.length);
    const oppsAfter = await world.engine.db
      .select()
      .from(opportunities)
      .where(eq(opportunities.person_id, person.id));
    expect(oppsAfter).toEqual(opps);

    // The operator views show the meeting as what happens next.
    const lead = await world.call<Any>("leads.get", { person_id: person.id });
    expect(lead.relationship).toMatchObject({
      state: "meeting_scheduled",
      next_action: { kind: "meeting", ref: { type: "meeting", id: recorded[0]?.id } },
    });
    const listed = await world.call<Any>("meetings.list", {});
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ id: recorded[0]?.id, status: "scheduled" });
  });
});
