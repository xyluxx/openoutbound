/** Report schedule operations. Clock: Saturday 2026-09-19 12:00 UTC, workspace in Berlin. */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { notification_channels, schedules } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { seedCampaign, seedWorkspace } from "../../testing/factories.js";
import {
  createReportSchedule,
  deleteReportSchedule,
  listReportSchedules,
  runReportSchedule,
} from "./operations/schedules.js";
import { MAX_SCHEDULES_PER_WORKSPACE, nextCronRun, REPORT_JOB_NAME } from "./schedule-config.js";
import { reportTools } from "./tools.js";

let ctx: TestContext;
const channel: Record<string, string> = {};
const MISSING_CHANNEL = "ntf_01k6a3v0q8x3m2n4p5r6s7t8v9";

async function create(input: Record<string, unknown>, context: TestContext = ctx) {
  const raw = await createReportSchedule.handler(context, createReportSchedule.input.parse(input));
  return createReportSchedule.output.parse(raw);
}

async function list(input: Record<string, unknown> = {}) {
  const raw = await listReportSchedules.handler(ctx, listReportSchedules.input.parse(input));
  return listReportSchedules.output.parse(raw);
}

beforeAll(async () => {
  ctx = await createTestContext({ workspace: { timezone: "Europe/Berlin" } });
  const rows = await ctx.db
    .insert(notification_channels)
    .values([
      { workspace_id: ctx.workspace.id, type: "slack_webhook", name: "Team Slack" },
      { workspace_id: ctx.workspace.id, type: "email", name: "Client email" },
      { workspace_id: ctx.workspace.id, type: "webhook", name: "Old hook", enabled: false },
    ])
    .returning();
  channel.slack = rows[0]?.id ?? "";
  channel.email = rows[1]?.id ?? "";
  channel.disabled = rows[2]?.id ?? "";
});

afterAll(async () => {
  await ctx.close();
});

describe("reports.schedules.create", () => {
  it("stores a schedule row the runtime scheduler runs", async () => {
    const output = await create({
      name: "Weekly overview",
      cron: "0 8 * * 1",
      channels: [channel.slack, channel.email, channel.slack],
      ai_summary: true,
    });
    expect(output).toMatchObject({
      name: "Weekly overview",
      type: "overview",
      period: "last_7_days",
      cron: "0 8 * * 1",
      timezone: "Europe/Berlin",
      channels: [channel.slack, channel.email],
      ai_summary: true,
      campaign_id: null,
      compare: true,
      enabled: true,
      last_run_at: null,
    });
    // Monday 08:00 in Berlin (UTC+2 in September).
    expect(output.next_run_at).toBe("2026-09-21T06:00:00.000Z");
    const [row] = await ctx.db.select().from(schedules).where(eq(schedules.id, output.id));
    expect(row).toMatchObject({
      workspace_id: ctx.workspace.id,
      name: "report:Weekly overview",
      job_name: REPORT_JOB_NAME,
      timezone: "Europe/Berlin",
      payload: {
        schedule_id: output.id,
        workspace_id: ctx.workspace.id,
        name: "Weekly overview",
        type: "overview",
        period: "last_7_days",
        channels: [channel.slack, channel.email],
        ai_summary: true,
        campaign_id: null,
        compare: true,
      },
    });
  });

  it("defaults the name and accepts another timezone and a campaign", async () => {
    const { campaign } = await seedCampaign(ctx, { name: "Spring push" });
    const output = await create({
      type: "campaign",
      period: "last_month",
      cron: "0 9 1 * *",
      timezone: "America/New_York",
      campaign_id: campaign.id,
      compare: false,
    });
    expect(output).toMatchObject({
      name: "campaign last_month",
      timezone: "America/New_York",
      campaign_id: campaign.id,
      compare: false,
      channels: [],
      ai_summary: false,
    });
    expect(output.next_run_at).toBe("2026-10-01T13:00:00.000Z");
  });

  it.each([
    [{ cron: "every monday" }, "validation_failed", "Invalid cron"],
    [{ cron: "*/5 * * * *" }, "validation_failed", "more than once an hour"],
    [{ cron: "0 8 * * 1", timezone: "Mars/Base" }, "validation_failed", "Mars/Base"],
    [{ cron: "0 8 * * 1", channels: [MISSING_CHANNEL] }, "not_found", MISSING_CHANNEL],
    [
      { cron: "0 8 * * 1", campaign_id: "cmp_01k6a3v0q8x3m2n4p5r6s7t8v9" },
      "validation_failed",
      "only works with type campaign",
    ],
    [
      { cron: "0 8 * * 1", type: "campaign", campaign_id: "cmp_01k6a3v0q8x3m2n4p5r6s7t8v9" },
      "not_found",
      "Campaign",
    ],
    [{ cron: "0 8 * * 1", name: "Weekly overview" }, "conflict", "already exists"],
  ])("rejects %o", async (input, code, message) => {
    await expect(create({ name: "Rejected", ...input })).rejects.toMatchObject({
      code,
      message: expect.stringContaining(message),
    });
  });

  it("rejects disabled channels", async () => {
    await expect(create({ cron: "0 8 * * 1", channels: [channel.disabled] })).rejects.toMatchObject(
      {
        code: "validation_failed",
        message: expect.stringContaining("disabled"),
      },
    );
  });

  it("does not schedule agency reports or malformed ids", () => {
    expect(
      createReportSchedule.input.safeParse({ type: "agency", cron: "0 8 * * 1" }).success,
    ).toBe(false);
    expect(
      createReportSchedule.input.safeParse({ cron: "0 8 * * 1", channels: ["slack"] }).success,
    ).toBe(false);
  });

  it("limits schedules per workspace", async () => {
    const other = ctx.with({ workspace: await seedWorkspace(ctx.db) });
    const workspaceId = other.workspace?.id ?? "";
    await ctx.db.insert(schedules).values(
      Array.from({ length: MAX_SCHEDULES_PER_WORKSPACE }, (_, i) => ({
        workspace_id: workspaceId,
        name: `report:filler ${i}`,
        cron: "0 8 * * 1",
        job_name: REPORT_JOB_NAME,
      })),
    );
    await expect(create({ cron: "0 8 * * 1" }, other)).rejects.toMatchObject({
      code: "limit_reached",
    });
  });
});

describe("nextCronRun", () => {
  it("runs in the given timezone and rejects crons that never run", () => {
    const now = new Date("2026-09-19T12:00:00Z");
    expect(nextCronRun("0 8 * * *", "Asia/Kolkata", now).toISOString()).toBe(
      "2026-09-20T02:30:00.000Z",
    );
    expect(nextCronRun("30 7 * * 1-5", "UTC", now).toISOString()).toBe("2026-09-21T07:30:00.000Z");
    expect(() => nextCronRun("0 8 30 2 *", "UTC", now)).toThrow(/never runs again|Invalid cron/);
    expect(() => nextCronRun("0 * * * *", "UTC", now)).not.toThrow();
    expect(() => nextCronRun("0 0 8 * * 1 2027", "UTC", now)).toThrow(/Invalid cron/);
    expect(nextCronRun("0 30 7 * * 1", "UTC", now).toISOString()).toBe("2026-09-21T07:30:00.000Z");
  });
});

describe("list, delete and run", () => {
  it("lists schedules newest first with a cursor", async () => {
    const all = await list();
    expect(all.items.map((item) => item.name)).toEqual(["campaign last_month", "Weekly overview"]);
    expect(all.next_cursor).toBeNull();
    const first = await list({ limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.next_cursor).not.toBeNull();
    const second = await list({ limit: 1, cursor: first.next_cursor });
    expect(second.items.map((item) => item.name)).toEqual(["Weekly overview"]);
  });

  it("queues a manual run with a job handle", async () => {
    const [schedule] = (await list()).items;
    const handle = runReportSchedule.output.parse(
      await runReportSchedule.handler(
        ctx,
        runReportSchedule.input.parse({ schedule_id: schedule?.id }),
      ),
    );
    expect(handle.job_id).toMatch(/^job_/);
    const [job] = ctx.enqueued(REPORT_JOB_NAME);
    expect(job?.payload).toEqual({
      schedule_id: schedule?.id,
      workspace_id: ctx.workspace.id,
      manual: true,
    });
    expect(job?.options?.singletonKey).toBe(`reports.run_now:${schedule?.id}`);
  });

  it("deletes a schedule and reports unknown ids", async () => {
    const [schedule] = (await list()).items;
    const input = deleteReportSchedule.input.parse({ schedule_id: schedule?.id });
    expect(await deleteReportSchedule.handler(ctx, input)).toEqual({
      id: schedule?.id,
      deleted: true,
    });
    await expect(deleteReportSchedule.handler(ctx, input)).rejects.toMatchObject({
      code: "not_found",
      hint: expect.stringContaining("manage_report_schedules (action list)"),
    });
    expect((await list()).items.map((item) => item.name)).toEqual(["Weekly overview"]);
  });

  it("never shows another workspace's schedules", async () => {
    const other = ctx.with({ workspace: await seedWorkspace(ctx.db) });
    const raw = await listReportSchedules.handler(other, listReportSchedules.input.parse({}));
    expect(raw.items).toEqual([]);
    const [schedule] = (await list()).items;
    await expect(
      runReportSchedule.handler(
        other,
        runReportSchedule.input.parse({ schedule_id: schedule?.id }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("tools", () => {
  it("exposes get_report, get_attention_queue and manage_report_schedules", () => {
    expect(reportTools.map((tool) => [tool.name, tool.toolset])).toEqual([
      ["get_report", "core"],
      ["get_attention_queue", "core"],
      ["manage_report_schedules", "admin"],
    ]);
  });
});
