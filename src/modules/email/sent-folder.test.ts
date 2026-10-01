import { and, eq } from "drizzle-orm";
import type { ListResponse } from "imapflow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enrollments,
  type Mailbox,
  mailboxes,
  messages,
  type Person,
  problems,
  type Thread,
  threads,
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
import {
  type FakeImapFolder,
  type FakeImapMessage,
  fakeImap,
  resetFakeImap,
} from "../../testing/fake-imap.js";
import { storePasswords } from "./credentials.js";
import { findSentFolder } from "./imap.js";
import { syncMailbox } from "./sync-job.js";
import { openEmailUnknownProblem } from "./unknown-sends.js";

vi.mock("imapflow", async () => (await import("../../testing/fake-imap.js")).fakeImapModule());
vi.mock("../leads/service.js", async () => (await import("./test-support.js")).fakeLeadsService);
vi.mock("../../runtime/notify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/notify.js")>()),
  notify: vi.fn(async () => {}),
}));

const NOW = new Date("2026-09-21T16:00:00Z");

let ctx: TestContext;
let mailbox: Mailbox;
let dana: Person;
let thread: Thread;

function sentRaw(input: {
  to: string;
  subject: string;
  id: string;
  inReplyTo?: string;
  references?: string;
  body: string;
  extra?: string[];
  date?: string;
}): string {
  return [
    "From: Sam Carter <sam@brand.example.com>",
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    `Message-ID: ${input.id}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(input.references ? [`References: ${input.references}`] : []),
    ...(input.extra ?? []),
    `Date: ${input.date ?? "Mon, 21 Sep 2026 15:45:00 +0000"}`,
    "",
    input.body,
    "",
  ].join("\r\n");
}

function sent(uid: number, source: string, at = "2026-09-21T15:45:00Z"): FakeImapMessage {
  return { uid, source, internalDate: new Date(at) };
}

function folders(sentMessages: FakeImapMessage[], sentFolder: Partial<FakeImapFolder> = {}) {
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
      path: "Sent Items",
      name: "Sent Items",
      flags: [],
      uidValidity: 5n,
      messages: sentMessages,
      ...sentFolder,
    },
  ] satisfies FakeImapFolder[];
}

async function reloadMailbox() {
  const [row] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, mailbox.id));
  if (!row) throw new Error("mailbox missing");
  return row;
}

async function external() {
  return ctx.db
    .select()
    .from(messages)
    .where(and(eq(messages.workspace_id, ctx.workspace.id), eq(messages.origin, "external")));
}

beforeEach(async () => {
  resetFakeImap();
  ctx = await createTestContext({ now: NOW });
  const secretId = await storePasswords(ctx, ctx.workspace.id, "sam@brand.example.com", "app-pass");
  mailbox = await seedMailbox(ctx, {
    email: "sam@brand.example.com",
    provider_label: "custom",
    auth_type: "password",
    secret_id: secretId,
    smtp: { host: "smtp.example.org", port: 465, secure: true, user: "sam@brand.example.com" },
    imap: { host: "imap.example.org", port: 993, secure: true, user: "sam@brand.example.com" },
  });
  dana = await seedPerson(ctx, { email: "dana@harbor.example.com", status: "replied" });
  thread = await seedThread(ctx, {
    person_id: dana.id,
    mailbox_id: mailbox.id,
    needs_attention: true,
    last_inbound_at: new Date("2026-09-21T15:30:00Z"),
    last_message_at: new Date("2026-09-21T15:30:00Z"),
  });
  await seedMessage(ctx, {
    thread_id: thread.id,
    person_id: dana.id,
    mailbox_id: mailbox.id,
    to_address: dana.email,
    status: "sent",
    sent_at: new Date("2026-09-20T15:00:00Z"),
    message_id_header: "<out-1@brand.example.com>",
  });
  await seedMessage(ctx, {
    thread_id: thread.id,
    person_id: dana.id,
    mailbox_id: mailbox.id,
    direction: "inbound",
    action: "reply",
    status: "received",
    received_at: new Date("2026-09-21T15:30:00Z"),
    message_id_header: "<r1@harbor.example.com>",
  });
});
afterEach(async () => {
  await ctx.close();
});

describe("findSentFolder", () => {
  const entry = (path: string, name: string, extra: Partial<ListResponse> = {}) =>
    ({ path, name, flags: new Set<string>(), ...extra }) as ListResponse;

  it("prefers the special-use flag, then common names on the leaf", () => {
    expect(
      findSentFolder([
        entry("INBOX", "INBOX"),
        entry("Sent", "Sent"),
        entry("[Gmail]/Sent Mail", "Sent Mail", { specialUse: "\\Sent" }),
      ]),
    ).toBe("[Gmail]/Sent Mail");
    expect(findSentFolder([entry("INBOX", "INBOX"), entry("Sent Items", "Sent Items")])).toBe(
      "Sent Items",
    );
    expect(findSentFolder([entry("INBOX", "INBOX"), entry("INBOX.Sent", "Sent")])).toBe(
      "INBOX.Sent",
    );
    expect(findSentFolder([entry("Sent Messages", "Sent Messages")])).toBe("Sent Messages");
    expect(
      findSentFolder([entry("[Gmail]", "[Gmail]", { flags: new Set(["\\Noselect"]) })]),
    ).toBeNull();
    expect(findSentFolder([entry("INBOX", "INBOX"), entry("Archive", "Archive")])).toBeNull();
  });
});

describe("Sent folder sync", () => {
  it("keeps its own cursor: 3 days back at first, then new UIDs only", async () => {
    fakeImap.folders = folders([
      sent(
        3,
        sentRaw({ to: "friend@elsewhere.example.org", subject: "Lunch", id: "<a@b>", body: "x" }),
      ),
    ]);
    const first = await syncMailbox(ctx.jobContext(), mailbox.id);
    expect(first.sent).toMatchObject({ folder: "Sent Items", seen: 1, ignored: 1, stored: 0 });
    const sentSearch = fakeImap.searches.find((search) => search.path === "Sent Items");
    expect(sentSearch?.query).toEqual({ since: new Date(NOW.getTime() - 3 * 86_400_000) });
    const row = await reloadMailbox();
    expect(row.sync_state.sent).toEqual({ path: "Sent Items", uidvalidity: 5, last_uid: 3 });
    // The INBOX cursor is kept apart.
    expect(row.sync_state.folders).toEqual({ INBOX: { uidvalidity: 7, last_uid: 0 } });

    fakeImap.searches = [];
    fakeImap.folders[1]?.messages.push(
      sent(
        4,
        sentRaw({ to: "friend@elsewhere.example.org", subject: "Again", id: "<c@d>", body: "y" }),
      ),
    );
    const next = await syncMailbox(ctx.jobContext(), mailbox.id);
    expect(next.sent).toMatchObject({ seen: 1 });
    expect(fakeImap.searches.find((search) => search.path === "Sent Items")?.query).toEqual({
      uid: "4:*",
    });

    // A new UIDVALIDITY starts over from the lookback.
    const sentFolder = fakeImap.folders[1] as FakeImapFolder;
    sentFolder.uidValidity = 6n;
    fakeImap.searches = [];
    await syncMailbox(ctx.jobContext(), mailbox.id);
    expect(fakeImap.searches.find((search) => search.path === "Sent Items")?.query).toHaveProperty(
      "since",
    );
    expect((await reloadMailbox()).sync_state.sent).toMatchObject({ uidvalidity: 6 });
  });

  it("confirms an unknown send by its copy and records the proof that the server keeps copies", async () => {
    const unknown = await seedMessage(ctx, {
      person_id: dana.id,
      mailbox_id: mailbox.id,
      to_address: dana.email,
      status: "unknown",
      subject: "Checking in",
      body_text: "Hi Dana, a short note.",
      message_id_header: "<ours-7@brand.example.com>",
      dispatch_started_at: new Date("2026-09-21T15:20:00Z"),
    });
    await openEmailUnknownProblem(ctx, unknown, mailbox.email, "timeout");
    expect((await reloadMailbox()).sent_copies_seen_at).toBeNull();
    fakeImap.folders = folders([
      sent(
        9,
        sentRaw({
          to: "dana@harbor.example.com",
          subject: "Checking in",
          id: "<ours-7@brand.example.com>",
          body: "Hi Dana, a short note.",
        }),
      ),
    ]);
    const summary = await syncMailbox(ctx.jobContext(), mailbox.id);
    expect(summary.sent).toMatchObject({ confirmed: 1, stored: 0 });
    const [row] = await ctx.db.select().from(messages).where(eq(messages.id, unknown.id));
    expect(row).toMatchObject({ status: "sent", origin: "engine" });
    expect(row?.sent_at?.toISOString()).toBe("2026-09-21T15:20:00.000Z");
    expect(ctx.emitted("message.sent")[0]?.data).toMatchObject({ message_id: unknown.id });
    expect((await reloadMailbox()).sent_copies_seen_at).toEqual(ctx.clock.now());
    const [problem] = await ctx.db.select().from(problems);
    expect(problem?.status).toBe("resolved");
    // Nothing new is stored for our own mail, and the body was never downloaded.
    expect(await external()).toHaveLength(0);
    expect(fakeImap.fetches.filter((fetch) => fetch.query.source)).toHaveLength(0);
  });

  it("drops a resend still in the queue when the first try's copy turns up", async () => {
    const queued = await seedMessage(ctx, {
      person_id: dana.id,
      mailbox_id: mailbox.id,
      to_address: dana.email,
      status: "scheduled",
      scheduled_for: new Date("2026-09-22T13:00:00Z"),
      subject: "Checking in",
      body_text: "Hi Dana, a short note.",
      message_id_header: "<ours-8@brand.example.com>",
      dispatch_started_at: new Date("2026-09-21T15:20:00Z"),
      why: { resent_after_unknown: "2026-09-21T15:50:00.000Z" },
    });
    fakeImap.folders = folders([
      sent(
        9,
        sentRaw({
          to: "dana@harbor.example.com",
          subject: "Checking in",
          id: "<ours-8@brand.example.com>",
          body: "Hi Dana, a short note.",
        }),
      ),
    ]);
    const summary = await syncMailbox(ctx.jobContext(), mailbox.id);
    expect(summary.sent).toMatchObject({ confirmed: 1 });
    const [row] = await ctx.db.select().from(messages).where(eq(messages.id, queued.id));
    expect(row).toMatchObject({ status: "sent" });
    expect(row?.sent_at?.toISOString()).toBe("2026-09-21T15:20:00.000Z");
    expect(ctx.emitted("message.sent")[0]?.data).toMatchObject({ message_id: queued.id });
  });

  it("stores a person's reply in a thread as external and takes the thread over", async () => {
    const autoReply = await seedMessage(ctx, {
      thread_id: thread.id,
      person_id: dana.id,
      mailbox_id: mailbox.id,
      action: "reply",
      status: "scheduled",
      scheduled_for: new Date("2026-09-21T17:00:00Z"),
      why: { notes: "reply:interested" },
    });
    fakeImap.folders = folders([
      sent(
        12,
        sentRaw({
          to: "Dana Reyes <dana@harbor.example.com>",
          subject: "Re: Quick question",
          id: "<human-1@brand.example.com>",
          inReplyTo: "<r1@harbor.example.com>",
          references: "<out-1@brand.example.com> <r1@harbor.example.com>",
          body: "Hi Dana, I will call you tomorrow.\r\n\r\n> Sounds good, send details.",
        }),
      ),
    ]);
    const summary = await syncMailbox(ctx.jobContext(), mailbox.id);
    expect(summary.sent).toMatchObject({ stored: 1 });

    const [stored] = await external();
    expect(stored).toMatchObject({
      thread_id: thread.id,
      person_id: dana.id,
      campaign_id: null,
      enrollment_id: null,
      direction: "outbound",
      action: "reply",
      status: "sent",
      origin: "external",
      subject: "Re: Quick question",
      from_address: "sam@brand.example.com",
      to_address: "dana@harbor.example.com",
      mailbox_id: mailbox.id,
      message_id_header: "<human-1@brand.example.com>",
      in_reply_to: "<r1@harbor.example.com>",
      references: ["<out-1@brand.example.com>", "<r1@harbor.example.com>"],
    });
    expect(stored?.body_text).toContain("I will call you tomorrow.");
    expect(stored?.sent_at?.toISOString()).toBe("2026-09-21T15:45:00.000Z");
    expect(stored?.headers).toMatchObject({ "message-id": "<human-1@brand.example.com>" });

    const [owned] = await ctx.db.select().from(threads).where(eq(threads.id, thread.id));
    expect(owned).toMatchObject({ owner: "person", needs_attention: false, status: "waiting" });
    const [cancelled] = await ctx.db.select().from(messages).where(eq(messages.id, autoReply.id));
    expect(cancelled).toMatchObject({ status: "cancelled", error: "superseded_by_person" });
    expect(ctx.emitted("thread.taken_over")[0]?.data).toEqual({
      thread_id: thread.id,
      person_id: dana.id,
      message_id: stored?.id,
    });
    // A person's email is not an engine send.
    expect(ctx.emitted("message.sent")).toHaveLength(0);

    // Seen again (a new UIDVALIDITY): stored once.
    (fakeImap.folders[1] as FakeImapFolder).uidValidity = 99n;
    await syncMailbox(ctx.jobContext(), mailbox.id);
    expect(await external()).toHaveLength(1);
  });

  it("starts a thread the person owns for a new email to a lead and stops their sequences", async () => {
    const lee = await seedPerson(ctx, { email: "lee@northwind.example.com", status: "active" });
    const { campaign } = await seedCampaign(ctx, { status: "active" });
    const enrollment = await seedEnrollment(ctx, {
      campaign_id: campaign.id,
      person_id: lee.id,
      status: "active",
    });
    fakeImap.folders = folders([
      sent(
        20,
        sentRaw({
          to: "lee@northwind.example.com",
          subject: "Following our call",
          id: "<human-2@brand.example.com>",
          body: "Hi Lee, as promised, the pilot details.",
        }),
      ),
    ]);
    const summary = await syncMailbox(ctx.jobContext(), mailbox.id);
    expect(summary.sent).toMatchObject({ stored: 1 });

    const [stored] = await external();
    expect(stored).toMatchObject({ person_id: lee.id, action: "email", origin: "external" });
    const [created] = await ctx.db
      .select()
      .from(threads)
      .where(eq(threads.id, stored?.thread_id ?? ""));
    expect(created).toMatchObject({
      person_id: lee.id,
      owner: "person",
      subject: "Following our call",
      external_ref: "<human-2@brand.example.com>",
      mailbox_id: mailbox.id,
    });
    const [stopped] = await ctx.db
      .select()
      .from(enrollments)
      .where(eq(enrollments.id, enrollment.id));
    expect(stopped).toMatchObject({ status: "stopped", stop_reason: "person_took_over" });
    expect(ctx.emitted("thread.taken_over")[0]?.data.message_id).toBe(stored?.id);
  });

  it("finds the lead by address whatever letter case the To header uses", async () => {
    const lee = await seedPerson(ctx, { email: "lee@northwind.example.com", status: "active" });
    fakeImap.folders = folders([
      sent(
        21,
        sentRaw({
          to: "Lee Park <Lee@NorthWind.Example.com>",
          subject: "Pilot details",
          id: "<human-3@brand.example.com>",
          body: "Hi Lee, the pilot details as promised.",
        }),
      ),
    ]);
    const summary = await syncMailbox(ctx.jobContext(), mailbox.id);
    expect(summary.sent).toMatchObject({ stored: 1 });
    const [stored] = await external();
    expect(stored).toMatchObject({ person_id: lee.id, origin: "external" });
  });

  it("ignores warmup, bulk, automatic and unrelated mail without storing or downloading it", async () => {
    fakeImap.folders = folders([
      sent(
        30,
        sentRaw({
          to: "warm@network.example.org",
          subject: "Checking in",
          id: "<w1@brand.example.com>",
          body: "hello",
          extra: ["X-Warmup-Id: abc123"],
        }),
      ),
      sent(
        31,
        sentRaw({
          to: "dana@harbor.example.com",
          subject: "Automatic reply: out of office",
          id: "<oof@brand.example.com>",
          body: "I am away.",
          extra: ["Auto-Submitted: auto-replied"],
        }),
      ),
      sent(
        32,
        sentRaw({
          to: "dana@harbor.example.com",
          subject: "Our newsletter",
          id: "<news@brand.example.com>",
          body: "News",
          extra: ["List-Unsubscribe: <mailto:leave@brand.example.com>"],
        }),
      ),
      sent(
        33,
        sentRaw({
          to: "accountant@elsewhere.example.org",
          subject: "Invoice",
          id: "<inv@brand.example.com>",
          body: "Attached.",
        }),
      ),
      // A forward of the thread to a colleague who is not a lead: not a reply.
      sent(
        34,
        sentRaw({
          to: "boss@brand.example.com",
          subject: "Fwd: Quick question",
          id: "<fwd@brand.example.com>",
          references: "<out-1@brand.example.com> <r1@harbor.example.com>",
          body: "FYI",
        }),
      ),
      sent(
        35,
        sentRaw({
          to: "dana@harbor.example.com",
          subject: "Hello",
          id: "<body-warm@brand.example.com>",
          body: "Greetings WARMUP-TAG-77",
        }),
      ),
    ]);
    await ctx.db
      .update(mailboxes)
      .set({ warmup_patterns: ["warmup-tag-77"] })
      .where(eq(mailboxes.id, mailbox.id));
    const summary = await syncMailbox(ctx.jobContext(), mailbox.id);
    expect(summary.sent).toMatchObject({ seen: 6, stored: 0, ignored: 6, errors: 0 });
    expect(await external()).toHaveLength(0);
    const [unchanged] = await ctx.db.select().from(threads).where(eq(threads.id, thread.id));
    expect(unchanged?.owner).toBe("engine");
    // Only the mail to a lead without warmup headers had its body downloaded (it had the tag).
    const downloads = fakeImap.fetches.filter((fetch) => fetch.query.source);
    expect(downloads.flatMap((fetch) => fetch.uids)).toEqual([35]);
    expect((await reloadMailbox()).sync_state.sent?.last_uid).toBe(35);
  });

  it("does not read the Sent folder when the setting is off", async () => {
    await ctx.close();
    ctx = await createTestContext({ now: NOW, settings: { inbox: { read_sent_folder: false } } });
    const secretId = await storePasswords(ctx, ctx.workspace.id, "sam@brand.example.com", "pw");
    mailbox = await seedMailbox(ctx, {
      email: "sam@brand.example.com",
      provider_label: "custom",
      auth_type: "password",
      secret_id: secretId,
      imap: { host: "imap.example.org", port: 993, secure: true, user: "sam@brand.example.com" },
    });
    fakeImap.folders = folders([
      sent(1, sentRaw({ to: "x@elsewhere.example.org", subject: "x", id: "<x@y>", body: "x" })),
    ]);
    const summary = await syncMailbox(ctx.jobContext(), mailbox.id);
    expect(summary.sent).toBeUndefined();
    expect(fakeImap.searches.map((search) => search.path)).toEqual(["INBOX"]);
    expect((await reloadMailbox()).sync_state.sent).toBeUndefined();
  });

  it("keeps syncing replies when the mailbox has no Sent folder", async () => {
    fakeImap.folders = [folders([])[0] as FakeImapFolder];
    const summary = await syncMailbox(ctx.jobContext(), mailbox.id);
    expect(summary).toMatchObject({ status: "synced", sent: { folder: null, seen: 0 } });
    expect((await reloadMailbox()).sync_state.sent).toBeNull();
  });
});
