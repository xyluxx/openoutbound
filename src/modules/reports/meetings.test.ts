/**
 * Meeting metrics from meeting records with a mix of statuses, plus the fallback for
 * opportunities booked before meetings were recorded. Clock: Saturday 2026-09-19 12:00 UTC,
 * workspace in UTC, period last_7_days = [09-12, 09-19), previous = [09-05, 09-12).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MeetingStatus } from "../../core/enums.js";
import { events, meetings, opportunities } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { seedPerson } from "../../testing/factories.js";
import { getReport } from "./operations/get-report.js";
import type { ReportOutput } from "./schemas.js";

const t = (iso: string) => new Date(iso);

let ctx: TestContext;

async function run(input: Record<string, unknown>) {
  const raw = await getReport.handler(ctx, getReport.input.parse(input));
  return getReport.output.parse(raw) as ReportOutput;
}

function data<T extends NonNullable<ReportOutput["data"]>["type"]>(
  output: ReportOutput,
  type: T,
): Extract<NonNullable<ReportOutput["data"]>, { type: T }> {
  if (output.data?.type !== type) throw new Error(`expected ${type} data`);
  return output.data as Extract<NonNullable<ReportOutput["data"]>, { type: T }>;
}

beforeAll(async () => {
  ctx = await createTestContext({ now: "2026-09-19T12:00:00.000Z" });
  const ws = ctx.workspace.id;
  const dana = await seedPerson(ctx, { full_name: "Dana Reyes" });
  const lee = await seedPerson(ctx, { full_name: "Lee Park" });

  // Dana's opportunity has meeting records, so its own meeting_booked event is not counted
  // again. Lee's opportunity was booked before meetings were recorded: it counts through the
  // fallback (event on 09-15).
  const [withRecords, legacy] = await ctx.db
    .insert(opportunities)
    .values([
      {
        workspace_id: ws,
        person_id: dana.id,
        stage: "meeting_booked",
        source_signal_keys: ["funding_round"],
        created_at: t("2026-09-01T10:00:00Z"),
      },
      {
        workspace_id: ws,
        person_id: lee.id,
        stage: "meeting_booked",
        created_at: t("2026-09-10T10:00:00Z"),
      },
    ])
    .returning();
  if (!withRecords || !legacy) throw new Error("opportunities missing");
  const event = (opportunityId: string, at: string) => ({
    workspace_id: ws,
    type: "opportunity.updated" as const,
    subject_type: "opportunity",
    subject_id: opportunityId,
    data: { opportunity_id: opportunityId, stage: "meeting_booked", previous_stage: "interested" },
    occurred_at: t(at),
  });
  await ctx.db
    .insert(events)
    .values([
      event(withRecords.id, "2026-09-13T09:00:00Z"),
      event(legacy.id, "2026-09-15T09:00:00Z"),
    ]);

  // Booked (created) in the period: m1-m4; previous period: m5; m6 earlier still.
  // Due (start) in the period: m1 held and qualified, m2 no-show, m3 cancelled, m6 held.
  // Due in the previous period: m5 held. m4 is next week.
  const meeting = (
    status: MeetingStatus,
    created: string,
    start: string,
    qualified: boolean | null = null,
  ) => ({
    workspace_id: ws,
    person_id: dana.id,
    opportunity_id: withRecords.id,
    source: "manual" as const,
    matched_by: "manual" as const,
    status,
    qualified,
    start_at: t(start),
    created_at: t(created),
  });
  await ctx.db
    .insert(meetings)
    .values([
      meeting("held", "2026-09-13T10:00:00Z", "2026-09-15T15:00:00Z", true),
      meeting("no_show", "2026-09-14T10:00:00Z", "2026-09-16T15:00:00Z"),
      meeting("cancelled", "2026-09-14T11:00:00Z", "2026-09-17T15:00:00Z"),
      meeting("scheduled", "2026-09-16T10:00:00Z", "2026-09-24T15:00:00Z"),
      meeting("held", "2026-09-06T10:00:00Z", "2026-09-08T15:00:00Z"),
      meeting("held", "2026-09-01T10:00:00Z", "2026-09-13T15:00:00Z", false),
    ]);
});

afterAll(async () => {
  await ctx.close();
});

describe("meeting metrics", () => {
  it("pipeline: booked, held, no-shows, cancelled, held rate and qualified meetings", async () => {
    const output = await run({ type: "pipeline" });
    const report = data(output, "pipeline");
    expect(report.metrics.meetings).toEqual({ value: 5, previous: 1, change: 4, change_pct: 400 });
    expect(report.metrics.meetings_held).toEqual({
      value: 2,
      previous: 1,
      change: 1,
      change_pct: 100,
    });
    expect(report.metrics.no_shows).toMatchObject({ value: 1, previous: 0 });
    expect(report.metrics.meetings_cancelled).toMatchObject({ value: 1, previous: 0 });
    expect(report.metrics.held_rate).toEqual({
      value: 66.7,
      previous: 100,
      change: -33.3,
      change_pct: null,
    });
    expect(report.metrics.qualified_meetings).toMatchObject({ value: 1, previous: 0 });
    expect(output.definitions.held_rate).toContain("held meetings / (held meetings + no-shows)");
    expect(output.definitions.meetings_held).toContain("assume_held_after_hours");

    const markdown = (await run({ type: "pipeline", format: "markdown" })).markdown ?? "";
    expect(markdown).toContain("| Meetings held | 2 | 1 | +1 (+100.0%) |");
    expect(markdown).toContain("| Held rate |");
  });

  it("overview counts booked meetings the same way", async () => {
    const report = data(await run({ type: "overview" }), "overview");
    expect(report.metrics.meetings).toMatchObject({ value: 5, previous: 1 });
  });

  it("signals: held meetings per signal key", async () => {
    const output = await run({ type: "signals" });
    const report = data(output, "signals");
    expect(report.keys).toEqual([
      expect.objectContaining({ key: "funding_round", meetings: 4, meetings_held: 2 }),
    ]);
    const csv = (await run({ type: "signals", format: "csv" })).csv ?? "";
    expect(csv.split("\r\n")[0]).toContain(",meetings,meetings_held,");
  });
});
