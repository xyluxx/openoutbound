/**
 * Delivery invariant for email (docs/concepts/delivery-guarantees.md): boundaries B1 (campaign
 * email) and B2 (email reply), scenarios S1 to S6 and S8. Both go through the same send job, so
 * each scenario runs once per boundary with its own kind of message. The transport is a fake that
 * answers like an SMTP server would (send-job.test.ts runs the same paths against a real local
 * SMTP server); the Sent folder is a fake IMAP server. S7 for replies is in
 * inbox/delivery-invariant.test.ts, for campaign steps in the sequencer tests.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  type Mailbox,
  type Message,
  mailboxes,
  messages,
  problems,
} from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import {
  seedCampaign,
  seedEnrollment,
  seedMailbox,
  seedMessage,
  seedPerson,
  seedThread,
} from "../../testing/factories.js";
import { type FakeImapFolder, fakeImap, resetFakeImap } from "../../testing/fake-imap.js";
import { storePasswords } from "./credentials.js";
import { RECONCILE_JOB, reconcileUnknownSends } from "./reconcile-job.js";
import { sendEmailMessage } from "./send-job.js";
import type { EmailTransport, SendResult } from "./transport.js";
import { resolveUnknownOperation } from "./unknown-operations.js";
import { INTERRUPTED_REASON, RECONCILE_CHECKS } from "./unknown-sends.js";

vi.mock("imapflow", async () => (await import("../../testing/fake-imap.js")).fakeImapModule());
vi.mock("../leads/service.js", async () => (await import("./test-support.js")).fakeLeadsService);
vi.mock("../../runtime/notify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/notify.js")>()),
  notify: vi.fn(async () => {}),
}));

/** What the fake mail server does with each hand-over, in order. */
const transport = vi.hoisted(() => ({
  send: null as unknown as Mock<EmailTransport["send"]>,
}));
vi.mock("./transport.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./transport.js")>();
  return {
    ...actual,
    transportFor: async (): Promise<EmailTransport> => ({
      kind: "smtp",
      send: (...args) => transport.send(...args),
      verify: async () => {},
    }),
  };
});

// Tuesday 10:00 in Chicago: inside every default send window.
const NOW = "2026-09-22T15:00:00.000Z";
const SAM = "sam@brand.example.com";
const DANA = "dana@harbor.example.com";
/** When the engine first found one of its own emails in the mailbox's Sent folder. */
const PROVEN = new Date("2026-09-20T09:00:00Z");

type Kind = "campaign" | "reply";

let ctx: TestContext;

beforeEach(() => {
  resetFakeImap();
  transport.send = vi.fn<EmailTransport["send"]>(async (email) => accepted(email.to[0] ?? DANA));
});
afterEach(async () => {
  await ctx?.close();
});

/** The server took the message: 250 with a queue id. */
function accepted(to: string = DANA): SendResult {
  return {
    providerMessageId: "250 2.0.0 Ok: queued as 4F1A2",
    accepted: [to],
    rejected: [],
    rejectedErrors: [],
    response: "250 2.0.0 Ok: queued as 4F1A2",
  };
}

/** The connection died after the message data, before the server's answer. */
function droppedAfterData(): Error {
  return Object.assign(new Error("Connection closed unexpectedly"), {
    code: "ECONNECTION",
    command: "DATA",
  });
}

/** The server refused the connection: nothing was handed over. */
function refusedConnection(): Error {
  return Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:2525"), {
    code: "ESOCKET",
    syscall: "connect",
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface World {
  mailbox: Mailbox;
  message: Message;
  campaignId: string | null;
}

/** A scheduled campaign email or reply to Dana, from a mailbox with or without IMAP. */
async function world(
  kind: Kind,
  options: { imap?: boolean; proven?: boolean } = {},
): Promise<World> {
  ctx = await createTestContext({
    now: NOW,
    config: { baseUrl: "https://engine.example.com" },
    settings: { company: { name: "Helix Outbound", postal_address: "12 Harbor Road, Austin" } },
  });
  const secretId = await storePasswords(ctx, ctx.workspace.id, SAM, "app-pass");
  const mailbox = await seedMailbox(ctx, {
    email: SAM,
    from_name: "Sam Carter",
    provider_label: "custom",
    auth_type: "password",
    secret_id: secretId,
    smtp: { host: "smtp.example.org", port: 465, secure: true, user: SAM },
    ...(options.imap
      ? { imap: { host: "imap.example.org", port: 993, secure: true, user: SAM } }
      : {}),
    ...(options.proven ? { sent_copies_seen_at: PROVEN } : {}),
  });
  const person = await seedPerson(ctx, { email: DANA, first_name: "Dana", status: "active" });
  const base = {
    person_id: person.id,
    mailbox_id: mailbox.id,
    to_address: DANA,
    status: "scheduled" as const,
    scheduled_for: ctx.clock.now(),
  };
  if (kind === "campaign") {
    const { campaign, steps } = await seedCampaign(ctx, { status: "active" });
    const enrollment = await seedEnrollment(ctx, {
      campaign_id: campaign.id,
      person_id: person.id,
      status: "active",
    });
    const message = await seedMessage(ctx, {
      ...base,
      campaign_id: campaign.id,
      step_id: steps[0]?.id ?? null,
      enrollment_id: enrollment.id,
      subject: "Quick question, {{first_name}}",
      body_text: "Hi {{first_name}},\n\nShort note about scheduling.",
    });
    return { mailbox, message, campaignId: campaign.id };
  }
  const thread = await seedThread(ctx, {
    person_id: person.id,
    mailbox_id: mailbox.id,
    subject: "Quick question",
  });
  await seedMessage(ctx, {
    thread_id: thread.id,
    person_id: person.id,
    mailbox_id: mailbox.id,
    status: "sent",
    sent_at: new Date("2026-09-21T15:00:00Z"),
    message_id_header: "<first@brand.example.com>",
  });
  const message = await seedMessage(ctx, {
    ...base,
    thread_id: thread.id,
    action: "reply",
    subject: "Re: Quick question",
    body_text: "Thanks Dana, Tuesday at 10 works.",
  });
  return { mailbox, message, campaignId: null };
}

const send = (messageId: string) =>
  sendEmailMessage(ctx.jobContext({ name: "email.send" }), messageId);

async function reload(id: string): Promise<Message> {
  const [row] = await ctx.db.select().from(messages).where(eq(messages.id, id));
  if (!row) throw new Error("message missing");
  return row;
}

async function problemsOf(messageId: string) {
  return ctx.db
    .select()
    .from(problems)
    .where(and(eq(problems.workspace_id, ctx.workspace.id), eq(problems.subject_id, messageId)));
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition never became true");
}

/** S1: an attempt stopped mid-send. */
async function foundMidSend(kind: Kind) {
  const w = await world(kind);
  await ctx.db
    .update(messages)
    .set({ status: "sending", attempt: 1, dispatch_started_at: ctx.clock.now() })
    .where(eq(messages.id, w.message.id));
  expect(await send(w.message.id)).toMatchObject({ status: "unknown", reason: INTERRUPTED_REASON });
  expect(await send(w.message.id)).toMatchObject({ status: "noop", reason: "status_unknown" });
  expect(transport.send).not.toHaveBeenCalled();
  expect(await reload(w.message.id)).toMatchObject({ status: "unknown", attempt: 1 });
  // No IMAP: nothing can look for a copy, so a person is asked at once.
  expect((await problemsOf(w.message.id)).map((p) => p.kind)).toEqual(["send_unknown"]);
}

/** S2: the connection dropped after the data. */
async function droppedAfterHandover(kind: Kind) {
  const w = await world(kind, { imap: true });
  transport.send.mockRejectedValueOnce(droppedAfterData());
  expect(await send(w.message.id)).toMatchObject({ status: "unknown" });
  expect(await send(w.message.id)).toMatchObject({ status: "noop", reason: "status_unknown" });
  expect(transport.send).toHaveBeenCalledTimes(1);
  const row = await reload(w.message.id);
  expect(row).toMatchObject({ status: "unknown", attempt: 1 });
  expect(row.why?.failed_before_handover).toBeUndefined();
  expect(ctx.emitted("message.failed")).toHaveLength(0);
}

/** S3: the server took it but its answer names no queue id and lists no accepted address. */
async function acceptedWithoutId(kind: Kind) {
  const w = await world(kind);
  transport.send.mockResolvedValueOnce({
    providerMessageId: null,
    accepted: [],
    rejected: [],
    rejectedErrors: [],
    response: null,
  });
  expect(await send(w.message.id)).toMatchObject({ status: "sent" });
  expect(await reload(w.message.id)).toMatchObject({ status: "sent", provider_message_id: null });
  expect(ctx.emitted("message.sent")).toHaveLength(1);
}

/** S4: two attempts at once. */
async function twoAttemptsAtOnce(kind: Kind) {
  const w = await world(kind);
  const outcomes = await Promise.all([send(w.message.id), send(w.message.id)]);
  expect(outcomes.filter((outcome) => outcome.status === "sent")).toHaveLength(1);
  expect(transport.send).toHaveBeenCalledTimes(1);
  expect(await reload(w.message.id)).toMatchObject({ status: "sent", attempt: 1 });
}

/** S5: refused before anything was handed over, then sent on the same row. */
async function retriedBeforeHandover(kind: Kind) {
  const w = await world(kind);
  transport.send.mockRejectedValueOnce(refusedConnection());
  await expect(send(w.message.id)).rejects.toThrow(/Temporary send failure/);
  expect(await reload(w.message.id)).toMatchObject({ status: "scheduled", attempt: 1 });
  expect(await send(w.message.id)).toMatchObject({ status: "sent" });
  expect(await reload(w.message.id)).toMatchObject({ status: "sent", attempt: 2 });
  expect(transport.send).toHaveBeenCalledTimes(2);
  expect(ctx.emitted("message.unknown")).toHaveLength(0);
}

/** S6: the first try's success comes back after a person had it sent again. */
async function lateSuccessAfterResend(kind: Kind) {
  const w = await world(kind);
  const first = deferred<SendResult>();
  const second = deferred<SendResult>();
  transport.send
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  const firstTry = send(w.message.id);
  await waitFor(async () => transport.send.mock.calls.length === 1);
  // The job timed out; its retry finds the message sending: unknown, and a person is asked.
  expect(await send(w.message.id)).toMatchObject({ status: "unknown" });
  await resolveUnknownOperation.handler(
    ctx,
    resolveUnknownOperation.input.parse({ message_id: w.message.id, outcome: "resend" }),
  );
  const resend = send(w.message.id);
  await waitFor(async () => transport.send.mock.calls.length === 2);
  first.resolve(accepted(DANA));
  expect(await firstTry).toMatchObject({ status: "noop", reason: "newer_attempt_sending" });
  second.resolve(accepted(DANA));
  expect(await resend).toMatchObject({ status: "sent" });

  const row = await reload(w.message.id);
  expect(row).toMatchObject({ status: "sent", attempt: 2 });
  expect(row.why?.duplicate_attempts).toEqual([1, 2]);
  expect(ctx.emitted("message.duplicate").map((event) => event.data)).toEqual([
    expect.objectContaining({
      message_id: w.message.id,
      attempts: [1, 2],
      channel: "email",
      campaign_id: w.campaignId,
    }),
  ]);
  const duplicate = (await problemsOf(w.message.id)).find((p) => p.kind === "duplicate_send");
  expect(duplicate).toMatchObject({
    status: "open",
    owner: "person",
    title: "Email went out twice",
  });
}

/** S8: one resend on proof that the first did not arrive, never a second: then a person. */
async function resentOnceOnProof(kind: Kind) {
  const w = await world(kind, { imap: true, proven: true });
  fakeImap.folders = withSent();
  transport.send
    .mockRejectedValueOnce(droppedAfterData())
    .mockRejectedValueOnce(droppedAfterData());
  expect(await send(w.message.id)).toMatchObject({ status: "unknown" });
  const reconcile = () => reconcileUnknownSends(ctx.jobContext({ name: RECONCILE_JOB }));
  for (let check = 1; check < RECONCILE_CHECKS; check++) await reconcile();
  // Three lookups found no copy on a server proven to keep them: sent once more, same row.
  expect((await reconcile()).email).toMatchObject({ resent: 1 });
  expect(await reload(w.message.id)).toMatchObject({ status: "scheduled", attempt: 1 });
  expect(await send(w.message.id)).toMatchObject({ status: "unknown" });
  expect(await reload(w.message.id)).toMatchObject({ status: "unknown", attempt: 2 });
  // The resend got no clear answer either: never a third try, a person decides.
  for (let check = 1; check < RECONCILE_CHECKS; check++) await reconcile();
  expect((await reconcile()).email).toMatchObject({ resent: 0, problems: 1 });
  expect(await send(w.message.id)).toMatchObject({ status: "noop", reason: "status_unknown" });
  expect(transport.send).toHaveBeenCalledTimes(2);
  const [problem] = await problemsOf(w.message.id);
  expect(problem).toMatchObject({ kind: "send_unknown", status: "open", owner: "person" });
  expect(problem?.reason).toContain("even after it was sent again once");
  // The proof stays on the mailbox.
  const [box] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, w.mailbox.id));
  expect(box?.sent_copies_seen_at?.toISOString()).toBe(PROVEN.toISOString());
}

/** A Sent folder with nothing of ours in it. */
function withSent(): FakeImapFolder[] {
  return [
    {
      path: "INBOX",
      name: "INBOX",
      specialUse: "\\Inbox",
      flags: [],
      uidValidity: 7n,
      messages: [],
    },
    { path: "Sent", name: "Sent", specialUse: "\\Sent", flags: [], uidValidity: 5n, messages: [] },
  ];
}

describe("delivery invariant: email (B1 campaign email, B2 email reply)", () => {
  it("B1 S1 a campaign email found mid-send becomes unknown and is not sent again", () =>
    foundMidSend("campaign"));
  it("B2 S1 a reply found mid-send becomes unknown and is not sent again", () =>
    foundMidSend("reply"));

  it("B1 S2 a campaign email whose connection dropped after the data becomes unknown, never retried", () =>
    droppedAfterHandover("campaign"));
  it("B2 S2 a reply whose connection dropped after the data becomes unknown, never retried", () =>
    droppedAfterHandover("reply"));

  it("B1 S3 a campaign email the server took without an id counts as sent", () =>
    acceptedWithoutId("campaign"));
  it("B2 S3 a reply the server took without an id counts as sent", () =>
    acceptedWithoutId("reply"));

  it("B1 S4 two attempts at the same campaign email hand it over once", () =>
    twoAttemptsAtOnce("campaign"));
  it("B2 S4 two attempts at the same reply hand it over once", () => twoAttemptsAtOnce("reply"));

  it("B1 S5 a campaign email refused before the data is sent again on the same row", () =>
    retriedBeforeHandover("campaign"));
  it("B2 S5 a reply refused before the data is sent again on the same row", () =>
    retriedBeforeHandover("reply"));

  // The campaign report counts these events per campaign (reports.test.ts).
  it("B1 S6 a campaign email whose first try succeeds after the resend is recorded as a duplicate", () =>
    lateSuccessAfterResend("campaign"));
  it("B2 S6 a reply whose first try succeeds after the resend is recorded as a duplicate", () =>
    lateSuccessAfterResend("reply"));

  it("B1 S8 a campaign email is sent again once only on proof it did not arrive, then a person decides", () =>
    resentOnceOnProof("campaign"));
  it("B2 S8 a reply is sent again once only on proof it did not arrive, then a person decides", () =>
    resentOnceOnProof("reply"));
});
