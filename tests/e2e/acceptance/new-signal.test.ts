/**
 * Acceptance scenario 2, new signal. The workspace has a launched campaign fed by a signal
 * automation ("funding round at a dental group: enroll the person"). Early on a Tuesday, before
 * the sending window opens, a funding signal arrives for Omar Haddad. The automation enrolls
 * him, the sequencer writes his first email at once and plans it for the moment his window
 * opens (08:00 on a weekday in his own timezone), get_next_actions lists it as the next thing
 * that happens, his relationship reads in_sequence, and the email goes out inside the window.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { automation_firings, enrollments, type Message } from "../../../src/db/schema/index.js";
import { getSandboxOutbox } from "../../../src/modules/email/sandbox-transport.js";
import {
  type Any,
  createCampaign,
  eventsOf,
  MINUTE,
  messageById,
  messagesOf,
  settle,
  startWorld,
  until,
  type World,
} from "./support.js";

/** Tuesday 2026-09-22, 06:00 in Chicago: two hours before the sending window opens. */
const BEFORE_WINDOW = "2026-09-22T11:00:00.000Z";
/** 08:00 in Chicago the same day: the window opens. */
const WINDOW_OPENS = "2026-09-22T13:00:00.000Z";

let world: World | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

function chicago(date: Date): { weekday: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  return {
    weekday: parts.find((part) => part.type === "weekday")?.value ?? "",
    hour: Number(parts.find((part) => part.type === "hour")?.value),
  };
}

/** The workspace, the automation, the signal and the written first email (see module doc). */
async function signalArrives() {
  const current = await startWorld({ now: BEFORE_WINDOW });
  world = current;
  const { person, company } = await current.lead({
    person: {
      first_name: "Omar",
      last_name: "Haddad",
      full_name: "Omar Haddad",
      email: "omar.haddad@cedar-dental.example.com",
      timezone: "America/Chicago",
    },
    company: { name: "Cedar Dental Group", domain: "cedar-dental.example.com" },
  });
  const campaign = await createCampaign(current, { name: "Funded dental groups" });
  const rule = await current.call<Any>("signals.automations.create", {
    name: "Funding at a dental group",
    filters: { definition_keys: ["funding_round"], has_email: true },
    actions: [{ type: "enroll", campaign_id: campaign.id, max_people: 1 }],
    require_approval: false,
  });
  // The automation is the campaign's lead source, so it launches with nobody enrolled yet.
  const launched = await current.call<Any>("campaigns.launch", { campaign_id: campaign.id });
  expect(launched.status).toBe("active");
  expect(await messagesOf(current, { personId: person.id })).toEqual([]);

  const ingested = await current.call<Any>("signals.ingest", {
    source: "agent_research",
    signals: [
      {
        key: "funding_round",
        company: { domain: "cedar-dental.example.com" },
        person: { email: "omar.haddad@cedar-dental.example.com" },
        title: "Cedar Dental Group raised a growth round to open two clinics",
        evidence_url: "https://news.example.org/cedar-dental-growth-round",
        occurred_at: "2026-09-21T09:00:00Z",
        strength: 1,
      },
    ],
  });
  expect(ingested).toMatchObject({ received: 1, created: 1, companies_created: 0 });
  await settle(current.engine);

  // The first email is written at once and waits for his window.
  let written: Message | undefined;
  await until(
    current.engine,
    "the first email is written",
    async () => {
      const rows = await messagesOf(current, { personId: person.id, direction: "outbound" });
      written = rows.find((row) => row.status === "approved" || row.status === "scheduled");
      return Boolean(written);
    },
    { stepMs: MINUTE, max: 30 },
  );
  if (!written) throw new Error("unreachable");
  return { world: current, person, company, campaign, rule, written };
}

describe("acceptance: new signal", () => {
  it("enrolls the person through the automation and plans the first email inside the window", async () => {
    const { world: current, person, company, campaign, rule, written } = await signalArrives();

    // The automation fired once and enrolled him in the campaign.
    const detected = await eventsOf(current, "signal.detected");
    expect(detected).toHaveLength(1);
    expect(detected[0]?.data).toMatchObject({ company_id: company.id, person_id: person.id });
    const firings = await current.engine.db
      .select()
      .from(automation_firings)
      .where(eq(automation_firings.rule_id, rule.id));
    expect(firings.map((row) => row.status)).toEqual(["fired"]);
    const enrolled = await current.engine.db
      .select()
      .from(enrollments)
      .where(and(eq(enrollments.campaign_id, campaign.id), eq(enrollments.person_id, person.id)));
    expect(enrolled).toHaveLength(1);
    expect(enrolled[0]?.status).toBe("active");

    // Written, checked and approved; planned for the moment his window opens.
    expect(written).toMatchObject({
      channel: "email",
      action: "email",
      campaign_id: campaign.id,
      status: "approved",
    });
    expect(written.check?.passed).toBe(true);
    expect(enrolled[0]?.next_run_at?.toISOString()).toBe(WINDOW_OPENS);
    expect(chicago(new Date(WINDOW_OPENS))).toEqual({ weekday: "Tue", hour: 8 });

    // The operator views: the email is the next thing that happens, and he is in a sequence.
    const next = await current.call<Any>("operating.next_actions", { hours: 24 });
    const item = next.items.find((entry: Any) => entry.ref.id === written.id);
    expect(item).toMatchObject({
      at: WINDOW_OPENS,
      kind: "send_message",
      channel: "email",
      person_id: person.id,
      campaign_id: campaign.id,
      overdue: false,
    });
    const lead = await current.call<Any>("leads.get", { person_id: person.id });
    expect(lead.relationship).toMatchObject({
      state: "in_sequence",
      next_action: { kind: "send_message", ref: { type: "message", id: written.id } },
      stuck: false,
    });
    expect(lead.signals.map((signal: Any) => signal.definition_key)).toContain("funding_round");

    // When the window opens the email goes out, never before 08:00 his time.
    expect(getSandboxOutbox({ workspaceId: current.workspaceId })).toHaveLength(0);
    await until(current.engine, "the first email is sent", async () => {
      return (await messageById(current, written.id)).status === "sent";
    });
    const sent = await messageById(current, written.id);
    const sentAt = sent.sent_at ?? new Date(0);
    expect(sentAt.getTime()).toBeGreaterThanOrEqual(Date.parse(WINDOW_OPENS));
    expect(chicago(sentAt).weekday).toBe("Tue");
    expect(chicago(sentAt).hour).toBeGreaterThanOrEqual(8);
    expect(chicago(sentAt).hour).toBeLessThan(17);
    expect(getSandboxOutbox({ workspaceId: current.workspaceId })).toHaveLength(1);
  });

  it("shows the planned email as not blocked", async () => {
    const { world: current, person, written } = await signalArrives();
    const next = await current.call<Any>("operating.next_actions", { hours: 24 });
    const item = next.items.find((entry: Any) => entry.ref.id === written.id);
    expect(item?.blocked).toBe(false);
    expect(next.blocked).toEqual([]);
    const lead = await current.call<Any>("leads.get", { person_id: person.id });
    expect(lead.relationship.blockers).toEqual([]);
  });
});
