/**
 * Acceptance scenario 9, CRM closed won. Two people at Maple Street Dental (Ines Duarte and
 * Victor Chen) are in an email sequence, next to Rosa Blanco at another practice. The deal is
 * won in HubSpot, and the agent reading the CRM tells the engine with manage_crm action
 * record_facts: Maple Street Dental is a customer. Every enrollment at the company stops at once
 * (reason crm_customer) while Rosa's goes on, enrolling anyone there again is refused, the
 * operator views (explain_blocker, get_lead) name the customer fact, the company file shows it
 * with source crm, and crm.fact_recorded fires once. Repeating the fact changes nothing.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { companies } from "../../../src/db/schema/index.js";
import {
  type Any,
  advance,
  createCampaign,
  DAY,
  enrollAndLaunch,
  enrollmentsOf,
  eventsOf,
  firstEmailSent,
  messagesOf,
  startWorld,
  until,
  type World,
} from "./support.js";

let world: World;
afterAll(async () => {
  await world?.close();
});

describe("acceptance: CRM closed won", () => {
  it("stops the whole account, refuses new enrollments and files the fact", async () => {
    world = await startWorld();
    const maple = { name: "Maple Street Dental", domain: "maple-dental.example.com" };
    const { person: ines, company } = await world.lead({
      person: {
        first_name: "Ines",
        last_name: "Duarte",
        full_name: "Ines Duarte",
        email: "ines.duarte@maple-dental.example.com",
      },
      company: maple,
    });
    const victor = await world.lead({
      person: {
        first_name: "Victor",
        last_name: "Chen",
        full_name: "Victor Chen",
        email: "victor.chen@maple-dental.example.com",
        company_id: company.id,
      },
    });
    const colleague = await world.lead({
      person: {
        first_name: "June",
        last_name: "Park",
        full_name: "June Park",
        email: "june.park@maple-dental.example.com",
        company_id: company.id,
      },
    });
    const { person: rosa } = await world.lead({
      person: {
        first_name: "Rosa",
        last_name: "Blanco",
        full_name: "Rosa Blanco",
        email: "rosa.blanco@birch-dental.example.com",
      },
      company: { name: "Birch Dental", domain: "birch-dental.example.com" },
    });
    const campaign = await createCampaign(world, { name: "Dental practices" });
    await enrollAndLaunch(world, campaign.id, [ines.id, victor.person.id, rosa.id]);
    for (const person of [ines, victor.person, rosa]) await firstEmailSent(world, person.id);

    // The deal is won in HubSpot: the agent records the fact.
    const recorded = await world.call<Any>("crm.facts", {
      crm: "hubspot",
      facts: [
        {
          fact: "customer",
          domain: "maple-dental.example.com",
          external_id: "7300000001",
          note: "Closed won, annual plan",
        },
      ],
    });
    expect(recorded.summary).toMatchObject({ facts: 1, changed: 1, unmatched: 0, errors: 0 });
    expect(recorded.results[0]).toMatchObject({
      fact: "customer",
      company_id: company.id,
      changed: true,
      error: null,
    });
    expect(recorded.results[0].effects).toContain("stopped 2 enrollments (crm_customer)");

    // The company is a customer; both enrollments there stopped, Rosa's goes on.
    const [row] = await world.engine.db
      .select()
      .from(companies)
      .where(and(eq(companies.workspace_id, world.workspaceId), eq(companies.id, company.id)));
    expect(row?.status).toBe("customer");
    for (const person of [ines, victor.person]) {
      expect(await enrollmentsOf(world, person.id)).toMatchObject([
        { status: "stopped", stop_reason: "crm_customer" },
      ]);
    }
    expect(await enrollmentsOf(world, rosa.id)).toMatchObject([{ status: "active" }]);

    // crm.fact_recorded fires once.
    const factEvents = await eventsOf(world, "crm.fact_recorded");
    expect(factEvents).toHaveLength(1);
    expect(factEvents[0]?.data).toMatchObject({ fact: "customer", company_id: company.id });

    // The company file shows the fact with source crm.
    const file = await world.call<Any>("companies.get", { company_id: company.id });
    expect(file.facts).toContainEqual(
      expect.objectContaining({
        scope: "company",
        source: "crm",
        source_ref: "hubspot",
        status: "active",
        text: "Customer in HubSpot. Closed won, annual plan",
      }),
    );

    // Enrolling anyone at the company again is refused.
    const again = await world.call<Any>("campaigns.enroll", {
      campaign_id: campaign.id,
      person_ids: [colleague.person.id],
    });
    expect(again.enrolled).toBe(0);
    expect(again.skipped_people).toEqual([
      expect.objectContaining({
        person_id: colleague.person.id,
        reasons: ["not_contactable:company_customer"],
      }),
    ]);
    const other = await createCampaign(world, { name: "Second touch" });
    const retry = await world.call<Any>("campaigns.enroll", {
      campaign_id: other.id,
      person_ids: [ines.id],
    });
    expect(retry.enrolled).toBe(0);

    // explain_blocker names the customer fact, for the colleague and for Ines.
    for (const person of [colleague.person, ines]) {
      const explained = await world.call<Any>("operating.explain", { person_id: person.id });
      expect(explained.blocked).toBe(true);
      expect(explained.blockers).toEqual([
        expect.objectContaining({
          code: "company_customer",
          message: "Maple Street Dental is a customer, so there is no cold outreach.",
          hard: true,
        }),
      ]);
      expect(explained.summary).toContain("Maple Street Dental is a customer");
      const lead = await world.call<Any>("leads.get", { person_id: person.id });
      expect(lead.relationship.blockers.map((item: Any) => item.code)).toEqual([
        "company_customer",
      ]);
      expect(lead.relationship.next_action).toBeNull();
    }

    // Three days later Rosa's second email goes out; nothing more is written for the account.
    await advance(world.engine, 3 * DAY);
    await until(world.engine, "Rosa's second email is sent", async () => {
      const rows = await messagesOf(world, { personId: rosa.id, direction: "outbound" });
      return rows.filter((message) => message.status === "sent").length === 2;
    });
    for (const person of [ines, victor.person, colleague.person]) {
      const rows = await messagesOf(world, { personId: person.id, direction: "outbound" });
      expect(rows.map((message) => message.status)).toEqual(
        person === colleague.person ? [] : ["sent"],
      );
    }

    // Repeating the fact changes nothing and fires nothing.
    const repeated = await world.call<Any>("crm.facts", {
      crm: "hubspot",
      facts: [
        {
          fact: "customer",
          domain: "maple-dental.example.com",
          external_id: "7300000001",
          note: "Closed won, annual plan",
        },
      ],
    });
    expect(repeated.summary).toMatchObject({ facts: 1, changed: 0, unchanged: 1 });
    expect(await eventsOf(world, "crm.fact_recorded")).toHaveLength(1);
  });
});
