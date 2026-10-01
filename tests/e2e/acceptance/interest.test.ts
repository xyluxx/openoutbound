/**
 * Acceptance scenario 1, interest. Dana Reyes is in two active sequences (an email campaign that
 * already sent her the first email, and a LinkedIn campaign waiting to start) when she answers
 * the email with interest. The engine sorts the reply as interested, opens an opportunity,
 * stops every sequence of hers on every channel, drafts a reply that offers the booking link
 * tagged with her own booking code and puts it up for review, fires `reply.classified`, and the
 * operator views show a conversation whose next step is reviewing that draft.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { approvals, opportunities, people } from "../../../src/db/schema/index.js";
import { seedLinkedInAccount } from "../../../src/testing/factories.js";
import {
  type Any,
  BOOKING_URL,
  classification,
  createCampaign,
  enrollAndLaunch,
  enrollmentsOf,
  eventsOf,
  firstEmailSent,
  messagesOf,
  receiveReply,
  startWorld,
  type World,
} from "./support.js";

let world: World;
afterAll(async () => {
  await world?.close();
});

describe("acceptance: interest", () => {
  it("stops every sequence, opens an opportunity and drafts a reply with the tagged booking link", async () => {
    world = await startWorld({
      settings: { compliance: { one_active_campaign_per_person: false } },
    });
    const { person, company } = await world.lead({
      person: {
        first_name: "Dana",
        last_name: "Reyes",
        full_name: "Dana Reyes",
        email: "dana.reyes@harbor-dental.example.com",
        linkedin_url: "https://www.linkedin.com/in/dana-reyes-example",
      },
      company: { name: "Harbor Dental", domain: "harbor-dental.example.com" },
    });
    const linkedin = await seedLinkedInAccount(world.target);
    const emailCampaign = await createCampaign(world, { name: "Dental groups" });
    const linkedinCampaign = await createCampaign(world, {
      name: "LinkedIn warm-up",
      steps: [{ type: "linkedin_visit", delay_days: 3 }],
      settings: { senders: { linkedin_account_ids: [linkedin.id] } },
    });
    await enrollAndLaunch(world, emailCampaign.id, [person.id]);
    await enrollAndLaunch(world, linkedinCampaign.id, [person.id]);

    const first = await firstEmailSent(world, person.id);
    expect(first.campaign_id).toBe(emailCampaign.id);
    const before = await enrollmentsOf(world, person.id);
    expect(before.map((row) => row.status).sort()).toEqual(["active", "active"]);

    world.classifyReply("tell me more", classification("interested"));
    const reply = await receiveReply(
      world,
      first,
      "Thanks Sam, this sounds interesting. Tell me more about how the overflow answering works for a practice our size.",
    );
    expect(reply.kind).toBe("reply");

    // Sorted as interested, with one reply.classified event.
    const inbound = (await messagesOf(world, { personId: person.id, direction: "inbound" }))[0];
    expect(inbound?.classification?.category).toBe("interested");
    const classified = await eventsOf(world, "reply.classified");
    expect(classified).toHaveLength(1);
    expect(classified[0]?.data).toMatchObject({
      message_id: reply.messageId,
      person_id: person.id,
      category: "interested",
    });

    // An opportunity at interested.
    const opps = await world.engine.db
      .select()
      .from(opportunities)
      .where(eq(opportunities.person_id, person.id));
    expect(opps.map((row) => row.stage)).toEqual(["interested"]);
    expect(opps[0]?.company_id).toBe(company.id);

    // Every sequence stopped, on both channels, and nothing else is queued for her.
    const after = await enrollmentsOf(world, person.id);
    expect(after.map((row) => [row.campaign_id, row.status, row.stop_reason]).sort()).toEqual(
      [
        [emailCampaign.id, "stopped", "replied"],
        [linkedinCampaign.id, "stopped", "replied"],
      ].sort(),
    );
    const outbound = await messagesOf(world, { personId: person.id, direction: "outbound" });
    expect(outbound.filter((row) => row.status === "scheduled")).toEqual([]);

    // A reply draft with her tagged booking link, waiting for review.
    const [row] = await world.engine.db.select().from(people).where(eq(people.id, person.id));
    const ref = row?.booking_ref;
    expect(ref).toMatch(/^bk[0-9a-z]{10}$/);
    const drafts = outbound.filter((message) => message.action === "reply");
    expect(drafts).toHaveLength(1);
    const draft = drafts[0];
    expect(draft?.status).toBe("pending_review");
    expect(draft?.thread_id).toBe(reply.threadId);
    expect(draft?.body_text).toContain(`${BOOKING_URL}?utm_content=${ref}&utm_source=openoutbound`);
    const [approval] = await world.engine.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.target_type, "message"), eq(approvals.target_id, draft?.id ?? "")));
    expect(approval).toMatchObject({ kind: "reply", status: "pending" });

    // The operator views: a conversation whose next step is reviewing that draft.
    const lead = await world.call<Any>("leads.get", { person_id: person.id });
    expect(lead.relationship).toMatchObject({
      person_id: person.id,
      state: "in_conversation",
      opportunity_id: opps[0]?.id,
      next_action: { kind: "review", ref: { type: "approval", id: approval?.id } },
    });
    const state = await world.call<Any>("operating.state");
    expect(state.replies.drafts_waiting_review).toBe(1);
    expect(state.approvals_pending.by_kind).toContainEqual({ kind: "reply", count: 1 });
    const explained = await world.call<Any>("operating.explain", { person_id: person.id });
    expect(JSON.stringify(explained)).toContain(approval?.id);
  });
});
