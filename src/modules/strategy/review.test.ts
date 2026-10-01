/**
 * Results of applied proposals: the numbers before and after over the same number of days,
 * scoped to the campaign or the workspace, and the verdict (unclear, better, worse, flat).
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryRows } from "../../db/client.js";
import {
  approvals,
  type ChangeProposal,
  change_proposals,
  events,
  meetings,
  messages,
  type NewMessage,
  opportunities,
} from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedCampaign, seedPerson } from "../../testing/factories.js";
import {
  repliesInWindow,
  reviewDueProposals,
  reviewProposal,
  reviewProposalsJob,
  verdictFor,
  type WindowNumbers,
} from "./review.js";

const DAY = 24 * 60 * 60 * 1000;

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

interface WindowSeed {
  sends: number;
  positive?: number;
  other?: number;
  campaignId?: string | null;
}

/** Applied 15 days ago with a 14 day window: the review is due. */
function appliedAt(ctx: TestContext): Date {
  return new Date(ctx.clock.now().getTime() - 15 * DAY);
}

/** Seeds sends and replies spread over one window (start inclusive, 14 days long). */
async function seedWindow(ctx: TestContext, start: Date, seed: WindowSeed) {
  const person = await seedPerson(ctx);
  const at = (index: number) => new Date(start.getTime() + (index + 1) * 60 * 60 * 1000);
  const rows: NewMessage[] = [];
  for (let index = 0; index < seed.sends; index++) {
    rows.push({
      workspace_id: ctx.workspace.id,
      person_id: person.id,
      campaign_id: seed.campaignId ?? null,
      channel: "email",
      action: "email",
      direction: "outbound",
      status: "sent",
      sent_at: at(index),
    });
  }
  const replies = [
    ...Array.from({ length: seed.positive ?? 0 }, () => "interested"),
    ...Array.from({ length: seed.other ?? 0 }, () => "question"),
  ];
  replies.forEach((category, index) => {
    rows.push({
      workspace_id: ctx.workspace.id,
      person_id: person.id,
      campaign_id: seed.campaignId ?? null,
      channel: "email",
      action: "reply",
      direction: "inbound",
      status: "received",
      received_at: at(index),
      classification: { category, confidence: 0.9 } as NewMessage["classification"],
    });
  });
  if (rows.length) await ctx.db.insert(messages).values(rows);
}

async function seedProposal(
  ctx: TestContext,
  values: Partial<ChangeProposal> = {},
): Promise<ChangeProposal> {
  const applied = appliedAt(ctx);
  const [row] = await ctx.db
    .insert(change_proposals)
    .values({
      workspace_id: ctx.workspace.id,
      title: "Shorter first email",
      reason: "Long emails get fewer replies",
      operation: "campaigns.update",
      input: {},
      status: "applied",
      applied_at: applied,
      review_after_days: 14,
      review_at: new Date(applied.getTime() + 14 * DAY),
      ...values,
    })
    .returning();
  if (!row) throw new Error("no proposal");
  return row;
}

async function reviewWith(before: WindowSeed, after: WindowSeed) {
  const ctx = await createTestContext({ db });
  const applied = appliedAt(ctx);
  await seedWindow(ctx, new Date(applied.getTime() - 14 * DAY), before);
  await seedWindow(ctx, applied, after);
  const proposal = await seedProposal(ctx, {
    target_type: "workspace",
    target_id: ctx.workspace.id,
  });
  const outcome = await reviewProposal(ctx, proposal);
  return { ctx, proposal, outcome };
}

describe("verdicts", () => {
  it("is unclear with fewer than 30 sends in a window", async () => {
    const { outcome } = await reviewWith({ sends: 20, positive: 1 }, { sends: 40, positive: 4 });
    expect(outcome).toMatchObject({
      verdict: "unclear",
      window_days: 14,
      before: { sends: 20, positive_replies: 1 },
      after: { sends: 40, positive_replies: 4 },
    });
    expect(outcome?.note).toContain("Too few sends");
  });

  it("is better when the positive reply rate rose by 20% or more", async () => {
    const { ctx, proposal, outcome } = await reviewWith(
      { sends: 50, positive: 1, other: 2 },
      { sends: 50, positive: 3, other: 1 },
    );
    expect(outcome).toMatchObject({
      verdict: "better",
      before: { sends: 50, replies: 3, positive_replies: 1, positive_reply_rate: 0.02 },
      after: {
        sends: 50,
        replies: 4,
        positive_replies: 3,
        positive_reply_rate: 0.06,
        reply_rate: 0.08,
      },
    });
    expect(outcome?.note).toBe(
      "Positive reply rate 2% -> 6% (+200%) over 14 days before and after.",
    );
    const [stored] = await ctx.db
      .select()
      .from(change_proposals)
      .where(eq(change_proposals.id, proposal.id));
    expect(stored?.outcome?.verdict).toBe("better");
    expect(stored?.reviewed_at).not.toBeNull();
    expect(ctx.emitted("proposal.reviewed").map((event) => event.data)).toEqual([
      { proposal_id: proposal.id, verdict: "better" },
    ]);
  });

  it("is worse when it fell by 20% or more", async () => {
    const { outcome } = await reviewWith({ sends: 50, positive: 4 }, { sends: 50, positive: 2 });
    expect(outcome?.verdict).toBe("worse");
  });

  it("is flat for smaller changes", async () => {
    const { outcome } = await reviewWith({ sends: 50, positive: 10 }, { sends: 50, positive: 9 });
    expect(outcome?.verdict).toBe("flat");
  });

  it("counts a change of exactly 20% as better", () => {
    const numbers = (positive: number): WindowNumbers => ({
      sends: 50,
      replies: positive,
      positive_replies: positive,
      meetings_booked: 0,
      meetings_held: null,
      reply_rate: positive / 50,
      positive_reply_rate: positive / 50,
      meeting_rate: 0,
    });
    expect(verdictFor(numbers(5), numbers(6), "positive_reply_rate").verdict).toBe("better");
    expect(verdictFor(numbers(5), numbers(4), "positive_reply_rate").verdict).toBe("worse");
    expect(verdictFor(numbers(0), numbers(0), "positive_reply_rate").verdict).toBe("flat");
    expect(verdictFor(numbers(0), numbers(2), "positive_reply_rate").verdict).toBe("better");
  });
});

describe("what is counted", () => {
  it("scopes to the campaign and counts only engine outreach and human replies", async () => {
    const ctx = await createTestContext({ db });
    const { campaign } = await seedCampaign(ctx);
    const { campaign: other } = await seedCampaign(ctx);
    const applied = appliedAt(ctx);
    const before = new Date(applied.getTime() - 14 * DAY);
    await seedWindow(ctx, before, { sends: 40, positive: 2, campaignId: campaign.id });
    await seedWindow(ctx, applied, { sends: 40, positive: 1, campaignId: campaign.id });
    // Another campaign's numbers stay out.
    await seedWindow(ctx, applied, { sends: 100, positive: 30, campaignId: other.id });
    const person = await seedPerson(ctx);
    const inside = new Date(applied.getTime() + DAY);
    await ctx.db.insert(messages).values([
      // Written outside the engine (found in the Sent folder).
      {
        workspace_id: ctx.workspace.id,
        person_id: person.id,
        campaign_id: campaign.id,
        channel: "email",
        action: "email",
        direction: "outbound",
        status: "sent",
        sent_at: inside,
        origin: "external",
      },
      // An answer to a prospect is not outreach.
      {
        workspace_id: ctx.workspace.id,
        person_id: person.id,
        campaign_id: campaign.id,
        channel: "email",
        action: "reply",
        direction: "outbound",
        status: "sent",
        sent_at: inside,
      },
      // Nor is an answer on LinkedIn (a message with no sequence step).
      {
        workspace_id: ctx.workspace.id,
        person_id: person.id,
        campaign_id: campaign.id,
        channel: "linkedin",
        action: "message",
        direction: "outbound",
        status: "sent",
        sent_at: inside,
      },
      // An out-of-office is not a reply.
      {
        workspace_id: ctx.workspace.id,
        person_id: person.id,
        campaign_id: campaign.id,
        channel: "email",
        action: "reply",
        direction: "inbound",
        status: "received",
        received_at: inside,
        classification: {
          category: "out_of_office",
          confidence: 0.9,
        } as NewMessage["classification"],
      },
    ]);
    const proposal = await seedProposal(ctx, { target_type: "campaign", target_id: campaign.id });
    const outcome = await reviewProposal(ctx, proposal);
    expect(outcome).toMatchObject({
      verdict: "worse",
      before: { sends: 40, replies: 2, positive_replies: 2 },
      after: { sends: 40, replies: 1, positive_replies: 1 },
    });
  });

  it("judges booking changes on meetings booked per send, and counts meetings held", async () => {
    const ctx = await createTestContext({ db });
    const applied = appliedAt(ctx);
    const before = new Date(applied.getTime() - 14 * DAY);
    await seedWindow(ctx, before, { sends: 50, positive: 5 });
    await seedWindow(ctx, applied, { sends: 50, positive: 5 });
    const meeting = (created: Date, status: "scheduled" | "held") => ({
      workspace_id: ctx.workspace.id,
      source: "manual" as const,
      matched_by: "manual" as const,
      status,
      start_at: new Date(created.getTime() + DAY),
      created_at: created,
    });
    await ctx.db
      .insert(meetings)
      .values([
        meeting(new Date(before.getTime() + DAY), "held"),
        meeting(new Date(applied.getTime() + DAY), "held"),
        meeting(new Date(applied.getTime() + 2 * DAY), "held"),
        meeting(new Date(applied.getTime() + 3 * DAY), "scheduled"),
      ]);
    const proposal = await seedProposal(ctx, {
      operation: "workspaces.update",
      input: { settings: { booking: { mode: "handoff" } } },
      target_type: "workspace",
      target_id: ctx.workspace.id,
    });
    const outcome = await reviewProposal(ctx, proposal);
    expect(outcome).toMatchObject({
      verdict: "better",
      before: { meetings_booked: 1, meetings_held: 1, meeting_rate: 0.02 },
      after: { meetings_booked: 3, meetings_held: 2, meeting_rate: 0.06 },
    });
    expect(outcome?.note).toContain("Meeting rate (meetings booked per send) 2% -> 6%");
  });

  it("falls back to opportunities when the workspace records no meetings", async () => {
    const ctx = await createTestContext({ db });
    const applied = appliedAt(ctx);
    await seedWindow(ctx, new Date(applied.getTime() - 14 * DAY), { sends: 30 });
    await seedWindow(ctx, applied, { sends: 30 });
    const [opportunity] = await ctx.db
      .insert(opportunities)
      .values({ workspace_id: ctx.workspace.id, stage: "meeting_booked" })
      .returning();
    await ctx.db.insert(events).values({
      workspace_id: ctx.workspace.id,
      type: "opportunity.updated",
      data: { opportunity_id: opportunity?.id, stage: "meeting_booked" },
      occurred_at: new Date(applied.getTime() + DAY),
    });
    const proposal = await seedProposal(ctx, {
      target_type: "workspace",
      target_id: ctx.workspace.id,
    });
    const outcome = await reviewProposal(ctx, proposal);
    expect(outcome?.after).toMatchObject({ meetings_booked: 1, meetings_held: null });
    expect(outcome?.before).toMatchObject({ meetings_booked: 0, meetings_held: null });
  });
});

describe("the daily job", () => {
  it("reviews due proposals once, leaves the others and closes lapsed approvals", async () => {
    const ctx = await createTestContext({ db });
    const due = await seedProposal(ctx);
    const notDue = await seedProposal(ctx, {
      applied_at: ctx.clock.now(),
      review_at: new Date(ctx.clock.now().getTime() + 14 * DAY),
    });
    const [expired] = await ctx.db
      .insert(approvals)
      .values({
        workspace_id: ctx.workspace.id,
        kind: "change",
        title: "Change: Goals",
        status: "expired",
      })
      .returning();
    const waiting = await seedProposal(ctx, {
      status: "awaiting_approval",
      approval_id: expired?.id ?? null,
      applied_at: null,
      review_at: null,
    });
    const other = await createTestContext({ db });
    const foreign = await seedProposal(other);

    const job = ctx.jobContext({ workspaceId: ctx.workspace.id });
    expect(await reviewProposalsJob.handler(job, { workspace_id: ctx.workspace.id })).toEqual({
      reviewed: 1,
      closed: 1,
    });
    expect(await reviewDueProposals(ctx)).toEqual({ reviewed: 0, closed: 0 });

    const read = async (id: string) =>
      (await ctx.db.select().from(change_proposals).where(eq(change_proposals.id, id)))[0];
    expect((await read(due.id))?.outcome?.verdict).toBe("unclear");
    expect((await read(notDue.id))?.outcome).toBeNull();
    expect(await read(waiting.id)).toMatchObject({
      status: "rejected",
      error: `Approval ${expired?.id} was expired; nothing changed.`,
    });
    expect((await read(foreign.id))?.reviewed_at).toBeNull();
  });
});

describe("reply counting", () => {
  it("filters replies on received_at, so the window uses the workspace and received index", async () => {
    // A database of its own: the plan does not depend on rows other tests left behind.
    const ctx = await createTestContext();
    // A year of replies from one company, with statistics, so the planner weighs the indexes as
    // on a real workspace instead of picking any index on workspace_id for an empty table.
    await ctx.db.execute(
      sql`insert into messages (id, workspace_id, channel, action, direction, status, company_id, person_id, received_at)
        select 'msg_plan_' || g, ${ctx.workspace.id}, 'email', 'reply', 'inbound', 'received',
          'co_plan', 'pe_plan', timestamptz '2026-01-01T00:00:00Z' + g * interval '1 day'
        from generate_series(1, 365) as g`,
    );
    await ctx.db.execute(sql`analyze messages`);
    await ctx.db.execute(sql`set enable_seqscan = off`);
    try {
      const window = {
        from: new Date("2026-09-01T00:00:00Z"),
        to: new Date("2026-09-15T00:00:00Z"),
      };
      const plan = await queryRows<{ "QUERY PLAN": string }>(
        ctx.db,
        sql`explain select count(*) from messages where ${repliesInWindow(ctx.workspace.id, window, null)}`,
      );
      const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
      expect(text).toMatch(/Index Cond: .*received_at >=.*received_at </);
    } finally {
      await ctx.close();
    }
  });
});
