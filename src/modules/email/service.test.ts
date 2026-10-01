import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { parseWorkspaceSettings } from "../../core/settings.js";
import { messages } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { seedMailbox, seedMessage, seedPerson } from "../../testing/factories.js";
import { prepareMailbox } from "./mailbox-create.js";
import { clearSandboxOutbox, getSandboxOutbox } from "./sandbox-transport.js";
import { queueEmailSend, sendSystemEmail } from "./service.js";

let ctx: TestContext;
afterEach(async () => {
  clearSandboxOutbox();
  await ctx?.close();
});

describe("queueEmailSend", () => {
  it("schedules an approved email once, with a singleton send job", async () => {
    ctx = await createTestContext({ sandbox: true });
    const mailbox = await seedMailbox(ctx, { email: "sam@brand.example.com" });
    const person = await seedPerson(ctx, { email: "Dana@Harbor.example.com" });
    const sendAt = new Date("2026-09-21T15:00:00Z");
    const message = await seedMessage(ctx, {
      person_id: person.id,
      mailbox_id: mailbox.id,
      status: "approved",
      scheduled_for: sendAt,
    });
    await queueEmailSend(ctx, message.id);
    await queueEmailSend(ctx, message.id);
    const [row] = await ctx.db.select().from(messages).where(eq(messages.id, message.id));
    expect(row).toMatchObject({
      status: "scheduled",
      from_address: "sam@brand.example.com",
      to_address: "dana@harbor.example.com",
    });
    const jobs = ctx.enqueued("email.send");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      payload: { message_id: message.id },
      options: { runAt: sendAt, singletonKey: `email.send:${message.id}` },
    });
  });

  it("refuses drafts and messages without a plan", async () => {
    ctx = await createTestContext();
    const draft = await seedMessage(ctx, { status: "draft" });
    await expect(queueEmailSend(ctx, draft.id)).rejects.toMatchObject({ code: "conflict" });
    const unplanned = await seedMessage(ctx, { status: "approved" });
    await expect(queueEmailSend(ctx, unplanned.id)).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(queueEmailSend(ctx, "msg_missing")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("sendSystemEmail", () => {
  it("sends a plain operational email from the first active mailbox", async () => {
    ctx = await createTestContext({ sandbox: true });
    await seedMailbox(ctx, { email: "ops@brand.example.com", status: "paused" });
    const active = await seedMailbox(ctx, { email: "sam@brand.example.com", from_name: null });
    await sendSystemEmail(ctx, {
      to: ["Owner <owner@agency.example.org>", "owner@agency.example.org"],
      subject: "Weekly   report\nready",
      text: "3 replies this week.",
    });
    const [entry] = getSandboxOutbox();
    expect(entry?.mailboxId).toBe(active.id);
    expect(entry?.email).toMatchObject({
      to: ["owner@agency.example.org"],
      subject: "Weekly report ready",
      headers: { "Auto-Submitted": "auto-generated" },
    });
    expect(entry?.raw).not.toContain("List-Unsubscribe");
  });

  it("explains when nothing can send", async () => {
    ctx = await createTestContext({ sandbox: true });
    await expect(
      sendSystemEmail(ctx, { to: ["owner@agency.example.org"], subject: "x", text: "y" }),
    ).rejects.toMatchObject({ code: "provider_not_configured" });
    await expect(
      sendSystemEmail(ctx, { to: ["not an address"], subject: "x", text: "y" }),
    ).rejects.toMatchObject({
      code: "validation_failed",
    });
  });
});

describe("prepareMailbox", () => {
  const today = "2026-09-21";

  it("fills presets, security defaults and the default ramp", async () => {
    ctx = await createTestContext();
    const zoho = prepareMailbox(
      { email: "sam@brand.example.com", preset: "zoho", password: "pw" },
      { workspace: ctx.workspace, today },
    );
    expect(zoho.values).toMatchObject({
      provider_label: "zoho",
      smtp: { host: "smtp.zoho.com", port: 465, secure: true },
      imap: { host: "imap.zoho.com", port: 993, secure: true },
      // Playbook ramp: two quiet weeks, then 5 a day, +5 a week; warming until it is complete.
      ramp: {
        enabled: true,
        start: 5,
        increment: 5,
        every_days: 7,
        delay_days: 14,
        started_at: today,
      },
      status: "warming",
    });
    expect(zoho.warnings.join(" ")).toContain("smtp.zoho.eu");
    const custom = prepareMailbox(
      {
        email: "sam@brand.example.com",
        smtp_host: "mail.example.org",
        smtp_port: 587,
        password: "pw",
      },
      { workspace: ctx.workspace, today },
    );
    expect(custom.values.smtp).toMatchObject({ port: 587, secure: false });
    expect(custom.values.imap).toBeNull();
    expect(custom.warnings.join(" ")).toContain("No IMAP server");
    expect(custom.passwords).toEqual({ smtp: "pw", imap: "pw" });
    expect(() =>
      prepareMailbox(
        { email: "sam@brand.example.com", password: "pw" },
        { workspace: ctx.workspace, today },
      ),
    ).toThrow(/smtp_host/);
    expect(() =>
      prepareMailbox({ email: "not-an-email" }, { workspace: ctx.workspace, today }),
    ).toThrow(/not a valid email/);
  });

  it("starts pre-warmed mailboxes at ramp week 5 and sends at once without a ramp", async () => {
    ctx = await createTestContext();
    const base = { email: "sam@brand.example.com", preset: "zoho" as const, password: "pw" };
    const warmed = prepareMailbox(
      { ...base, warmed_up: true },
      { workspace: ctx.workspace, today },
    );
    expect(warmed.values).toMatchObject({
      ramp: { start: 15, increment: 5, every_days: 7, delay_days: 0, started_at: today },
      status: "warming",
    });
    expect(warmed.warnings.join(" ")).toContain("week 5");
    const none = prepareMailbox({ ...base, ramp: null }, { workspace: ctx.workspace, today });
    expect(none.values).toMatchObject({ ramp: null, status: "active" });
    expect(none.warnings.join(" ")).toContain("No ramp");
  });

  it("lets OAuth mailboxes use the Microsoft preset", async () => {
    ctx = await createTestContext();
    const prepared = prepareMailbox(
      { email: "lee@brand.example.com", preset: "microsoft", auth: "oauth_microsoft" },
      { workspace: ctx.workspace, today },
    );
    expect(prepared.values).toMatchObject({
      auth_type: "oauth_microsoft",
      smtp: { host: "smtp.office365.com", port: 587, secure: false },
    });
    expect(prepared.passwords).toBeNull();
    expect(parseWorkspaceSettings({}).compliance.ad_disclosure.countries).toEqual(["US"]);
  });
});
