/** The relationship view: states and precedence, next action, blockers and stuck. */

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NewMessage } from "../../db/schema/index.js";
import {
  approvals,
  companies,
  meetings,
  opportunities,
  problems,
  suppressions,
  tasks,
  threads,
} from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import {
  seedCampaign,
  seedCompany,
  seedEnrollment,
  seedMailbox,
  seedMessage,
  seedPerson,
  seedThread,
} from "../../testing/factories.js";
import { getRelationship } from "./relationship.js";

/** Tuesday 2026-09-22 10:00 in Chicago. */
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

async function fresh(settings: Parameters<typeof createTestContext>[0] = {}) {
  const ctx = await createTestContext({ db, now: NOW, ...settings });
  const company = await seedCompany(ctx, { name: "Harbor Supply Ltd" });
  const person = await seedPerson(ctx, { company_id: company.id, full_name: "Dana Reyes" });
  return { ctx, company, person };
}

async function inbound(
  ctx: TestContext,
  threadId: string,
  personId: string,
  when: Date,
  category: string | null,
  extra: Partial<NewMessage> = {},
) {
  // Every inbound path stamps the thread with its latest reply; so does this seed.
  await ctx.db
    .update(threads)
    .set({
      last_inbound_at: sql`greatest(${threads.last_inbound_at}, ${when.toISOString()}::timestamptz)`,
    })
    .where(eq(threads.id, threadId));
  return seedMessage(ctx, {
    thread_id: threadId,
    person_id: personId,
    direction: "inbound",
    status: "received",
    action: "reply",
    received_at: when,
    created_at: when,
    classification: category
      ? ({ category, confidence: 0.9 } as NewMessage["classification"])
      : null,
    ...extra,
  });
}

describe("relationship states", () => {
  it("is new with nothing on record", async () => {
    const { ctx, person } = await fresh();
    const view = await getRelationship(ctx, person.id);
    expect(view).toMatchObject({
      person_id: person.id,
      company_id: person.company_id,
      opportunity_id: null,
      state: "new",
      state_since: person.created_at.toISOString(),
      next_action: null,
      stuck: false,
      stuck_reason: null,
    });
  });

  it("walks up the precedence as higher facts appear", async () => {
    const { ctx, company, person } = await fresh();
    const mailbox = await seedMailbox(ctx);
    const { campaign } = await seedCampaign(ctx, {
      name: "Q4 distributors",
      status: "active",
      settings: { senders: { mailbox_ids: [mailbox.id] } },
    });
    await seedEnrollment(ctx, {
      campaign_id: campaign.id,
      person_id: person.id,
      next_run_at: at(20),
      activated_at: at(-48),
    });
    const state = async () => (await getRelationship(ctx, person.id)).state;
    expect(await state()).toBe("in_sequence");

    await ctx.db
      .update(companies)
      .set({ hold_until: at(24 * 14), hold_reason: "Budget freeze" })
      .where(eq(companies.id, company.id));
    expect(await state()).toBe("waiting");

    const quiet = await seedThread(ctx, { person_id: person.id, status: "open" });
    await inbound(ctx, quiet.id, person.id, at(-30), "not_now");
    await ctx.db.insert(tasks).values({
      workspace_id: ctx.workspace.id,
      person_id: person.id,
      type: "follow_up",
      title: "Follow up with Dana in November",
      due_at: at(24 * 30),
    });
    expect(await state()).toBe("not_now");

    const hot = await seedThread(ctx, { person_id: person.id });
    await inbound(ctx, hot.id, person.id, at(-2), "question");
    expect(await state()).toBe("in_conversation");

    await ctx.db.insert(meetings).values({
      workspace_id: ctx.workspace.id,
      person_id: person.id,
      source: "manual",
      matched_by: "manual",
      status: "held",
      start_at: at(-72),
      status_changed_at: at(-70),
    });
    expect(await state()).toBe("meeting_held");

    await ctx.db.insert(meetings).values({
      workspace_id: ctx.workspace.id,
      person_id: person.id,
      source: "manual",
      matched_by: "manual",
      start_at: at(48),
    });
    expect(await state()).toBe("meeting_scheduled");

    await ctx.db.insert(opportunities).values({
      workspace_id: ctx.workspace.id,
      person_id: person.id,
      stage: "won",
      closed_at: at(-1),
    });
    expect(await state()).toBe("won");

    await ctx.db.insert(suppressions).values({
      workspace_id: ctx.workspace.id,
      type: "person",
      value: person.id,
      reason: "manual",
      source: "test",
      created_at: at(-3),
    });
    const stopped = await getRelationship(ctx, person.id);
    expect(stopped.state).toBe("stopped");
    expect(stopped.state_since).toBe(at(-3).toISOString());
  });

  it("is stopped by an open privacy request", async () => {
    const { ctx, person } = await fresh();
    await ctx.db.insert(problems).values({
      workspace_id: ctx.workspace.id,
      kind: "privacy_request",
      severity: "urgent",
      title: "Privacy request",
      reason: "Asked to delete their data.",
      remedy: "Forget them.",
      person_id: person.id,
      created_at: at(-5),
    });
    const view = await getRelationship(ctx, person.id);
    expect(view.state).toBe("stopped");
    expect(view.state_since).toBe(at(-5).toISOString());
    expect(view.blockers.map((item) => item.code)).toContain("privacy_request_open");
  });

  it("reads v0.1 meetings from the opportunity when there is no meeting record", async () => {
    const { ctx, person } = await fresh();
    const [opportunity] = await ctx.db
      .insert(opportunities)
      .values({
        workspace_id: ctx.workspace.id,
        person_id: person.id,
        stage: "meeting_booked",
        meeting_at: at(26),
      })
      .returning();
    const view = await getRelationship(ctx, person.id);
    expect(view.state).toBe("meeting_scheduled");
    expect(view.opportunity_id).toBe(opportunity?.id);
    expect(view.next_action).toMatchObject({
      kind: "meeting",
      due_at: at(26).toISOString(),
      channel: null,
      ref: { type: "opportunity", id: opportunity?.id },
    });

    const past = await fresh();
    await past.ctx.db.insert(opportunities).values({
      workspace_id: past.ctx.workspace.id,
      person_id: past.person.id,
      stage: "meeting_booked",
      meeting_at: at(-26),
    });
    expect((await getRelationship(past.ctx, past.person.id)).state).toBe("meeting_held");
  });

  it("counts a meeting as held once the assumed time passed", async () => {
    const { ctx, person } = await fresh();
    await ctx.db.insert(meetings).values({
      workspace_id: ctx.workspace.id,
      person_id: person.id,
      source: "calendly",
      matched_by: "email",
      start_at: at(-30),
    });
    expect((await getRelationship(ctx, person.id)).state).toBe("meeting_held");

    const manual = await fresh({ settings: { booking: { assume_held_after_hours: 0 } } });
    await manual.ctx.db.insert(meetings).values({
      workspace_id: manual.ctx.workspace.id,
      person_id: manual.person.id,
      source: "calendly",
      matched_by: "email",
      start_at: at(-50),
    });
    const view = await getRelationship(manual.ctx, manual.person.id);
    expect(view.state).toBe("meeting_scheduled");
    expect(view.stuck).toBe(true);
    expect(view.stuck_reason).toContain("still marked scheduled");
  });

  it("is in conversation when a person owns the thread or an opportunity is open", async () => {
    const owned = await fresh();
    await seedThread(owned.ctx, {
      person_id: owned.person.id,
      owner: "person",
      owner_changed_at: at(-4),
    });
    const view = await getRelationship(owned.ctx, owned.person.id);
    expect(view).toMatchObject({ state: "in_conversation", state_since: at(-4).toISOString() });

    const open = await fresh();
    await open.ctx.db.insert(opportunities).values({
      workspace_id: open.ctx.workspace.id,
      person_id: open.person.id,
      stage: "interested",
      created_at: at(-10),
    });
    expect((await getRelationship(open.ctx, open.person.id)).state).toBe("in_conversation");
  });

  it("is lost, then finished, when sequences ended without anything open", async () => {
    const lost = await fresh();
    await lost.ctx.db.insert(opportunities).values({
      workspace_id: lost.ctx.workspace.id,
      person_id: lost.person.id,
      stage: "lost",
      closed_at: at(-100),
    });
    expect((await getRelationship(lost.ctx, lost.person.id)).state).toBe("lost");

    const done = await fresh();
    const { campaign } = await seedCampaign(done.ctx, { status: "active" });
    await seedEnrollment(done.ctx, {
      campaign_id: campaign.id,
      person_id: done.person.id,
      status: "completed",
      completed_at: at(-200),
    });
    const view = await getRelationship(done.ctx, done.person.id);
    expect(view).toMatchObject({ state: "finished", state_since: at(-200).toISOString() });
    expect(view.next_action).toBeNull();
  });

  it("is waiting while a message waits for approval, and says so", async () => {
    const { ctx, person } = await fresh();
    const mailbox = await seedMailbox(ctx);
    const { campaign } = await seedCampaign(ctx, {
      status: "active",
      settings: { senders: { mailbox_ids: [mailbox.id] } },
    });
    const enrollment = await seedEnrollment(ctx, {
      campaign_id: campaign.id,
      person_id: person.id,
      status: "waiting_review",
    });
    const message = await seedMessage(ctx, {
      person_id: person.id,
      campaign_id: campaign.id,
      enrollment_id: enrollment.id,
      status: "pending_review",
      created_at: at(-6),
    });
    const [approval] = await ctx.db
      .insert(approvals)
      .values({
        workspace_id: ctx.workspace.id,
        kind: "message",
        title: "Email to Dana Reyes",
        target_type: "message",
        target_id: message.id,
        created_at: at(-5),
      })
      .returning();
    const view = await getRelationship(ctx, person.id);
    expect(view.state).toBe("waiting");
    expect(view.next_action).toMatchObject({
      kind: "review",
      channel: "email",
      campaign_id: campaign.id,
      due_at: at(-5).toISOString(),
      ref: { type: "approval", id: approval?.id },
    });
    expect(view.blockers[0]).toMatchObject({ code: "approval_pending" });
    expect(view.blockers[0]?.fix).toContain(`approval_id ${approval?.id}`);
  });
});

describe("next action", () => {
  it("picks the earliest of messages, steps, tasks and meetings", async () => {
    const { ctx, person } = await fresh();
    const mailbox = await seedMailbox(ctx);
    const { campaign } = await seedCampaign(ctx, {
      name: "Q4 distributors",
      status: "active",
      settings: { senders: { mailbox_ids: [mailbox.id] } },
    });
    const enrollment = await seedEnrollment(ctx, {
      campaign_id: campaign.id,
      person_id: person.id,
    });
    const message = await seedMessage(ctx, {
      person_id: person.id,
      campaign_id: campaign.id,
      enrollment_id: enrollment.id,
      mailbox_id: mailbox.id,
      status: "scheduled",
      scheduled_for: at(22),
    });
    await ctx.db.insert(meetings).values({
      workspace_id: ctx.workspace.id,
      person_id: person.id,
      source: "manual",
      matched_by: "manual",
      start_at: at(72),
    });
    const [task] = await ctx.db
      .insert(tasks)
      .values({
        workspace_id: ctx.workspace.id,
        person_id: person.id,
        type: "promise",
        title: "Send the case study",
        due_at: at(5),
      })
      .returning();
    const first = await getRelationship(ctx, person.id);
    expect(first.next_action).toMatchObject({
      kind: "task",
      due_at: at(5).toISOString(),
      ref: { type: "task", id: task?.id },
    });
    expect(first.next_action?.reason).toBe("Promise: Send the case study (due today 20:00 UTC).");

    await ctx.db
      .update(tasks)
      .set({ status: "done" })
      .where(eq(tasks.id, task?.id ?? ""));
    const second = await getRelationship(ctx, person.id);
    expect(second.next_action).toMatchObject({
      kind: "send_message",
      channel: "email",
      campaign_id: campaign.id,
      due_at: at(22).toISOString(),
      ref: { type: "message", id: message.id },
    });
    expect(second.next_action?.reason).toBe(
      "An email (campaign Q4 distributors) is scheduled for tomorrow 13:00 UTC.",
    );
    expect(second.blockers).toEqual([]);
  });

  it("uses the due sequence step and its channel when nothing is queued", async () => {
    const { ctx, person } = await fresh();
    const { campaign } = await seedCampaign(ctx, {
      name: "LinkedIn first",
      status: "active",
      steps: [{ type: "linkedin_invite" }],
    });
    const enrollment = await seedEnrollment(ctx, {
      campaign_id: campaign.id,
      person_id: person.id,
      next_run_at: at(3),
    });
    const view = await getRelationship(ctx, person.id);
    expect(view.next_action).toMatchObject({
      kind: "campaign_step",
      channel: "linkedin",
      due_at: at(3).toISOString(),
      ref: { type: "enrollment", id: enrollment.id },
      reason: "Step 1 (LinkedIn invitation) of campaign LinkedIn first is due today 18:00 UTC.",
    });
    // No LinkedIn URL and no account: the step's own checks say so.
    expect(view.blockers.map((item) => item.code)).toEqual(
      expect.arrayContaining(["no_linkedin_account", "no_linkedin"]),
    );
  });

  it("shows a company hold as a relationship blocker with its end", async () => {
    const { ctx, company, person } = await fresh();
    await ctx.db
      .update(companies)
      .set({ hold_until: at(24 * 7), hold_reason: "Signed with a competitor" })
      .where(eq(companies.id, company.id));
    const view = await getRelationship(ctx, person.id);
    const hold = view.blockers.find((item) => item.code === "company_on_hold");
    expect(hold).toMatchObject({ until: at(24 * 7).toISOString(), hard: false });
    expect(hold?.message).toContain("Signed with a competitor");
  });
});

describe("stuck and errors", () => {
  it("flags a hot reply nobody answered for a day", async () => {
    const { ctx, person } = await fresh();
    const thread = await seedThread(ctx, { person_id: person.id });
    await inbound(ctx, thread.id, person.id, at(-30), "interested");
    const view = await getRelationship(ctx, person.id);
    expect(view.state).toBe("in_conversation");
    expect(view.stuck).toBe(true);
    expect(view.stuck_reason).toContain("Dana Reyes replied (interested) on ");
  });

  it("refuses unknown people and people of another workspace", async () => {
    const { ctx } = await fresh();
    await expect(getRelationship(ctx, "pe_missing")).rejects.toMatchObject({ code: "not_found" });
    const other = await fresh();
    await expect(getRelationship(ctx, other.person.id)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
