import { type AddressInfo, createServer } from "node:net";
import { and, eq } from "drizzle-orm";
import { SMTPServer } from "smtp-server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { JobWaitError } from "../../core/errors.js";
import {
  type Mailbox,
  mailboxes,
  messages,
  people,
  problems,
  sender_counters,
  suppressions,
  threads,
  workspaces,
} from "../../db/schema/index.js";
import type { EmailVerifierProvider } from "../../providers/types.js";
import { notify } from "../../runtime/notify.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import {
  seedCampaign,
  seedCompany,
  seedEnrollment,
  seedMailbox,
  seedMessage,
  seedPerson,
  seedThread,
} from "../../testing/factories.js";
import { stopEnrollments } from "../campaigns/control.js";
import { verifyEmailNow } from "../enrichment/service.js";
import { evaluateEmailGate } from "../relationships/gate.js";
import { storePasswords } from "./credentials.js";
import { testAndRecord } from "./mailbox-test.js";
import { removeMailbox } from "./operations/update.js";
import { planEmailSendWith } from "./plan.js";
import { queueEmailSend } from "./queue.js";
import { clearSandboxOutbox, getSandboxOutbox } from "./sandbox-transport.js";
import { confirmEmailSent, type SendOutcome, sendEmailMessage } from "./send-job.js";
import { openMailboxDown } from "./send-problems.js";
import { closeSmtpPools, setSmtpSendDeadline } from "./smtp-transport.js";
import { resolveUnknownOperation } from "./unknown-operations.js";
import { INTERRUPTED_REASON, RECONCILE_CHECKS, savesSentCopies } from "./unknown-sends.js";

vi.mock("../leads/service.js", async () => (await import("./test-support.js")).fakeLeadsService);
vi.mock("../../runtime/notify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/notify.js")>()),
  notify: vi.fn(async () => {}),
}));
vi.mock("../enrichment/service.js", () => ({ verifyEmailNow: vi.fn(async () => "valid") }));
vi.mock("./plan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./plan.js")>();
  return { ...actual, planEmailSendWith: vi.fn(actual.planEmailSendWith) };
});

interface Received {
  from: string;
  to: string[];
  raw: string;
}

const received: Received[] = [];
let server: SMTPServer;
let port = 0;
/** Runs once while the fake server holds a message's data, before it answers 250. */
const serverHooks: { beforeAccept: (() => Promise<void>) | null } = { beforeAccept: null };

/** Drops the client's connection without answering (the data already arrived). */
function dropConnection(sessionId: string): void {
  const { connections } = server as unknown as {
    connections: Set<{ id: string; _socket: { destroy(): void } }>;
  };
  for (const connection of connections) {
    if (connection.id === sessionId) connection._socket.destroy();
  }
}

/** A local port nothing listens on (connections to it are refused). */
async function closedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port: free } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return free;
}

function smtpError(code: number, message: string): Error {
  return Object.assign(new Error(message), { responseCode: code });
}

/** Recipient local part decides what the fake server answers. */
function rcptReply(address: string): Error | null {
  if (address.startsWith("unknown@")) return smtpError(550, "5.1.1 No such user here");
  return null;
}

function dataReply(to: string[]): Error | null {
  const first = to[0] ?? "";
  if (first.startsWith("content@")) return smtpError(554, "5.7.1 Message rejected due to content");
  if (first.startsWith("tempfail@")) return smtpError(451, "4.3.0 Temporary local problem");
  if (first.startsWith("ratelimit@")) {
    return smtpError(421, "4.7.0 Try again later, closing connection (rate limited)");
  }
  if (first.startsWith("dmarc@")) {
    return smtpError(550, "5.7.26 Unauthenticated email from brand.example.com is not accepted");
  }
  if (first.startsWith("spamrate@")) {
    return smtpError(421, "4.7.28 Our system has detected an unusual rate of unsolicited mail");
  }
  return null;
}

beforeAll(async () => {
  server = new SMTPServer({
    logger: false,
    disabledCommands: ["STARTTLS"],
    allowInsecureAuth: true,
    onAuth(auth, _session, callback) {
      if (auth.password !== "right-password") {
        callback(smtpError(535, "5.7.8 Authentication credentials invalid"));
        return;
      }
      callback(null, { user: auth.username });
    },
    onRcptTo(address, _session, callback) {
      const error = rcptReply(address.address);
      callback(error ?? undefined);
    },
    onData(stream, session, callback) {
      let raw = "";
      stream.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf8");
      });
      stream.on("end", () => {
        const to = session.envelope.rcptTo.map((rcpt) => rcpt.address);
        const from = session.envelope.mailFrom ? session.envelope.mailFrom.address : "";
        if (to[0]?.startsWith("drop@")) {
          // The server took the message, then the connection died before its answer.
          received.push({ from, to, raw });
          dropConnection(session.id);
          return;
        }
        const error = dataReply(to);
        if (error) {
          callback(error);
          return;
        }
        const accept = () => {
          received.push({ from, to, raw });
          callback(null, "Ok: queued as ABC123");
        };
        const hook = serverHooks.beforeAccept;
        serverHooks.beforeAccept = null;
        if (hook) hook().then(accept, (hookError: Error) => callback(hookError));
        else accept();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.server.address() as AddressInfo).port;
});

afterAll(async () => {
  closeSmtpPools();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let ctx: TestContext;
afterEach(async () => {
  closeSmtpPools();
  setSmtpSendDeadline();
  clearSandboxOutbox();
  received.length = 0;
  serverHooks.beforeAccept = null;
  vi.mocked(verifyEmailNow).mockClear();
  vi.mocked(notify).mockClear();
  vi.mocked(planEmailSendWith).mockClear();
  await ctx?.close();
});

const fakeVerifier = {
  id: "test_verifier",
  verify: async () => ({ status: "valid", creditsUsed: 0 }),
} as unknown as EmailVerifierProvider;

async function setup(
  options: {
    password?: string;
    sandbox?: boolean;
    baseUrl?: string;
    now?: string;
    verifier?: boolean;
    settings?: Record<string, unknown>;
  } = {},
) {
  ctx = await createTestContext({
    sandbox: options.sandbox ?? false,
    ...(options.now ? { now: options.now } : {}),
    config: { baseUrl: options.baseUrl ?? "https://engine.example.com" },
    settings: {
      company: { name: "Helix Outbound", postal_address: "12 Harbor Road, Austin" },
      ...options.settings,
    },
    ...(options.verifier ? { providers: { email_verifier: fakeVerifier } } : {}),
  });
  let mailbox: Mailbox;
  if (options.sandbox) {
    mailbox = await seedMailbox(ctx, { email: "sam@brand.example.com", from_name: "Sam Carter" });
  } else {
    const secretId = await storePasswords(
      ctx,
      ctx.workspace.id,
      "sam@brand.example.com",
      options.password ?? "right-password",
    );
    mailbox = await seedMailbox(ctx, {
      email: "sam@brand.example.com",
      from_name: "Sam Carter",
      provider_label: "custom",
      auth_type: "password",
      secret_id: secretId,
      smtp: { host: "127.0.0.1", port, secure: false, user: "sam@brand.example.com" },
    });
  }
  return mailbox;
}

async function scheduled(mailbox: Mailbox, email = "dana@harbor.example.com", overrides = {}) {
  const person = await seedPerson(ctx, { email, first_name: "Dana", status: "active" });
  const message = await seedMessage(ctx, {
    person_id: person.id,
    mailbox_id: mailbox.id,
    to_address: email,
    status: "scheduled",
    scheduled_for: ctx.clock.now(),
    subject: "Quick question, {{first_name}}",
    body_text: "Hi {{first_name}},\n\nShort note about scheduling.",
    ...overrides,
  });
  return { person, message };
}

async function reload(messageId: string) {
  const [row] = await ctx.db.select().from(messages).where(eq(messages.id, messageId));
  if (!row) throw new Error("message missing");
  return row;
}

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition never became true");
}

describe("email.send over SMTP", () => {
  it("sends, threads, counts and emits message.sent", async () => {
    const mailbox = await setup();
    const { person, message } = await scheduled(mailbox);
    const outcome = await sendEmailMessage(ctx.jobContext(), message.id);
    expect(outcome).toEqual({ message_id: message.id, status: "sent", mailbox_id: mailbox.id });

    const sent = await reload(message.id);
    expect(sent).toMatchObject({
      status: "sent",
      provider_message_id: "ABC123",
      subject: "Quick question, Dana",
      from_address: "sam@brand.example.com",
    });
    expect(sent.message_id_header).toMatch(/^<[0-9a-z]+\.[0-9a-f]{20}@brand\.example\.com>$/);
    expect(sent.thread_id).toBeTruthy();

    expect(received).toHaveLength(1);
    const raw = received[0]?.raw ?? "";
    expect(received[0]?.from).toBe("sam@brand.example.com");
    expect(raw).toContain("From: Sam Carter <sam@brand.example.com>");
    expect(raw).toMatch(/List-Unsubscribe:\s+<https:\/\/engine\.example\.com\/u\/[\w-]+\.[\w-]+>,/);
    expect(raw).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    expect(raw).toContain(`Message-ID: ${sent.message_id_header}`);
    expect(raw).not.toMatch(/^Precedence:/im);
    expect(raw).toContain("Hi Dana,");
    // The body is quoted-printable (long unsubscribe URL): check the stored rendering.
    expect(sent.body_text).toContain("Helix Outbound, 12 Harbor Road, Austin");
    expect(sent.body_text).toContain("Unsubscribe: https://engine.example.com/u/");

    const [counter] = await ctx.db.select().from(sender_counters);
    expect(counter).toMatchObject({ sender_id: mailbox.id, action: "email", count: 1 });
    const [contacted] = await ctx.db.select().from(people).where(eq(people.id, person.id));
    expect(contacted?.last_contacted_at?.toISOString()).toBe(ctx.clock.now().toISOString());
    expect(ctx.emitted("message.sent")[0]?.data).toMatchObject({
      message_id: message.id,
      thread_id: sent.thread_id,
      person_id: person.id,
      channel: "email",
    });

    // Running the job again does nothing (idempotent).
    expect(await sendEmailMessage(ctx.jobContext(), message.id)).toMatchObject({ status: "noop" });
    expect(received).toHaveLength(1);
  });

  it("never sends again a message whose outcome is unknown", async () => {
    const mailbox = await setup();
    const { message } = await scheduled(mailbox, "dana@harbor.example.com", {
      status: "unknown",
    });
    expect(await sendEmailMessage(ctx.jobContext(), message.id)).toEqual({
      message_id: message.id,
      status: "noop",
      reason: "status_unknown",
    });
    expect(received).toHaveLength(0);
    expect((await reload(message.id)).status).toBe("unknown");
    // Queueing it again is a no-op as well: only reconciliation may decide.
    await queueEmailSend(ctx, message.id);
    expect(ctx.enqueued("email.send")).toHaveLength(0);
  });

  it("replies in the thread with Re:, In-Reply-To and References", async () => {
    const mailbox = await setup();
    const person = await seedPerson(ctx, { email: "dana@harbor.example.com" });
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
      sent_at: new Date("2026-09-15T15:00:00Z"),
      message_id_header: "<first@brand.example.com>",
    });
    const followUp = await seedMessage(ctx, {
      thread_id: thread.id,
      person_id: person.id,
      mailbox_id: mailbox.id,
      action: "reply",
      to_address: "dana@harbor.example.com",
      status: "scheduled",
      scheduled_for: ctx.clock.now(),
      subject: "ignored for replies",
      body_text: "Bumping this up.",
    });
    expect(await sendEmailMessage(ctx.jobContext(), followUp.id)).toMatchObject({ status: "sent" });
    const raw = received[0]?.raw ?? "";
    expect(raw).toContain("Subject: Re: Quick question");
    expect(raw).toContain("In-Reply-To: <first@brand.example.com>");
    expect(raw).toContain("References: <first@brand.example.com>");
    expect((await reload(followUp.id)).thread_id).toBe(thread.id);
  });

  it("marks the mailbox error on a refused login and holds the email until a clean test", async () => {
    const mailbox = await setup({ password: "wrong-password" });
    const { message } = await scheduled(mailbox);
    const error = await sendEmailMessage(ctx.jobContext(), message.id).catch((e: unknown) => e);
    // No other mailbox can take it: it waits on this one and looks again within a day.
    expect(error).toBeInstanceOf(JobWaitError);
    expect((error as JobWaitError).waitFor).toBe(`mailbox_active:${mailbox.id}`);
    expect((error as JobWaitError).retryAt?.toISOString()).toBe(
      new Date(ctx.clock.now().getTime() + 24 * 3_600_000).toISOString(),
    );
    const [row] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, mailbox.id));
    expect(row?.status).toBe("error");
    expect(ctx.emitted("mailbox.error")).toHaveLength(1);
    expect(ctx.emitted("message.failed")).toHaveLength(0);
    expect((await reload(message.id)).status).toBe("scheduled");
    expect(received).toHaveLength(0);

    // The password is fixed and a clean test brings the mailbox back: the email goes out.
    const secretId = await storePasswords(
      ctx,
      ctx.workspace.id,
      "sam@brand.example.com",
      "right-password",
    );
    const [fixed] = await ctx.db
      .update(mailboxes)
      .set({ secret_id: secretId })
      .where(eq(mailboxes.id, mailbox.id))
      .returning();
    if (!fixed) throw new Error("mailbox missing");
    closeSmtpPools(mailbox.id);
    expect((await testAndRecord(ctx, ctx.workspace, fixed)).mailbox.status).toBe("active");
    expect(ctx.recorded.wakes).toContain(`mailbox_active:${mailbox.id}`);
    expect(await sendEmailMessage(ctx.jobContext(), message.id)).toMatchObject({ status: "sent" });
    expect(received).toHaveLength(1);
  });

  it("turns an unknown recipient into a hard bounce", async () => {
    const mailbox = await setup();
    const { person, message } = await scheduled(mailbox, "unknown@harbor.example.com");
    expect(await sendEmailMessage(ctx.jobContext(), message.id)).toMatchObject({
      status: "bounced",
    });
    expect((await reload(message.id)).status).toBe("bounced");
    const [bounced] = await ctx.db.select().from(people).where(eq(people.id, person.id));
    expect(bounced).toMatchObject({ status: "bounced", email_status: "invalid" });
    expect(await ctx.db.select().from(suppressions)).toHaveLength(1);
    expect(ctx.emitted("message.bounced")[0]?.data.bounce_type).toBe("hard");
  });

  it("fails the message on other permanent 5xx answers", async () => {
    const mailbox = await setup();
    const { message } = await scheduled(mailbox, "content@harbor.example.com");
    expect(await sendEmailMessage(ctx.jobContext(), message.id)).toMatchObject({
      status: "failed",
    });
    const failed = await reload(message.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("5.7.1");
    expect(ctx.emitted("message.failed")[0]?.data.retryable).toBe(false);
    const [row] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, mailbox.id));
    expect(row?.health.consecutive_failures).toBe(1);
  });

  it("retries temporary 4xx answers with backoff", async () => {
    const mailbox = await setup();
    const { message } = await scheduled(mailbox, "tempfail@harbor.example.com");
    await expect(sendEmailMessage(ctx.jobContext(), message.id)).rejects.toThrow(
      /Temporary send failure/,
    );
    expect((await reload(message.id)).status).toBe("scheduled");
    // On the last attempt the message fails for good instead of throwing, and says so.
    const last = await sendEmailMessage(ctx.jobContext({ attempt: 6, maxAttempts: 6 }), message.id);
    expect(last.status).toBe("failed");
    const failed = await reload(message.id);
    expect(failed.error).toMatch(/^Temporary errors until the retries ran out \(6 tries\): /);
    expect(ctx.emitted("message.failed").at(-1)?.data.retryable).toBe(false);
    const [problem] = await ctx.db
      .select()
      .from(problems)
      .where(and(eq(problems.workspace_id, ctx.workspace.id), eq(problems.kind, "send_failed")));
    expect(problem).toMatchObject({
      title: expect.stringContaining("temporary errors until the retries ran out"),
      data: expect.objectContaining({ class: "retries_used_up", count: 1 }),
    });
    expect(problem?.remedy).toContain("manage_mailboxes action test");
  });

  it("stops the mailbox for the day when the provider throttles", async () => {
    const mailbox = await setup();
    const { message } = await scheduled(mailbox, "ratelimit@harbor.example.com");
    const error = await sendEmailMessage(ctx.jobContext(), message.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobWaitError);
    // Throttled until the next workspace day (Sunday); the next working day is Monday.
    const [row] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, mailbox.id));
    expect(row?.health.throttled_until).toBe("2026-09-20T00:00:00.000Z");
    const monday = new Date("2026-09-21T00:00:00.000Z");
    expect((error as JobWaitError).retryAt?.toISOString()).toBe(monday.toISOString());
    expect(await reload(message.id)).toMatchObject({ status: "scheduled", scheduled_for: monday });
    expect(received).toHaveLength(0);
  });

  it("pauses the mailbox on sender-authentication rejections", async () => {
    const mailbox = await setup();
    const { message } = await scheduled(mailbox, "dmarc@harbor.example.com");
    const outcome = await sendEmailMessage(ctx.jobContext(), message.id).catch((e: unknown) => e);
    // No other mailbox: the message waits for the resume.
    expect(outcome).toBeInstanceOf(JobWaitError);
    expect((outcome as JobWaitError).waitFor).toBe(`mailbox_active:${mailbox.id}`);
    const [row] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, mailbox.id));
    expect(row?.status).toBe("paused");
    expect(ctx.emitted("mailbox.paused")).toHaveLength(1);
  });
});

describe("email.send safety checks", () => {
  it("skips suppressed recipients", async () => {
    const mailbox = await setup({ sandbox: true });
    const { message } = await scheduled(mailbox);
    await ctx.db.insert(suppressions).values({
      workspace_id: ctx.workspace.id,
      type: "domain",
      value: "harbor.example.com",
      reason: "manual",
    });
    expect(await sendEmailMessage(ctx.jobContext(), message.id)).toMatchObject({
      status: "skipped",
    });
    expect((await reload(message.id)).status).toBe("skipped");
    expect(ctx.emitted("message.failed")[0]?.data.retryable).toBe(false);
    expect(getSandboxOutbox()).toHaveLength(0);
  });

  it("waits while the workspace is paused", async () => {
    const mailbox = await setup({ sandbox: true });
    const { message } = await scheduled(mailbox);
    await ctx.db
      .update(workspaces)
      .set({ status: "paused" })
      .where(eq(workspaces.id, ctx.workspace.id));
    await ctx.reloadWorkspace();
    await expect(sendEmailMessage(ctx.jobContext(), message.id)).rejects.toBeInstanceOf(
      JobWaitError,
    );
    expect(getSandboxOutbox()).toHaveLength(0);
  });

  it("waits while its campaign is paused but still sends inbox replies", async () => {
    const mailbox = await setup({ sandbox: true });
    const { campaign } = await seedCampaign(ctx, { status: "paused" });
    const { message } = await scheduled(mailbox, "dana@harbor.example.com", {
      campaign_id: campaign.id,
    });
    const error = await sendEmailMessage(ctx.jobContext(), message.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobWaitError);
    expect((error as JobWaitError).waitFor).toBe(`campaign_active:${campaign.id}`);
    expect(getSandboxOutbox()).toHaveLength(0);

    const reply = await scheduled(mailbox, "lee@harbor.example.com", {
      campaign_id: campaign.id,
      action: "reply",
    });
    await sendEmailMessage(ctx.jobContext(), reply.message.id);
    expect(getSandboxOutbox()).toHaveLength(1);
  });

  it("refuses unresolved template variables", async () => {
    const mailbox = await setup({ sandbox: true });
    const { message } = await scheduled(mailbox, "dana@harbor.example.com", {
      body_text: "Hi {{nickname}}, short note.",
    });
    const outcome = await sendEmailMessage(ctx.jobContext(), message.id);
    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toContain("nickname");
  });

  it("sends through the sandbox outbox and bounces bounce+ addresses", async () => {
    const mailbox = await setup({ sandbox: true });
    const { message } = await scheduled(mailbox);
    expect(await sendEmailMessage(ctx.jobContext(), message.id)).toMatchObject({ status: "sent" });
    const [entry] = getSandboxOutbox({ workspaceId: ctx.workspace.id });
    expect(entry?.email.to).toEqual(["dana@harbor.example.com"]);
    expect(entry?.raw).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    const bounce = await scheduled(mailbox, "bounce+1@harbor.example.com");
    expect(await sendEmailMessage(ctx.jobContext(), bounce.message.id)).toMatchObject({
      status: "bounced",
    });
    expect(await ctx.db.select().from(threads)).toHaveLength(1);
  });

  it("never passes the daily cap when two sends of one mailbox run together", async () => {
    const mailbox = await setup();
    await ctx.db.update(mailboxes).set({ daily_limit: 1 }).where(eq(mailboxes.id, mailbox.id));
    const dana = await scheduled(mailbox, "dana@harbor.example.com");
    const lee = await scheduled(mailbox, "lee@harbor.example.com");
    let settled = false;
    let second: Promise<unknown> = Promise.resolve();
    serverHooks.beforeAccept = async () => {
      // While the server holds Dana's email, the job for Lee's runs: nothing counts as sent yet.
      second = sendEmailMessage(ctx.jobContext(), lee.message.id)
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      await waitUntil(async () => settled || (await reload(lee.message.id)).status === "sending");
    };
    expect(await sendEmailMessage(ctx.jobContext(), dana.message.id)).toMatchObject({
      status: "sent",
    });
    // The one email a day went to Dana: Lee's is planned again for the next opening.
    expect(await second).toBeInstanceOf(JobWaitError);
    expect(received.map((mail) => mail.to)).toEqual([["dana@harbor.example.com"]]);
    const later = await reload(lee.message.id);
    expect(later.status).toBe("scheduled");
    expect(later.scheduled_for?.getTime()).toBeGreaterThan(ctx.clock.now().getTime());
    const [counter] = await ctx.db.select().from(sender_counters);
    expect(counter?.count).toBe(1);
  });
});

describe("email.send without a public base URL", () => {
  async function heldProblems() {
    return ctx.db.select().from(problems).where(eq(problems.kind, "sending_blocked"));
  }

  it("holds a campaign email that would lack its unsubscribe link and opens one problem", async () => {
    const mailbox = await setup({ baseUrl: "http://localhost:7331" });
    const { message } = await scheduled(mailbox);
    const { message: second } = await scheduled(mailbox, "lee@harbor.example.com");
    const error = await sendEmailMessage(ctx.jobContext(), message.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobWaitError);
    expect((error as JobWaitError).waitFor).toBe(`unsubscribe_link:${ctx.workspace.id}`);
    expect((error as JobWaitError).retryAt?.toISOString()).toBe(
      new Date(ctx.clock.now().getTime() + 30 * 60_000).toISOString(),
    );
    await expect(sendEmailMessage(ctx.jobContext(), second.id)).rejects.toBeInstanceOf(
      JobWaitError,
    );
    expect(received).toHaveLength(0);
    expect((await reload(message.id)).status).toBe("scheduled");
    const open = await heldProblems();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      severity: "high",
      owner: "person",
      status: "open",
      dedupe_key: "sending_blocked:base_url",
    });
    expect(open[0]?.reason).toContain("http://localhost:7331");
    expect(open[0]?.remedy).toContain("OPENOUTBOUND_BASE_URL");
    expect(open[0]?.remedy).toContain("restart `openoutbound serve`");
  });

  it("sends the held email once the base URL is public and resolves the problem", async () => {
    const mailbox = await setup({ baseUrl: "http://localhost:7331" });
    const { message } = await scheduled(mailbox);
    await expect(sendEmailMessage(ctx.jobContext(), message.id)).rejects.toBeInstanceOf(
      JobWaitError,
    );
    Object.assign(ctx.config, { baseUrl: "https://engine.example.com" });
    expect(await sendEmailMessage(ctx.jobContext(), message.id)).toMatchObject({ status: "sent" });
    expect(received[0]?.raw).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    const [problem] = await heldProblems();
    expect(problem?.status).toBe("resolved");
  });

  it("shows the hold in the gate view with what to do", async () => {
    const mailbox = await setup({ baseUrl: "http://localhost:7331" });
    const { person, message } = await scheduled(mailbox);
    const gate = await evaluateEmailGate(ctx, { personId: person.id, messageId: message.id });
    expect(gate.blockers.map((entry) => entry.code)).toEqual(["unsubscribe_link_missing"]);
    expect(gate.blockers[0]).toMatchObject({
      hard: true,
      fix: expect.stringContaining("OPENOUTBOUND_BASE_URL"),
    });
  });

  it("never holds a reply to someone who wrote to us: the mailto and a reply line stay", async () => {
    const mailbox = await setup({ baseUrl: "http://localhost:7331" });
    const { message } = await scheduled(mailbox, "dana@harbor.example.com", { action: "reply" });
    expect(await sendEmailMessage(ctx.jobContext(), message.id)).toMatchObject({ status: "sent" });
    expect(await heldProblems()).toEqual([]);
    const raw = received[0]?.raw ?? "";
    expect(raw).toMatch(
      /List-Unsubscribe:\s+<mailto:sam@brand\.example\.com\?subject=unsubscribe>/,
    );
    expect(raw).not.toContain("List-Unsubscribe-Post");
    expect(raw).not.toContain("localhost:7331");
    const sent = await reload(message.id);
    expect(sent.body_text).toContain('Prefer not to hear from us? Reply "unsubscribe" to opt out.');
    expect(sent.body_text).not.toContain("/u/");
    expect(sent.headers).toMatchObject({
      "List-Unsubscribe": "<mailto:sam@brand.example.com?subject=unsubscribe>",
    });
  });

  it("never holds sandbox email, even from a real workspace", async () => {
    await setup({ baseUrl: "http://localhost:7331" });
    const simulated = await seedMailbox(ctx, { email: "sim@brand.example.com" });
    const { message } = await scheduled(simulated);
    expect(await sendEmailMessage(ctx.jobContext(), message.id)).toMatchObject({ status: "sent" });
    expect(await heldProblems()).toEqual([]);
  });
});

describe("email.send unsubscribe line and headers", () => {
  it("keeps the simulated link in sandbox workspaces", async () => {
    const mailbox = await setup({ sandbox: true, baseUrl: "http://localhost:7331" });
    const { message } = await scheduled(mailbox);
    await sendEmailMessage(ctx.jobContext(), message.id);
    const [entry] = getSandboxOutbox({ workspaceId: ctx.workspace.id });
    expect(entry?.raw).toMatch(/List-Unsubscribe:\s+<http:\/\/localhost:7331\/u\//);
    expect(entry?.raw).not.toContain("List-Unsubscribe-Post");
    expect((await reload(message.id)).body_text).toContain("Unsubscribe: http://localhost:7331/u/");
  });

  it("never lets the compliance switches drop the unsubscribe line or postal address", async () => {
    const mailbox = await setup({
      sandbox: true,
      settings: {
        compliance: { include_unsubscribe_link: false, include_postal_address: false },
      },
    });
    const { message } = await scheduled(mailbox);
    await sendEmailMessage(ctx.jobContext(), message.id);
    const sent = await reload(message.id);
    expect(sent.body_text).toContain("Helix Outbound, 12 Harbor Road, Austin");
    expect(sent.body_text).toContain("Unsubscribe: https://engine.example.com/u/");
    expect(sent.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });
});

describe("email.send recipient, window and person checks", () => {
  it("reads a late job's window in the company's zone when the person has none", async () => {
    // Monday 15:00Z: 11:00 in New York (the campaign fallback), midnight in Tokyo.
    const mailbox = await setup({ sandbox: true, now: "2026-09-21T15:00:00.000Z" });
    const { campaign } = await seedCampaign(ctx, {
      status: "active",
      settings: {
        schedule: { start_hour: 9, end_hour: 17, timezone: "America/New_York" },
        senders: { mailbox_ids: [mailbox.id] },
      },
    });
    const company = await seedCompany(ctx, { country: "JP", timezone: null });
    const person = await seedPerson(ctx, {
      email: "kenji@harbor.example.jp",
      first_name: "Kenji",
      status: "active",
      timezone: null,
      country: null,
      company_id: company.id,
    });
    const message = await seedMessage(ctx, {
      person_id: person.id,
      company_id: company.id,
      campaign_id: campaign.id,
      mailbox_id: mailbox.id,
      to_address: person.email,
      status: "scheduled",
      scheduled_for: new Date("2026-09-21T12:00:00.000Z"),
      subject: "Quick question",
      body_text: "Hi {{first_name}}, short note.",
    });
    const error = await sendEmailMessage(ctx.jobContext(), message.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobWaitError);
    // Next opening: Tuesday 09:00 in Tokyo, never 03:00 local.
    const tokyoNine = new Date("2026-09-22T00:00:00.000Z");
    expect((error as JobWaitError).retryAt?.toISOString()).toBe(tokyoNine.toISOString());
    expect(await reload(message.id)).toMatchObject({
      status: "scheduled",
      scheduled_for: tokyoNine,
    });
    expect(getSandboxOutbox()).toHaveLength(0);
  });

  it("refuses anything but exactly one plain recipient address", async () => {
    const mailbox = await setup({ sandbox: true });
    for (const address of [
      "dana@harbor.example.com, lee@harbor.example.com",
      "dana@harbor.example.com;lee@harbor.example.com",
      "Lee <lee@harbor.example.com>",
    ]) {
      const message = await seedMessage(ctx, {
        mailbox_id: mailbox.id,
        to_address: address,
        status: "scheduled",
        scheduled_for: ctx.clock.now(),
      });
      const outcome = await sendEmailMessage(ctx.jobContext(), message.id);
      expect(outcome.status, address).toBe("failed");
      expect(outcome.reason).toContain("exactly one plain address");
      expect((await reload(message.id)).status).toBe("failed");
    }
    expect(getSandboxOutbox()).toHaveLength(0);
  });

  it("cancels the message when its person was deleted or forgotten", async () => {
    const mailbox = await setup({ sandbox: true });
    const { person, message } = await scheduled(mailbox);
    await ctx.db.delete(people).where(eq(people.id, person.id));
    const outcome = await sendEmailMessage(ctx.jobContext(), message.id);
    expect(outcome).toMatchObject({ status: "cancelled" });
    expect(await reload(message.id)).toMatchObject({ status: "cancelled" });
    expect(ctx.emitted("message.failed")[0]?.data).toMatchObject({ retryable: false });
    expect(getSandboxOutbox()).toHaveLength(0);
  });
});

describe("email.send contactability for replies", () => {
  async function withReasons(mailbox: Mailbox, email: string, reasons: string[], action = "reply") {
    const person = await seedPerson(ctx, {
      email,
      first_name: "Dana",
      status: "replied",
      custom: { contactable_reasons: reasons },
    });
    return seedMessage(ctx, {
      person_id: person.id,
      mailbox_id: mailbox.id,
      to_address: email,
      action: action as "reply" | "email",
      status: "scheduled",
      scheduled_for: ctx.clock.now(),
      subject: "Re: Quick question",
      body_text: "Tuesday works, talk then.",
    });
  }

  it("answers despite consent-country or catch-all rules, never after an opt-out", async () => {
    const mailbox = await setup({ sandbox: true });
    const reply = await withReasons(mailbox, "dana@praxis.example.org", [
      "consent_required",
      "catch_all_skipped",
    ]);
    expect(await sendEmailMessage(ctx.jobContext(), reply.id)).toMatchObject({ status: "sent" });

    const optedOut = await withReasons(mailbox, "lee@praxis.example.org", [
      "person_unsubscribed",
      "consent_required",
    ]);
    const skipped = await sendEmailMessage(ctx.jobContext(), optedOut.id);
    expect(skipped).toMatchObject({ status: "skipped", reason: "person_unsubscribed" });

    // Cold email still follows every rule.
    const cold = await withReasons(
      mailbox,
      "kim@praxis.example.org",
      ["consent_required"],
      "email",
    );
    expect(await sendEmailMessage(ctx.jobContext(), cold.id)).toMatchObject({
      status: "skipped",
      reason: "consent_required",
    });
    expect(getSandboxOutbox()).toHaveLength(1);
  });
});

describe("email.send re-verification before the first email", () => {
  it("verifies a stale address before the first email and skips it when invalid", async () => {
    const mailbox = await setup({ sandbox: true, verifier: true });
    const { person, message } = await scheduled(mailbox);
    vi.mocked(verifyEmailNow).mockResolvedValueOnce("invalid");
    const outcome = await sendEmailMessage(ctx.jobContext(), message.id);
    expect(verifyEmailNow).toHaveBeenCalledWith(expect.anything(), person.id);
    expect(outcome).toMatchObject({ status: "skipped", reason: "invalid_email" });
    expect(getSandboxOutbox()).toHaveLength(0);

    const catchAll = await scheduled(mailbox, "lee@harbor.example.com");
    vi.mocked(verifyEmailNow).mockResolvedValueOnce("catch_all");
    expect(await sendEmailMessage(ctx.jobContext(), catchAll.message.id)).toMatchObject({
      status: "skipped",
      reason: "catch_all_skipped",
    });

    const valid = await scheduled(mailbox, "kim@harbor.example.com");
    vi.mocked(verifyEmailNow).mockResolvedValueOnce("valid");
    expect(await sendEmailMessage(ctx.jobContext(), valid.message.id)).toMatchObject({
      status: "sent",
    });
  });

  it("skips the check for fresh checks, follow-ups and workspaces without a verifier", async () => {
    const mailbox = await setup({ sandbox: true, verifier: true });
    const now = ctx.clock.now().getTime();
    const fresh = await scheduled(mailbox, "dana@harbor.example.com");
    await ctx.db
      .update(people)
      .set({ email_checked_at: new Date(now - 10 * 86_400_000) })
      .where(eq(people.id, fresh.person.id));
    expect(await sendEmailMessage(ctx.jobContext(), fresh.message.id)).toMatchObject({
      status: "sent",
    });

    // Checked 40 days ago, but the first email went out 3 days ago: a follow-up.
    const followUp = await scheduled(mailbox, "lee@harbor.example.com");
    await ctx.db
      .update(people)
      .set({ email_checked_at: new Date(now - 40 * 86_400_000) })
      .where(eq(people.id, followUp.person.id));
    await seedMessage(ctx, {
      person_id: followUp.person.id,
      mailbox_id: mailbox.id,
      to_address: "lee@harbor.example.com",
      status: "sent",
      sent_at: new Date(now - 3 * 86_400_000),
    });
    expect(await sendEmailMessage(ctx.jobContext(), followUp.message.id)).toMatchObject({
      status: "sent",
    });
    expect(verifyEmailNow).not.toHaveBeenCalled();
  });

  it("proceeds as before when no verifier is configured", async () => {
    const mailbox = await setup({ sandbox: true });
    const { message } = await scheduled(mailbox);
    expect(await sendEmailMessage(ctx.jobContext(), message.id)).toMatchObject({ status: "sent" });
    expect(verifyEmailNow).not.toHaveBeenCalled();
  });
});

/** An active campaign that may send any time, from these mailboxes. */
async function campaignWith(mailboxIds: string[]) {
  const { campaign } = await seedCampaign(ctx, {
    status: "active",
    settings: {
      schedule: {
        days: [1, 2, 3, 4, 5, 6, 7],
        start_hour: 0,
        end_hour: 24,
        timezone_mode: "fixed",
      },
      senders: { mailbox_ids: mailboxIds },
    },
  });
  return campaign;
}

describe("email.send auto-pauses are not routed around", () => {
  it("holds cold mail on a mailbox paused for its bounce rate, moves it off a person's pause", async () => {
    const held = await setup({ sandbox: true });
    const healthy = await seedMailbox(ctx, { email: "lee@brand.example.com" });
    const campaign = await campaignWith([held.id, healthy.id]);
    await ctx.db
      .update(mailboxes)
      .set({
        status: "paused",
        health: {
          auto_pause: { kind: "bounce_rate", at: ctx.clock.now().toISOString(), until: null },
        },
      })
      .where(eq(mailboxes.id, held.id));
    const { message } = await scheduled(held, "dana@harbor.example.com", {
      campaign_id: campaign.id,
    });
    const error = await sendEmailMessage(ctx.jobContext(), message.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobWaitError);
    expect((error as JobWaitError).waitFor).toBe(`mailbox_active:${held.id}`);
    expect(await reload(message.id)).toMatchObject({ status: "scheduled", mailbox_id: held.id });

    // Paused by a person (no health record): the mail moves to the healthy mailbox.
    const manual = await seedMailbox(ctx, { email: "kim@brand.example.com", status: "paused" });
    const other = await campaignWith([manual.id, healthy.id]);
    const moved = await scheduled(manual, "lee@harbor.example.com", { campaign_id: other.id });
    const next = await sendEmailMessage(ctx.jobContext(), moved.message.id).catch(
      (e: unknown) => e,
    );
    expect(next).toBeInstanceOf(JobWaitError);
    expect((await reload(moved.message.id)).mailbox_id).toBe(healthy.id);

    // Never parked on a mailbox held by a health pause either: it waits on its own mailbox.
    const lonely = await campaignWith([manual.id, held.id]);
    const stays = await scheduled(manual, "kim@harbor.example.com", { campaign_id: lonely.id });
    const wait = await sendEmailMessage(ctx.jobContext(), stays.message.id).catch(
      (e: unknown) => e,
    );
    expect((wait as JobWaitError).waitFor).toBe(`mailbox_active:${manual.id}`);
    expect((await reload(stays.message.id)).mailbox_id).toBe(manual.id);
    expect(getSandboxOutbox()).toHaveLength(0);
  });

  it("pauses every mailbox on the domain for 48 hours on an x.7.28 block and waits", async () => {
    const mailbox = await setup();
    const sibling = await seedMailbox(ctx, { email: "lee@brand.example.com" });
    const elsewhere = await seedMailbox(ctx, { email: "sam@other.example.org" });
    const campaign = await campaignWith([mailbox.id, sibling.id, elsewhere.id]);
    const { message } = await scheduled(mailbox, "spamrate@harbor.example.com", {
      campaign_id: campaign.id,
    });
    const error = await sendEmailMessage(ctx.jobContext(), message.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobWaitError);
    expect((error as JobWaitError).waitFor).toBe(`mailbox_active:${mailbox.id}`);
    // The message stays on its mailbox (never moved to the other domain).
    expect(await reload(message.id)).toMatchObject({ status: "scheduled", mailbox_id: mailbox.id });

    const until = new Date(ctx.clock.now().getTime() + 48 * 3_600_000).toISOString();
    const rows = await ctx.db.select().from(mailboxes);
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of [mailbox.id, sibling.id]) {
      expect(byId.get(id)).toMatchObject({ status: "paused" });
      expect(byId.get(id)?.health.auto_pause).toMatchObject({
        kind: "provider_block",
        status: "4.7.28",
        domain: "brand.example.com",
        until,
      });
    }
    expect(byId.get(elsewhere.id)?.status).toBe("active");
    expect(ctx.emitted("mailbox.paused")).toHaveLength(2);
    expect(vi.mocked(notify)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: "Sending domain brand.example.com was paused" }),
    );
    expect(received).toHaveLength(0);
  });
});

describe("email.send holds mail on a mailbox that cannot send", () => {
  it("holds a reply on a mailbox in error until a clean test, then sends it", async () => {
    const mailbox = await setup({ sandbox: true, now: "2026-09-22T15:00:00.000Z" });
    await ctx.db
      .update(mailboxes)
      .set({
        status: "error",
        status_reason: "Login failed: 535 5.7.8 Authentication credentials invalid",
      })
      .where(eq(mailboxes.id, mailbox.id));
    await openMailboxDown(ctx, mailbox.id);
    const dana = await seedPerson(ctx, {
      email: "dana@harbor.example.com",
      first_name: "Dana",
      status: "active",
    });
    const thread = await seedThread(ctx, { person_id: dana.id, mailbox_id: mailbox.id });
    const answer = await seedMessage(ctx, {
      person_id: dana.id,
      thread_id: thread.id,
      mailbox_id: mailbox.id,
      action: "reply",
      to_address: dana.email,
      status: "scheduled",
      scheduled_for: ctx.clock.now(),
      body_text: "Yes, Tuesday 10:00 works. Here is the invite.",
    });
    const error = await sendEmailMessage(ctx.jobContext(), answer.id).catch((e: unknown) => e);
    // A reply keeps its mailbox: it waits for it instead of failing.
    expect(error).toBeInstanceOf(JobWaitError);
    expect((error as JobWaitError).waitFor).toBe(`mailbox_active:${mailbox.id}`);
    expect((await reload(answer.id)).status).toBe("scheduled");
    expect(ctx.emitted("message.failed")).toHaveLength(0);
    // The mailbox's problem says so.
    const open = await ctx.db.select().from(problems);
    expect(open.map((row) => row.kind)).toEqual(["mailbox_down"]);
    expect(open[0]?.reason).toContain(
      "replies and emails no other mailbox can take wait until it sends again",
    );

    // A clean test brings the mailbox back and wakes the reply, which goes out.
    const [down] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, mailbox.id));
    if (!down) throw new Error("mailbox missing");
    expect((await testAndRecord(ctx, ctx.workspace, down)).mailbox.status).toBe("active");
    expect(ctx.recorded.wakes).toContain(`mailbox_active:${mailbox.id}`);
    expect(await sendEmailMessage(ctx.jobContext(), answer.id)).toMatchObject({ status: "sent" });
    expect(getSandboxOutbox()).toHaveLength(1);
  });

  it("holds a campaign email no other mailbox can send, and fails it once its mailbox is removed", async () => {
    const mailbox = await setup({ sandbox: true });
    // The campaign's other mailbox is paused by a person: it cannot take the email either.
    const other = await seedMailbox(ctx, { email: "lee@brand.example.com", status: "paused" });
    const campaign = await campaignWith([mailbox.id, other.id]);
    await ctx.db
      .update(mailboxes)
      .set({ status: "disconnected" })
      .where(eq(mailboxes.id, mailbox.id));
    const { message } = await scheduled(mailbox, "dana@harbor.example.com", {
      campaign_id: campaign.id,
    });
    const error = await sendEmailMessage(ctx.jobContext(), message.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobWaitError);
    expect((error as JobWaitError).waitFor).toBe(`mailbox_active:${mailbox.id}`);
    expect(await reload(message.id)).toMatchObject({ status: "scheduled", mailbox_id: mailbox.id });
    expect(ctx.emitted("message.failed")).toHaveLength(0);

    // Removing the mailbox wakes the email: nothing can send it now, so it fails (retryable).
    await removeMailbox.handler(ctx, removeMailbox.input.parse({ mailbox_id: mailbox.id }));
    expect(ctx.recorded.wakes).toContain(`mailbox_active:${mailbox.id}`);
    expect(await sendEmailMessage(ctx.jobContext(), message.id)).toMatchObject({
      status: "failed",
    });
    expect(ctx.emitted("message.failed")[0]?.data.retryable).toBe(true);
    expect(getSandboxOutbox()).toHaveLength(0);
  });
});

describe("email.send moves only a message that still waits", () => {
  it("leaves a follow-up cancelled when the reply-stop cancels it while its move is planned", async () => {
    const mailbox = await setup({ sandbox: true, now: "2026-09-22T15:00:00.000Z" });
    // Provider throttling until tomorrow: the gate says "move" to a later time.
    await ctx.db
      .update(mailboxes)
      .set({ health: { throttled_until: "2026-09-23T04:00:00.000Z" } })
      .where(eq(mailboxes.id, mailbox.id));
    const { campaign } = await seedCampaign(ctx, {
      status: "active",
      settings: { senders: { mailbox_ids: [mailbox.id] } },
    });
    const dana = await seedPerson(ctx, { email: "dana@harbor.example.com", status: "active" });
    const enrollment = await seedEnrollment(ctx, { campaign_id: campaign.id, person_id: dana.id });
    const followUp = await seedMessage(ctx, {
      person_id: dana.id,
      campaign_id: campaign.id,
      enrollment_id: enrollment.id,
      mailbox_id: mailbox.id,
      to_address: dana.email,
      status: "scheduled",
      scheduled_for: ctx.clock.now(),
      subject: "Following up",
      body_text: "Hi {{first_name}}, bumping this.",
    });

    // While the job plans the move, Dana's reply stops her enrollment (another worker).
    const actual = await vi.importActual<typeof import("./plan.js")>("./plan.js");
    vi.mocked(planEmailSendWith).mockImplementationOnce(async (...args) => {
      expect(await stopEnrollments(ctx, [{ id: enrollment.id }], "replied")).toBe(1);
      return actual.planEmailSendWith(...args);
    });
    expect(await sendEmailMessage(ctx.jobContext(), followUp.id)).toEqual({
      message_id: followUp.id,
      status: "noop",
      reason: "status_changed",
      mailbox_id: mailbox.id,
    });
    expect(await reload(followUp.id)).toMatchObject({
      status: "cancelled",
      error: "enrollment_stopped:replied",
      scheduled_for: ctx.clock.now(),
    });

    // Later runs of the job leave it alone, so nothing reaches someone who replied.
    ctx.clock.set("2026-09-23T15:00:00.000Z");
    await ctx.db.update(mailboxes).set({ health: {} }).where(eq(mailboxes.id, mailbox.id));
    expect(await sendEmailMessage(ctx.jobContext(), followUp.id)).toMatchObject({
      status: "noop",
      reason: "status_cancelled",
    });
    expect(getSandboxOutbox()).toHaveLength(0);
  });
});

describe("email.send never sends twice", () => {
  it("turns a message found sending into unknown and never sends it", async () => {
    const mailbox = await setup();
    const { message } = await scheduled(mailbox, "dana@harbor.example.com", { status: "sending" });
    expect(await sendEmailMessage(ctx.jobContext(), message.id)).toEqual({
      message_id: message.id,
      status: "unknown",
      reason: INTERRUPTED_REASON,
      mailbox_id: mailbox.id,
    });
    expect(received).toHaveLength(0);
    expect(ctx.emitted("message.unknown")[0]?.data).toEqual({
      message_id: message.id,
      channel: "email",
      reason: INTERRUPTED_REASON,
    });
    // No IMAP: nothing can look for a copy, so a person is asked at once.
    expect(await reload(message.id)).toMatchObject({
      status: "unknown",
      reconcile_checks: RECONCILE_CHECKS,
    });
    const [problem] = await ctx.db.select().from(problems);
    expect(problem).toMatchObject({
      kind: "send_unknown",
      severity: "high",
      owner: "person",
      title: "Check whether an email went out",
      dedupe_key: `send_unknown:${message.id}`,
      subject_type: "message",
      subject_id: message.id,
    });
    expect(problem?.reason).toContain("dana@harbor.example.com");
    expect(problem?.remedy).toBe(
      `Look in the Sent folder of sam@brand.example.com, then use manage_messages action resolve_unknown with outcome sent or resend (message_id ${message.id}).`,
    );
    // Running the job again changes nothing.
    expect(await sendEmailMessage(ctx.jobContext(), message.id)).toMatchObject({
      status: "noop",
      reason: "status_unknown",
    });
  });

  it("leaves an unknown send on an IMAP mailbox to the reconcile job", async () => {
    const mailbox = await setup();
    await ctx.db
      .update(mailboxes)
      .set({ imap: { host: "127.0.0.1", port: 993, secure: true, user: "sam@brand.example.com" } })
      .where(eq(mailboxes.id, mailbox.id));
    const { message } = await scheduled(mailbox, "dana@harbor.example.com", { status: "sending" });
    expect((await sendEmailMessage(ctx.jobContext(), message.id)).status).toBe("unknown");
    expect(await reload(message.id)).toMatchObject({ status: "unknown", reconcile_checks: 0 });
    expect(await ctx.db.select().from(problems)).toHaveLength(0);
  });

  it("claims a scheduled message once when two attempts run together", async () => {
    const mailbox = await setup();
    const { message } = await scheduled(mailbox);
    const outcomes = await Promise.all([
      sendEmailMessage(ctx.jobContext(), message.id),
      sendEmailMessage(ctx.jobContext(), message.id),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "sent")).toHaveLength(1);
    expect(received).toHaveLength(1);
    expect((await reload(message.id)).status).toBe("sent");
  });

  it("marks a send unknown when the connection drops after the data, and never retries it", async () => {
    const mailbox = await setup();
    await ctx.db
      .update(mailboxes)
      .set({ imap: { host: "127.0.0.1", port: 993, secure: true, user: "sam@brand.example.com" } })
      .where(eq(mailboxes.id, mailbox.id));
    const { message } = await scheduled(mailbox, "drop@harbor.example.com");
    const outcome = await sendEmailMessage(ctx.jobContext(), message.id);
    expect(outcome.status).toBe("unknown");
    expect(received).toHaveLength(1);
    const row = await reload(message.id);
    expect(row).toMatchObject({ status: "unknown", attempt: 1, reconcile_checks: 0 });
    expect(row.dispatch_started_at?.toISOString()).toBe(ctx.clock.now().toISOString());
    expect(row.message_id_header).toMatch(/@brand\.example\.com>$/);
    expect(row.error).toContain("no clear answer from the mail server");
    expect(ctx.emitted("message.unknown")).toHaveLength(1);
    expect(ctx.emitted("message.failed")).toHaveLength(0);
    // The failure counts on the mailbox's streak, like any failed send.
    const [health] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, mailbox.id));
    expect(health?.health.consecutive_failures).toBe(1);

    expect(await sendEmailMessage(ctx.jobContext(), message.id)).toMatchObject({
      status: "noop",
      reason: "status_unknown",
    });
    expect(received).toHaveLength(1);
  });

  it("still retries when the server refuses the connection (nothing was handed over)", async () => {
    const mailbox = await setup();
    await ctx.db
      .update(mailboxes)
      .set({
        smtp: {
          host: "127.0.0.1",
          port: await closedPort(),
          secure: false,
          user: "sam@brand.example.com",
        },
      })
      .where(eq(mailboxes.id, mailbox.id));
    const { message } = await scheduled(mailbox);
    await expect(sendEmailMessage(ctx.jobContext(), message.id)).rejects.toThrow(
      /Temporary send failure/,
    );
    expect(await reload(message.id)).toMatchObject({
      status: "scheduled",
      dispatch_started_at: null,
    });
    expect(ctx.emitted("message.unknown")).toHaveLength(0);
  });

  it("keeps a late success after a retry marked the message unknown", async () => {
    const mailbox = await setup();
    const { message } = await scheduled(mailbox);
    serverHooks.beforeAccept = async () => {
      // The job timed out and its retry starts while the server still holds the data.
      const retry = await sendEmailMessage(ctx.jobContext(), message.id);
      expect(retry.status).toBe("unknown");
    };
    expect(await sendEmailMessage(ctx.jobContext(), message.id)).toMatchObject({ status: "sent" });
    expect(received).toHaveLength(1);
    expect((await reload(message.id)).status).toBe("sent");
    const [problem] = await ctx.db.select().from(problems);
    expect(problem).toMatchObject({
      status: "resolved",
      resolution: "The email was sent after all.",
    });
    expect(ctx.emitted("message.sent")).toHaveLength(1);
    const [counter] = await ctx.db.select().from(sender_counters);
    expect(counter?.count).toBe(1);
  });

  it("records a duplicate when an earlier attempt's late success comes back on a resend's claim", async () => {
    const mailbox = await setup();
    const { message } = await scheduled(mailbox);
    let resend: Promise<SendOutcome> | null = null;
    serverHooks.beforeAccept = async () => {
      // The first attempt's job timed out while the server holds the data; its retry finds the
      // message sending and marks it unknown (no IMAP: a send_unknown problem opens at once).
      const retry = await sendEmailMessage(ctx.jobContext(), message.id);
      expect(retry.status).toBe("unknown");
      // A person settles the problem at once: resend (the Sent folder has no copy yet).
      await resolveUnknownOperation.handler(
        ctx,
        resolveUnknownOperation.input.parse({ message_id: message.id, outcome: "resend" }),
      );
      // The resend job claims the message while the first attempt still waits for its answer.
      resend = sendEmailMessage(ctx.jobContext(), message.id);
      await waitUntil(async () => (await reload(message.id)).status === "sending");
    };

    // The first attempt's success comes back on the resend's claim: never recorded as the
    // resend's result, but remembered on the message.
    expect(await sendEmailMessage(ctx.jobContext(), message.id)).toEqual({
      message_id: message.id,
      status: "noop",
      reason: "newer_attempt_sending",
      mailbox_id: mailbox.id,
    });
    expect((await reload(message.id)).why?.earlier_attempt_went_out).toBe(1);
    // The resend goes out too: one send recorded, and the second copy recorded as a duplicate.
    expect(await resend).toMatchObject({ status: "sent" });
    expect(received).toHaveLength(2);
    const row = await reload(message.id);
    expect(row).toMatchObject({ status: "sent", attempt: 2 });
    expect(row.why?.duplicate_attempts).toEqual([1, 2]);
    expect(ctx.emitted("message.sent")).toHaveLength(1);
    expect(ctx.emitted("message.duplicate").map((event) => event.data)).toEqual([
      expect.objectContaining({ message_id: message.id, attempts: [1, 2], channel: "email" }),
    ]);
    const [counter] = await ctx.db.select().from(sender_counters);
    expect(counter?.count).toBe(1);
    const duplicate = (await ctx.db.select().from(problems)).find(
      (problem) => problem.kind === "duplicate_send",
    );
    expect(duplicate).toMatchObject({
      status: "open",
      severity: "normal",
      owner: "person",
      title: "Email went out twice",
      dedupe_key: `duplicate_send:${message.id}`,
    });
  });

  it("stops a send that outlives its deadline and settles it as unknown", async () => {
    setSmtpSendDeadline(300);
    const mailbox = await setup();
    const { message } = await scheduled(mailbox);
    let answer: () => void = () => {};
    // The server holds the data and does not answer.
    serverHooks.beforeAccept = () => new Promise<void>((resolve) => (answer = resolve));
    const outcome = await sendEmailMessage(ctx.jobContext(), message.id);
    expect(outcome).toMatchObject({ status: "unknown", mailbox_id: mailbox.id });
    expect(outcome.reason).toContain("did not finish within 0.3 seconds");
    expect(await reload(message.id)).toMatchObject({ status: "unknown", attempt: 1 });
    // The server answers after the session was closed: nothing changes.
    answer();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await reload(message.id)).status).toBe("unknown");
    expect(ctx.emitted("message.sent")).toHaveLength(0);
  });

  it("stops a send when its job ends first", async () => {
    const mailbox = await setup();
    const { message } = await scheduled(mailbox);
    const job = new AbortController();
    let answer: () => void = () => {};
    serverHooks.beforeAccept = () => {
      // The job times out while the server holds the data.
      job.abort();
      return new Promise<void>((resolve) => (answer = resolve));
    };
    const outcome = await sendEmailMessage(ctx.jobContext({ signal: job.signal }), message.id);
    expect(outcome).toMatchObject({ status: "unknown" });
    expect(outcome.reason).toContain("its job ended before the mail server finished");
    answer();
  });

  it("confirms an unknown email as sent with the text that went out", async () => {
    const mailbox = await setup({ sandbox: true });
    const { person, message } = await scheduled(mailbox, "dana@harbor.example.com", {
      status: "unknown",
      message_id_header: "<kept@brand.example.com>",
      dispatch_started_at: new Date("2026-09-19T11:50:00Z"),
    });
    expect(
      await confirmEmailSent(ctx.jobContext(), message.id, { resolution: "Found in Sent" }),
    ).toBe(true);
    const row = await reload(message.id);
    expect(row).toMatchObject({
      status: "sent",
      subject: "Quick question, Dana",
      message_id_header: "<kept@brand.example.com>",
    });
    expect(row.sent_at?.toISOString()).toBe("2026-09-19T11:50:00.000Z");
    expect(row.body_text).toContain("Hi Dana,");
    expect(row.thread_id).toBeTruthy();
    const [contacted] = await ctx.db.select().from(people).where(eq(people.id, person.id));
    expect(contacted?.last_contacted_at?.toISOString()).toBe("2026-09-19T11:50:00.000Z");
    expect(ctx.emitted("message.sent")[0]?.data.sent_at).toBe("2026-09-19T11:50:00.000Z");
    // Only unknown messages: a second call changes nothing.
    expect(
      await confirmEmailSent(ctx.jobContext(), message.id, { resolution: "Found in Sent" }),
    ).toBe(false);
    expect(getSandboxOutbox()).toHaveLength(0);
  });

  it("counts a server as keeping sent copies only once a copy was found", () => {
    const smtp = { host: "smtp.gmail.com", port: 465, secure: true, user: "sam@brand.example.com" };
    // Google usually keeps copies, but only a copy of one of the engine's own emails proves it.
    expect(savesSentCopies({ sent_copies_seen_at: null, smtp })).toBeNull();
    expect(savesSentCopies({ sent_copies_seen_at: new Date(), smtp })).toBe(true);
    // Google Workspace's SMTP relay never saves what it relays.
    const relay = { ...smtp, host: "smtp-relay.gmail.com" };
    expect(savesSentCopies({ sent_copies_seen_at: new Date(), smtp: relay })).toBe(false);
    expect(savesSentCopies({ sent_copies_seen_at: null, smtp: null })).toBeNull();
  });
});
