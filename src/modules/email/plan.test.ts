import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { parseCampaignSettings } from "../../core/settings.js";
import { mailboxes, sender_counters, workspaces } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { seedMailbox, seedMessage } from "../../testing/factories.js";
import { planEmailSend } from "./service.js";

const MONDAY_10_CHICAGO = "2026-09-21T15:00:00.000Z";
const schedule = parseCampaignSettings({}).schedule; // Mon-Fri 8-17, recipient timezone

let ctx: TestContext;
afterEach(async () => {
  await ctx?.close();
});

async function setup(now = MONDAY_10_CHICAGO) {
  ctx = await createTestContext({ now });
  return ctx;
}

function plan(mailboxIds: string[], overrides: Partial<Parameters<typeof planEmailSend>[1]> = {}) {
  return planEmailSend(ctx, {
    mailboxIds,
    recipientEmail: "dana@harbor.example.com",
    recipientTimezone: "America/Chicago",
    schedule,
    ...overrides,
  });
}

describe("planEmailSend", () => {
  it("sends now inside the window", async () => {
    await setup();
    const mailbox = await seedMailbox(ctx);
    const result = await plan([mailbox.id]);
    expect(result).toEqual({
      ok: true,
      mailboxId: mailbox.id,
      sendAt: new Date(MONDAY_10_CHICAGO),
    });
  });

  it("returns outside_window with the next opening on a weekend", async () => {
    await setup("2026-09-19T12:00:00.000Z"); // Saturday
    const mailbox = await seedMailbox(ctx);
    expect(await plan([mailbox.id])).toEqual({
      ok: false,
      reason: "outside_window",
      retryAt: new Date("2026-09-21T13:00:00.000Z"),
    });
    // Tokyo recipients open earlier (Monday 08:00 JST = Sunday 23:00Z).
    expect(await plan([mailbox.id], { recipientTimezone: "Asia/Tokyo" })).toMatchObject({
      reason: "outside_window",
      retryAt: new Date("2026-09-20T23:00:00.000Z"),
    });
  });

  it("skips workspace holidays", async () => {
    ctx = await createTestContext({
      now: "2026-09-19T12:00:00.000Z",
      settings: { schedule: { holidays: ["2026-09-21"] } },
    });
    const mailbox = await seedMailbox(ctx);
    expect(await plan([mailbox.id])).toMatchObject({
      reason: "outside_window",
      retryAt: new Date("2026-09-22T13:00:00.000Z"),
    });
  });

  it("makes mail bound to a mailbox paused for its health wait instead of moving", async () => {
    await setup();
    const held = await seedMailbox(ctx, {
      status: "paused",
      health: {
        auto_pause: { kind: "bounce_rate", at: MONDAY_10_CHICAGO, until: null },
      },
    });
    // Callers (the sequencer's thread mailbox) get a retry time, not "no mailbox left".
    expect(await plan([held.id])).toEqual({
      ok: false,
      reason: "no_capacity",
      retryAt: new Date("2026-09-21T21:00:00.000Z"),
    });
    const timed = await seedMailbox(ctx, {
      status: "paused",
      health: {
        auto_pause: {
          kind: "provider_block",
          at: MONDAY_10_CHICAGO,
          status: "4.7.28",
          until: "2026-09-21T17:00:00.000Z",
        },
      },
    });
    expect(await plan([timed.id])).toMatchObject({
      reason: "no_capacity",
      retryAt: new Date("2026-09-21T17:00:00.000Z"),
    });
    // With a healthy mailbox in the list, new mail simply goes there.
    const active = await seedMailbox(ctx);
    expect(await plan([held.id, active.id])).toMatchObject({ ok: true, mailboxId: active.id });
  });

  it("refuses when the workspace is paused or no mailbox can send", async () => {
    await setup();
    const paused = await seedMailbox(ctx, { status: "paused" });
    expect(await plan([])).toEqual({ ok: false, reason: "no_active_mailbox" });
    expect(await plan([paused.id])).toEqual({ ok: false, reason: "no_active_mailbox" });
    const active = await seedMailbox(ctx);
    await ctx.db
      .update(workspaces)
      .set({ status: "paused" })
      .where(eq(workspaces.id, ctx.workspace.id));
    await ctx.reloadWorkspace();
    expect(await plan([active.id])).toEqual({ ok: false, reason: "workspace_paused" });
  });

  it("keeps a random gap after the mailbox's last scheduled send", async () => {
    await setup();
    const mailbox = await seedMailbox(ctx, { min_gap_seconds: 300, max_gap_seconds: 600 });
    await seedMessage(ctx, {
      mailbox_id: mailbox.id,
      status: "scheduled",
      scheduled_for: new Date(MONDAY_10_CHICAGO),
      to_address: "omar@bluefield.example.com",
    });
    const result = await plan([mailbox.id]);
    if (!result.ok) throw new Error("expected a slot");
    const gap = (result.sendAt.getTime() - Date.parse(MONDAY_10_CHICAGO)) / 1000;
    expect(gap).toBeGreaterThanOrEqual(300);
    expect(gap).toBeLessThanOrEqual(600);
    // Deterministic: the same question gets the same answer.
    expect(await plan([mailbox.id])).toEqual(result);
  });

  it("counts a send whose outcome is unknown as taken (it may have gone out)", async () => {
    await setup();
    const mailbox = await seedMailbox(ctx, { min_gap_seconds: 300, max_gap_seconds: 600 });
    await seedMessage(ctx, {
      mailbox_id: mailbox.id,
      status: "unknown",
      scheduled_for: new Date(MONDAY_10_CHICAGO),
      to_address: "omar@bluefield.example.com",
    });
    const result = await plan([mailbox.id]);
    if (!result.ok) throw new Error("expected a slot");
    expect(result.sendAt.getTime() - Date.parse(MONDAY_10_CHICAGO)).toBeGreaterThanOrEqual(300_000);
  });

  it("follows the ramp: day one allows `start` sends, then no_capacity until tomorrow", async () => {
    await setup();
    const mailbox = await seedMailbox(ctx, {
      daily_limit: 30,
      ramp: { enabled: true, start: 2, increment: 5, every_days: 3, started_at: "2026-09-21" },
    });
    await ctx.db.insert(sender_counters).values({
      sender_type: "mailbox",
      sender_id: mailbox.id,
      day: "2026-09-21",
      action: "email",
      count: 2,
    });
    expect(await plan([mailbox.id])).toEqual({
      ok: false,
      reason: "no_capacity",
      retryAt: new Date("2026-09-22T13:00:00.000Z"),
    });
  });

  it("limits sends to one company domain to 2 per hour across mailboxes", async () => {
    await setup();
    const [a, b, c] = [await seedMailbox(ctx), await seedMailbox(ctx), await seedMailbox(ctx)];
    for (const [mailbox, minutes] of [
      [a, 20],
      [b, 10],
    ] as const) {
      await seedMessage(ctx, {
        mailbox_id: mailbox.id,
        status: "sent",
        sent_at: new Date(Date.parse(MONDAY_10_CHICAGO) - minutes * 60_000),
        to_address: `person${minutes}@harbor.example.com`,
      });
    }
    const result = await plan([c.id]);
    expect(result).toMatchObject({ ok: true, mailboxId: c.id });
    if (!result.ok) return;
    expect(result.sendAt.toISOString()).toBe("2026-09-21T15:40:00.000Z");
    // Freemail recipients are not throttled.
    expect(await plan([c.id], { recipientEmail: "dana@gmail.com" })).toMatchObject({
      sendAt: new Date(MONDAY_10_CHICAGO),
    });
  });

  it("rotates to the least used mailbox unless the preferred one fits", async () => {
    await setup();
    const busy = await seedMailbox(ctx, { ramp: null });
    const idle = await seedMailbox(ctx, { ramp: null });
    await ctx.db.insert(sender_counters).values({
      sender_type: "mailbox",
      sender_id: busy.id,
      day: "2026-09-21",
      action: "email",
      count: 12,
    });
    expect(await plan([busy.id, idle.id])).toMatchObject({ ok: true, mailboxId: idle.id });
    expect(await plan([busy.id, idle.id], { preferredMailboxId: busy.id })).toMatchObject({
      ok: true,
      mailboxId: busy.id,
    });
  });

  it("skips a mailbox the provider throttled for the day", async () => {
    await setup();
    const throttled = await seedMailbox(ctx, {
      health: { throttled_until: "2026-09-22T00:00:00.000Z" },
    });
    const other = await seedMailbox(ctx);
    expect(await plan([throttled.id, other.id])).toMatchObject({ ok: true, mailboxId: other.id });
    await ctx.db.update(mailboxes).set({ status: "paused" }).where(eq(mailboxes.id, other.id));
    expect(await plan([throttled.id])).toEqual({
      ok: false,
      reason: "no_capacity",
      retryAt: new Date("2026-09-22T13:00:00.000Z"),
    });
  });

  it("does not plan after the campaign end", async () => {
    await setup();
    const mailbox = await seedMailbox(ctx);
    expect(
      await plan([mailbox.id], {
        schedule: { ...schedule, end_at: "2026-09-20T00:00:00.000Z" },
      }),
    ).toEqual({ ok: false, reason: "outside_window" });
  });
});
