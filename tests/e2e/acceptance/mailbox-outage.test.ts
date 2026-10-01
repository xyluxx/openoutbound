/**
 * Acceptance scenario 10, a mailbox outage. The client's campaign sends from two mailboxes,
 * Alex's and Sam's. Alex's password was changed at the provider, so his mailbox's next login is
 * refused (SMTP 535). The mailbox moves to `error` and stops sending; the emails that were
 * planned on it move to Sam's mailbox (the existing rule for new threads), and new people are
 * planned on Sam's mailbox only. Nobody gets an email twice. Once the owner stores the new
 * password and tests the mailbox it is active again, and sending from it resumes. The
 * `mailbox_down` problem for the outage (opened and resolved by the sender) has its own test.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mailboxes } from "../../../src/db/schema/index.js";
import { fakeImap, resetFakeImap } from "../../../src/testing/fake-imap.js";
import {
  addSmtpMailbox,
  MAIL_PASSWORD,
  type MailServer,
  mailFolders,
  startMailServer,
} from "./mail-server.js";
import {
  type Any,
  createCampaign,
  eventsOf,
  type Lead,
  MINUTE,
  messagesOf,
  problemsOf,
  startWorld,
  until,
  type World,
} from "./support.js";

vi.mock("imapflow", async () =>
  (await import("../../../src/testing/fake-imap.js")).fakeImapModule(),
);

let server: MailServer | undefined;
let world: World | undefined;
beforeAll(() => {
  resetFakeImap();
  fakeImap.folders = mailFolders();
});
afterEach(async () => {
  await world?.close();
  await server?.close();
  world = undefined;
  server = undefined;
});

const ALEX = "alex@brightline-answering.example.org";
const SAM = "sam@brightline-answering.example.org";

const PEOPLE = [
  ["Ruth", "Olsen", "lakeshore"],
  ["Kofi", "Mensah", "summit"],
  ["Lucia", "Romero", "pinecrest"],
  ["Henrik", "Dahl", "fjord"],
  ["Amara", "Obi", "meadow"],
  ["Jonas", "Weber", "linden"],
  ["Mei", "Chen", "harborview"],
  ["Tariq", "Nasser", "willow"],
] as const;

async function addLeads(current: World, from: number, to: number): Promise<Lead[]> {
  const leads: Lead[] = [];
  for (const [first, last, slug] of PEOPLE.slice(from, to)) {
    const name = slug.charAt(0).toUpperCase() + slug.slice(1);
    leads.push(
      await current.lead({
        person: {
          first_name: first,
          last_name: last,
          full_name: `${first} ${last}`,
          email: `${first.toLowerCase()}.${last.toLowerCase()}@${slug}-dental.example.com`,
        },
        company: { name: `${name} Dental`, domain: `${slug}-dental.example.com` },
      }),
    );
  }
  return leads;
}

async function mailboxRow(current: World, id: string) {
  const [row] = await current.engine.db
    .select()
    .from(mailboxes)
    .where(and(eq(mailboxes.workspace_id, current.workspaceId), eq(mailboxes.id, id)));
  return row;
}

async function firstEmails(current: World, leads: Lead[]) {
  const rows = await Promise.all(
    leads.map((lead) => messagesOf(current, { personId: lead.person.id, direction: "outbound" })),
  );
  return rows.flat().filter((row) => row.action === "email");
}

/**
 * A world where the campaign's first emails are planned on both mailboxes and Alex's stored
 * password no longer works; returns once every first email went out, with every mailbox each
 * email was planned on along the way.
 */
async function outage() {
  server = await startMailServer();
  const current = await startWorld();
  world = current;
  const alex = await addSmtpMailbox(current, server, {
    email: ALEX,
    fromName: "Alex Rivera",
    password: "password-before-the-change",
  });
  const sam = await addSmtpMailbox(current, server, { email: SAM, fromName: "Sam Ortiz" });
  const first = await addLeads(current, 0, 4);
  const campaign = await createCampaign(current, {
    name: "Lakeshore practices",
    settings: {
      senders: { mailbox_ids: [alex.id, sam.id] },
      // The window opens at 11:00, an hour from now: the first emails are written before.
      schedule: { timezone_mode: "fixed", timezone: "America/Chicago", start_hour: 11 },
    },
  });
  await current.call("campaigns.enroll", {
    campaign_id: campaign.id,
    person_ids: first.map((lead) => lead.person.id),
  });
  await current.call("campaigns.launch", { campaign_id: campaign.id });
  await until(
    current.engine,
    "the first emails are written and approved",
    async () => {
      const rows = await firstEmails(current, first);
      return rows.length === first.length && rows.every((row) => row.status === "approved");
    },
    { stepMs: MINUTE, max: 30 },
  );

  // From 11:00 each email gets its mailbox shortly before it goes out: note every one seen.
  const seenOn = new Map<string, Set<string>>();
  await until(
    current.engine,
    "every first email is sent",
    async () => {
      const rows = await firstEmails(current, first);
      for (const row of rows) {
        if (row.mailbox_id)
          seenOn.set(row.id, (seenOn.get(row.id) ?? new Set()).add(row.mailbox_id));
      }
      return rows.length === first.length && rows.every((row) => row.status === "sent");
    },
    { stepMs: 30_000, max: 400 },
  );
  const plannedOnAlex = [...seenOn]
    .filter(([, mailboxIds]) => mailboxIds.has(alex.id))
    .map(([id]) => id);
  return { world: current, alex, sam, campaign, first, plannedOnAlex };
}

describe("acceptance: mailbox outage", () => {
  it("moves the mail to the other sender while a mailbox cannot log in, and sends from it again once fixed", async () => {
    const { world: current, alex, sam, campaign, first, plannedOnAlex } = await outage();
    const mail = server as MailServer;

    // Alex's mailbox stopped sending: status error with the login failure.
    const down = await mailboxRow(current, alex.id);
    expect(down?.status).toBe("error");
    expect(down?.status_reason).toMatch(/^Login failed: .*535/);
    const errors = await eventsOf(current, "mailbox.error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.data).toMatchObject({ mailbox_id: alex.id, email: ALEX });

    // Its emails moved to Sam's mailbox; every first email went out once, all from Sam.
    expect(plannedOnAlex.length).toBeGreaterThan(0);
    const sent = await firstEmails(current, first);
    expect(sent.map((row) => [row.mailbox_id, row.status])).toEqual(
      first.map(() => [sam.id, "sent"]),
    );
    for (const id of plannedOnAlex) {
      expect(sent.find((row) => row.id === id)?.mailbox_id).toBe(sam.id);
    }
    expect(mail.received.map((item) => item.from)).toEqual(first.map(() => SAM));
    expect(mail.received.map((item) => item.to[0]).sort()).toEqual(
      first.map((lead) => lead.person.email).sort(),
    );
    expect(new Set(mail.received.map((item) => item.messageId)).size).toBe(first.length);

    // The operator view shows the mailbox in error (Sam's and the client's first mailbox are fine).
    const state = await current.call<Any>("operating.state");
    expect(state.sending_today.mailboxes).toMatchObject({ active: 2, error: 1 });

    // While it is down, new people are planned on Sam's mailbox only.
    const second = await addLeads(current, 4, 6);
    await current.call("campaigns.enroll", {
      campaign_id: campaign.id,
      person_ids: second.map((lead) => lead.person.id),
    });
    await until(current.engine, "the new people's first emails are sent", async () => {
      const rows = await firstEmails(current, second);
      return rows.length === second.length && rows.every((row) => row.status === "sent");
    });
    expect((await firstEmails(current, second)).map((row) => row.mailbox_id)).toEqual(
      second.map(() => sam.id),
    );
    expect(mail.received.filter((item) => item.from === ALEX)).toEqual([]);

    // The owner stores the new password and tests the mailbox: it is active again.
    await current.call("mailboxes.update", { mailbox_id: alex.id, password: MAIL_PASSWORD });
    const tested = await current.call<Any>("mailboxes.test", { mailbox_id: alex.id });
    expect(tested).toMatchObject({ smtp: "ok", auth_failed: false, status: "active" });
    expect((await mailboxRow(current, alex.id))?.status_reason).toBeNull();

    // Sending from it resumes, and still nobody gets an email twice.
    const third = await addLeads(current, 6, 8);
    await current.call("campaigns.enroll", {
      campaign_id: campaign.id,
      person_ids: third.map((lead) => lead.person.id),
    });
    await until(current.engine, "the last people's first emails are sent", async () => {
      const rows = await firstEmails(current, third);
      return rows.length === third.length && rows.every((row) => row.status === "sent");
    });
    expect(mail.received.filter((item) => item.from === ALEX).length).toBeGreaterThan(0);
    const everyone = [...first, ...second, ...third];
    expect(mail.received).toHaveLength(everyone.length);
    expect(mail.received.map((item) => item.to[0]).sort()).toEqual(
      everyone.map((lead) => lead.person.email).sort(),
    );
    expect(new Set(mail.received.map((item) => item.messageId)).size).toBe(everyone.length);
    const all = await messagesOf(current, { direction: "outbound" });
    expect(all.filter((row) => row.status === "failed")).toEqual([]);
  });

  it("opens one mailbox_down problem for the login failure and resolves it once the mailbox is active again", async () => {
    const { world: current, alex } = await outage();

    const [problem] = await problemsOf(current, "mailbox_down");
    expect(problem).toMatchObject({
      status: "open",
      severity: "high",
      owner: "person",
      title: `Mailbox ${ALEX} stopped sending`,
      dedupe_key: `mailbox_down:${alex.id}`,
    });
    expect(problem?.reason).toContain("error");
    expect(problem?.reason).toContain("Login failed");
    expect(problem?.remedy).toContain("manage_mailboxes");
    expect(problem?.remedy).toContain("test");
    // Several emails met the refused login: still one problem.
    expect(await problemsOf(current, "mailbox_down")).toHaveLength(1);
    const state = await current.call<Any>("operating.state");
    expect(state.problems.top).toContainEqual(
      expect.objectContaining({ id: problem?.id, kind: "mailbox_down", severity: "high" }),
    );

    await current.call("mailboxes.update", { mailbox_id: alex.id, password: MAIL_PASSWORD });
    await current.call("mailboxes.test", { mailbox_id: alex.id });
    const [resolved] = await problemsOf(current, "mailbox_down");
    expect(resolved).toMatchObject({ id: problem?.id, status: "resolved" });
    expect(await problemsOf(current, "mailbox_down")).toHaveLength(1);
  });
});
