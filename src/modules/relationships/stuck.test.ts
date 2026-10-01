/** Stuck rules: open, refresh without duplicates, resolve when cleared. */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NewMessage } from "../../db/schema/index.js";
import {
  approvals,
  campaigns,
  meetings,
  people,
  problems,
  threads,
  workspaces,
} from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import {
  seedCampaign,
  seedEnrollment,
  seedMessage,
  seedPerson,
  seedThread,
} from "../../testing/factories.js";
import { runStuckCheck, STUCK_CHECK_JOB, stuckCheckJob, stuckForPerson } from "./stuck.js";

const NOW = "2026-09-22T15:00:00.000Z";
const HOUR = 3_600_000;
const at = (hours: number) => new Date(Date.parse(NOW) + hours * HOUR);

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

async function stuckProblems(ctx: TestContext) {
  return ctx.db
    .select()
    .from(problems)
    .where(and(eq(problems.workspace_id, ctx.workspace.id), eq(problems.kind, "stuck")))
    .orderBy(problems.dedupe_key);
}

/** One case of every rule. */
async function seedAll(ctx: TestContext) {
  const dana = await seedPerson(ctx, { full_name: "Dana Reyes" });
  const omar = await seedPerson(ctx, { full_name: "Omar Haddad" });
  const mei = await seedPerson(ctx, { full_name: "Mei Chen" });

  const thread = await seedThread(ctx, { person_id: dana.id, last_inbound_at: at(-30) });
  const reply = await seedMessage(ctx, {
    thread_id: thread.id,
    person_id: dana.id,
    direction: "inbound",
    status: "received",
    action: "reply",
    received_at: at(-30),
    created_at: at(-30),
    classification: { category: "interested", confidence: 0.9 } as NewMessage["classification"],
  });

  const { campaign } = await seedCampaign(ctx, { name: "Q4 distributors", status: "active" });
  const enrollment = await seedEnrollment(ctx, {
    campaign_id: campaign.id,
    person_id: omar.id,
    next_run_at: null,
  });

  const [approval] = await ctx.db
    .insert(approvals)
    .values({
      workspace_id: ctx.workspace.id,
      kind: "enrollment",
      title: "Enroll 12 leads in Q4 distributors",
      payload: { person_id: mei.id },
      created_at: at(-80),
      expires_at: at(24 * 5),
    })
    .returning();

  const [meeting] = await ctx.db
    .insert(meetings)
    .values({
      workspace_id: ctx.workspace.id,
      person_id: mei.id,
      source: "calendly",
      matched_by: "email",
      start_at: at(-50),
    })
    .returning();

  return { dana, omar, mei, thread, reply, enrollment, approval, meeting, campaign };
}

describe("stuck check", () => {
  it("opens one problem per case, naming the person and the fix", async () => {
    const ctx = await createTestContext({
      db,
      now: NOW,
      settings: { booking: { assume_held_after_hours: 0 } },
    });
    const seeded = await seedAll(ctx);
    const result = await runStuckCheck(ctx.jobContext());
    expect(result).toEqual({ opened: 4, refreshed: 0, unchanged: 0, resolved: 0 });

    const rows = await stuckProblems(ctx);
    const byRule = new Map(rows.map((row) => [String(row.data.rule), row]));
    expect([...byRule.keys()].sort()).toEqual([
      "active_no_next_step",
      "approval_waiting",
      "hot_reply_unanswered",
      "meeting_unmarked",
    ]);

    const hot = byRule.get("hot_reply_unanswered");
    expect(hot).toMatchObject({
      severity: "high",
      owner: "anyone",
      person_id: seeded.dana.id,
      subject_type: "thread",
      subject_id: seeded.thread.id,
      dedupe_key: `stuck:hot_reply_unanswered:${seeded.thread.id}`,
      title: "Hot reply from Dana Reyes waits for an answer",
    });
    expect(hot?.remedy).toBe(
      `Draft an answer with reply_to_thread action draft (thread_id ${seeded.thread.id}), then send it with reply_to_thread action send.`,
    );
    expect(hot?.due_at?.toISOString()).toBe(at(-6).toISOString());

    expect(byRule.get("active_no_next_step")).toMatchObject({
      severity: "normal",
      person_id: seeded.omar.id,
      title: "Sequence stuck for Omar Haddad",
    });
    expect(byRule.get("active_no_next_step")?.remedy).toContain(
      `get_campaigns action enrollments (campaign_id ${seeded.campaign.id})`,
    );
    expect(byRule.get("approval_waiting")).toMatchObject({
      person_id: seeded.mei.id,
      title: "Approval waiting 3 days: Enroll 12 leads in Q4 distributors",
      remedy: `Decide it with review_items action decide (approval_id ${seeded.approval?.id}).`,
    });
    expect(byRule.get("meeting_unmarked")?.remedy).toBe(
      `Record what happened with manage_meetings action mark_held or mark_no_show (meeting_id ${seeded.meeting?.id}).`,
    );
    expect(ctx.emitted("problem.opened")).toHaveLength(4);
  });

  it("refreshes instead of duplicating, and resolves what cleared", async () => {
    const ctx = await createTestContext({
      db,
      now: NOW,
      settings: { booking: { assume_held_after_hours: 0 } },
    });
    const seeded = await seedAll(ctx);
    await runStuckCheck(ctx.jobContext());
    const before = await stuckProblems(ctx);

    const again = await runStuckCheck(ctx.jobContext());
    expect(again).toEqual({ opened: 0, refreshed: 0, unchanged: 4, resolved: 0 });
    expect((await stuckProblems(ctx)).map((row) => row.id)).toEqual(before.map((row) => row.id));

    // Dana gets an answer, the approval is decided and the meeting is marked.
    await seedMessage(ctx, {
      thread_id: seeded.thread.id,
      person_id: seeded.dana.id,
      action: "reply",
      status: "pending_review",
      created_at: at(-1),
    });
    await ctx.db
      .update(approvals)
      .set({ status: "approved" })
      .where(eq(approvals.id, seeded.approval?.id ?? ""));
    await ctx.db
      .update(meetings)
      .set({ status: "held" })
      .where(eq(meetings.id, seeded.meeting?.id ?? ""));
    const after = await runStuckCheck(ctx.jobContext());
    expect(after).toEqual({ opened: 0, refreshed: 0, unchanged: 1, resolved: 3 });
    const rows = await stuckProblems(ctx);
    const resolved = rows.filter((row) => row.status === "resolved");
    expect(resolved.map((row) => String(row.data.rule)).sort()).toEqual([
      "approval_waiting",
      "hot_reply_unanswered",
      "meeting_unmarked",
    ]);
    expect(resolved.find((row) => row.data.rule === "approval_waiting")?.resolution).toBe(
      "The approval was decided or expired.",
    );
    expect(ctx.emitted("problem.resolved")).toHaveLength(3);
  });

  it("writes a problem again only when its words change", async () => {
    const ctx = await createTestContext({
      db,
      now: NOW,
      settings: { booking: { assume_held_after_hours: 0 } },
    });
    const seeded = await seedAll(ctx);
    await runStuckCheck(ctx.jobContext());
    const quiet = await runStuckCheck(ctx.jobContext());
    expect(quiet).toEqual({ opened: 0, refreshed: 0, unchanged: 4, resolved: 0 });

    await ctx.db
      .update(campaigns)
      .set({ name: "Q4 wholesalers" })
      .where(eq(campaigns.id, seeded.campaign.id));
    const renamed = await runStuckCheck(ctx.jobContext());
    expect(renamed).toEqual({ opened: 0, refreshed: 1, unchanged: 3, resolved: 0 });
    const rows = await stuckProblems(ctx);
    const sequence = rows.find((row) => row.data.rule === "active_no_next_step");
    expect(sequence?.reason).toContain("campaign Q4 wholesalers");
    const hot = rows.find((row) => row.data.rule === "hot_reply_unanswered");
    expect(hot?.reason).toBe(
      "Dana Reyes replied (interested) on Monday 21 September 09:00 UTC, and nothing has been drafted or sent since.",
    );
  });

  it("hands a hot reply in a thread a person owns to them, and a recorded meeting clears it", async () => {
    const ctx = await createTestContext({ db, now: NOW });
    const seeded = await seedAll(ctx);
    await runStuckCheck(ctx.jobContext());
    const hotOf = async () =>
      (await stuckProblems(ctx)).find((row) => row.data.rule === "hot_reply_unanswered");
    expect(await hotOf()).toMatchObject({ owner: "anyone", status: "open" });

    // A person takes the conversation over: the same problem becomes theirs, with a reminder.
    await ctx.db.update(threads).set({ owner: "person" }).where(eq(threads.id, seeded.thread.id));
    expect(await runStuckCheck(ctx.jobContext())).toMatchObject({ opened: 0, refreshed: 1 });
    const owned = await hotOf();
    expect(owned).toMatchObject({ owner: "person", status: "open" });
    expect(owned?.remedy).toBe(
      `A person owns this conversation: remind them to answer Dana Reyes. Hand it back with reply_to_thread action release (thread_id ${seeded.thread.id}) only if they ask.`,
    );

    // A cancelled meeting answers nothing; a meeting recorded after the reply does.
    await ctx.db.insert(meetings).values({
      workspace_id: ctx.workspace.id,
      person_id: seeded.dana.id,
      source: "manual",
      matched_by: "manual",
      status: "cancelled",
      start_at: at(24),
    });
    expect(await runStuckCheck(ctx.jobContext())).toMatchObject({ resolved: 0 });
    await ctx.db.insert(meetings).values({
      workspace_id: ctx.workspace.id,
      person_id: seeded.dana.id,
      source: "manual",
      matched_by: "manual",
      start_at: at(48),
    });
    expect(await runStuckCheck(ctx.jobContext())).toMatchObject({ resolved: 1 });
    expect(await hotOf()).toMatchObject({
      status: "resolved",
      resolution:
        "An answer was drafted or sent, a meeting was recorded, or the conversation moved on.",
    });
    expect(await stuckForPerson(ctx, seeded.dana.id)).toEqual([]);
  });

  it("leaves out people nobody may contact any more and resolves their problems", async () => {
    const ctx = await createTestContext({
      db,
      now: NOW,
      settings: { booking: { assume_held_after_hours: 0 } },
    });
    const seeded = await seedAll(ctx);
    await runStuckCheck(ctx.jobContext());
    // Dana asks for her data to be deleted: she is do not contact from now on.
    await ctx.db
      .update(people)
      .set({ status: "do_not_contact" })
      .where(eq(people.id, seeded.dana.id));
    const after = await runStuckCheck(ctx.jobContext());
    expect(after).toEqual({ opened: 0, refreshed: 0, unchanged: 3, resolved: 1 });
    const hot = (await stuckProblems(ctx)).find((row) => row.data.rule === "hot_reply_unanswered");
    expect(hot).toMatchObject({
      status: "resolved",
      resolution: "The person may not be contacted any more.",
    });
    // Nothing opens it again, and her view shows nothing stuck.
    expect(await runStuckCheck(ctx.jobContext())).toMatchObject({ opened: 0, resolved: 0 });
    expect(await stuckForPerson(ctx, seeded.dana.id)).toEqual([]);
  });

  it("looks only at threads with a reply inside the lookback", async () => {
    const ctx = await createTestContext({ db, now: NOW });
    const lead = await seedPerson(ctx, { full_name: "Ines Moreau" });
    // The latest reply is recent, but the thread says its last reply was 40 days ago: the stuck
    // check trusts the thread (every inbound path keeps it current) and skips it.
    const thread = await seedThread(ctx, { person_id: lead.id, last_inbound_at: at(-24 * 40) });
    await seedMessage(ctx, {
      thread_id: thread.id,
      person_id: lead.id,
      direction: "inbound",
      status: "received",
      action: "reply",
      received_at: at(-30),
      created_at: at(-30),
      classification: { category: "interested", confidence: 0.9 } as NewMessage["classification"],
    });
    const result = await runStuckCheck(ctx.jobContext());
    expect(result.opened).toBe(0);
  });

  it("leaves the sequence rule alone while the workspace is paused", async () => {
    const ctx = await createTestContext({ db, now: NOW });
    await seedAll(ctx);
    await ctx.db
      .update(workspaces)
      .set({ status: "paused" })
      .where(eq(workspaces.id, ctx.workspace.id));
    const result = await runStuckCheck(ctx.jobContext());
    // Hot reply and approval only: the meeting rule is off (automatic held after 24 hours).
    expect(result.opened).toBe(2);
    const rules = (await stuckProblems(ctx)).map((row) => row.data.rule);
    expect(rules).not.toContain("active_no_next_step");
    expect(rules).not.toContain("meeting_unmarked");
  });

  it("never touches another workspace", async () => {
    const one = await createTestContext({ db, now: NOW });
    const two = await createTestContext({ db, now: NOW });
    await seedAll(one);
    await runStuckCheck(two.jobContext());
    expect(await stuckProblems(two)).toHaveLength(0);
    await runStuckCheck(one.jobContext());
    expect((await stuckProblems(one)).length).toBeGreaterThan(0);
    expect(await stuckProblems(two)).toHaveLength(0);
  });

  it("is a job the scheduler can run", async () => {
    const ctx = await createTestContext({ db, now: NOW });
    expect(stuckCheckJob.name).toBe(STUCK_CHECK_JOB);
    await seedAll(ctx);
    const result = (await stuckCheckJob.handler(ctx.jobContext(), {
      workspace_id: ctx.workspace.id,
    })) as { opened: number };
    expect(result.opened).toBeGreaterThan(0);
  });
});
