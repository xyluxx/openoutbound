/**
 * Acceptance scenario 11, privacy request. Lena Fischer is in two sequences (one sent her a first
 * email, the other has an email waiting for review); the agent added her LinkedIn profile and
 * linked her HubSpot contact. She answers: delete all the data you hold about me. The engine
 * recognizes the request from its wording alone, suppresses her everywhere, stops every
 * sequence, cancels the waiting email and its review, never answers her itself, and opens an
 * urgent problem for a person with the deadline (received plus 30 days), where her data came
 * from and a suggested reply; the team is notified. With seven days left the daily reminder
 * fires once. manage_leads action forget runs with a dry run first (nothing changes), then for
 * real: her facts are gone, her address and profile are redacted in every stored copy (events,
 * audit entries), lead.forgotten carries no readable email, only hashed blocks remain, and
 * crm.on_forget (task) opens a crm_forget problem to delete the HubSpot contact.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  approvals,
  audit_events,
  events,
  lead_facts,
  people,
  suppressions,
} from "../../../src/db/schema/index.js";
import { getSandboxOutbox } from "../../../src/modules/email/sandbox-transport.js";
import {
  type Any,
  advance,
  alertsChannel,
  createCampaign,
  DAY,
  enrollAndLaunch,
  enrollmentsOf,
  eventsOf,
  firstEmailSent,
  messageById,
  messagesOf,
  problemsOf,
  receiveReply,
  startWorld,
  until,
  type World,
} from "./support.js";

let world: World;
afterAll(async () => {
  await world?.close();
});

const EMAIL = "lena.fischer@northgate-dental.example.com";
const LINKEDIN = "https://www.linkedin.com/in/lena-fischer-example";

/** Stored events of the workspace whose data holds this text. */
async function eventCopies(text: string): Promise<number> {
  const rows = await world.engine.db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.workspace_id, world.workspaceId),
        sql`${events.data}::text like ${`%${text}%`}`,
      ),
    );
  return rows.length;
}

/** Audit entries of the workspace whose input holds this text. */
async function auditCopies(text: string): Promise<number> {
  const rows = await world.engine.db
    .select({ id: audit_events.id })
    .from(audit_events)
    .where(
      and(
        eq(audit_events.workspace_id, world.workspaceId),
        sql`${audit_events.input}::text like ${`%${text}%`}`,
      ),
    );
  return rows.length;
}

describe("acceptance: privacy request", () => {
  it("stops everything, asks a person to answer in time, then forgets her", async () => {
    world = await startWorld({
      settings: {
        compliance: { one_active_campaign_per_person: false },
        crm: { on_forget: "task" },
      },
    });
    const alerts = await alertsChannel(world);
    const { person, company } = await world.lead({
      person: {
        first_name: "Lena",
        last_name: "Fischer",
        full_name: "Lena Fischer",
        email: EMAIL,
        source: "apollo",
        created_at: new Date("2026-09-15T14:00:00.000Z"),
      },
      company: { name: "Northgate Dental", domain: "northgate-dental.example.com" },
    });
    // The agent adds her LinkedIn profile, a preference and her HubSpot contact id.
    await world.call("leads.update", { person_id: person.id, linkedin_url: LINKEDIN });
    await world.call("leads.add_fact", {
      kind: "preference",
      text: "Prefers email over phone calls",
      person_id: person.id,
    });
    await world.call("crm.link", {
      provider: "hubspot",
      entity_type: "person",
      entity_id: person.id,
      external_id: "51000001",
    });
    const outreach = await createCampaign(world, { name: "Dental groups" });
    const reviewed = await createCampaign(world, {
      name: "Reviewed follow-up",
      steps: [{ type: "email", config: { style: "free" } }],
      settings: { review_level: "every" },
    });
    await enrollAndLaunch(world, outreach.id, [person.id]);
    await enrollAndLaunch(world, reviewed.id, [person.id]);
    const first = await firstEmailSent(world, person.id);
    let waiting: Any;
    await until(world.engine, "the reviewed email waits for review", async () => {
      const rows = await messagesOf(world, { personId: person.id, direction: "outbound" });
      waiting = rows.find(
        (row) => row.campaign_id === reviewed.id && row.status === "pending_review",
      );
      return Boolean(waiting);
    });

    // She asks to delete everything held about her.
    const reply = await receiveReply(
      world,
      first,
      "Please delete all the data you hold about me and do not contact me again.",
    );
    const inbound = await messageById(world, reply.messageId ?? "");
    const receivedAt = inbound.received_at ?? new Date(0);
    expect(inbound.classification?.category).toBe("privacy_request");

    // Suppressed everywhere, do not contact, every sequence stopped.
    const blocks = await world.engine.db
      .select()
      .from(suppressions)
      .where(eq(suppressions.workspace_id, world.workspaceId));
    expect(blocks.map((row) => [row.type, row.value]).sort()).toEqual(
      [
        ["email", EMAIL],
        ["linkedin", LINKEDIN],
        ["person", person.id],
      ].sort(),
    );
    const [lena] = await world.engine.db.select().from(people).where(eq(people.id, person.id));
    expect(lena?.status).toBe("do_not_contact");
    expect(
      (await enrollmentsOf(world, person.id)).map((row) => [row.status, row.stop_reason]),
    ).toEqual([
      ["stopped", "privacy_request"],
      ["stopped", "privacy_request"],
    ]);

    // The waiting email and its review are cancelled; the engine answers nothing.
    expect(await messageById(world, waiting.id)).toMatchObject({
      status: "cancelled",
      error: expect.stringContaining("privacy_request"),
    });
    const [review] = await world.engine.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.target_type, "message"), eq(approvals.target_id, waiting.id)));
    expect(review?.status).toBe("cancelled");
    const outbound = await messagesOf(world, { personId: person.id, direction: "outbound" });
    expect(outbound.filter((row) => row.action === "reply")).toEqual([]);
    expect(outbound.filter((row) => row.status === "sent").map((row) => row.id)).toEqual([
      first.id,
    ]);
    expect(getSandboxOutbox({ workspaceId: world.workspaceId })).toHaveLength(1);

    // An urgent problem for a person: deadline, data source, suggested reply, next step.
    const [problem] = await problemsOf(world, "privacy_request");
    const due = new Date(receivedAt.getTime() + 30 * DAY);
    expect(problem).toMatchObject({
      status: "open",
      severity: "urgent",
      owner: "person",
      person_id: person.id,
      company_id: company.id,
      title: "Privacy request from Lena Fischer (Northgate Dental): delete their data",
      reason:
        "Lena Fischer asked to delete their data on 22 Sep 2026. Answer by 22 Oct 2026. Source of their data: Apollo, a business contact database, on 15 Sep 2026.",
      remedy: `Reply to them yourself (suggested text below), then run manage_leads action forget with person_id ${person.id}, first with dry_run true; the forget resolves this problem. The CRM step follows crm.on_forget.\n\nSuggested reply: Hi Lena, understood. I am deleting your details now and you will not hear from us again.`,
    });
    expect(problem?.due_at?.toISOString()).toBe(due.toISOString());
    const requested = await eventsOf(world, "privacy.requested");
    expect(requested).toHaveLength(1);
    expect(requested[0]?.data).toMatchObject({
      person_id: person.id,
      kind: "delete",
      due_at: due.toISOString(),
    });
    const state = await world.call<Any>("operating.state");
    expect(state.problems.by_severity.urgent).toBe(1);
    expect(state.problems.top[0]).toMatchObject({ id: problem?.id, kind: "privacy_request" });
    const notified = alerts.filter((alert) => alert.title.startsWith("Privacy request from"));
    expect(notified).toEqual([
      expect.objectContaining({
        title: "Privacy request from Lena Fischer (Northgate Dental): delete their data",
        severity: "critical",
        event: "privacy.requested",
      }),
    ]);

    // With seven days left the daily reminder fires, once.
    await advance(world.engine, 20 * DAY);
    const reminders = () => alerts.filter((alert) => alert.title.endsWith("days left)"));
    expect(reminders()).toEqual([]);
    await until(world.engine, "the reminder fires", async () => reminders().length > 0, {
      stepMs: DAY,
      max: 8,
    });
    expect(reminders()).toEqual([
      expect.objectContaining({
        title:
          "Privacy request from Lena Fischer (Northgate Dental): delete their data (7 days left)",
        severity: "warning",
      }),
    ]);
    expect(due.getTime() - world.engine.clock.now().getTime()).toBeLessThanOrEqual(7 * DAY);
    await advance(world.engine, DAY);
    expect(reminders()).toHaveLength(1);

    // Her profile URL sits in a stored copy: the audit entry of the update that added it.
    expect(await auditCopies(LINKEDIN)).toBeGreaterThan(0);

    // forget, first as a dry run: it says what would go and changes nothing.
    const preview = await world.call<Any>(
      "leads.forget",
      { person_id: person.id },
      { dryRun: true },
    );
    expect(preview).toMatchObject({ dry_run: true });
    expect(preview.preview).toMatchObject({ person_id: person.id, facts_deleted: 1 });
    expect(preview.preview.redacted.audit_entries).toBeGreaterThan(0);
    expect(
      await world.engine.db.select().from(people).where(eq(people.id, person.id)),
    ).toHaveLength(1);
    expect(
      await world.engine.db.select().from(lead_facts).where(eq(lead_facts.person_id, person.id)),
    ).toHaveLength(1);
    expect(await auditCopies(LINKEDIN)).toBeGreaterThan(0);
    expect(await eventsOf(world, "lead.forgotten")).toEqual([]);

    // Then for real.
    const forgotten = await world.call<Any>("leads.forget", { person_id: person.id });
    expect(forgotten).toMatchObject({
      person_id: person.id,
      person_deleted: true,
      facts_deleted: 1,
      crm_links: [{ provider: "hubspot", entity_type: "person", external_id: "51000001" }],
    });
    expect(forgotten.redacted.audit_entries).toBeGreaterThan(0);
    expect(forgotten.problems_resolved).toBeGreaterThanOrEqual(1);
    await advance(world.engine, 60_000);

    // Her record and facts are gone; no stored event or audit entry holds her address or profile.
    expect(await world.engine.db.select().from(people).where(eq(people.id, person.id))).toEqual([]);
    expect(
      await world.engine.db.select().from(lead_facts).where(eq(lead_facts.person_id, person.id)),
    ).toEqual([]);
    for (const value of [EMAIL, LINKEDIN]) {
      expect(await eventCopies(value)).toBe(0);
      expect(await auditCopies(value)).toBe(0);
    }
    const gone = await eventsOf(world, "lead.forgotten");
    expect(gone).toHaveLength(1);
    const goneText = JSON.stringify(gone[0]?.data);
    expect(goneText).not.toContain(EMAIL);
    expect(goneText).not.toContain("lena.fischer");
    expect(goneText).not.toContain(LINKEDIN);

    // Only hashed blocks remain, and they still stop her address.
    const hashed = await world.engine.db
      .select()
      .from(suppressions)
      .where(eq(suppressions.workspace_id, world.workspaceId));
    expect(hashed.length).toBeGreaterThan(0);
    expect(hashed.every((row) => row.value.startsWith("sha256:"))).toBe(true);
    const check = await world.call<Any>("suppressions.check", { email: EMAIL });
    expect(check.suppressed).toBe(true);

    // The privacy problem is closed, and crm.on_forget (task) asks a person to delete the contact.
    const [closed] = await problemsOf(world, "privacy_request");
    expect(closed?.status).toBe("resolved");
    const crmTasks = await problemsOf(world, "crm_forget");
    expect(crmTasks).toEqual([
      expect.objectContaining({
        status: "open",
        owner: "person",
        title: "Delete a forgotten contact in HubSpot",
        dedupe_key: "crm_forget:hubspot:person:51000001",
      }),
    ]);
    expect(JSON.stringify(crmTasks[0])).not.toContain(EMAIL);
  });
});
