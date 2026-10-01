/**
 * A/B fields of the campaign report: meetings per variant (meetings table, cancelled ones never
 * counted, and, for older data, opportunities), configured variants without sends, leader,
 * confidence and enough_data.
 * Clock: 2026-09-19 12:00 UTC; last_7_days = [09-12, 09-19).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { events, meetings, opportunities } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { seedCampaign, seedMessage, seedPerson } from "../../testing/factories.js";
import { getReport } from "./operations/get-report.js";
import type { ReportOutput, StepRow } from "./schemas.js";

const t = (iso: string) => new Date(iso);

let ctx: TestContext;
let campaignId = "";

async function run(input: Record<string, unknown>) {
  const raw = await getReport.handler(ctx, getReport.input.parse(input));
  return getReport.output.parse(raw) as ReportOutput;
}

async function firstStep(): Promise<StepRow> {
  const output = await run({ type: "campaign", campaign_id: campaignId });
  if (output.data?.type !== "campaign") throw new Error("expected campaign data");
  const step = output.data.campaigns[0]?.steps[0];
  if (!step) throw new Error("no step");
  return step;
}

beforeAll(async () => {
  ctx = await createTestContext();
  const ws = ctx.workspace.id;
  const { campaign, steps } = await seedCampaign(ctx, {
    name: "AB test",
    status: "active",
    settings: { ab_test: { enabled: true, metric: "meeting_rate" } },
    steps: [
      {
        type: "email",
        config: {
          variants: [
            { key: "A", instruction: "Lead with the signal." },
            { key: "B", instruction: "Lead with the proof." },
            { key: "C", instruction: "Lead with a question." },
          ],
        },
      },
    ],
  });
  const other = await seedCampaign(ctx, { name: "Other", status: "active" });
  campaignId = campaign.id;
  const step = steps[0];
  if (!step) throw new Error("step missing");
  const people = await Promise.all([1, 2, 3, 4, 5].map(() => seedPerson(ctx)));
  const [p1, p2, p3, p4, p5] = people;
  if (!p1 || !p2 || !p3 || !p4 || !p5) throw new Error("people missing");
  const send = (personId: string, variant: string, at: string) =>
    seedMessage(ctx, {
      person_id: personId,
      campaign_id: campaign.id,
      step_id: step.id,
      variant,
      status: "sent",
      sent_at: t(at),
    });
  await send(p1.id, "A", "2026-09-13T10:00:00Z");
  await send(p2.id, "A", "2026-09-13T11:00:00Z");
  await send(p3.id, "B", "2026-09-14T10:00:00Z");
  await send(p4.id, "B", "2026-09-14T11:00:00Z");
  await send(p5.id, "B", "2026-09-15T10:00:00Z");
  const meeting = (personId: string, at: string, extra: Record<string, unknown> = {}) =>
    ctx.db.insert(meetings).values({
      workspace_id: ws,
      person_id: personId,
      campaign_id: campaign.id,
      source: "manual",
      matched_by: "manual",
      created_at: t(at),
      ...extra,
    });
  await meeting(p1.id, "2026-09-15T09:00:00Z"); // counts for A
  // Cancelled: its opportunity reached meeting_booked, then went back to interested.
  const [released] = await ctx.db
    .insert(opportunities)
    .values({
      workspace_id: ws,
      person_id: p2.id,
      campaign_id: campaign.id,
      stage: "interested",
      created_at: t("2026-09-14T09:00:00Z"),
    })
    .returning();
  if (!released) throw new Error("opportunity missing");
  await ctx.db.insert(events).values({
    workspace_id: ws,
    type: "opportunity.updated",
    subject_type: "opportunity",
    subject_id: released.id,
    data: { opportunity_id: released.id, stage: "meeting_booked" },
    occurred_at: t("2026-09-14T09:00:00Z"),
  });
  await meeting(p2.id, "2026-09-14T09:00:00Z", {
    status: "cancelled",
    opportunity_id: released.id,
  });
  await meeting(p3.id, "2026-09-10T09:00:00Z"); // booked before the send
  await meeting(p5.id, "2026-09-16T09:00:00Z", { campaign_id: other.campaign.id }); // other campaign
  // Data from before the meetings table: an opportunity created at meeting_booked.
  await ctx.db.insert(opportunities).values({
    workspace_id: ws,
    person_id: p4.id,
    campaign_id: campaign.id,
    stage: "meeting_booked",
    created_at: t("2026-09-16T10:00:00Z"),
  });
});

afterAll(async () => {
  await ctx.close();
});

describe("campaign report A/B fields", () => {
  it("counts meetings per variant and lists configured variants without sends", async () => {
    const step = await firstStep();
    expect(
      step.variants.map((row) => [
        row.variant,
        row.sent,
        row.people,
        row.meetings,
        row.meeting_rate,
      ]),
    ).toEqual([
      ["A", 2, 2, 1, 50],
      ["B", 3, 3, 1, 33.3],
      ["C", 0, 0, 0, null],
    ]);
  });

  it("names no leader before every variant has enough sends (C was never sent)", async () => {
    const step = await firstStep();
    expect(step.ab_metric).toBe("meeting_rate");
    expect(step.enough_data).toBe(false);
    expect(step.leader).toBeNull();
    expect(step.confidence).toBeNull();
  });

  it("adds an A/B section to the markdown", async () => {
    const markdown = (await run({ type: "campaign", format: "markdown" })).markdown ?? "";
    expect(markdown).toContain("### AB test: A/B tests");
    expect(markdown).toContain("| 1. Email | Meeting % |");
    expect(markdown).toContain("A 1, B 1, C 0");
    expect(markdown).toContain("no (50 sends per variant)");
  });
});
