/**
 * Mailbox reply sync failures: the failure is stored with its class next to the error text, a
 * refused IMAP login opens a `mailbox_down` problem for reading at once (sending stays as it
 * is), and a clean sync or IMAP test clears the failure and closes the problem. A message the
 * sync cannot store keeps blocking its folder, is reported on every sync, and after 3 syncs in
 * a row opens the same problem; storing it closes the problem.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Mailbox, mailboxes, messages, problems } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { seedMailbox } from "../../testing/factories.js";
import { fakeImap, resetFakeImap } from "../../testing/fake-imap.js";
import { storePasswords } from "./credentials.js";
import { mailboxReadDownKey } from "./mailbox-state.js";
import { testAndRecord } from "./mailbox-test.js";
import { syncMailbox } from "./sync-job.js";

vi.mock("../leads/service.js", async () => (await import("./test-support.js")).fakeLeadsService);
vi.mock("../../runtime/notify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/notify.js")>()),
  notify: vi.fn(async () => {}),
}));
vi.mock("imapflow", async () => (await import("../../testing/fake-imap.js")).fakeImapModule());

/** Message-ID headers the store refuses (a stand-in for a message that breaks the inbound path). */
const refusedIds = vi.hoisted(() => new Set<string>());
vi.mock("./inbound/ingest.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./inbound/ingest.js")>();
  return {
    ...original,
    ingestInboundEmail: async (...args: Parameters<typeof original.ingestInboundEmail>) => {
      if (refusedIds.has(args[1].messageIdHeader ?? "")) {
        throw new Error('value too long for type character varying(998) in "subject"');
      }
      return original.ingestInboundEmail(...args);
    },
  };
});

const NOW = new Date("2026-09-21T16:00:00Z");
const imap = fakeImap;

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
});

const refused = () =>
  Object.assign(new Error("Authentication failed"), { authenticationFailed: true });

async function stored() {
  const [row] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, mailbox.id));
  if (!row) throw new Error("mailbox gone");
  return row;
}

async function readProblems() {
  return ctx.db
    .select()
    .from(problems)
    .where(
      and(
        eq(problems.workspace_id, ctx.workspace.id),
        eq(problems.dedupe_key, mailboxReadDownKey(mailbox.id)),
      ),
    );
}

describe("a refused IMAP login", () => {
  it("is stored as auth_invalid and opens mailbox_down for reading at once", async () => {
    imap.connectError = refused();
    await syncMailbox(ctx.jobContext(), mailbox.id);

    const row = await stored();
    expect(row.status).toBe("active");
    expect(row.health.last_sync_failure).toEqual({
      class: "auth_invalid",
      retryable: false,
      scope: "account",
      provider: "imap",
    });
    const [problem] = await readProblems();
    expect(problem).toMatchObject({
      kind: "mailbox_down",
      severity: "high",
      owner: "person",
      status: "open",
      subject_type: "mailbox",
      subject_id: mailbox.id,
    });
    expect(problem?.title).toContain("cannot read replies");
    expect(problem?.remedy).toContain("manage_mailboxes action test");

    // Failing again refreshes the same problem.
    await syncMailbox(ctx.jobContext(), mailbox.id);
    expect(await readProblems()).toHaveLength(1);

    // A clean sync clears the failure and closes the problem.
    imap.connectError = null;
    imap.folders = [
      {
        path: "INBOX",
        name: "INBOX",
        specialUse: String.raw`\Inbox`,
        flags: [],
        uidValidity: 7n,
        messages: [],
      },
    ];
    expect((await syncMailbox(ctx.jobContext(), mailbox.id)).status).toBe("synced");
    expect((await stored()).health).toMatchObject({
      last_sync_error: null,
      last_sync_failure: null,
      sync_error_since: null,
    });
    expect((await readProblems()).map((p) => p.status)).toEqual(["resolved"]);
  });

  it("found by a mailbox test does the same, and a clean test closes it", async () => {
    imap.connectError = refused();
    await testAndRecord(ctx, ctx.workspace, { ...mailbox, smtp: null });
    expect((await stored()).health.last_sync_failure).toMatchObject({ class: "auth_invalid" });
    expect((await readProblems()).map((p) => p.status)).toEqual(["open"]);

    imap.connectError = null;
    await testAndRecord(ctx, ctx.workspace, { ...mailbox, smtp: null });
    expect((await stored()).health.last_sync_failure).toBeNull();
    expect((await readProblems()).map((p) => p.status)).toEqual(["resolved"]);
  });
});

describe("a message the sync cannot store", () => {
  const message = (uid: number, id: string) => ({
    uid,
    internalDate: new Date("2026-09-21T15:30:00Z"),
    source: [
      "From: Dana Reyes <dana@harbor.example.com>",
      "To: sam@brand.example.com",
      "Subject: Please remove me",
      `Message-ID: ${id}`,
      "Date: Mon, 21 Sep 2026 15:30:00 +0000",
      "",
      "Please take me off your list.",
      "",
    ].join("\r\n"),
  });

  it("keeps blocking its folder, is not a clean sync, and opens the read problem after 3 syncs", async () => {
    refusedIds.add("<stuck-1@harbor.example.com>");
    imap.folders = [
      {
        path: "INBOX",
        name: "INBOX",
        specialUse: String.raw`\Inbox`,
        flags: [],
        uidValidity: 7n,
        messages: [
          message(41, "<stuck-1@harbor.example.com>"),
          message(42, "<later-1@harbor.example.com>"),
        ],
      },
    ];
    for (let sync = 1; sync <= 2; sync++) {
      const summary = await syncMailbox(ctx.jobContext(), mailbox.id);
      expect(summary).toMatchObject({
        status: "error",
        stuck: { folder: "INBOX", uid: 41, syncs: sync },
      });
      ctx.clock.advance(5 * 60_000);
    }
    const row = await stored();
    // Nothing after the message is skipped: the folder waits at it.
    expect(row.sync_state.folders?.INBOX).toMatchObject({ last_uid: 40 });
    expect(await ctx.db.select().from(messages).where(eq(messages.mailbox_id, mailbox.id))).toEqual(
      [],
    );
    expect(row.health).toMatchObject({
      stuck_message: { folder: "INBOX", uid: 41, syncs: 2 },
      sync_error_since: NOW.toISOString(),
    });
    expect(row.health.last_sync_error).toContain("UID 41 in INBOX");
    expect(row.health.last_sync_error).toContain("value too long");
    expect(row.health.last_sync_failure).not.toBeNull();
    expect(row.last_synced_at).toBeNull();
    expect(await readProblems()).toEqual([]);

    await syncMailbox(ctx.jobContext(), mailbox.id);
    const [problem] = await readProblems();
    expect(problem).toMatchObject({
      kind: "mailbox_down",
      severity: "high",
      owner: "person",
      status: "open",
      title: "Mailbox sam@brand.example.com cannot read replies",
      subject_type: "mailbox",
      subject_id: mailbox.id,
      data: { mailbox_id: mailbox.id, folder: "INBOX", uid: 41, syncs: 3 },
    });
    expect(problem?.reason).toContain("UID 41");

    // A clean login test does not close it: the message still blocks the folder.
    await testAndRecord(ctx, ctx.workspace, { ...mailbox, smtp: null });
    expect((await readProblems()).map((p) => p.status)).toEqual(["open"]);
    expect((await stored()).health.stuck_message).toMatchObject({ uid: 41 });

    // Once it can be stored, the sync goes on and the problem closes.
    refusedIds.clear();
    const clean = await syncMailbox(ctx.jobContext(), mailbox.id);
    expect(clean).toMatchObject({ status: "synced", fetched: 2 });
    expect(clean).not.toHaveProperty("stuck");
    expect((await stored()).health).toMatchObject({
      stuck_message: null,
      last_sync_error: null,
      last_sync_failure: null,
    });
    expect((await stored()).sync_state.folders?.INBOX).toMatchObject({ last_uid: 42 });
    expect((await readProblems()).map((p) => p.status)).toEqual(["resolved"]);
  });
});

describe("network trouble", () => {
  it("is stored as a temporary failure without a problem", async () => {
    imap.connectError = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
    await syncMailbox(ctx.jobContext(), mailbox.id);
    expect((await stored()).health.last_sync_failure).toMatchObject({
      class: "timeout",
      retryable: true,
      provider: "imap",
    });
    expect(await readProblems()).toHaveLength(0);
  });
});
