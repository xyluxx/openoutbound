import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Mailbox, mailboxes, messages } from "../../db/schema/index.js";
import { notify } from "../../runtime/notify.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { seedMailbox } from "../../testing/factories.js";
import { HARD_BOUNCE_PREFIX } from "./bounce.js";
import { checkMailboxHealth, healthJob } from "./health-job.js";
import { holdsQueuedMail, mergeAutoPause } from "./mailbox-state.js";
import { resumeMailboxOperation } from "./operations/status.js";

vi.mock("../../runtime/notify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/notify.js")>()),
  notify: vi.fn(async () => {}),
}));

const NOW = new Date("2026-09-21T16:00:00Z");
let ctx: TestContext;

beforeEach(async () => {
  vi.mocked(notify).mockClear();
  ctx = await createTestContext({ now: NOW });
});
afterEach(async () => {
  await ctx.close();
});

/** `sent` outbound emails in the last days, `bounced` of them hard bounces. */
async function history(mailbox: Mailbox, sent: number, bounced: number) {
  const rows = Array.from({ length: sent }, (_, i) => ({
    workspace_id: ctx.workspace.id,
    channel: "email" as const,
    action: "email" as const,
    direction: "outbound" as const,
    mailbox_id: mailbox.id,
    to_address: `lead${i}@clinic${i}.example.com`,
    status: i < bounced ? ("bounced" as const) : ("sent" as const),
    error: i < bounced ? `${HARD_BOUNCE_PREFIX}550 5.1.1 unknown user` : null,
    sent_at: new Date(NOW.getTime() - (i % 6) * 86_400_000 - 3_600_000),
  }));
  if (rows.length > 0) await ctx.db.insert(messages).values(rows);
}

async function reload(id: string) {
  const [row] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, id));
  if (!row) throw new Error("mailbox missing");
  return row;
}

describe("mailbox health", () => {
  it("pauses above 3% hard bounces with at least 20 sends", async () => {
    const mailbox = await seedMailbox(ctx);
    await history(mailbox, 25, 1);
    const result = await checkMailboxHealth(ctx.jobContext(), mailbox);
    expect(result).toMatchObject({
      sent_7d: 25,
      bounced_7d: 1,
      bounce_rate_7d: 0.04,
      action: "paused",
    });
    const row = await reload(mailbox.id);
    expect(row.status).toBe("paused");
    expect(row.status_reason).toContain("4.0%");
    expect(row.health).toMatchObject({ sent_7d: 25, bounced_7d: 1, bounce_rate_7d: 0.04 });
    // Marked as a health pause: its queued mail waits instead of moving to other mailboxes.
    expect(row.health.auto_pause).toMatchObject({ kind: "bounce_rate", until: null });
    expect(ctx.emitted("mailbox.paused")[0]?.data).toMatchObject({ mailbox_id: mailbox.id });
    expect(vi.mocked(notify)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ severity: "warning", event: "mailbox.paused" }),
    );
  });

  it("warns once a day from 2% without pausing", async () => {
    const mailbox = await seedMailbox(ctx);
    await history(mailbox, 50, 1);
    const first = await checkMailboxHealth(ctx.jobContext(), mailbox);
    expect(first.action).toBe("warned");
    expect((await reload(mailbox.id)).status).toBe("active");
    expect(vi.mocked(notify)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notify).mock.calls[0]?.[1]).toMatchObject({ severity: "warning" });

    const second = await checkMailboxHealth(ctx.jobContext(), await reload(mailbox.id));
    expect(second.action).toBe("none");
    expect(vi.mocked(notify)).toHaveBeenCalledTimes(1);
  });

  it("needs at least 20 sends before judging", async () => {
    const mailbox = await seedMailbox(ctx);
    await history(mailbox, 10, 3);
    expect((await checkMailboxHealth(ctx.jobContext(), mailbox)).action).toBe("none");
    expect((await reload(mailbox.id)).status).toBe("active");
  });

  it("pauses after 5 send failures in a row", async () => {
    const mailbox = await seedMailbox(ctx, { health: { consecutive_failures: 5 } });
    expect((await checkMailboxHealth(ctx.jobContext(), mailbox)).action).toBe("paused");
    const row = await reload(mailbox.id);
    expect(row.status_reason).toContain("5 send failures in a row");
    expect(row.health.auto_pause).toMatchObject({ kind: "failures" });
  });

  it("ends 48-hour domain-block pauses when their time is up and finishes warmups", async () => {
    const autoPause = (until: string) => ({
      kind: "provider_block" as const,
      at: "2026-09-19T15:00:00.000Z",
      status: "4.7.28",
      domain: "example.org",
      until,
    });
    const due = await seedMailbox(ctx, {
      status: "paused",
      health: { auto_pause: autoPause("2026-09-21T15:00:00.000Z"), consecutive_failures: 2 },
    });
    const later = await seedMailbox(ctx, {
      status: "paused",
      health: { auto_pause: autoPause("2026-09-22T15:00:00.000Z") },
    });
    const byPerson = await seedMailbox(ctx, { status: "paused", status_reason: "Paused by Sam" });
    // Week 8 of the default ramp: warming ends.
    const warmed = await seedMailbox(ctx, {
      status: "warming",
      ramp: {
        enabled: true,
        start: 5,
        increment: 5,
        every_days: 7,
        delay_days: 14,
        started_at: "2026-08-03",
      },
    });
    const warming = await seedMailbox(ctx, {
      status: "warming",
      ramp: {
        enabled: true,
        start: 5,
        increment: 5,
        every_days: 7,
        delay_days: 14,
        started_at: "2026-09-14",
      },
    });
    const result = (await healthJob.handler(ctx.jobContext(), undefined)) as {
      resumed: number;
      warmed_up: number;
    };
    expect(result).toMatchObject({ resumed: 1, warmed_up: 1 });
    expect(await reload(due.id)).toMatchObject({ status: "active", status_reason: null });
    expect((await reload(due.id)).health).toMatchObject({
      auto_pause: null,
      consecutive_failures: 0,
    });
    expect(ctx.recorded.wakes).toContain(`mailbox_active:${due.id}`);
    expect((await reload(later.id)).status).toBe("paused");
    expect((await reload(byPerson.id)).status).toBe("paused");
    expect((await reload(warmed.id)).status).toBe("active");
    expect((await reload(warming.id)).status).toBe("warming");
  });

  it("counts only sends after a person resumed the mailbox", async () => {
    const mailbox = await seedMailbox(ctx);
    await history(mailbox, 25, 1);
    expect((await checkMailboxHealth(ctx.jobContext(), mailbox)).action).toBe("paused");

    // The person re-verifies the list and resumes: the old bounces no longer pause it.
    await resumeMailboxOperation.handler(
      ctx,
      resumeMailboxOperation.input.parse({ mailbox_id: mailbox.id }),
    );
    expect((await reload(mailbox.id)).health.resumed_at).toBe(NOW.toISOString());
    ctx.clock.advance(3_600_000);
    const after = await checkMailboxHealth(ctx.jobContext(), await reload(mailbox.id));
    expect(after).toMatchObject({ action: "none", sent_7d: 0, bounced_7d: 0 });
    expect((await reload(mailbox.id)).status).toBe("active");

    // Sends after the resume count as usual.
    const since = NOW.getTime() + 60_000;
    await ctx.db.insert(messages).values(
      Array.from({ length: 20 }, (_, i) => ({
        workspace_id: ctx.workspace.id,
        channel: "email" as const,
        action: "email" as const,
        direction: "outbound" as const,
        mailbox_id: mailbox.id,
        to_address: `fresh${i}@clinic${i}.example.com`,
        status: i < 1 ? ("bounced" as const) : ("sent" as const),
        error: i < 1 ? `${HARD_BOUNCE_PREFIX}550 5.1.1 unknown user` : null,
        sent_at: new Date(since + i * 60_000),
      })),
    );
    const again = await checkMailboxHealth(ctx.jobContext(), await reload(mailbox.id));
    expect(again).toMatchObject({ action: "paused", sent_7d: 20, bounced_7d: 1 });
  });

  it("checks every active mailbox of the workspace", async () => {
    const healthy = await seedMailbox(ctx);
    const bad = await seedMailbox(ctx);
    await seedMailbox(ctx, { status: "paused" });
    await history(bad, 20, 2);
    const result = (await healthJob.handler(ctx.jobContext(), undefined)) as {
      checked: number;
      paused: number;
    };
    expect(result).toMatchObject({ checked: 2, paused: 1 });
    expect((await reload(healthy.id)).status).toBe("active");
    expect((await reload(bad.id)).status).toBe("paused");
  });
});

describe("auto-pause records", () => {
  const at = "2026-09-21T10:00:00.000Z";
  const block = (until: string | null) => ({
    kind: "provider_block" as const,
    at,
    status: "4.7.28",
    domain: "brand.example.com",
    until,
  });

  it("keeps the strictest pause and never times one that had no end", () => {
    // A person's pause (no record) never ends by itself.
    expect(mergeAutoPause(null, true, block("2026-09-23T10:00:00.000Z")).until).toBeNull();
    // Two timed blocks: the later end wins.
    expect(
      mergeAutoPause(block("2026-09-23T10:00:00.000Z"), true, block("2026-09-24T10:00:00.000Z"))
        .until,
    ).toBe("2026-09-24T10:00:00.000Z");
    // An open-ended bounce-rate pause stays open-ended and becomes a provider block.
    expect(
      mergeAutoPause(
        { kind: "bounce_rate", at, until: null },
        true,
        block("2026-09-23T10:00:00.000Z"),
      ),
    ).toMatchObject({ kind: "provider_block", until: null, at });
    expect(
      mergeAutoPause({ kind: "bounce_rate", at, until: null }, true, { kind: "failures", at }).kind,
    ).toBe("bounce_rate");
    // Not paused before: the new record as is.
    expect(mergeAutoPause(null, false, block("2026-09-23T10:00:00.000Z")).until).toBe(
      "2026-09-23T10:00:00.000Z",
    );
  });

  it("holds queued mail only for bounce-rate and provider-block pauses", () => {
    const paused = (kind: "bounce_rate" | "failures" | "provider_block") => ({
      status: "paused" as const,
      health: { auto_pause: { kind, at } },
    });
    expect(holdsQueuedMail(paused("bounce_rate"))).toBe(true);
    expect(holdsQueuedMail(paused("provider_block"))).toBe(true);
    expect(holdsQueuedMail(paused("failures"))).toBe(false);
    expect(holdsQueuedMail({ status: "paused", health: {} })).toBe(false);
    expect(holdsQueuedMail({ ...paused("bounce_rate"), status: "active" })).toBe(false);
  });
});
