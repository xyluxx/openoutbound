import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Mailbox, mailboxes, messages, suppressions } from "../../db/schema/index.js";
import { notify } from "../../runtime/notify.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { seedMailbox, seedMessage, seedPerson, seedThread } from "../../testing/factories.js";
import {
  type FakeImapFolder,
  type FakeImapMessage,
  fakeImap,
  resetFakeImap,
} from "../../testing/fake-imap.js";
import { storePasswords } from "./credentials.js";
import { testAndRecord } from "./mailbox-test.js";
import { SYNC_MAILBOX_JOB, syncAllJob, syncJobKey, syncMailbox } from "./sync-job.js";

vi.mock("../leads/service.js", async () => (await import("./test-support.js")).fakeLeadsService);
vi.mock("../../runtime/notify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/notify.js")>()),
  notify: vi.fn(async () => {}),
}));

type FakeMessage = FakeImapMessage;
type FakeFolder = FakeImapFolder;

vi.mock("imapflow", async () => (await import("../../testing/fake-imap.js")).fakeImapModule());

/** What the fake IMAP server holds (shared with the mocked ImapFlow class). */
const imap = fakeImap;

const NOW = new Date("2026-09-21T16:00:00Z");

function raw(input: {
  from: string;
  subject: string;
  id: string;
  inReplyTo?: string;
  body: string;
  extra?: string;
}) {
  return [
    `From: ${input.from}`,
    "To: sam@brand.example.com",
    `Subject: ${input.subject}`,
    `Message-ID: ${input.id}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(input.extra ? [input.extra] : []),
    "Date: Mon, 21 Sep 2026 15:30:00 +0000",
    "",
    input.body,
    "",
  ].join("\r\n");
}

let ctx: TestContext;
let mailbox: Mailbox;

beforeEach(async () => {
  resetFakeImap();
  ctx = await createTestContext({ now: NOW });
  const secretId = await storePasswords(ctx, ctx.workspace.id, "sam@brand.example.com", "app-pass");
  mailbox = await seedMailbox(ctx, {
    email: "sam@brand.example.com",
    provider_label: "google",
    auth_type: "password",
    secret_id: secretId,
    smtp: { host: "smtp.gmail.com", port: 465, secure: true, user: "sam@brand.example.com" },
    imap: { host: "imap.gmail.com", port: 993, secure: true, user: "sam@brand.example.com" },
  });
  const person = await seedPerson(ctx, { email: "dana@harbor.example.com", status: "active" });
  const thread = await seedThread(ctx, { person_id: person.id, mailbox_id: mailbox.id });
  await seedMessage(ctx, {
    thread_id: thread.id,
    person_id: person.id,
    mailbox_id: mailbox.id,
    to_address: "dana@harbor.example.com",
    status: "sent",
    sent_at: new Date("2026-09-21T15:00:00Z"),
    message_id_header: "<out-1@brand.example.com>",
  });
});
afterEach(async () => {
  await ctx.close();
});

function gmailFolders(inbox: FakeMessage[], spam: FakeMessage[] = []): FakeFolder[] {
  return [
    {
      path: "INBOX",
      name: "INBOX",
      specialUse: "\\Inbox",
      flags: [],
      uidValidity: 7n,
      messages: inbox,
    },
    { path: "[Gmail]", name: "[Gmail]", flags: ["\\Noselect"], uidValidity: 1n, messages: [] },
    {
      path: "[Gmail]/Sent Mail",
      name: "Sent Mail",
      specialUse: "\\Sent",
      flags: [],
      uidValidity: 3n,
      messages: [],
    },
    {
      path: "[Gmail]/Spam",
      name: "Spam",
      specialUse: "\\Junk",
      flags: [],
      uidValidity: 9n,
      messages: spam,
    },
  ];
}

const reply = (uid: number, id: string, body = "Sounds good, send details.") => ({
  uid,
  internalDate: new Date("2026-09-21T15:30:00Z"),
  source: raw({
    from: "Dana Reyes <dana@harbor.example.com>",
    subject: "Re: Quick question",
    id,
    inReplyTo: "<out-1@brand.example.com>",
    body,
  }),
});

describe("IMAP sync", () => {
  it("reads INBOX and spam, routes everything through the inbound path and tracks UIDs", async () => {
    imap.folders = gmailFolders(
      [
        reply(11, "<r1@harbor.example.com>"),
        {
          uid: 12,
          internalDate: new Date("2026-09-21T15:40:00Z"),
          source: raw({
            from: "warm@network.example.org",
            subject: "Checking in",
            id: "<w1@network.example.org>",
            body: "hello",
            extra: "X-Warmup-Id: abc123",
          }),
        },
      ],
      [reply(4, "<r2@harbor.example.com>", "Following up from spam, interested.")],
    );
    const summary = await syncMailbox(ctx.jobContext(), mailbox.id);
    expect(summary).toMatchObject({
      status: "synced",
      folders: 2,
      fetched: 3,
      kinds: { reply: 2, warmup: 1 },
      errors: 0,
    });
    const [row] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, mailbox.id));
    expect(row?.sync_state.folders).toEqual({
      INBOX: { uidvalidity: 7, last_uid: 12 },
      "[Gmail]/Spam": { uidvalidity: 9, last_uid: 4 },
    });
    expect(row?.last_synced_at?.toISOString()).toBe(NOW.toISOString());
    expect(ctx.emitted("reply.received")).toHaveLength(2);
    expect(imap.options[0]).toMatchObject({
      host: "imap.gmail.com",
      secure: true,
      logger: false,
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
      auth: { user: "sam@brand.example.com", pass: "app-pass" },
    });

    // Next run: only the new UID is fetched.
    imap.folders[0]?.messages.push(reply(13, "<r3@harbor.example.com>", "One more question."));
    imap.searches = [];
    const next = await syncMailbox(ctx.jobContext(), mailbox.id);
    expect(next).toMatchObject({ fetched: 1, kinds: { reply: 1 } });
    expect(imap.searches.find((search) => search.path === "INBOX")?.query).toEqual({ uid: "13:*" });
    const inbound = await ctx.db.select().from(messages).where(eq(messages.direction, "inbound"));
    expect(inbound).toHaveLength(3);
  });

  it("starts over (last 3 days) when UIDVALIDITY changes", async () => {
    imap.folders = gmailFolders([reply(11, "<r1@harbor.example.com>")]);
    await syncMailbox(ctx.jobContext(), mailbox.id);
    const inbox = imap.folders[0] as FakeFolder;
    inbox.uidValidity = 8n;
    inbox.messages = [reply(1, "<r1@harbor.example.com>")];
    imap.searches = [];
    const summary = await syncMailbox(ctx.jobContext(), mailbox.id);
    expect(imap.searches[0]?.query).toHaveProperty("since");
    // The same Message-ID is not stored twice.
    expect(summary.fetched).toBe(1);
    expect(
      await ctx.db.select().from(messages).where(eq(messages.direction, "inbound")),
    ).toHaveLength(1);
    const [row] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, mailbox.id));
    expect(row?.sync_state.folders?.INBOX).toEqual({ uidvalidity: 8, last_uid: 1 });
  });

  it("records a refused IMAP login apart from the sending status and notifies once", async () => {
    vi.mocked(notify).mockClear();
    imap.connectError = Object.assign(new Error("Authentication failed"), {
      authenticationFailed: true,
    });
    const summary = await syncMailbox(ctx.jobContext(), mailbox.id);
    expect(summary.status).toBe("error");
    const [row] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, mailbox.id));
    // Sending is not affected; the IMAP problem is recorded on its own.
    expect(row?.status).toBe("active");
    expect(row?.health).toMatchObject({
      last_sync_error: expect.stringContaining("IMAP login failed"),
      sync_error_since: NOW.toISOString(),
    });
    expect(ctx.emitted("mailbox.error")).toHaveLength(0);
    expect(vi.mocked(notify)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notify).mock.calls[0]?.[1].title).toContain("cannot read replies");

    // The next failed run records it again without a second notification.
    await syncMailbox(ctx.jobContext(), mailbox.id);
    expect(vi.mocked(notify)).toHaveBeenCalledTimes(1);

    // A clean sync clears it.
    imap.connectError = null;
    imap.folders = gmailFolders([]);
    expect((await syncMailbox(ctx.jobContext(), mailbox.id)).status).toBe("synced");
    const [clean] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, mailbox.id));
    expect(clean?.health).toMatchObject({ last_sync_error: null, sync_error_since: null });
  });

  it("keeps reading unsubscribe replies while SMTP is in error", async () => {
    await ctx.db
      .update(mailboxes)
      .set({ status: "error", status_reason: "Login failed: 535" })
      .where(eq(mailboxes.id, mailbox.id));
    imap.folders = gmailFolders([reply(21, "<u1@harbor.example.com>", "Please unsubscribe me.")]);
    const summary = await syncMailbox(ctx.jobContext(), mailbox.id);
    expect(summary).toMatchObject({ status: "synced", kinds: { unsubscribe: 1 } });
    const rows = await ctx.db.select().from(suppressions);
    expect(rows.map((row) => row.value)).toContain("dana@harbor.example.com");
    const [row] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, mailbox.id));
    expect(row?.status).toBe("error");
  });

  it("does not turn the mailbox to error when the IMAP test login fails", async () => {
    imap.connectError = Object.assign(new Error("Authentication failed"), {
      authenticationFailed: true,
    });
    const { result, mailbox: after } = await testAndRecord(ctx, ctx.workspace, {
      ...mailbox,
      smtp: null,
    });
    expect(result).toMatchObject({ imap: "failed", auth_failed: true });
    expect(after.status).toBe("active");
    expect(after.health.last_sync_error).toContain("IMAP login failed");
  });

  it("records network trouble without changing the status", async () => {
    imap.connectError = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
    const summary = await syncMailbox(ctx.jobContext(), mailbox.id);
    expect(summary.status).toBe("error");
    const [row] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, mailbox.id));
    expect(row?.status).toBe("active");
    expect(row?.health.last_sync_error).toContain("ETIMEDOUT");
  });

  it("fans out one singleton job per real mailbox with IMAP, error and paused ones included", async () => {
    await seedMailbox(ctx); // sandbox mailbox: skipped
    const imapServer = { host: "imap.example.org", port: 993, secure: true, user: "x@example.org" };
    const failing = await seedMailbox(ctx, {
      provider_label: "custom",
      auth_type: "password",
      status: "error",
      imap: imapServer,
    });
    const paused = await seedMailbox(ctx, {
      provider_label: "custom",
      auth_type: "password",
      status: "paused",
      imap: imapServer,
    });
    await seedMailbox(ctx, {
      provider_label: "custom",
      auth_type: "password",
      status: "disconnected",
      imap: imapServer,
    });
    await seedMailbox(ctx, { provider_label: "custom", auth_type: "password", imap: null });
    const result = await syncAllJob.handler(ctx.jobContext(), undefined);
    expect(result).toEqual({ enqueued: 3 });
    expect(
      ctx
        .enqueued(SYNC_MAILBOX_JOB)
        .map((job) => (job.payload as { mailbox_id: string }).mailbox_id)
        .sort(),
    ).toEqual([mailbox.id, failing.id, paused.id].sort());
    expect(ctx.enqueued(SYNC_MAILBOX_JOB)[0]?.options).toMatchObject({
      singletonKey: syncJobKey(mailbox.id),
    });
  });
});
