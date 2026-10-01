/**
 * Outage and failure problems: `mailbox_down` when a mailbox stops sending because of an error
 * (a refused login in the send job or a test, a bounce-rate or provider-block pause), never for
 * a person's pause, resolved when it sends again; `send_failed` for failures for good, grouped
 * by campaign and cause, never for bounces, skips or cancels.
 */
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { SMTPServer } from "smtp-server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { JobWaitError } from "../../core/errors.js";
import {
  type Mailbox,
  mailboxes,
  messages,
  type NewMessage,
  people,
  problems,
  suppressions,
} from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { seedCampaign, seedMailbox, seedMessage, seedPerson } from "../../testing/factories.js";
import { HARD_BOUNCE_PREFIX } from "./bounce.js";
import { storePasswords } from "./credentials.js";
import { checkMailboxHealth } from "./health-job.js";
import { endTimedPauses, pauseSendingDomain } from "./mailbox-state.js";
import { testAndRecord } from "./mailbox-test.js";
import { pauseMailboxOperation, resumeMailboxOperation } from "./operations/status.js";
import { clearSandboxOutbox } from "./sandbox-transport.js";
import { sendEmailMessage } from "./send-job.js";
import { sendFailureClass } from "./send-problems.js";
import { closeSmtpPools } from "./smtp-transport.js";

vi.mock("../../runtime/notify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/notify.js")>()),
  notify: vi.fn(async () => {}),
}));

/** Tuesday 2026-09-22 10:00 in Chicago. */
const NOW = "2026-09-22T15:00:00.000Z";

let server: SMTPServer;
let port = 0;

beforeAll(async () => {
  server = new SMTPServer({
    logger: false,
    disabledCommands: ["STARTTLS"],
    allowInsecureAuth: true,
    onAuth(auth, _session, callback) {
      if (auth.password !== "right-password") {
        callback(
          Object.assign(new Error("5.7.8 Authentication credentials invalid"), {
            responseCode: 535,
          }),
        );
        return;
      }
      callback(null, { user: auth.username });
    },
    onRcptTo(address, _session, callback) {
      if (address.address.startsWith("unknown@")) {
        callback(Object.assign(new Error("5.1.1 No such user here"), { responseCode: 550 }));
        return;
      }
      callback();
    },
    onData(stream, _session, callback) {
      stream.on("data", () => {});
      stream.on("end", () => callback(null, "Ok: queued"));
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
  clearSandboxOutbox();
  await ctx?.close();
});

async function smtpMailbox(password: string): Promise<Mailbox> {
  const secretId = await storePasswords(ctx, ctx.workspace.id, "sam@brand.example.com", password);
  return seedMailbox(ctx, {
    email: "sam@brand.example.com",
    from_name: "Sam Carter",
    provider_label: "custom",
    auth_type: "password",
    secret_id: secretId,
    smtp: { host: "127.0.0.1", port, secure: false, user: "sam@brand.example.com" },
  });
}

async function queued(mailbox: Mailbox, overrides: Partial<NewMessage> = {}, email?: string) {
  const person = await seedPerson(ctx, {
    ...(email ? { email } : {}),
    first_name: "Dana",
    status: "active",
  });
  return seedMessage(ctx, {
    person_id: person.id,
    mailbox_id: mailbox.id,
    to_address: person.email,
    status: "scheduled",
    scheduled_for: ctx.clock.now(),
    subject: "Quick question, {{first_name}}",
    body_text: "Hi {{first_name}},\n\nShort note about scheduling.",
    ...overrides,
  });
}

async function problemsOf(kind: "mailbox_down" | "send_failed") {
  return ctx.db
    .select()
    .from(problems)
    .where(and(eq(problems.workspace_id, ctx.workspace.id), eq(problems.kind, kind)));
}

async function mailboxRow(id: string): Promise<Mailbox> {
  const [row] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, id));
  if (!row) throw new Error("mailbox missing");
  return row;
}

describe("mailbox_down", () => {
  it("opens once when the login fails in the send job, and a clean test resolves it", async () => {
    ctx = await createTestContext({
      now: NOW,
      config: { baseUrl: "https://engine.example.com" },
      settings: { company: { name: "Helix Outbound", postal_address: "12 Harbor Road, Austin" } },
    });
    const mailbox = await smtpMailbox("wrong-password");
    const first = await queued(mailbox);
    // No other mailbox can take it: it waits until the mailbox sends again.
    await expect(sendEmailMessage(ctx.jobContext(), first.id)).rejects.toBeInstanceOf(JobWaitError);
    expect((await mailboxRow(mailbox.id)).status).toBe("error");

    const [problem] = await problemsOf("mailbox_down");
    expect(problem).toMatchObject({
      severity: "high",
      owner: "person",
      status: "open",
      title: "Mailbox sam@brand.example.com stopped sending",
      dedupe_key: `mailbox_down:${mailbox.id}`,
      subject_type: "mailbox",
      subject_id: mailbox.id,
    });
    expect(problem?.reason).toContain("It is in error: Login failed");
    expect(problem?.remedy).toBe(
      `Fix the password (password_env) or the server settings with manage_mailboxes action update (mailbox_id ${mailbox.id}), then check it with manage_mailboxes action test (mailbox_id ${mailbox.id}); a clean test makes it send again.`,
    );

    // More mail for the broken mailbox changes nothing: still one problem.
    const second = await queued(mailbox);
    await expect(sendEmailMessage(ctx.jobContext(), second.id)).rejects.toBeInstanceOf(
      JobWaitError,
    );
    expect(await problemsOf("mailbox_down")).toHaveLength(1);

    // The password is fixed and the test passes: it sends again and the problem is resolved.
    const secretId = await storePasswords(
      ctx,
      ctx.workspace.id,
      "sam@brand.example.com",
      "right-password",
    );
    await ctx.db.update(mailboxes).set({ secret_id: secretId }).where(eq(mailboxes.id, mailbox.id));
    closeSmtpPools(mailbox.id);
    const { result } = await testAndRecord(ctx, ctx.workspace, await mailboxRow(mailbox.id));
    expect(result.smtp).toBe("ok");
    expect((await mailboxRow(mailbox.id)).status).toBe("active");
    const [resolved] = await problemsOf("mailbox_down");
    expect(resolved).toMatchObject({
      status: "resolved",
      resolution: "A clean login test; it sends again.",
    });
  });

  it("opens for a refused login found by a test", async () => {
    ctx = await createTestContext({ now: NOW });
    const mailbox = await smtpMailbox("wrong-password");
    await testAndRecord(ctx, ctx.workspace, mailbox);
    const [problem] = await problemsOf("mailbox_down");
    expect(problem?.reason).toContain("SMTP");
  });

  it("opens for a bounce-rate pause but not for a person's pause; resume resolves it", async () => {
    ctx = await createTestContext({ now: NOW });
    const mailbox = await seedMailbox(ctx, { email: "sam@brand.example.com" });
    await ctx.db.insert(messages).values(
      Array.from({ length: 25 }, (_, i) => ({
        workspace_id: ctx.workspace.id,
        channel: "email" as const,
        action: "email" as const,
        direction: "outbound" as const,
        mailbox_id: mailbox.id,
        to_address: `lead${i}@clinic${i}.example.com`,
        status: i < 1 ? ("bounced" as const) : ("sent" as const),
        error: i < 1 ? `${HARD_BOUNCE_PREFIX}550 5.1.1 unknown user` : null,
        sent_at: new Date(Date.parse(NOW) - (i % 6) * 86_400_000 - 3_600_000),
      })),
    );
    expect((await checkMailboxHealth(ctx.jobContext(), mailbox)).action).toBe("paused");
    // Checked again while paused: the same problem, refreshed.
    await checkMailboxHealth(ctx.jobContext(), await mailboxRow(mailbox.id));
    const open = await problemsOf("mailbox_down");
    expect(open).toHaveLength(1);
    expect(open[0]?.reason).toContain("It is paused for its bounce rate: Bounce rate 4.0%");
    expect(open[0]?.remedy).toBe(
      `Re-verify the list the bounces came from (enrich_leads action verify), then resume it with manage_mailboxes action resume (mailbox_id ${mailbox.id}) and restart_ramp true.`,
    );

    const other = await seedMailbox(ctx, { email: "lee@brand.example.com" });
    await pauseMailboxOperation.handler(
      ctx,
      pauseMailboxOperation.input.parse({ mailbox_id: other.id }),
    );
    expect((await mailboxRow(other.id)).status).toBe("paused");
    expect(await problemsOf("mailbox_down")).toHaveLength(1);

    await resumeMailboxOperation.handler(
      ctx,
      resumeMailboxOperation.input.parse({ mailbox_id: mailbox.id, restart_ramp: true }),
    );
    const [resolved] = await problemsOf("mailbox_down");
    expect(resolved).toMatchObject({ status: "resolved", resolution: "Resumed by Test User." });
  });

  it("says a timed provider block ends by itself, and resolves it when it does", async () => {
    ctx = await createTestContext({ now: NOW });
    const mailbox = await seedMailbox(ctx, { email: "sam@brand.example.com" });
    await pauseSendingDomain(ctx, mailbox, "4.7.28", "Unusual rate of unsolicited mail");
    const [problem] = await problemsOf("mailbox_down");
    expect(problem?.remedy).toContain("It sends again by itself when the pause ends (");

    ctx.clock.advanceBy({ hours: 49 });
    const resumed = await endTimedPauses(ctx, ctx.workspace);
    expect(resumed.map((row) => row.id)).toEqual([mailbox.id]);
    const [resolved] = await problemsOf("mailbox_down");
    expect(resolved).toMatchObject({
      status: "resolved",
      resolution: "Its timed pause after a provider block ended; it sends again.",
    });
  });
});

describe("send_failed", () => {
  async function sandbox() {
    ctx = await createTestContext({
      now: NOW,
      sandbox: true,
      settings: { company: { name: "Helix Outbound", postal_address: "12 Harbor Road, Austin" } },
    });
    const mailbox = await seedMailbox(ctx, { email: "sam@brand.example.com", from_name: "Sam" });
    const { campaign, steps } = await seedCampaign(ctx, {
      name: "Q4 distributors",
      status: "active",
      settings: { senders: { mailbox_ids: [mailbox.id] } },
    });
    const inCampaign = { campaign_id: campaign.id, step_id: steps[0]?.id ?? null };
    return { mailbox, campaign, inCampaign };
  }

  it("groups failures for good by campaign and cause, with the count and the latest message", async () => {
    const { mailbox, campaign, inCampaign } = await sandbox();
    const variables = { ...inCampaign, body_text: "Hi {{first_name}}, how is {{city}}?" };
    const first = await queued(mailbox, variables);
    const second = await queued(mailbox, variables);
    for (const message of [first, second]) {
      expect((await sendEmailMessage(ctx.jobContext(), message.id)).status).toBe("failed");
    }
    const [problem] = await problemsOf("send_failed");
    expect(problem).toMatchObject({
      severity: "normal",
      owner: "anyone",
      status: "open",
      title: "Sends fail in campaign Q4 distributors: template variables with no value",
      dedupe_key: `send_failed:${campaign.id}:template_variables`,
      subject_type: "campaign",
      subject_id: campaign.id,
    });
    expect(problem?.data).toMatchObject({
      count: 2,
      latest_message_id: second.id,
      class: "template_variables",
    });
    expect(problem?.reason).toContain(
      "2 messages in campaign Q4 distributors failed for good and will not be sent",
    );
    expect(problem?.reason).toContain(`Latest: message ${second.id}`);
    expect(problem?.remedy).toBe(
      `Add fallbacks like {{first_name|there}} to the step with create_campaign action update (campaign_id ${campaign.id}), or fill the missing lead fields with manage_leads action update; see the failed message with manage_messages action get (message_id ${second.id}).`,
    );

    // Another cause in the same campaign is its own problem.
    const blank = await queued(mailbox, { ...inCampaign, subject: "" });
    expect((await sendEmailMessage(ctx.jobContext(), blank.id)).status).toBe("failed");
    const all = await problemsOf("send_failed");
    expect(all.map((row) => row.dedupe_key).sort()).toEqual(
      [
        `send_failed:${campaign.id}:empty_content`,
        `send_failed:${campaign.id}:template_variables`,
      ].sort(),
    );
  });

  it("never opens for skips or cancels", async () => {
    const { mailbox, inCampaign } = await sandbox();
    const suppressed = await queued(mailbox, inCampaign, "dana@harbor.example.com");
    await ctx.db.insert(suppressions).values({
      workspace_id: ctx.workspace.id,
      type: "email",
      value: "dana@harbor.example.com",
      reason: "manual",
      source: "test",
    });
    expect((await sendEmailMessage(ctx.jobContext(), suppressed.id)).status).toBe("skipped");

    const gone = await queued(mailbox, inCampaign);
    await ctx.db.delete(people).where(eq(people.id, gone.person_id ?? ""));
    expect((await sendEmailMessage(ctx.jobContext(), gone.id)).status).toBe("cancelled");
    expect(await problemsOf("send_failed")).toHaveLength(0);
  });

  it("never opens for a bounce", async () => {
    ctx = await createTestContext({
      now: NOW,
      config: { baseUrl: "https://engine.example.com" },
      settings: { company: { name: "Helix Outbound", postal_address: "12 Harbor Road, Austin" } },
    });
    const mailbox = await smtpMailbox("right-password");
    const message = await queued(mailbox, {}, "unknown@harbor.example.com");
    expect((await sendEmailMessage(ctx.jobContext(), message.id)).status).toBe("bounced");
    expect(await problemsOf("send_failed")).toHaveLength(0);
    expect(await problemsOf("mailbox_down")).toHaveLength(0);
  });

  it("classifies the stored errors of both senders", () => {
    expect(sendFailureClass("email", "No recipient address.")).toBe("bad_recipient");
    expect(sendFailureClass("email", "The message body is empty.")).toBe("empty_content");
    expect(sendFailureClass("email", "5.7.1 Message rejected due to content")).toBe("rejected");
    expect(sendFailureClass("linkedin", "note_too_long: 320 characters, max 300")).toBe("too_long");
    expect(sendFailureClass("linkedin", "empty_comment")).toBe("empty_content");
    expect(sendFailureClass("linkedin", "provider_error: Invalid recipient")).toBe("rejected");
    // Nothing to fix in the message itself: no problem.
    for (const error of ["missing_person", "person_removed", "account_removed"]) {
      expect(sendFailureClass("linkedin", error)).toBeNull();
    }
  });
});
