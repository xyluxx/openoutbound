/**
 * Sending an email again after an unknown outcome (the reconcile job's resend, or a person's
 * resolve_unknown resend): the resend follows the sequence and the campaign as they are now,
 * and it goes out inside the send window.
 */
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { campaigns, enrollments, messages } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import {
  seedCampaign,
  seedEnrollment,
  seedMailbox,
  seedMessage,
  seedPerson,
  seedThread,
} from "../../testing/factories.js";
import { stopCampaign } from "../campaigns/operations/lifecycle.js";
import { takeOverThread } from "../inbox/takeover.js";
import { RECONCILE_JOB, reconcileUnknownSends } from "./reconcile-job.js";
import { clearSandboxOutbox, getSandboxOutbox } from "./sandbox-transport.js";
import { sendEmailMessage } from "./send-job.js";
import { resolveUnknownOperation } from "./unknown-operations.js";

vi.mock("../leads/service.js", async () => (await import("./test-support.js")).fakeLeadsService);
vi.mock("../../runtime/notify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/notify.js")>()),
  notify: vi.fn(async () => {}),
}));
vi.mock("../enrichment/service.js", () => ({ verifyEmailNow: vi.fn(async () => "valid") }));

let ctx: TestContext;
afterEach(async () => {
  clearSandboxOutbox();
  await ctx?.close();
});

async function reload(id: string) {
  const [row] = await ctx.db.select().from(messages).where(eq(messages.id, id));
  if (!row) throw new Error("message gone");
  return row;
}

const reconcile = () => reconcileUnknownSends(ctx.jobContext({ name: RECONCILE_JOB }));

/** A first campaign email whose outcome is unknown; its last lookup is due now. */
async function unknownStep() {
  ctx = await createTestContext({ sandbox: true, now: "2026-09-22T15:00:00.000Z" });
  const mailbox = await seedMailbox(ctx, { email: "sam@brand.example.com" });
  const { campaign, steps } = await seedCampaign(ctx, {
    status: "active",
    settings: { senders: { mailbox_ids: [mailbox.id] } },
  });
  const dana = await seedPerson(ctx, {
    email: "dana@harbor.example.com",
    first_name: "Dana",
    status: "active",
  });
  const enrollment = await seedEnrollment(ctx, { campaign_id: campaign.id, person_id: dana.id });
  const dispatched = new Date("2026-09-22T14:30:00.000Z");
  const unknown = await seedMessage(ctx, {
    person_id: dana.id,
    campaign_id: campaign.id,
    enrollment_id: enrollment.id,
    step_id: steps[0]?.id ?? null,
    mailbox_id: mailbox.id,
    to_address: dana.email,
    status: "unknown",
    scheduled_for: dispatched,
    dispatch_started_at: dispatched,
    reconcile_checks: 2,
    message_id_header: "<first-try@brand.example.com>",
    subject: "Quick question",
    body_text: "Hi {{first_name}}, short note.",
  });
  return { mailbox, campaign, dana, enrollment, unknown };
}

describe("a resend after an unknown outcome follows the sequence", () => {
  it("is cancelled when the user stopped the campaign meanwhile", async () => {
    const { campaign, enrollment, unknown } = await unknownStep();
    await stopCampaign.handler(ctx, stopCampaign.input.parse({ campaign_id: campaign.id }));
    const [stopped] = await ctx.db.select().from(campaigns).where(eq(campaigns.id, campaign.id));
    expect(stopped?.status).toBe("completed");
    const [row] = await ctx.db.select().from(enrollments).where(eq(enrollments.id, enrollment.id));
    expect(row?.status).toBe("stopped");
    // The stop cancels pending messages, not one whose outcome is unknown.
    expect((await reload(unknown.id)).status).toBe("unknown");

    // No copy found after the last lookup: it is queued again, and the send job cancels it.
    expect((await reconcile()).email.resent).toBe(1);
    expect(await sendEmailMessage(ctx.jobContext(), unknown.id)).toMatchObject({
      status: "cancelled",
      reason: "campaign_completed",
    });
    expect(await reload(unknown.id)).toMatchObject({
      status: "cancelled",
      error: "cancelled: campaign_completed",
    });
    expect(getSandboxOutbox()).toHaveLength(0);
  });

  it("is cancelled when a person wrote to the lead themselves meanwhile", async () => {
    const { dana, enrollment, unknown } = await unknownStep();
    // A person's own email to Dana (found in the Sent folder) takes a new thread over.
    const own = await seedThread(ctx, { person_id: dana.id, owner: "engine" });
    expect((await takeOverThread(ctx, own.id, { reason: "sent_folder" })).changed).toBe(true);
    const [row] = await ctx.db.select().from(enrollments).where(eq(enrollments.id, enrollment.id));
    expect(row).toMatchObject({ status: "stopped", stop_reason: "person_took_over" });

    expect((await reconcile()).email.resent).toBe(1);
    expect(await sendEmailMessage(ctx.jobContext(), unknown.id)).toMatchObject({
      status: "cancelled",
      reason: "enrollment_stopped:person_took_over",
    });
    expect(getSandboxOutbox()).toHaveLength(0);
  });
});

describe("a resend after an unknown outcome keeps to the send window", () => {
  /** A campaign that sends 9:00 to 17:00 New York time, weekdays, and Dana's unknown email. */
  async function unknownInNewYork(now: string, reconcileChecks: number) {
    ctx = await createTestContext({ sandbox: true, now });
    const mailbox = await seedMailbox(ctx, { email: "sam@brand.example.com" });
    const { campaign } = await seedCampaign(ctx, {
      status: "active",
      settings: {
        schedule: { start_hour: 9, end_hour: 17, timezone: "America/New_York" },
        senders: { mailbox_ids: [mailbox.id] },
      },
    });
    const dana = await seedPerson(ctx, {
      email: "dana@harbor.example.com",
      first_name: "Dana",
      status: "active",
      timezone: "America/New_York",
    });
    // Dispatched Friday 16:55 in New York, inside the window.
    const dispatched = new Date("2026-09-25T20:55:00.000Z");
    const unknown = await seedMessage(ctx, {
      person_id: dana.id,
      campaign_id: campaign.id,
      mailbox_id: mailbox.id,
      to_address: dana.email,
      status: "unknown",
      scheduled_for: dispatched,
      dispatch_started_at: dispatched,
      reconcile_checks: reconcileChecks,
      message_id_header: "<first-try@brand.example.com>",
      subject: "Quick question",
      body_text: "Hi {{first_name}}, short note.",
    });
    return unknown;
  }

  /** Monday 28 September, 09:00 to 17:00 in New York. */
  function expectMondayWindow(at: Date | null | undefined) {
    expect(at?.getTime()).toBeGreaterThanOrEqual(Date.parse("2026-09-28T13:00:00.000Z"));
    expect(at?.getTime()).toBeLessThan(Date.parse("2026-09-28T21:00:00.000Z"));
  }

  it("plans the automatic resend at the next opening, not at 17:25 after the close", async () => {
    // Friday 17:25 in New York: the window closed at 17:00.
    const unknown = await unknownInNewYork("2026-09-25T21:25:00.000Z", 2);
    expect((await reconcile()).email.resent).toBe(1);
    const row = await reload(unknown.id);
    expect(row.status).toBe("scheduled");
    expectMondayWindow(row.scheduled_for);
    const [job] = ctx.enqueued("email.send");
    expect(job?.options.runAt).toEqual(row.scheduled_for);

    // The job runs when it is due and sends it then.
    ctx.clock.set(row.scheduled_for ?? new Date());
    expect((await sendEmailMessage(ctx.jobContext(), unknown.id)).status).toBe("sent");
    expect(getSandboxOutbox()).toHaveLength(1);
  });

  it("plans a manual resend at the next opening, not at 03:00 on a Sunday", async () => {
    // Sunday 03:00 in New York.
    const unknown = await unknownInNewYork("2026-09-27T07:00:00.000Z", 3);
    await resolveUnknownOperation.handler(
      ctx,
      resolveUnknownOperation.input.parse({ message_id: unknown.id, outcome: "resend" }),
    );
    const row = await reload(unknown.id);
    expect(row.status).toBe("scheduled");
    expectMondayWindow(row.scheduled_for);
    expect(ctx.enqueued("email.send")[0]?.options.runAt).toEqual(row.scheduled_for);
  });
});
