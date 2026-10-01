import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  jobs,
  type Mailbox,
  mailboxes,
  messages,
  type NewMessage,
  type Person,
  problems,
  sender_counters,
} from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { seedMailbox, seedMessage, seedPerson } from "../../testing/factories.js";
import {
  type FakeImapFolder,
  type FakeImapMessage,
  fakeImap,
  resetFakeImap,
} from "../../testing/fake-imap.js";
import { storePasswords } from "./credentials.js";
import { sendJobKey } from "./queue.js";
import {
  LATE_COPY_MS,
  OPEN_FAILURE_GRACE_MS,
  RECONCILE_JOB,
  reconcileUnknownSends,
} from "./reconcile-job.js";
import { clearSandboxOutbox, getSandboxOutbox, sandboxTransport } from "./sandbox-transport.js";
import { confirmEmailSent, sendEmailMessage } from "./send-job.js";
import { INTERRUPTED_REASON } from "./unknown-sends.js";

vi.mock("imapflow", async () => (await import("../../testing/fake-imap.js")).fakeImapModule());
vi.mock("../leads/service.js", async () => (await import("./test-support.js")).fakeLeadsService);
vi.mock("../../runtime/notify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/notify.js")>()),
  notify: vi.fn(async () => {}),
}));

const NOW = new Date("2026-09-21T16:00:00Z");
const DISPATCHED = new Date("2026-09-21T15:55:00Z");
/** When the engine first found one of its own emails in the mailbox's Sent folder (the proof). */
const PROVEN = new Date("2026-09-20T09:00:00Z");
const SAM = "sam@brand.example.com";

let ctx: TestContext;
let mailbox: Mailbox;
let dana: Person;
let seq = 0;

/** The Sent folder copy of one of our emails. */
function copy(uid: number, messageId: string): FakeImapMessage {
  return {
    uid,
    internalDate: DISPATCHED,
    source: [
      `From: Sam Carter <${SAM}>`,
      "To: dana@harbor.example.com",
      "Subject: Checking in",
      `Message-ID: ${messageId}`,
      "Date: Mon, 21 Sep 2026 15:55:00 +0000",
      "",
      "Hi Dana, a short note.",
      "",
    ].join("\r\n"),
  };
}

function withSent(sent: FakeImapMessage[]): FakeImapFolder[] {
  return [
    {
      path: "INBOX",
      name: "INBOX",
      specialUse: "\\Inbox",
      flags: [],
      uidValidity: 7n,
      messages: [],
    },
    {
      path: "Sent",
      name: "Sent",
      specialUse: "\\Sent",
      flags: [],
      uidValidity: 5n,
      messages: sent,
    },
  ];
}

async function unknownEmail(over: Partial<NewMessage> = {}) {
  seq += 1;
  return seedMessage(ctx, {
    person_id: dana.id,
    mailbox_id: mailbox.id,
    to_address: dana.email,
    status: "unknown",
    subject: "Checking in",
    body_text: "Hi Dana, a short note.",
    message_id_header: `<unknown-${seq}@brand.example.com>`,
    dispatch_started_at: DISPATCHED,
    ...over,
  });
}

async function reload(id: string) {
  const [row] = await ctx.db.select().from(messages).where(eq(messages.id, id));
  if (!row) throw new Error("message gone");
  return row;
}

async function openProblems() {
  return ctx.db.select().from(problems).where(eq(problems.workspace_id, ctx.workspace.id));
}

const reconcile = () => reconcileUnknownSends(ctx.jobContext({ name: RECONCILE_JOB }));

async function setMailbox(values: Partial<Mailbox>) {
  await ctx.db.update(mailboxes).set(values).where(eq(mailboxes.id, mailbox.id));
}

beforeEach(async () => {
  resetFakeImap();
  clearSandboxOutbox();
  ctx = await createTestContext({ now: NOW });
  const secretId = await storePasswords(ctx, ctx.workspace.id, SAM, "app-pass");
  mailbox = await seedMailbox(ctx, {
    email: SAM,
    provider_label: "custom",
    auth_type: "password",
    secret_id: secretId,
    smtp: { host: "smtp.example.org", port: 465, secure: true, user: SAM },
    imap: { host: "imap.example.org", port: 993, secure: true, user: SAM },
  });
  dana = await seedPerson(ctx, { email: "dana@harbor.example.com" });
});
afterEach(async () => {
  await ctx.close();
});

describe("reconciling unknown emails over IMAP", () => {
  it("marks an email sent when its Message-ID is in the Sent folder", async () => {
    const unknown = await unknownEmail();
    fakeImap.folders = withSent([copy(4, unknown.message_id_header ?? "")]);

    const summary = await reconcile();
    expect(summary.email).toMatchObject({ checked: 1, confirmed: 1, errors: 0 });
    expect(fakeImap.searches).toEqual([
      { path: "Sent", query: { header: { "message-id": unknown.message_id_header } } },
    ]);
    const row = await reload(unknown.id);
    expect(row.status).toBe("sent");
    expect(row.sent_at?.toISOString()).toBe(DISPATCHED.toISOString());
    expect(ctx.emitted("message.sent")[0]?.data).toMatchObject({ message_id: unknown.id });
    // The copy proves that this server keeps sent copies.
    const [box] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, mailbox.id));
    expect(box?.sent_copies_seen_at?.toISOString()).toBe(NOW.toISOString());
    // Settled: nothing is looked up again.
    expect((await reconcile()).email.checked).toBe(0);
  });

  it("sends once more when a server proven to keep copies has none, then asks a person", async () => {
    await setMailbox({ sent_copies_seen_at: PROVEN });
    const unknown = await unknownEmail();
    fakeImap.folders = withSent([copy(1, "<someone-else@brand.example.com>")]);

    expect((await reconcile()).email).toMatchObject({ checked: 1, pending: 1 });
    expect((await reconcile()).email).toMatchObject({ pending: 1 });
    expect((await reconcile()).email).toMatchObject({ resent: 1 });
    const resent = await reload(unknown.id);
    expect(resent).toMatchObject({ status: "scheduled", reconcile_checks: 0 });
    // The first try's hand-over time stays: a late copy of it still dates the send.
    expect(resent.dispatch_started_at?.toISOString()).toBe(DISPATCHED.toISOString());
    expect(resent.why?.resent_after_unknown).toBe(NOW.toISOString());
    // The same Message-ID goes out again, so a late copy still matches.
    expect(resent.message_id_header).toBe(unknown.message_id_header);
    expect(ctx.enqueued("email.send")).toEqual([
      expect.objectContaining({
        payload: { message_id: unknown.id },
        options: expect.objectContaining({ singletonKey: sendJobKey(unknown.id) }),
      }),
    ]);
    expect(await openProblems()).toHaveLength(0);

    // The resend has no clear answer either: never a third try.
    await ctx.db
      .update(messages)
      .set({ status: "unknown", dispatch_started_at: NOW })
      .where(eq(messages.id, unknown.id));
    await reconcile();
    await reconcile();
    expect((await reconcile()).email).toMatchObject({ problems: 1, resent: 0 });
    expect(ctx.enqueued("email.send")).toHaveLength(1);
    const [problem] = await openProblems();
    expect(problem).toMatchObject({
      kind: "send_unknown",
      severity: "high",
      owner: "person",
      status: "open",
      title: "Check whether an email went out",
      dedupe_key: `send_unknown:${unknown.id}`,
    });
    expect(problem?.reason).toContain("even after it was sent again once");
    expect(problem?.remedy).toBe(
      `Look in the Sent folder of ${SAM}, then use manage_messages action resolve_unknown with outcome sent or resend (message_id ${unknown.id}).`,
    );
  });

  it("drops a queued resend when a late copy of the first try turns up", async () => {
    await setMailbox({ sent_copies_seen_at: PROVEN, daily_limit: 1 });
    const unknown = await unknownEmail({ reconcile_checks: 2 });
    // The mailbox used its one email today: the resend waits for tomorrow.
    await ctx.db.insert(sender_counters).values({
      sender_type: "mailbox",
      sender_id: mailbox.id,
      day: "2026-09-21",
      action: "email",
      count: 1,
    });
    fakeImap.folders = withSent([]);
    expect((await reconcile()).email).toMatchObject({ resent: 1 });
    const queued = await reload(unknown.id);
    expect(queued.status).toBe("scheduled");
    expect(queued.scheduled_for?.getTime()).toBeGreaterThan(NOW.getTime());

    // The first try's copy turns up while the resend waits: it went out, the resend is dropped.
    fakeImap.folders = withSent([copy(6, unknown.message_id_header ?? "")]);
    expect((await reconcile()).email).toMatchObject({ checked: 1, confirmed: 1 });
    const row = await reload(unknown.id);
    expect(row).toMatchObject({ status: "sent", attempt: unknown.attempt });
    expect(row.sent_at?.toISOString()).toBe(DISPATCHED.toISOString());
    expect(ctx.emitted("message.sent")).toHaveLength(1);
    // The queued send job finds nothing left to send.
    ctx.clock.set(queued.scheduled_for ?? NOW);
    expect(await sendEmailMessage(ctx.jobContext(), unknown.id)).toMatchObject({
      status: "noop",
      reason: "status_sent",
    });
    expect((await reconcile()).email.checked).toBe(0);
  });

  it("leaves a resend a send job already claimed to that job", async () => {
    const unknown = await unknownEmail({
      status: "sending",
      attempt: 2,
      why: { resent_after_unknown: DISPATCHED.toISOString() },
    });
    fakeImap.folders = withSent([copy(7, unknown.message_id_header ?? "")]);
    expect((await reconcile()).email.checked).toBe(0);
    expect(
      await confirmEmailSent(ctx.jobContext(), unknown.id, { resolution: "Found in Sent" }),
    ).toBe(false);
    expect((await reload(unknown.id)).status).toBe("sending");
  });

  it("asks a person when the server is not proven to keep copies, and a late copy still settles it", async () => {
    const unknown = await unknownEmail();
    fakeImap.folders = withSent([]);
    await reconcile();
    await reconcile();
    expect((await reconcile()).email).toMatchObject({ problems: 1, resent: 0 });
    expect(ctx.enqueued("email.send")).toHaveLength(0);
    expect((await reload(unknown.id)).status).toBe("unknown");
    const [problem] = await openProblems();
    expect(problem?.reason).toContain("not proven to keep a copy");
    expect(problem?.reason).toContain("dana@harbor.example.com");
    expect(problem?.reason).toContain('"Checking in"');

    // The copy shows up an hour later.
    ctx.clock.advance(60 * 60_000);
    fakeImap.folders = withSent([copy(9, unknown.message_id_header ?? "")]);
    expect((await reconcile()).email).toMatchObject({ confirmed: 1 });
    expect((await reload(unknown.id)).status).toBe("sent");
    const [resolved] = await openProblems();
    expect(resolved?.status).toBe("resolved");
  });

  it("asks a person for a Google mailbox with no copy found yet: the provider is only a hint", async () => {
    await setMailbox({
      provider_label: "google",
      smtp: { host: "smtp.gmail.com", port: 465, secure: true, user: SAM },
    });
    const unknown = await unknownEmail();
    fakeImap.folders = withSent([]);
    await reconcile();
    await reconcile();
    expect((await reconcile()).email).toMatchObject({ problems: 1, resent: 0 });
    expect(ctx.enqueued("email.send")).toHaveLength(0);
    expect((await reload(unknown.id)).status).toBe("unknown");
    const [problem] = await openProblems();
    expect(problem?.reason).toContain("not proven to keep a copy");
  });

  it("never resends through smtp-relay.gmail.com, which keeps no copy of what it relays", async () => {
    await setMailbox({
      provider_label: "google",
      smtp: { host: "smtp-relay.gmail.com", port: 587, secure: false, user: SAM },
      // Even a recorded proof does not count for this server.
      sent_copies_seen_at: PROVEN,
    });
    const unknown = await unknownEmail();
    fakeImap.folders = withSent([]);
    await reconcile();
    await reconcile();
    expect((await reconcile()).email).toMatchObject({ problems: 1, resent: 0 });
    expect(ctx.enqueued("email.send")).toHaveLength(0);
    expect((await reload(unknown.id)).status).toBe("unknown");
    const [problem] = await openProblems();
    expect(problem?.reason).toContain("never keeps a copy of what it relays");
  });

  it("stops looking for a late copy after three days", async () => {
    const unknown = await unknownEmail({ reconcile_checks: 3 });
    fakeImap.folders = withSent([]);
    expect((await reconcile()).email).toMatchObject({ checked: 1, pending: 1 });
    ctx.clock.advance(LATE_COPY_MS);
    expect((await reconcile()).email.checked).toBe(0);
    expect((await reload(unknown.id)).status).toBe("unknown");
  });

  it("waits out a connection failure before asking a person", async () => {
    const unknown = await unknownEmail();
    fakeImap.connectError = new Error("connect ETIMEDOUT 192.0.2.10:993");
    expect((await reconcile()).email).toMatchObject({ checked: 1, pending: 1 });
    expect(await openProblems()).toHaveLength(0);

    ctx.clock.set(new Date(DISPATCHED.getTime() + OPEN_FAILURE_GRACE_MS));
    expect((await reconcile()).email).toMatchObject({ problems: 1 });
    const [problem] = await openProblems();
    expect(problem?.reason).toContain(`could not check the Sent folder of ${SAM}`);
    expect(problem?.reason).toContain("ETIMEDOUT");
    expect((await reload(unknown.id)).reconcile_checks).toBe(3);
  });

  it("asks a person at once when the mailbox has no Sent folder", async () => {
    await unknownEmail();
    fakeImap.folders = [
      {
        path: "INBOX",
        name: "INBOX",
        specialUse: "\\Inbox",
        flags: [],
        uidValidity: 7n,
        messages: [],
      },
    ];
    expect((await reconcile()).email).toMatchObject({ problems: 1 });
    expect((await openProblems())[0]?.reason).toContain("it has no Sent folder");
  });
});

describe("reconciling unknown emails without IMAP", () => {
  it("asks a person at once and never opens a connection", async () => {
    await setMailbox({ imap: null });
    const unknown = await unknownEmail();
    expect((await reconcile()).email).toMatchObject({ checked: 1, problems: 1 });
    expect(fakeImap.options).toHaveLength(0);
    const [problem] = await openProblems();
    expect(problem?.reason).toContain("no IMAP access");
    expect((await reload(unknown.id)).reconcile_checks).toBe(3);
    // Nothing left to do for it.
    expect((await reconcile()).email.checked).toBe(0);
  });

  it("checks the sandbox outbox for sandbox mailboxes", async () => {
    const sandbox = await seedMailbox(ctx, { email: "sandbox@brand.example.com" });
    const inOutbox = await unknownEmail({ mailbox_id: sandbox.id });
    const missing = await unknownEmail({ mailbox_id: sandbox.id });
    await sandboxTransport({
      mailboxId: sandbox.id,
      workspaceId: ctx.workspace.id,
      clock: ctx.clock,
    }).send({
      from: { name: "Sam Carter", address: sandbox.email },
      to: ["dana@harbor.example.com"],
      subject: "Checking in",
      text: "Hi Dana, a short note.",
      messageId: inOutbox.message_id_header ?? "",
      date: DISPATCHED,
      headers: {},
    });

    expect((await reconcile()).email).toMatchObject({ checked: 2, confirmed: 1, pending: 1 });
    expect((await reload(inOutbox.id)).status).toBe("sent");
    await reconcile();
    expect((await reconcile()).email).toMatchObject({ resent: 1 });
    expect((await reload(missing.id)).status).toBe("scheduled");
    expect(fakeImap.options).toHaveLength(0);
    // The outbox is the engine's own record, no proof about a real server.
    const [box] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, sandbox.id));
    expect(box?.sent_copies_seen_at).toBeNull();
  });
});

describe("sweeping sends stuck in sending", () => {
  it("settles sends with no job left, and leaves live or recent ones alone", async () => {
    fakeImap.folders = withSent([]);
    const long = new Date(NOW.getTime() - 20 * 60_000);
    const stuck = await unknownEmail({ status: "sending", dispatch_started_at: long });
    const live = await unknownEmail({ status: "sending", dispatch_started_at: long });
    const recent = await unknownEmail({ status: "sending", dispatch_started_at: NOW });
    const visit = await seedMessage(ctx, {
      channel: "linkedin",
      action: "visit",
      status: "sending",
      subject: null,
      body_text: "",
      person_id: dana.id,
      dispatch_started_at: long,
    });
    await ctx.db.insert(jobs).values({
      workspace_id: ctx.workspace.id,
      name: "email.send",
      payload: { message_id: live.id },
      status: "running",
      singleton_key: sendJobKey(live.id),
    });

    const summary = await reconcile();
    expect(summary.swept).toBe(2);
    const settled = await reload(stuck.id);
    expect(settled.status).toBe("unknown");
    expect(settled.error).toContain(INTERRUPTED_REASON);
    expect(ctx.emitted("message.unknown").map((event) => event.data)).toEqual([
      { message_id: stuck.id, channel: "email", reason: INTERRUPTED_REASON },
    ]);
    // The IMAP mailbox leaves it to the Sent folder lookups, which start in the same run.
    expect(summary.email).toMatchObject({ checked: 1, pending: 1 });
    expect(await openProblems()).toHaveLength(0);
    // A visit is harmless to repeat (at least once by design): queued again with a new job.
    expect((await reload(visit.id)).status).toBe("scheduled");
    expect(ctx.enqueued("linkedin.action")).toEqual([
      expect.objectContaining({
        payload: { message_id: visit.id },
        options: expect.objectContaining({ singletonKey: `linkedin.action:${visit.id}` }),
      }),
    ]);
    expect((await reload(live.id)).status).toBe("sending");
    expect((await reload(recent.id)).status).toBe("sending");

    // Once its job is gone, the live one is swept too.
    await ctx.db
      .update(jobs)
      .set({ status: "failed" })
      .where(and(eq(jobs.singleton_key, sendJobKey(live.id)), eq(jobs.status, "running")));
    expect((await reconcile()).swept).toBe(1);
    expect((await reload(live.id)).status).toBe("unknown");
  });
});

describe("scheduled emails whose send job is gone", () => {
  it("queues one again 15 minutes past its time, and it goes out", async () => {
    const sandbox = await seedMailbox(ctx, { email: "sandbox@brand.example.com" });
    const scheduled = (minutesAgo: number) =>
      seedMessage(ctx, {
        person_id: dana.id,
        mailbox_id: sandbox.id,
        to_address: dana.email,
        status: "scheduled",
        scheduled_for: new Date(NOW.getTime() - minutesAgo * 60_000),
        subject: "Checking in",
        body_text: "Hi Dana, a short note.",
      });
    // Its job was cancelled with jobs.cancel, or ended without settling the message.
    const lost = await scheduled(180);
    const recent = await scheduled(10);
    const parked = await scheduled(180);
    await ctx.db.insert(jobs).values({
      workspace_id: ctx.workspace.id,
      name: "email.send",
      payload: { message_id: parked.id },
      status: "waiting",
      singleton_key: sendJobKey(parked.id),
    });

    expect((await reconcile()).requeued).toBe(1);
    expect(ctx.enqueued("email.send")).toEqual([
      expect.objectContaining({
        payload: { message_id: lost.id },
        options: expect.objectContaining({ runAt: NOW, singletonKey: sendJobKey(lost.id) }),
      }),
    ]);
    expect((await sendEmailMessage(ctx.jobContext(), lost.id)).status).toBe("sent");
    expect(getSandboxOutbox()).toHaveLength(1);
    expect((await reload(recent.id)).status).toBe("scheduled");
  });
});
