/**
 * Scheduled report job end to end with a fake brain and a mocked runtime notify helper.
 * Clock: Monday 2026-09-21 06:00 UTC (08:00 in Berlin); period last_7_days = 09-14 to 09-20.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { JobWaitError, OpenOutboundError } from "../../../core/errors.js";
import { newId } from "../../../core/ids.js";
import { notification_channels, reports, schedules } from "../../../db/schema/index.js";
import { type NotifyInput, notify } from "../../../runtime/notify.js";
import { createTestContext, type TestContext } from "../../../testing/context.js";
import {
  seedCampaign,
  seedMessage,
  seedPerson,
  seedWorkspace,
} from "../../../testing/factories.js";
import { REPORT_JOB_NAME, type StoredSchedule } from "../schedule-config.js";
import {
  type RunScheduleResult,
  runScheduledReport,
  runScheduleJob,
  runSchedulePayload,
} from "./run-schedule.js";

vi.mock("../../../runtime/notify.js", () => ({ notify: vi.fn(async () => undefined) }));

const notifyMock = vi.mocked(notify);
const t = (iso: string) => new Date(iso);
const GOOD_SUMMARY = {
  summary: "4 people were contacted and 2 replied, a 50.0% reply rate, with 1 positive reply.",
  highlights: ["Reply rate 50.0%", "Positive rate 25.0%"],
};

let ctx: TestContext;
const channels: string[] = [];

async function schedule(
  overrides: Partial<StoredSchedule> & { enabled?: boolean; timezone?: string } = {},
) {
  const { enabled = true, timezone = "Europe/Berlin", ...config } = overrides;
  const id = newId("sch");
  const payload: StoredSchedule = {
    schedule_id: id,
    workspace_id: ctx.workspace.id,
    name: `Weekly ${id}`,
    type: "overview",
    period: "last_7_days",
    channels,
    ai_summary: true,
    campaign_id: null,
    compare: true,
    ...config,
  };
  await ctx.db.insert(schedules).values({
    id,
    workspace_id: payload.workspace_id,
    name: `report:${payload.name}`,
    cron: "0 8 * * 1",
    timezone,
    job_name: REPORT_JOB_NAME,
    payload,
    enabled,
  });
  return id;
}

async function storedReports(scheduleId: string) {
  const all = await ctx.db.select().from(reports).where(eq(reports.workspace_id, ctx.workspace.id));
  return all.filter((row) => row.content.schedule_id === scheduleId);
}

beforeAll(async () => {
  ctx = await createTestContext({
    now: "2026-09-21T06:00:00.000Z",
    workspace: { name: "Harbor Outreach", timezone: "Europe/Berlin" },
  });
  const rows = await ctx.db
    .insert(notification_channels)
    .values([
      { workspace_id: ctx.workspace.id, type: "slack_webhook", name: "Team Slack" },
      { workspace_id: ctx.workspace.id, type: "email", name: "Client email" },
    ])
    .returning();
  channels.push(...rows.map((row) => row.id));

  // 4 contacted in the period (Berlin days 09-14 to 09-20), 2 replied, 1 positive.
  for (let i = 0; i < 4; i++) {
    const person = await seedPerson(ctx, { created_at: t("2026-09-01T00:00:00Z") });
    await seedMessage(ctx, {
      person_id: person.id,
      status: "sent",
      sent_at: t(`2026-09-1${5 + i}T09:00:00Z`),
    });
    if (i < 2) {
      await seedMessage(ctx, {
        person_id: person.id,
        direction: "inbound",
        status: "received",
        action: "reply",
        received_at: t(`2026-09-1${5 + i}T15:00:00Z`),
        classification: { category: i === 0 ? "interested" : "not_now", confidence: 0.9 },
      });
    }
  }
});

beforeEach(() => {
  notifyMock.mockReset();
  notifyMock.mockResolvedValue(undefined);
  ctx.brain.on("reports.summary", GOOD_SUMMARY);
});

afterAll(async () => {
  await ctx.close();
});

describe("scheduled report job", () => {
  it("renders, stores, announces and delivers the report with an AI summary", async () => {
    const id = await schedule();
    const job = ctx.jobContext({ name: REPORT_JOB_NAME });
    const events = ctx.emitted("report.ready").length;
    expect(runScheduleJob.name).toBe(REPORT_JOB_NAME);
    const result = (await runScheduleJob.handler(
      job,
      runSchedulePayload.parse({ schedule_id: id, workspace_id: ctx.workspace.id }),
    )) as RunScheduleResult;
    expect(result).toMatchObject({
      status: "delivered",
      type: "overview",
      channels: 2,
      summary: true,
      reused: false,
    });

    const [row] = await storedReports(id);
    if (!row || result.status === "skipped") throw new Error("expected a stored report");
    expect(row.id).toBe(result.report_id);
    expect(row.period).toMatchObject({ label: "Last 7 days" });
    expect(row.content).toMatchObject({
      schedule_id: id,
      job_id: job.job.id,
      summary: {
        text: GOOD_SUMMARY.summary,
        highlights: GOOD_SUMMARY.highlights,
        model: "fake-fast",
      },
      period: { start_date: "2026-09-14", end_date: "2026-09-20", timezone: "Europe/Berlin" },
    });
    expect(row.markdown).toContain(`**Summary:** ${GOOD_SUMMARY.summary}\n- Reply rate 50.0%`);
    expect(row.markdown).toContain("| Contacted | 4 | 0 | +4 |");
    expect(row.delivered_to).toEqual(
      channels.map((channel) => ({
        channel_id: channel,
        delivered_at: "2026-09-21T06:00:00.000Z",
        ok: true,
      })),
    );

    const ready = ctx.emitted("report.ready").slice(events);
    expect(ready).toHaveLength(1);
    expect(ready[0]?.subject).toEqual({ type: "report", id: row.id });
    expect(ready[0]?.data).toEqual({ report_id: row.id, type: "overview" });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const input = notifyMock.mock.calls[0]?.[1] as NotifyInput & { channelIds?: string[] };
    expect(input).toMatchObject({
      title: "Overview report for Harbor Outreach: Last 7 days (2026-09-14 to 2026-09-20)",
      severity: "info",
      event: "report.ready",
      channelIds: channels,
    });
    expect(input.lines).toEqual([
      GOOD_SUMMARY.summary,
      "Contacted 4 (+4), new leads 0 (0)",
      "Replied 2 (+2), reply rate 50.0%",
      "Positive 1 (+1), positive rate 25.0%",
      "Meetings 0 (0)",
      "Bounce rate 0.0%",
    ]);

    const call = ctx.brain.calls.at(-1);
    expect(call?.promptId).toBe("reports.summary");
    expect(call?.options).toMatchObject({
      jobId: job.job.id,
      taskKey: `reports.summary:${job.job.id}`,
    });
    expect(call?.user).toContain("Workspace: Harbor Outreach");
    expect(call?.user).toContain("Period: Last 7 days (2026-09-14 to 2026-09-20, Europe/Berlin)");
    expect(call?.user).toContain('"contacted":{"value":4');
  });

  it("is idempotent per job: a retry reuses the stored report and does not deliver twice", async () => {
    const id = await schedule();
    const job = ctx.jobContext({ name: REPORT_JOB_NAME });
    const first = await runScheduledReport(job, { schedule_id: id });
    const events = ctx.emitted("report.ready").length;
    const again = await runScheduledReport(job, { schedule_id: id });
    expect(again).toMatchObject({ status: "delivered", reused: true, channels: 2 });
    if (first.status === "skipped" || again.status === "skipped")
      throw new Error("expected reports");
    expect(again.report_id).toBe(first.report_id);
    expect(await storedReports(id)).toHaveLength(1);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(ctx.emitted("report.ready")).toHaveLength(events);
  });

  it("fails the job when delivery fails and delivers on the retry", async () => {
    const id = await schedule();
    const job = ctx.jobContext({ name: REPORT_JOB_NAME });
    notifyMock.mockRejectedValueOnce(new Error("Slack answered 500"));
    await expect(runScheduledReport(job, { schedule_id: id })).rejects.toMatchObject({
      code: "provider_error",
      message: expect.stringContaining("Slack answered 500"),
    });
    const [failed] = await storedReports(id);
    expect(failed?.delivered_to.every((entry) => entry.ok === false)).toBe(true);
    expect(failed?.delivered_to[0]?.error).toBe("Slack answered 500");

    const retry = await runScheduledReport(job, { schedule_id: id });
    expect(retry).toMatchObject({ status: "delivered", reused: true, summary: true });
    const [delivered] = await storedReports(id);
    expect(delivered?.delivered_to.every((entry) => entry.ok)).toBe(true);
    expect(await storedReports(id)).toHaveLength(1);
  });

  it("drops a summary that cites numbers the report does not contain", async () => {
    ctx.brain.on("reports.summary", {
      summary: "Replies jumped to 73.4% across 41 accounts.",
      highlights: [],
    });
    const id = await schedule();
    const result = await runScheduledReport(ctx.jobContext({ name: REPORT_JOB_NAME }), {
      schedule_id: id,
    });
    expect(result).toMatchObject({ status: "delivered", summary: false });
    const [row] = await storedReports(id);
    expect(row?.content.summary).toBeNull();
    expect(row?.markdown).not.toContain("**Summary:**");
    expect(row?.markdown).toContain(
      "AI summary skipped: the AI summary cited numbers that are not in the report (73.4, 41).",
    );
    const input = notifyMock.mock.calls[0]?.[1];
    expect(input?.lines?.[0]).toBe("Contacted 4 (+4), new leads 0 (0)");
  });

  it("still delivers when the AI call fails", async () => {
    ctx.brain.on("reports.summary", () => {
      throw new OpenOutboundError("budget_exceeded", "The monthly AI budget is used up.");
    });
    const id = await schedule();
    const result = await runScheduledReport(ctx.jobContext({ name: REPORT_JOB_NAME }), {
      schedule_id: id,
    });
    expect(result).toMatchObject({ status: "delivered", summary: false });
    const [row] = await storedReports(id);
    expect(row?.markdown).toContain("AI summary skipped: The monthly AI budget is used up.");
  });

  it("lets an agent-brain wait park the job", async () => {
    ctx.brain.on("reports.summary", () => {
      throw new JobWaitError("agent_task:reports.summary");
    });
    const id = await schedule();
    await expect(
      runScheduledReport(ctx.jobContext({ name: REPORT_JOB_NAME }), { schedule_id: id }),
    ).rejects.toBeInstanceOf(JobWaitError);
    expect(await storedReports(id)).toHaveLength(0);
  });

  it("only stores and announces when the schedule has no channels or no summary", async () => {
    const id = await schedule({ channels: [], ai_summary: false, type: "costs" });
    const calls = ctx.brain.calls.length;
    const result = await runScheduledReport(ctx.jobContext({ name: REPORT_JOB_NAME }), {
      schedule_id: id,
    });
    expect(result).toMatchObject({ status: "stored", type: "costs", channels: 0, summary: false });
    expect(notifyMock).not.toHaveBeenCalled();
    expect(ctx.brain.calls.length).toBe(calls);
    const [row] = await storedReports(id);
    expect(row?.markdown).toContain("## Costs: Harbor Outreach");
  });

  it("falls back to all campaigns when the scheduled campaign is gone", async () => {
    const { campaign } = await seedCampaign(ctx, { name: "Live one", status: "active" });
    const id = await schedule({
      type: "campaign",
      campaign_id: "cmp_01k6a3v0q8x3m2n4p5r6s7t8v9",
      ai_summary: false,
    });
    await runScheduledReport(ctx.jobContext({ name: REPORT_JOB_NAME }), { schedule_id: id });
    const [row] = await storedReports(id);
    expect(row?.content.notes).toEqual(
      expect.arrayContaining(["The scheduled campaign no longer exists; showing all campaigns."]),
    );
    expect(row?.markdown).toContain(campaign.name);
  });

  it("skips disabled, missing and broken schedules and archived workspaces", async () => {
    const job = () => ctx.jobContext({ name: REPORT_JOB_NAME });
    const disabled = await schedule({ enabled: false });
    expect(await runScheduledReport(job(), { schedule_id: disabled })).toEqual({
      status: "skipped",
      reason: "schedule_disabled",
    });
    expect(await runScheduledReport(job(), { schedule_id: disabled, manual: true })).toMatchObject({
      status: "delivered",
    });
    expect(
      await runScheduledReport(job(), { schedule_id: "sch_01k6a3v0q8x3m2n4p5r6s7t8v9" }),
    ).toEqual({
      status: "skipped",
      reason: "schedule_not_found",
    });

    const broken = await schedule();
    await ctx.db
      .update(schedules)
      .set({ payload: { type: "nope" } })
      .where(eq(schedules.id, broken));
    expect(await runScheduledReport(job(), { schedule_id: broken })).toEqual({
      status: "skipped",
      reason: "invalid_schedule_config",
    });

    // An instance-level job names the workspace in its payload.
    const instanceJob = () => ctx.jobContext({ name: REPORT_JOB_NAME, workspaceId: null });
    const archived = await seedWorkspace(ctx.db, { status: "archived" });
    expect(
      await runScheduledReport(instanceJob(), {
        schedule_id: disabled,
        workspace_id: archived.id,
      }),
    ).toEqual({ status: "skipped", reason: "workspace_archived" });
    expect(
      await runScheduledReport(instanceJob(), {
        schedule_id: disabled,
        workspace_id: "ws_01k6a3v0q8x3m2n4p5r6s7t8v9",
      }),
    ).toEqual({ status: "skipped", reason: "workspace_not_found" });
  });

  it("runs an instance-level job in the payload's workspace, never a workspace job", async () => {
    const other = await seedWorkspace(ctx.db, { name: "Second Client", timezone: "UTC" });
    const otherCtx = ctx.with({ workspace: other });
    const id = newId("sch");
    await ctx.db.insert(schedules).values({
      id,
      workspace_id: other.id,
      name: "report:Second",
      cron: "0 8 * * 1",
      timezone: "UTC",
      job_name: REPORT_JOB_NAME,
      payload: {
        schedule_id: id,
        workspace_id: other.id,
        name: "Second",
        type: "overview",
        period: "yesterday",
        channels: [],
        ai_summary: false,
        campaign_id: null,
        compare: true,
      },
    });
    // A job of this test's workspace acts only there.
    await expect(
      runScheduledReport(ctx.jobContext({ name: REPORT_JOB_NAME }), {
        schedule_id: id,
        workspace_id: other.id,
      }),
    ).rejects.toMatchObject({ code: "forbidden", details: { reason: "workspace_scope" } });
    expect(
      await otherCtx.db.select().from(reports).where(eq(reports.workspace_id, other.id)),
    ).toHaveLength(0);

    const before = ctx.recorded.events.length;
    const result = await runScheduledReport(
      ctx.jobContext({ name: REPORT_JOB_NAME, workspaceId: null }),
      { schedule_id: id, workspace_id: other.id },
    );
    expect(result).toMatchObject({ status: "stored" });
    const [row] = await otherCtx.db
      .select()
      .from(reports)
      .where(eq(reports.workspace_id, other.id));
    expect(row?.markdown).toContain(
      "## Overview: Second Client\nYesterday: 2026-09-20 to 2026-09-20 (UTC).",
    );
    const ready = ctx.recorded.events
      .slice(before)
      .filter((event) => event.type === "report.ready");
    expect(ready.map((event) => event.workspaceId)).toEqual([other.id]);
  });
});
