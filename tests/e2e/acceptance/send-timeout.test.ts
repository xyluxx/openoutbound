/**
 * Acceptance scenario 4, send timeout. The first campaign email to Tomas Lindqvist goes to a
 * real SMTP conversation (a local server): the server takes the message data, then the
 * connection dies before it answers. The engine cannot tell whether the email went out, so the
 * message becomes `unknown` and is never sent again blindly. The reconcile job looks for its
 * Message-ID in the mailbox's Sent folder (an IMAP fake):
 * - found: the email is marked sent, with exactly one delivery;
 * - not found, on a server known to keep sent copies: it is sent again exactly once;
 * - not found otherwise: a `send_unknown` problem asks a person, nothing is sent again, and
 *   manage_messages action resolve_unknown closes it.
 * Reading the Sent folder during mailbox sync is off here, so the reconcile job is the one that
 * looks (the sync would find the same copy with the same result).
 */
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Mailbox, type Message, mailboxes } from "../../../src/db/schema/index.js";
import { fakeImap, resetFakeImap } from "../../../src/testing/fake-imap.js";
import {
  addSmtpMailbox,
  type MailServer,
  mailFolders,
  sentCopy,
  startMailServer,
} from "./mail-server.js";
import {
  type Any,
  advance,
  createCampaign,
  enrollAndLaunch,
  eventsOf,
  HOUR,
  MINUTE,
  messageById,
  messagesOf,
  problemsOf,
  startWorld,
  until,
  type World,
} from "./support.js";

vi.mock("imapflow", async () =>
  (await import("../../../src/testing/fake-imap.js")).fakeImapModule(),
);

let server: MailServer;
let world: World | undefined;

beforeAll(async () => {
  server = await startMailServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  resetFakeImap();
  fakeImap.folders = mailFolders();
  server.received.length = 0;
  server.dropNext = 0;
});
afterEach(async () => {
  await world?.close();
  world = undefined;
});

/** The world, the SMTP mailbox, and the first email whose connection drops after the data. */
async function sendThatTimesOut(sentCopiesSeenAt: Date | null) {
  const current = await startWorld({ settings: { inbox: { read_sent_folder: false } } });
  world = current;
  const mailbox = await addSmtpMailbox(current, server, {
    email: "alex@brightline-answering.example.org",
    sentCopiesSeenAt,
  });
  const { person } = await current.lead({
    person: {
      first_name: "Tomas",
      last_name: "Lindqvist",
      full_name: "Tomas Lindqvist",
      email: "tomas@fjord-dental.example.com",
    },
    company: { name: "Fjord Dental", domain: "fjord-dental.example.com" },
  });
  const campaign = await createCampaign(current, {
    name: "Fjord region practices",
    settings: { senders: { mailbox_ids: [mailbox.id] } },
  });
  server.dropNext = 1;
  await enrollAndLaunch(current, campaign.id, [person.id]);

  let unknown: Message | undefined;
  await until(current.engine, "the send ends with no clear answer", async () => {
    const rows = await messagesOf(current, { personId: person.id, direction: "outbound" });
    unknown = rows.find((row) => row.status === "unknown");
    return Boolean(unknown);
  });
  if (!unknown) throw new Error("unreachable");

  // Unknown, not failed: the data reached the server once, and nothing retries it blindly.
  expect(unknown).toMatchObject({ status: "unknown", mailbox_id: mailbox.id });
  expect(unknown.error).toContain("no clear answer from the mail server");
  expect(server.received).toHaveLength(1);
  expect(server.received[0]).toMatchObject({
    to: ["tomas@fjord-dental.example.com"],
    messageId: unknown.message_id_header,
    dropped: true,
  });
  expect(await eventsOf(current, "message.unknown")).toHaveLength(1);
  expect(await eventsOf(current, "message.failed")).toHaveLength(0);
  expect(await eventsOf(current, "message.sent")).toHaveLength(0);

  // explain_blocker says why nothing happens to it until it is checked.
  const explained = await current.call<Any>("operating.explain", { message_id: unknown.id });
  expect(explained.blocked).toBe(true);
  expect(explained.blockers).toContainEqual(
    expect.objectContaining({ code: "send_unknown", hard: true }),
  );
  return { world: current, mailbox, person, campaign, unknown };
}

async function mailboxRow(current: World, mailbox: Mailbox) {
  const [row] = await current.engine.db
    .select()
    .from(mailboxes)
    .where(and(eq(mailboxes.id, mailbox.id), eq(mailboxes.workspace_id, current.workspaceId)));
  return row;
}

describe("acceptance: send timeout", () => {
  it("finds the email in the Sent folder and marks it sent with one delivery", async () => {
    const { world: current, mailbox, person, unknown } = await sendThatTimesOut(null);

    // The server did keep it: its copy is in the Sent folder.
    const delivered = server.received[0];
    if (!delivered) throw new Error("unreachable");
    fakeImap.folders = mailFolders([sentCopy(delivered, 41, current.engine.clock.now())]);

    await until(current.engine, "the reconcile job confirms the email", async () => {
      return (await messageById(current, unknown.id)).status === "sent";
    });
    const sent = await messageById(current, unknown.id);
    expect(sent.sent_at?.toISOString()).toBe(unknown.dispatch_started_at?.toISOString());
    expect(fakeImap.searches).toContainEqual({
      path: "Sent",
      query: { header: { "message-id": unknown.message_id_header } },
    });

    // Exactly one delivery, one message.sent, no problem, and the copy proves that the server
    // keeps copies.
    expect(server.received).toHaveLength(1);
    expect(await eventsOf(current, "message.sent")).toHaveLength(1);
    expect(await problemsOf(current, "send_unknown")).toEqual([]);
    expect((await mailboxRow(current, mailbox))?.sent_copies_seen_at).toBeInstanceOf(Date);

    // The sequence moves on as for any sent email; an hour later nothing went out again.
    await advance(current.engine, HOUR);
    expect(server.received).toHaveLength(1);
    const lead = await current.call<Any>("leads.get", { person_id: person.id });
    expect(lead.relationship.state).toBe("in_sequence");
    expect(lead.relationship.next_action).toMatchObject({ kind: "campaign_step" });
  });

  it("sends it again exactly once when a server proven to keep copies has none", async () => {
    // A copy of an earlier email was found in this mailbox's Sent folder the day before.
    const { world: current, unknown } = await sendThatTimesOut(new Date("2026-09-20T09:00:00Z"));

    // The Sent folder stays empty: the server lost the message. After three lookups the
    // reconcile job sends it once more, with the same Message-ID.
    await until(current.engine, "the email is sent again", async () => {
      return (await messageById(current, unknown.id)).status === "sent";
    });
    expect(server.received).toHaveLength(2);
    expect(server.received.map((entry) => [entry.messageId, entry.dropped])).toEqual([
      [unknown.message_id_header, true],
      [unknown.message_id_header, false],
    ]);
    expect(await eventsOf(current, "message.sent")).toHaveLength(1);
    expect(await problemsOf(current, "send_unknown")).toEqual([]);

    // Never a third time.
    await advance(current.engine, HOUR);
    await advance(current.engine, HOUR);
    expect(server.received).toHaveLength(2);
    expect((await messageById(current, unknown.id)).status).toBe("sent");
  });

  it("asks a person when the server is not proven to keep copies, and resolve_unknown closes it", async () => {
    const { world: current, unknown } = await sendThatTimesOut(null);

    await until(current.engine, "a send_unknown problem opens", async () => {
      return (await problemsOf(current, "send_unknown")).length > 0;
    });
    const [problem] = await problemsOf(current, "send_unknown");
    expect(problem).toMatchObject({
      kind: "send_unknown",
      status: "open",
      severity: "high",
      owner: "person",
      dedupe_key: `send_unknown:${unknown.id}`,
      subject_type: "message",
      subject_id: unknown.id,
    });
    expect(problem?.remedy).toContain("resolve_unknown");
    expect(problem?.remedy).toContain(unknown.id);

    // Nothing is sent again while it waits for a person.
    await advance(current.engine, HOUR);
    await advance(current.engine, HOUR);
    expect(server.received).toHaveLength(1);
    expect((await messageById(current, unknown.id)).status).toBe("unknown");

    // The operator views show it.
    const state = await current.call<Any>("operating.state");
    expect(state.problems.open).toBe(1);
    expect(state.problems.top).toContainEqual(
      expect.objectContaining({ id: problem?.id, kind: "send_unknown", severity: "high" }),
    );

    // A person checked with the provider: it went out. resolve_unknown closes the problem.
    const resolved = await current.call<Any>("messages.resolve_unknown", {
      message_id: unknown.id,
      outcome: "sent",
      note: "The provider's delivery log shows it was accepted",
    });
    expect(resolved).toMatchObject({ status: "sent", outcome: "sent", changed: true });
    const [closed] = await problemsOf(current, "send_unknown");
    expect(closed?.status).toBe("resolved");
    expect((await messageById(current, unknown.id)).status).toBe("sent");
    expect(server.received).toHaveLength(1);
    expect((await current.call<Any>("operating.state")).problems.open).toBe(0);
    await advance(current.engine, 10 * MINUTE);
    expect(server.received).toHaveLength(1);
  });
});
