/**
 * Acceptance scenario 12, takeover. Mateo Silva answers the first campaign email with interest,
 * and the engine plans an automatic reply (the client allows them, with a 30 minute human-like
 * delay). Before it goes out, Alex, the mailbox owner, answers Mateo from his own mail app. The
 * next mailbox sync finds that answer in the Sent folder: it is stored as an `external` message,
 * the thread becomes owned by a person, and the waiting automatic reply is cancelled
 * (`superseded_by_person`), so Mateo never gets two answers. Mateo's next message gets no AI
 * draft, his sequence stays stopped, and once Alex releases the thread the engine drafts again.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { threads } from "../../../src/db/schema/index.js";
import { fakeImap, resetFakeImap } from "../../../src/testing/fake-imap.js";
import { addSmtpMailbox, type MailServer, mailFolders, startMailServer } from "./mail-server.js";
import {
  type Any,
  advance,
  classification,
  createCampaign,
  enrollAndLaunch,
  enrollmentsOf,
  eventsOf,
  firstEmailSent,
  HOUR,
  MINUTE,
  messageById,
  messagesOf,
  receiveReply,
  startWorld,
  type World,
} from "./support.js";

vi.mock("imapflow", async () =>
  (await import("../../../src/testing/fake-imap.js")).fakeImapModule(),
);

let server: MailServer;
let world: World;
beforeAll(async () => {
  server = await startMailServer();
  resetFakeImap();
  fakeImap.folders = mailFolders();
});
afterAll(async () => {
  await world?.close();
  await server.close();
});

const MAILBOX = "alex@brightline-answering.example.org";
const EMAIL = "mateo.silva@lakeview-dental.example.com";

/** Alex's own answer as his mail app files it in the Sent folder. */
function ownAnswer(input: { inReplyTo: string; references: string[]; at: Date }): string {
  return [
    `From: Alex Rivera <${MAILBOX}>`,
    `To: Mateo Silva <${EMAIL}>`,
    "Subject: Re: front desk coverage",
    "Message-ID: <own-answer-1@brightline-answering.example.org>",
    `In-Reply-To: ${input.inReplyTo}`,
    `References: ${input.references.join(" ")}`,
    `Date: ${input.at.toUTCString().replace("GMT", "+0000")}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hi Mateo, happy to walk you through pricing for two locations. I will call you tomorrow at 9.",
    "",
    "Alex",
    "",
  ].join("\r\n");
}

describe("acceptance: takeover", () => {
  it("steps back when a person answers from their own mail app, until the thread is released", async () => {
    world = await startWorld({
      settings: {
        replies: { interested: { action: "auto_reply" } },
        sending: { reply_delay_minutes: [30, 30] },
      },
    });
    const mailbox = await addSmtpMailbox(world, server, { email: MAILBOX });
    const { person } = await world.lead({
      person: { first_name: "Mateo", last_name: "Silva", full_name: "Mateo Silva", email: EMAIL },
      company: { name: "Lakeview Dental", domain: "lakeview-dental.example.com" },
    });
    const campaign = await createCampaign(world, {
      name: "Lakeview area practices",
      settings: { senders: { mailbox_ids: [mailbox.id] } },
    });
    await enrollAndLaunch(world, campaign.id, [person.id]);
    const first = await firstEmailSent(world, person.id);
    expect(server.received).toHaveLength(1);

    // Mateo is interested: an automatic reply is planned, 30 minutes out.
    world.classifyReply("tell me more about pricing", classification("interested"));
    const reply = await receiveReply(
      world,
      first,
      "Thanks Alex, this sounds interesting. Tell me more about pricing for two locations.",
    );
    const threadId = reply.threadId ?? "";
    const inbound = await messageById(world, reply.messageId ?? "");
    const planned = (await messagesOf(world, { threadId, direction: "outbound" })).find(
      (row) => row.action === "reply",
    );
    expect(planned).toMatchObject({ status: "scheduled", origin: "engine" });
    expect(await enrollmentsOf(world, person.id)).toMatchObject([
      { status: "stopped", stop_reason: "replied" },
    ]);

    // Alex answers from his own mail app; the next sync finds it in the Sent folder.
    const answeredAt = world.engine.clock.now();
    fakeImap.folders = mailFolders([
      {
        uid: 1,
        internalDate: answeredAt,
        source: ownAnswer({
          inReplyTo: inbound.message_id_header ?? "",
          references: [first.message_id_header ?? "", inbound.message_id_header ?? ""],
          at: answeredAt,
        }),
      },
    ]);
    await advance(world.engine, 5 * MINUTE);

    // Stored as external, the thread is owned by a person, the automatic reply is cancelled.
    const outbound = await messagesOf(world, { threadId, direction: "outbound" });
    const external = outbound.find((row) => row.origin === "external");
    expect(external).toMatchObject({
      action: "reply",
      status: "sent",
      message_id_header: "<own-answer-1@brightline-answering.example.org>",
      person_id: person.id,
    });
    expect(external?.body_text).toContain("I will call you tomorrow at 9.");
    expect(await messageById(world, planned?.id ?? "")).toMatchObject({
      status: "cancelled",
      error: "superseded_by_person",
    });
    const [thread] = await world.engine.db.select().from(threads).where(eq(threads.id, threadId));
    expect(thread?.owner).toBe("person");
    const takenOver = await eventsOf(world, "thread.taken_over");
    expect(takenOver).toHaveLength(1);
    expect(takenOver[0]?.data).toMatchObject({ thread_id: threadId, message_id: external?.id });

    // The 30 minutes pass: Mateo never gets the automatic reply on top of Alex's answer.
    await advance(world.engine, HOUR);
    expect(server.received).toHaveLength(1);

    // His next message gets no AI draft while a person owns the thread (the same interest
    // would otherwise be answered automatically).
    const draftsBefore = world.brain.calls.filter(
      (call) => call.promptId === "inbox.reply.draft",
    ).length;
    world.classifyReply("pricing sheet", classification("interested"));
    await receiveReply(world, first, "Great, talk tomorrow. Please also send the pricing sheet.");
    expect(world.brain.calls.filter((call) => call.promptId === "inbox.reply.draft")).toHaveLength(
      draftsBefore,
    );
    const engineReplies = (await messagesOf(world, { threadId, direction: "outbound" })).filter(
      (row) => row.origin === "engine" && row.action === "reply",
    );
    expect(engineReplies.map((row) => row.status)).toEqual(["cancelled"]);
    expect(await enrollmentsOf(world, person.id)).toMatchObject([{ status: "stopped" }]);
    const lead = await world.call<Any>("leads.get", { person_id: person.id });
    expect(lead.relationship.state).toBe("in_conversation");

    // Alex hands the thread back: the engine answers the next message on its own again.
    const released = await world.call<Any>("threads.release", { thread_id: threadId });
    expect(released).toMatchObject({ changed: true });
    expect(await eventsOf(world, "thread.released")).toHaveLength(1);
    world.classifyReply("summary i can forward", classification("interested"));
    await receiveReply(
      world,
      first,
      "One more thing: could you send a short summary I can forward to my partner?",
    );
    const after = (await messagesOf(world, { threadId, direction: "outbound" })).filter(
      (row) => row.origin === "engine" && row.action === "reply",
    );
    expect(after.map((row) => row.status)).toEqual(["cancelled", "scheduled"]);
    await advance(world.engine, HOUR);
    expect(server.received).toHaveLength(2);
    expect(await enrollmentsOf(world, person.id)).toMatchObject([
      { status: "stopped", stop_reason: "replied" },
    ]);
  });
});
