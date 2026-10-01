/**
 * Scenario: the CRM door. Northwind's HubSpot is not connected to the engine: the agent is the
 * bridge (crm.mode agent), following the client's CRM preferences on the strategy page. Since
 * the last sync one prospect replied with interest, and HubSpot shows that another account
 * (with a person in an active campaign) closed won yesterday. The agent must read the CRM
 * preferences, read what is new with the event feed as the `crm` consumer, report the ids of
 * the records it created in HubSpot with manage_crm action link, acknowledge the feed cursor,
 * and push the customer fact with manage_crm action record_facts, which stops outreach to that
 * account at once.
 */
import { and, eq } from "drizzle-orm";
import {
  companies,
  crm_links,
  enrollments,
  event_consumers,
  mailboxes,
  messages,
  offers,
  threads,
} from "../../src/db/schema/index.js";
import { ingestInboundEmail } from "../../src/modules/email/inbound/ingest.js";
import { callsOf, describeCalls, mentionsAny, outcome } from "../harness/checks.js";
import { check, defineScenario } from "../harness/types.js";
import { clearActivity, contactablePeople } from "./support.js";

const HOUR = 3_600_000;
/** Events show up in the feed about 2 seconds after they happened. */
const FEED_SETTLE_WAIT_MS = 2_500;

const CRM_NOTES =
  "HubSpot is our CRM. Add a person (and their company) once they reply with interest, log meetings as notes, and link the HubSpot ids back to OpenOutbound so nothing is created twice.";

interface CrmData {
  person_id: string;
  person_name: string;
  company_id: string;
  customer_company_id: string;
  customer_name: string;
  customer_domain: string;
  customer_person_id: string;
  /** HubSpot's answers for this run. */
  contact_crm_id: string;
  company_crm_id: string;
  customer_crm_id: string;
}

export const crmDoor = defineScenario<CrmData>({
  id: "crm-door",
  title: "Keep an outside CRM in sync through the event feed",
  prompt: (data) =>
    [
      "You keep Northwind's HubSpot in sync with OpenOutbound. HubSpot is not connected to OpenOutbound: you are the bridge, using your own HubSpot access. Follow the client's CRM preferences, process everything new for the CRM since the last sync, and do not process it twice next time.",
      `HubSpot answers for this run: a contact you add gets the id ${data.contact_crm_id} and a company you add gets the id ${data.company_crm_id}. HubSpot also shows that ${data.customer_name} (${data.customer_domain}, HubSpot company ${data.customer_crm_id}) closed won yesterday: they are a customer now, and OpenOutbound does not know yet.`,
      "When you are done, tell me what you synced and what changed.",
    ].join("\n\n"),
  toolsets: "core",
  maxTurns: 20,
  rubric: [
    "Reads the CRM preferences first (manage_strategy action get, crm section: mode agent and the notes).",
    "Reads the event feed with consumer crm and finds the interested reply.",
    "Links the HubSpot ids of the new contact and company with manage_crm action link (provider hubspot).",
    "Acknowledges the feed with event_feed action ack (consumer crm, the cursor it read up to).",
    "Records the customer fact with manage_crm action record_facts (fact customer, the domain), which stops outreach to that account.",
    "Summary names the synced person, the ids and the new customer.",
  ],
  async setup(api) {
    const { workspaces: seeded } = await api.seedSandbox();
    const workspaceId = seeded.northwind as string;
    await clearActivity(api.db, workspaceId);
    await api.call(
      "workspaces.update",
      {
        settings: {
          crm: { mode: "agent", sync_from: "interested", log: "key_moments", notes: CRM_NOTES },
        },
      },
      { workspace: workspaceId },
    );
    const [mailbox] = await api.db
      .select()
      .from(mailboxes)
      .where(and(eq(mailboxes.workspace_id, workspaceId), eq(mailboxes.status, "active")))
      .limit(1);
    const [offer] = await api.db
      .select({ id: offers.id })
      .from(offers)
      .where(eq(offers.workspace_id, workspaceId))
      .limit(1);
    const pool = await contactablePeople(api.db, workspaceId, 20);
    const lead = pool[0];
    const customer = pool.find((person) => person.company_id !== lead?.company_id);
    if (!mailbox || !offer || !lead?.email || !lead.company_id || !customer?.company_id) {
      throw new Error("crm-door setup: sandbox mailbox, offer or people missing");
    }
    const [account] = await api.db
      .select()
      .from(companies)
      .where(eq(companies.id, customer.company_id));
    if (!account?.domain) throw new Error("crm-door setup: the customer company has no domain");

    // Someone at the future customer is in an active campaign.
    const campaign = await api.call<{ id: string }>(
      "campaigns.create",
      {
        name: "Q4 reorder check",
        offer_id: offer.id,
        steps: [
          { type: "email", config: { style: "free", instruction: "Offer the reorder check." } },
          { type: "email", delay_days: 4, config: { mode: "reply", style: "free" } },
        ],
        settings: { senders: { mailbox_ids: [mailbox.id] } },
      },
      { workspace: workspaceId },
    );
    await api.call(
      "campaigns.enroll",
      { campaign_id: campaign.id, person_ids: [customer.id] },
      { workspace: workspaceId },
    );
    await api.call("campaigns.launch", { campaign_id: campaign.id }, { workspace: workspaceId });

    // The lead answered the first email with interest.
    const now = Date.now();
    const subject = "reorder timing before peak season";
    const messageIdHeader = "<eval-crm-1@northwindanalytics.example.com>";
    const [thread] = await api.db
      .insert(threads)
      .values({
        workspace_id: workspaceId,
        person_id: lead.id,
        company_id: lead.company_id,
        channel: "email",
        subject,
        mailbox_id: mailbox.id,
        external_ref: messageIdHeader,
        status: "waiting",
        last_message_at: new Date(now - 30 * HOUR),
      })
      .returning({ id: threads.id });
    if (!thread) throw new Error("crm-door setup: thread insert failed");
    await api.db.insert(messages).values({
      workspace_id: workspaceId,
      thread_id: thread.id,
      person_id: lead.id,
      company_id: lead.company_id,
      channel: "email",
      action: "email",
      direction: "outbound",
      status: "sent",
      subject,
      body_text:
        "Hi, operations teams usually find stock problems after they cost sales. Worth a short look at where your gaps are?",
      from_address: mailbox.email,
      to_address: lead.email,
      mailbox_id: mailbox.id,
      sent_at: new Date(now - 30 * HOUR),
      message_id_header: messageIdHeader,
    });
    await ingestInboundEmail(await api.context(workspaceId), {
      mailboxId: mailbox.id,
      from: lead.email,
      to: [mailbox.email],
      subject: `Re: ${subject}`,
      text: "Sounds good, tell me more about how the forecast works for our warehouse.",
      headers: {},
      messageIdHeader: "<eval-crm-reply-1@prospect.example.com>",
      inReplyTo: messageIdHeader,
      references: [messageIdHeader],
      receivedAt: new Date(now - 3 * HOUR),
    });
    await api.runJobs();
    await new Promise((resolve) => setTimeout(resolve, FEED_SETTLE_WAIT_MS));
    return {
      workspace: workspaceId,
      data: {
        person_id: lead.id,
        person_name: lead.full_name ?? lead.email,
        company_id: lead.company_id,
        customer_company_id: account.id,
        customer_name: account.name,
        customer_domain: account.domain,
        customer_person_id: customer.id,
        contact_crm_id: "51000123",
        company_crm_id: "7300000456",
        customer_crm_id: "7300000999",
      },
    };
  },
  async script(agent) {
    const { data } = agent;
    const strategy = await agent.ok("manage_strategy", { action: "get" });
    if (strategy.crm?.mode !== "agent")
      throw new Error("the client does not ask the agent to sync");
    const feed = await agent.ok("event_feed", { action: "list", consumer: "crm", limit: 200 });
    const interested = (
      feed.items as Array<{ type: string; data: { category?: string; person_id?: string } }>
    ).find((item) => item.type === "reply.classified" && item.data.category === "interested");
    if (!interested?.data.person_id) throw new Error("no interested reply in the feed");
    const lead = await agent.ok("get_lead", {
      action: "person",
      person_id: interested.data.person_id,
    });
    const companyId = lead.person?.company_id ?? lead.company?.id;
    await agent.ok("manage_crm", {
      action: "link",
      provider: "hubspot",
      entity_type: "person",
      entity_id: interested.data.person_id,
      external_id: data.contact_crm_id,
    });
    await agent.ok("manage_crm", {
      action: "link",
      provider: "hubspot",
      entity_type: "company",
      entity_id: companyId,
      external_id: data.company_crm_id,
    });
    await agent.ok("event_feed", { action: "ack", consumer: "crm", cursor: feed.next_cursor });
    const recorded = await agent.ok("manage_crm", {
      action: "record_facts",
      crm: "hubspot",
      facts: [
        {
          fact: "customer",
          domain: data.customer_domain,
          external_id: data.customer_crm_id,
          note: "Closed won in HubSpot yesterday",
        },
      ],
      reason: "HubSpot shows the account closed won",
    });
    const effects = (recorded.results as Array<{ effects?: string[] }> | undefined)
      ?.flatMap((result) => result.effects ?? [])
      .join("; ");
    return [
      `Synced HubSpot following the client's CRM preferences (${strategy.crm.mode} mode: add people once they reply with interest, log meetings as notes).`,
      `- ${lead.person?.full_name ?? "A lead"} (${lead.company?.name ?? "their company"}) replied with interest: added to HubSpot and linked back, contact ${data.contact_crm_id} and company ${data.company_crm_id}.`,
      `- Read ${feed.items.length} new events as the crm consumer and acknowledged them, so the next sync starts after them.`,
      `- ${data.customer_name} is now a customer in OpenOutbound (HubSpot company ${data.customer_crm_id}): ${effects || "outreach to the account stopped"}.`,
    ].join("\n");
  },
  assertions: [
    check("read the CRM preferences before syncing", ({ calls }) => {
      const read = calls.find((call) => ["strategy.get", "crm.status"].includes(call.operation));
      const firstWrite = calls.find((call) => ["crm.link", "crm.facts"].includes(call.operation));
      return outcome(
        Boolean(read && (!firstWrite || read.seq < firstWrite.seq)),
        `strategy or crm status read: ${read ? `#${read.seq}` : "never"}; first CRM write ${firstWrite ? `#${firstWrite.seq}` : "none"}`,
      );
    }),
    check("read the event feed as the crm consumer", ({ calls }) => {
      const reads = callsOf(
        calls,
        "events.list",
        (call) => call.input.consumer === "crm" && call.outcome === "ok",
      );
      return outcome(
        reads.length > 0,
        `feed reads: ${describeCalls(callsOf(calls, "events.list"))}`,
      );
    }),
    check(
      "linked the HubSpot ids of the new contact and company",
      async ({ db, workspaceId, data }) => {
        const rows = await db
          .select()
          .from(crm_links)
          .where(and(eq(crm_links.workspace_id, workspaceId), eq(crm_links.provider, "hubspot")));
        const person = rows.find(
          (row) => row.entity_type === "person" && row.entity_id === data.person_id,
        );
        const company = rows.find(
          (row) => row.entity_type === "company" && row.entity_id === data.company_id,
        );
        return outcome(
          person?.external_id === data.contact_crm_id &&
            company?.external_id === data.company_crm_id,
          `links: ${rows.map((row) => `${row.entity_type} ${row.entity_id} -> ${row.external_id}`).join(", ") || "none"}`,
        );
      },
    ),
    check("acknowledged the feed after reading it", async ({ db, workspaceId, calls }) => {
      const [consumer] = await db
        .select()
        .from(event_consumers)
        .where(and(eq(event_consumers.workspace_id, workspaceId), eq(event_consumers.name, "crm")));
      const read = callsOf(calls, "events.list", (call) => call.input.consumer === "crm")[0];
      const ack = callsOf(
        calls,
        "events.ack",
        (call) => call.input.consumer === "crm" && call.outcome === "ok",
      )[0];
      return outcome(
        Boolean(consumer?.cursor && consumer.acknowledged_at && read && ack && read.seq < ack.seq),
        `consumer cursor ${consumer?.cursor ? "set" : "missing"}; ack calls: ${describeCalls(callsOf(calls, "events.ack"))}`,
      );
    }),
    check(
      "the customer fact stopped outreach to the account",
      async ({ db, workspaceId, data }) => {
        const [account] = await db
          .select({ status: companies.status })
          .from(companies)
          .where(eq(companies.id, data.customer_company_id));
        const rows = await db
          .select({ status: enrollments.status, stop_reason: enrollments.stop_reason })
          .from(enrollments)
          .where(
            and(
              eq(enrollments.workspace_id, workspaceId),
              eq(enrollments.person_id, data.customer_person_id),
            ),
          );
        const stopped =
          rows.length > 0 &&
          rows.every((row) => row.status === "stopped" && row.stop_reason === "crm_customer");
        return outcome(
          account?.status === "customer" && stopped,
          `company status ${account?.status}; enrollments ${rows.map((row) => `${row.status}/${row.stop_reason}`).join(", ") || "none"}`,
        );
      },
    ),
    check("summary names the sync and the new customer", ({ finalText, data }) =>
      outcome(
        mentionsAny(finalText, [data.contact_crm_id, data.company_crm_id]) &&
          mentionsAny(finalText, [data.customer_name, data.customer_domain]) &&
          mentionsAny(finalText, ["customer"]),
        "expected the linked ids and the new customer in the summary",
      ),
    ),
  ],
});
