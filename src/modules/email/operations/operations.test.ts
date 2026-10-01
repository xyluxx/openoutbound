import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { SMTPServer } from "smtp-server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { AnyZodObject, OperationDefinition } from "../../../core/operation.js";
import { toolOperationIds } from "../../../core/operation.js";
import { approvals, mailboxes, messages, sender_counters } from "../../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../../testing/context.js";
import { seedMailbox, seedMessage } from "../../../testing/factories.js";
import { DEFAULT_RAMP } from "../capacity.js";
import { storePasswords } from "../credentials.js";
import { module } from "../index.js";
import { mailboxLimitsResolver } from "../limits-approval.js";
import { RAMP_OFF_WARNING } from "../mailbox-limits.js";
import { verifyState } from "../oauth.js";
import { closeSmtpPools } from "../smtp-transport.js";
import { addMailbox } from "./add.js";
import { checkDnsOperation } from "./dns.js";
import { manageMailboxesTool } from "./index.js";
import { listMailboxes } from "./list.js";
import { oauthStartOperation } from "./oauth-start.js";
import { pauseMailboxOperation, resumeMailboxOperation, testMailboxOperation } from "./status.js";
import { removeMailbox, updateMailbox } from "./update.js";

vi.mock("../../../runtime/notify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/notify.js")>()),
  notify: vi.fn(async () => {}),
}));

const ENV = {
  MAILBOX_SAM_PASSWORD: "app-pass-123",
  OPENAI_API_KEY: "not-for-mailboxes",
  GOOGLE_OAUTH_CLIENT_ID: "client-123.apps.example.com",
  GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
};

let ctx: TestContext;
afterEach(async () => {
  closeSmtpPools();
  await ctx?.close();
});

async function setup(options: { sandbox?: boolean; allowPrivateNetwork?: boolean } = {}) {
  ctx = await createTestContext({
    now: "2026-09-21T15:00:00.000Z",
    sandbox: options.sandbox ?? false,
    config: { env: ENV, allowPrivateNetwork: options.allowPrivateNetwork ?? false },
  });
  return ctx;
}

/** Runs an operation the way the executor does: parse input, handler, parse output. */
async function run<I extends AnyZodObject, O extends z.ZodType>(
  op: OperationDefinition<I, O>,
  input: z.input<I>,
  context: TestContext = ctx,
): Promise<z.output<O>> {
  const result = await op.handler(context, op.input.parse(input));
  return op.output.parse(result);
}

type UpdateResult = z.output<typeof updateMailbox.output>;

/** The result of an update that applied at once. */
function applied(result: UpdateResult) {
  if ("approval_id" in result) throw new Error(`expected the update to apply: ${result.summary}`);
  return result;
}

/** The result of an update that waits for a human approval. */
function held(result: UpdateResult) {
  if (!("approval_id" in result)) throw new Error("expected the update to wait for an approval");
  return result;
}

async function failure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e as { code?: string; message?: string; hint?: string },
  );
  if (!error) throw new Error("expected a failure");
  return error;
}

describe("manage_mailboxes tool", () => {
  it("maps every action to a registered operation", () => {
    const ids = new Set((module.operations ?? []).map((op) => op.id));
    expect(Object.keys(manageMailboxesTool.actions)).toEqual([
      "list",
      "add",
      "import_csv",
      "update",
      "remove",
      "pause",
      "resume",
      "test",
      "check_dns",
      "oauth_start",
    ]);
    for (const id of toolOperationIds(manageMailboxesTool)) expect(ids.has(id)).toBe(true);
    expect(module.jobs?.map((job) => job.name)).toEqual([
      "email.send",
      "email.sync_all",
      "email.sync_mailbox",
      "email.health_check",
      "email.dns_daily_check",
      "email.reconcile_sends",
    ]);
    expect(module.schedules?.map((schedule) => schedule.cron)).toEqual([
      "*/5 * * * *",
      "7 * * * *",
      "17 6 * * *",
      "*/10 * * * *",
    ]);
  });
});

describe("mailboxes.add", () => {
  it("adds a Google mailbox with an app password from the environment", async () => {
    await setup();
    const result = await run(addMailbox, {
      email: "Sam@Brand.example.com",
      from_name: "Sam Carter",
      preset: "google",
      password_env: "MAILBOX_SAM_PASSWORD",
    });
    if (!("mailbox" in result)) throw new Error("expected a created mailbox");
    // Playbook ramp: no cold email in the first two weeks, warming until week 8.
    expect(result.mailbox).toMatchObject({
      email: "sam@brand.example.com",
      provider: "google",
      auth_type: "password",
      status: "warming",
      daily_limit: 30,
      today_limit: 0,
      ramp: { day: 0, today_limit: 0, full_limit: 30, complete: false },
      has_credentials: true,
      // Google likely keeps what SMTP sends in the Sent folder, but only a copy found proves it.
      saves_sent_copies: null,
      sent_copies_seen_at: null,
    });
    expect(JSON.stringify(result)).not.toContain("app-pass-123");
    const [row] = await ctx.db.select().from(mailboxes);
    expect(row?.sent_copies_seen_at).toBeNull();
    expect(row?.smtp).toEqual({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      user: "sam@brand.example.com",
    });
    expect(JSON.stringify(row?.smtp)).not.toContain("app-pass");
    expect(await ctx.vault.getSecret(row?.secret_id ?? "", ctx.workspace.id)).toContain(
      "app-pass-123",
    );
    expect(result.next_steps.join(" ")).toContain("check_dns");
    expect(result.next_steps.join(" ")).toContain("No cold email for the first 14 days");
  });

  it("refuses password login for Microsoft 365 and points to OAuth", async () => {
    await setup();
    const preset = await failure(
      run(addMailbox, { email: "sam@brand.example.com", preset: "microsoft", password: "x" }),
    );
    expect(preset.code).toBe("validation_failed");
    expect(preset.hint).toContain("oauth_start");
    const host = await failure(
      run(addMailbox, {
        email: "sam@brand.example.com",
        smtp_host: "smtp.office365.com",
        imap_host: "outlook.office365.com",
        password: "x",
      }),
    );
    expect(host.message).toContain("Microsoft 365");
  });

  it("refuses onmicrosoft.com senders", async () => {
    await setup();
    const error = await failure(
      run(addMailbox, {
        email: "sam@brandco.onmicrosoft.com",
        preset: "custom",
        smtp_host: "smtp.example.org",
        password: "x",
      }),
    );
    expect(error.code).toBe("validation_failed");
    expect(error.hint).toContain("custom domain");
  });

  it("validates hosts, env names, duplicates and missing passwords", async () => {
    await setup();
    expect(() =>
      addMailbox.input.parse({ email: "a@b.example.com", password_env: "OPENAI_API_KEY" }),
    ).toThrow();
    const missing = await failure(run(addMailbox, { email: "a@b.example.com", preset: "google" }));
    expect(missing.message).toContain("needs a password");
    const local = await failure(
      run(addMailbox, { email: "a@b.example.com", smtp_host: "127.0.0.1", password: "x" }),
    );
    expect(local.message).toContain("private");
    const gaps = await failure(
      run(addMailbox, {
        email: "a@b.example.com",
        smtp_host: "smtp.example.org",
        password: "x",
        min_gap_seconds: 900,
        max_gap_seconds: 300,
      }),
    );
    expect(gaps.message).toContain("min_gap_seconds");
    await run(addMailbox, {
      email: "a@b.example.com",
      smtp_host: "smtp.example.org",
      password: "x",
    });
    const duplicate = await failure(
      run(addMailbox, { email: "A@b.example.com", smtp_host: "smtp.example.org", password: "x" }),
    );
    expect(duplicate.code).toBe("conflict");
  });

  it("previews without writing on dry runs", async () => {
    await setup();
    const preview = await run(
      addMailbox,
      { email: "sam@brand.example.com", preset: "zoho", password: "x", warmed_up: true },
      ctx.with({ request: { dryRun: true } }),
    );
    expect(preview).toMatchObject({
      dry_run: true,
      preview: {
        email: "sam@brand.example.com",
        provider: "zoho",
        smtp: { host: "smtp.zoho.com", port: 465, security: "tls" },
        // Pre-warmed: the ramp starts at week 5.
        ramp_start: 15,
      },
    });
    expect(await ctx.db.select().from(mailboxes)).toHaveLength(0);
  });

  it("needs no password in sandbox workspaces", async () => {
    await setup({ sandbox: true });
    const result = await run(addMailbox, { email: "sam@brand.example.com", test: true });
    expect(result).toMatchObject({
      // No domain to set up: the ramp skips the two quiet weeks.
      mailbox: { auth_type: "sandbox", has_credentials: true, status: "warming", today_limit: 5 },
      test: { smtp: "ok", imap: "skipped", error: null },
    });
  });
});

describe("mailboxes.list", () => {
  it("pages through mailboxes with today's usage", async () => {
    await setup();
    const a = await seedMailbox(ctx, { daily_limit: 40, ramp: null });
    const b = await seedMailbox(ctx, { status: "paused", status_reason: "Bounce rate 4%" });
    await ctx.db.insert(sender_counters).values({
      sender_type: "mailbox",
      sender_id: a.id,
      day: "2026-09-21",
      action: "email",
      count: 7,
    });
    await seedMessage(ctx, {
      mailbox_id: a.id,
      status: "scheduled",
      scheduled_for: new Date("2026-09-21T18:00:00Z"),
    });
    const first = await run(listMailboxes, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.has_more).toBe(true);
    expect(first.items[0]).toMatchObject({
      id: a.id,
      today_limit: 40,
      sent_today: 7,
      scheduled_today: 1,
      ramp: null,
      // Not known until a copy of one of its emails shows up in the Sent folder.
      saves_sent_copies: null,
    });
    const second = await run(listMailboxes, { limit: 1, cursor: first.next_cursor ?? "" });
    expect(second).toMatchObject({ items: [{ id: b.id }], has_more: false, next_cursor: null });
    const paused = await run(listMailboxes, { status: "paused" });
    expect(paused.items.map((item) => item.status_reason)).toEqual(["Bounce rate 4%"]);
  });
});

describe("mailboxes.update and remove", () => {
  it("changes limits, gaps, ramp and password", async () => {
    await setup();
    const mailbox = await seedMailbox(ctx, {
      provider_label: "custom",
      auth_type: "password",
      smtp: { host: "smtp.example.org", port: 587, secure: false, user: "sender@example.org" },
    });
    const result = applied(
      await run(updateMailbox, {
        mailbox_id: mailbox.id,
        daily_limit: 45,
        max_gap_seconds: 900,
        restart_ramp: true,
        smtp_port: 465,
        password_env: "MAILBOX_SAM_PASSWORD",
      }),
    );
    expect(result.changed).toEqual(
      expect.arrayContaining(["daily_limit", "max_gap_seconds", "ramp", "smtp", "password"]),
    );
    const [row] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, mailbox.id));
    expect(row?.smtp).toMatchObject({ host: "smtp.example.org", port: 465, secure: true });
    expect(row?.ramp).toMatchObject({ enabled: true, started_at: "2026-09-21" });
    expect(await ctx.vault.getSecret(row?.secret_id ?? "")).toContain("app-pass-123");

    const gaps = await failure(
      run(updateMailbox, { mailbox_id: mailbox.id, min_gap_seconds: 1000 }),
    );
    expect(gaps.message).toContain("larger than");
    const nothing = await failure(run(updateMailbox, { mailbox_id: mailbox.id }));
    expect(nothing.message).toContain("Nothing to update");
    const missing = await failure(
      run(updateMailbox, { mailbox_id: "mbx_missing", daily_limit: 5 }),
    );
    expect(missing.code).toBe("not_found");
  });

  it("forgets the proof of sent copies when the server or login changes, not the port", async () => {
    await setup();
    const proven = new Date("2026-09-20T09:00:00Z");
    const mailbox = await seedMailbox(ctx, {
      provider_label: "custom",
      auth_type: "password",
      smtp: { host: "smtp.example.org", port: 587, secure: false, user: "sender@example.org" },
      imap: { host: "imap.example.org", port: 993, secure: true, user: "sender@example.org" },
      sent_copies_seen_at: proven,
    });
    const proof = async () => {
      const [row] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, mailbox.id));
      return row?.sent_copies_seen_at ?? null;
    };
    applied(await run(updateMailbox, { mailbox_id: mailbox.id, smtp_port: 465 }));
    expect(await proof()).toEqual(proven);
    const moved = applied(
      await run(updateMailbox, { mailbox_id: mailbox.id, smtp_host: "mail.example.org" }),
    );
    expect(moved.mailbox).toMatchObject({ saves_sent_copies: null, sent_copies_seen_at: null });
    expect(await proof()).toBeNull();
  });

  /** A mailbox one week into the default ramp: still in its two quiet weeks. */
  async function warmingMailbox(overrides: Parameters<typeof seedMailbox>[1] = {}) {
    return seedMailbox(ctx, {
      status: "warming",
      daily_limit: 30,
      ramp: { ...DEFAULT_RAMP, started_at: "2026-09-14" },
      created_at: new Date("2026-09-14T09:00:00Z"),
      ...overrides,
    });
  }

  /** A mailbox whose ramp reached its daily limit long ago. */
  async function warmedMailbox() {
    return seedMailbox(ctx, {
      status: "active",
      daily_limit: 30,
      ramp: { ...DEFAULT_RAMP, delay_days: 0, started_at: "2026-05-04" },
      created_at: new Date("2026-05-04T09:00:00Z"),
    });
  }

  const agent = () => ctx.with({ principal: { type: "agent", id: "key_agent", name: "Agent" } });
  const decidedBy = { type: "human" as const, id: "usr_test", name: "Test User" };

  async function reload(id: string) {
    const [row] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, id));
    if (!row) throw new Error("mailbox is gone");
    return row;
  }

  async function pendingLimits() {
    return ctx.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.kind, "mailbox_limits"), eq(approvals.status, "pending")));
  }

  it("warns like add when the daily limit goes above the safe level or the ramp is turned off", async () => {
    await setup();
    const mailbox = await warmedMailbox();
    const raised = applied(await run(updateMailbox, { mailbox_id: mailbox.id, daily_limit: 120 }));
    expect(raised.changed).toEqual(["daily_limit"]);
    expect(raised.warnings).toEqual([
      "daily_limit 120 is high for cold email; 30 a mailbox is the safe default.",
    ]);
    const off = applied(await run(updateMailbox, { mailbox_id: mailbox.id, ramp: null }));
    expect(off.warnings).toEqual([RAMP_OFF_WARNING]);
    const calm = applied(await run(updateMailbox, { mailbox_id: mailbox.id, signature: "Sam" }));
    expect(calm.warnings).toEqual([]);
    // A human's change applies at once.
    expect(await reload(mailbox.id)).toMatchObject({ daily_limit: 120, ramp: null });
    expect(await pendingLimits()).toEqual([]);
  });

  it("asks a human before an agent raises the daily limit above the safe level", async () => {
    await setup();
    const mailbox = await warmedMailbox();
    const result = held(
      await run(updateMailbox, { mailbox_id: mailbox.id, daily_limit: 120 }, agent()),
    );
    expect(result.summary).toContain("raise the daily limit from 30 to 120 a day");
    expect(result.summary).toContain("review_items");
    expect((await reload(mailbox.id)).daily_limit).toBe(30);
    const [approval, ...others] = await pendingLimits();
    if (!approval) throw new Error("no approval");
    expect(others).toEqual([]);
    expect(approval).toMatchObject({
      id: result.approval_id,
      target_type: "mailbox",
      target_id: mailbox.id,
      payload: { mailbox_id: mailbox.id, daily_limit: 120 },
    });
    // A newer request for the mailbox replaces this one.
    expect(ctx.recorded.approvals[0]?.request).toMatchObject({
      kind: "mailbox_limits",
      target: { type: "mailbox", id: mailbox.id },
      supersede: true,
    });

    // Reject keeps the limit; approve (here edited down to 60) applies it; a bad edit fails.
    const rejected = await mailboxLimitsResolver.apply(ctx, approval, {
      decision: "reject",
      decidedBy,
    });
    expect(rejected.message).toContain("keeps");
    expect((await reload(mailbox.id)).daily_limit).toBe(30);
    const edit = (daily_limit: number) =>
      mailboxLimitsResolver.apply(
        ctx,
        { ...approval, payload: { ...approval.payload, daily_limit } },
        { decision: "edit", edits: { daily_limit }, decidedBy },
      );
    const invalid = await failure(edit(5000));
    expect(invalid.code).toBe("validation_failed");
    expect(invalid.hint).toContain("review_items");
    expect((await reload(mailbox.id)).daily_limit).toBe(30);
    expect((await edit(60)).message).toContain("up to 60 a day");
    expect((await reload(mailbox.id)).daily_limit).toBe(60);

    // Lowering the limit, or raising it up to the safe level, needs no approval.
    const lower = applied(
      await run(updateMailbox, { mailbox_id: mailbox.id, daily_limit: 55 }, agent()),
    );
    expect(lower.warnings.join(" ")).toContain("high for cold email");
    expect((await reload(mailbox.id)).daily_limit).toBe(55);
    await run(updateMailbox, { mailbox_id: mailbox.id, daily_limit: 20 }, agent());
    applied(await run(updateMailbox, { mailbox_id: mailbox.id, daily_limit: 50 }, agent()));
    expect((await reload(mailbox.id)).daily_limit).toBe(50);
  });

  it("asks a human before an agent turns off or shortens the ramp of a warming mailbox", async () => {
    await setup();
    const mailbox = await warmingMailbox();
    for (const change of [
      { ramp: { start: 20, increment: 10 } },
      { ramp: { delay_days: 0 } },
      { restart_ramp: true },
      { ramp: { enabled: false } },
      { ramp: null },
    ]) {
      const result = await run(updateMailbox, { mailbox_id: mailbox.id, ...change }, agent());
      expect(result, JSON.stringify(change)).toMatchObject({ status: "awaiting_approval" });
    }
    expect(await reload(mailbox.id)).toMatchObject({
      status: "warming",
      ramp: { ...DEFAULT_RAMP, started_at: "2026-09-14" },
    });
    const pending = await pendingLimits();
    expect(pending).toHaveLength(5);

    // A slower ramp is always fine.
    const slower = applied(
      await run(
        updateMailbox,
        { mailbox_id: mailbox.id, ramp: { start: 5, increment: 5, every_days: 14 } },
        agent(),
      ),
    );
    expect(slower).toMatchObject({ changed: ["ramp"], warnings: [] });

    // Approving turns the ramp off.
    const off = pending.find((row) => row.payload.ramp === null);
    if (!off) throw new Error("no approval");
    const approved = await mailboxLimitsResolver.apply(ctx, off, {
      decision: "approve",
      decidedBy,
    });
    expect(approved.message).toContain("no ramp");
    expect(await reload(mailbox.id)).toMatchObject({ ramp: null, status: "active" });
  });

  it("lets an agent change a finished ramp at once and holds only the volume change", async () => {
    await setup();
    const warmed = await warmedMailbox();
    const off = applied(await run(updateMailbox, { mailbox_id: warmed.id, ramp: null }, agent()));
    expect(off).toMatchObject({ changed: ["ramp"], warnings: [RAMP_OFF_WARNING] });
    expect((await reload(warmed.id)).ramp).toBeNull();

    const warming = await warmingMailbox({ email: "lee@example.org" });
    const mixed = held(
      await run(
        updateMailbox,
        { mailbox_id: warming.id, signature: "Lee, Brightline", ramp: null },
        agent(),
      ),
    );
    expect(mixed.summary).toContain("Changed now: signature.");
    expect(await reload(warming.id)).toMatchObject({
      signature: "Lee, Brightline",
      status: "warming",
      ramp: { enabled: true },
    });
    // A human turns it off at once, with the same warning.
    const human = applied(await run(updateMailbox, { mailbox_id: warming.id, ramp: null }));
    expect(human.warnings).toEqual([RAMP_OFF_WARNING]);
    expect(await reload(warming.id)).toMatchObject({ ramp: null, status: "active" });
  });

  it("registers the mailbox_limits resolver", () => {
    expect(module.approvalResolvers?.map((resolver) => resolver.kind)).toContain("mailbox_limits");
  });

  it("keeps OAuth mailboxes on OAuth", async () => {
    await setup();
    const mailbox = await seedMailbox(ctx, {
      provider_label: "microsoft",
      auth_type: "oauth_microsoft",
    });
    const error = await failure(run(updateMailbox, { mailbox_id: mailbox.id, password: "x" }));
    expect(error.hint).toContain("oauth_start");
  });

  it("removes a mailbox and its secrets, previewing scheduled emails first", async () => {
    await setup();
    const secretId = await storePasswords(ctx, ctx.workspace.id, "sender@example.org", "pw");
    const mailbox = await seedMailbox(ctx, {
      email: "sender@example.org",
      auth_type: "password",
      provider_label: "custom",
      secret_id: secretId,
    });
    await seedMessage(ctx, {
      mailbox_id: mailbox.id,
      status: "scheduled",
      scheduled_for: new Date(),
    });
    const preview = await run(
      removeMailbox,
      { mailbox_id: mailbox.id },
      ctx.with({ request: { dryRun: true } }),
    );
    expect(preview).toMatchObject({ dry_run: true, preview: { scheduled_messages: 1 } });
    expect(await run(removeMailbox, { mailbox_id: mailbox.id })).toMatchObject({ removed: true });
    expect(await ctx.db.select().from(mailboxes)).toHaveLength(0);
    expect(await ctx.vault.getSecret(secretId)).toBeNull();
    expect(await ctx.db.select().from(messages)).toHaveLength(1);
    // Emails held on it move or fail now.
    expect(ctx.recorded.wakes).toContain(`mailbox_active:${mailbox.id}`);
  });
});

describe("mailboxes.pause and resume", () => {
  it("pauses with the caller's reason and resumes with a fresh ramp", async () => {
    await setup();
    const mailbox = await seedMailbox(ctx, {
      daily_limit: 40,
      health: { consecutive_failures: 3, throttled_until: "2026-09-22T00:00:00.000Z" },
    });
    const paused = await run(
      pauseMailboxOperation,
      { mailbox_id: mailbox.id },
      ctx.with({ request: { reason: "Fixing DMARC first" } }),
    );
    expect(paused).toMatchObject({ status: "paused", status_reason: "Fixing DMARC first" });
    expect(ctx.emitted("mailbox.paused")).toHaveLength(1);
    // Pausing twice is harmless.
    await run(pauseMailboxOperation, { mailbox_id: mailbox.id });
    expect(ctx.emitted("mailbox.paused")).toHaveLength(1);

    const resumed = await run(resumeMailboxOperation, {
      mailbox_id: mailbox.id,
      restart_ramp: true,
    });
    // restart_ramp restarts at the ramp start (5 a day), not at half the daily limit.
    expect(resumed.mailbox).toMatchObject({
      status: "warming",
      status_reason: null,
      consecutive_failures: 0,
      throttled_until: null,
      today_limit: 5,
      ramp: { day: 0, today_limit: 5, full_limit: 40 },
    });
    expect(ctx.recorded.wakes).toContain(`mailbox_active:${mailbox.id}`);
  });

  it("keeps a person's pause over a timed auto-pause and warns on an early resume", async () => {
    await setup();
    const until = new Date(ctx.clock.now().getTime() + 48 * 3_600_000).toISOString();
    const autoPause = {
      kind: "provider_block" as const,
      at: ctx.clock.now().toISOString(),
      status: "4.7.28",
      domain: "example.org",
      until,
    };
    const mailbox = await seedMailbox(ctx, {
      status: "paused",
      status_reason: "Gmail refused mail as unsolicited",
      health: { auto_pause: autoPause },
    });
    await run(pauseMailboxOperation, { mailbox_id: mailbox.id });
    const [held] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, mailbox.id));
    // It no longer ends by itself, and queued mail still waits.
    expect(held?.health.auto_pause).toMatchObject({ kind: "provider_block", until: null });

    const other = await seedMailbox(ctx, {
      status: "paused",
      health: { auto_pause: autoPause },
    });
    const resumed = await run(resumeMailboxOperation, { mailbox_id: other.id });
    expect(resumed.warnings.join(" ")).toContain("4.7.28");
    const [row] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, other.id));
    expect(row).toMatchObject({ status: "active" });
    expect(row?.health.auto_pause).toBeNull();
  });
});

describe("mailboxes.test", () => {
  let server: SMTPServer;
  let port = 0;
  beforeAll(async () => {
    server = new SMTPServer({
      logger: false,
      disabledCommands: ["STARTTLS"],
      allowInsecureAuth: true,
      onAuth(auth, _session, callback) {
        if (auth.password === "right") callback(null, { user: auth.username });
        else callback(Object.assign(new Error("5.7.8 Bad credentials"), { responseCode: 535 }));
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function smtpMailbox(password: string, status: "active" | "error" = "active") {
    const secretId = await storePasswords(ctx, ctx.workspace.id, "sam@brand.example.com", password);
    return seedMailbox(ctx, {
      email: "sam@brand.example.com",
      provider_label: "custom",
      auth_type: "password",
      status,
      secret_id: secretId,
      smtp: { host: "127.0.0.1", port, secure: false, user: "sam@brand.example.com" },
    });
  }

  it("reports a refused login and marks the mailbox error", async () => {
    await setup();
    const mailbox = await smtpMailbox("wrong");
    const result = await run(testMailboxOperation, { mailbox_id: mailbox.id });
    expect(result).toMatchObject({
      smtp: "failed",
      imap: "skipped",
      auth_failed: true,
      status: "error",
    });
    expect(result.hint).toContain("password_env");
  });

  it("adds a mailbox whose login test failed and names the failed login first", async () => {
    await setup({ allowPrivateNetwork: true });
    // MAILBOX_SAM_PASSWORD is not the password this server takes: the SMTP login is refused.
    const result = await run(addMailbox, {
      email: "sam@brand.example.com",
      preset: "custom",
      smtp_host: "127.0.0.1",
      smtp_port: port,
      smtp_security: "starttls",
      password_env: "MAILBOX_SAM_PASSWORD",
      test: true,
    });
    if (!("mailbox" in result)) throw new Error("expected the mailbox to be added");
    expect(result.test).toMatchObject({ smtp: "failed", auth_failed: true });
    // The mailbox stays added, so the person can fix the password and test again.
    expect(await ctx.db.select().from(mailboxes)).toHaveLength(1);
    const first = result.next_steps[0] ?? "";
    expect(first).toMatch(
      /^The login test failed: sending \(SMTP\) failed \(SMTP: .*Bad credentials/,
    );
    expect(first).toContain("cannot send until it passes");
    expect(first).toContain("MAILBOX_SAM_PASSWORD");
    expect(first).toContain("restart `openoutbound serve`");
    expect(first).toContain(`manage_mailboxes action test (mailbox_id ${result.mailbox.id})`);
    expect(result.next_steps.some((step) => step.startsWith("Verify the login"))).toBe(false);
  });

  it("brings an error mailbox back after a clean login", async () => {
    await setup();
    const mailbox = await smtpMailbox("right", "error");
    const result = await run(testMailboxOperation, { mailbox_id: mailbox.id });
    expect(result).toMatchObject({ smtp: "ok", error: null, status: "active", hint: null });
    // Emails held on it while it could not send go out now.
    expect(ctx.recorded.wakes).toContain(`mailbox_active:${mailbox.id}`);
    // Kept for workspace readiness, which counts a mailbox as tested from it.
    const [row] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, mailbox.id));
    expect(row?.health.last_test).toEqual({
      at: ctx.clock.now().toISOString(),
      smtp: "ok",
      imap: "skipped",
    });
  });
});

describe("mailboxes.check_dns", () => {
  /** Records on the engine's DNS (ctx.dns); every other name answers ENOTFOUND. */
  function brandRecords() {
    ctx.dns.set("brand.example.com", {
      mx: ["aspmx.l.google.com"],
      txt: ["v=spf1 include:_spf.google.com ~all"],
    });
    ctx.dns.set("_dmarc.brand.example.com", { txt: ["v=DMARC1; p=none"] });
  }

  it("checks a mailbox domain through ctx.dns and stores the result on its mailboxes", async () => {
    await setup();
    brandRecords();
    const a = await seedMailbox(ctx, { email: "sam@brand.example.com", provider_label: "google" });
    await seedMailbox(ctx, { email: "lee@brand.example.com" });
    await seedMailbox(ctx, { email: "sam@other.example.org" });
    const result = await run(checkDnsOperation, { mailbox_id: a.id });
    expect(result).toMatchObject({
      domain: "brand.example.com",
      overall: "yellow",
      mailboxes_updated: 2,
    });
    const [row] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, a.id));
    expect(row?.dns).toMatchObject({
      overall: "yellow",
      mx: true,
      spf: true,
      dkim: false,
      dmarc: false,
    });
    expect(row?.dns?.issues.join(" ")).toContain("DMARC");
    const list = await run(listMailboxes, {});
    expect(list.items.filter((item) => item.dns?.overall === "yellow")).toHaveLength(2);
    expect(ctx.dns.lookups).toEqual(
      expect.arrayContaining([
        "mx:brand.example.com",
        "txt:brand.example.com",
        "txt:google._domainkey.brand.example.com",
        "txt:_dmarc.brand.example.com",
      ]),
    );
  });

  it("reads nothing but ctx.dns: a domain without records is red, not a lookup error", async () => {
    await setup();
    const result = await run(checkDnsOperation, { domain: "nothing-here.example.org" });
    expect(result).toMatchObject({ domain: "nothing-here.example.org", overall: "red" });
    expect(result.checks.find((check) => check.name === "mx")).toMatchObject({
      status: "red",
      records: [],
    });
    expect(ctx.dns.lookups).toContain("mx:nothing-here.example.org");
  });

  it("checks a bare domain without storing and validates input", async () => {
    await setup();
    brandRecords();
    expect(await run(checkDnsOperation, { domain: "Brand.Example.com." })).toMatchObject({
      domain: "brand.example.com",
      mailboxes_updated: 0,
    });
    expect((await failure(run(checkDnsOperation, {}))).message).toContain("exactly one");
    expect((await failure(run(checkDnsOperation, { domain: "not a domain" }))).code).toBe(
      "validation_failed",
    );
  });
});

describe("mailboxes.oauth_start", () => {
  it("returns a signed connect link bound to the workspace and draft", async () => {
    await setup();
    const result = await run(oauthStartOperation, {
      provider: "google",
      email: "Sam@Brand.example.com",
      daily_limit: 25,
    });
    expect(result.connect_url).toMatch(/^http:\/\/localhost:7331\/oauth\/google\/start\?state=/);
    expect(result.redirect_uri).toBe("http://localhost:7331/oauth/google/callback");
    expect(result.expires_at).toBe("2026-09-21T15:30:00.000Z");
    const token = decodeURIComponent(result.connect_url.split("state=")[1] ?? "");
    expect(verifyState(ctx.config, token, null)).toMatchObject({
      ws: ctx.workspace.id,
      p: "google",
      d: { email: "sam@brand.example.com", daily_limit: 25 },
    });
  });

  it("explains what is missing", async () => {
    await setup();
    expect((await failure(run(oauthStartOperation, { provider: "microsoft" }))).code).toBe(
      "provider_not_configured",
    );
    expect(
      (
        await failure(
          run(oauthStartOperation, { provider: "google", email: "a@x.onmicrosoft.com" }),
        )
      ).hint,
    ).toContain("custom domain");
    await ctx.close();
    await setup({ sandbox: true });
    expect((await failure(run(oauthStartOperation, { provider: "google" }))).code).toBe(
      "unsupported",
    );
  });
});
