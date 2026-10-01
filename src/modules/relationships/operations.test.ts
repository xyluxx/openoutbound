/**
 * The operator operations: operating state, next actions (order, blockers, pages, isolation),
 * explain_blocker for messages and people, and a query-count guard on a large workspace.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { AnyOperation } from "../../core/operation.js";
import {
  approvals,
  change_log,
  enrollments,
  meetings,
  messages,
  type NewEnrollment,
  type NewMessage,
  type NewPerson,
  people,
  suppressions,
  tasks,
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
import { modules } from "../index.js";
import { openProblem } from "../problems/service.js";
import { module } from "./index.js";
import { buildNextActions } from "./next-actions.js";
import { buildOperatingState } from "./operating-state.js";
import { explainBlocker, getNextActions, getOperatingState } from "./operations.js";

/** Tuesday 2026-09-22 10:00 in Chicago (inside the default send window). */
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

async function call<O extends AnyOperation>(
  op: O,
  ctx: TestContext,
  input: z.input<O["input"]>,
): Promise<z.output<O["output"]>> {
  return op.output.parse(await op.handler(ctx, op.input.parse(input)));
}

describe("relationships module", () => {
  it("registers three read-only core tools, the stuck job and its 15-minute schedule", () => {
    expect(module.tools?.map((tool) => [tool.name, tool.toolset, tool.operation])).toEqual([
      ["get_operating_state", "core", "operating.state"],
      ["get_next_actions", "core", "operating.next_actions"],
      ["explain_blocker", "core", "operating.explain"],
    ]);
    expect(module.operations?.map((op) => [op.id, op.effect, op.http?.path])).toEqual([
      ["operating.state", "read", "/v1/operating/state"],
      ["operating.next_actions", "read", "/v1/operating/next-actions"],
      ["operating.explain", "read", "/v1/operating/explain"],
    ]);
    expect(module.jobs?.map((job) => job.name)).toEqual(["relationships.stuck_check"]);
    expect(module.schedules).toEqual([
      {
        name: "relationships.stuck_check",
        cron: "*/15 * * * *",
        job: "relationships.stuck_check",
        perWorkspace: true,
      },
    ]);
    expect(modules.map((item) => item.name)).toContain("relationships");
  });
});

describe("operating.state", () => {
  it("answers on an empty workspace", async () => {
    const ctx = await createTestContext({ db, now: NOW });
    const state = await call(getOperatingState, ctx, {});
    expect(state.workspace).toMatchObject({ id: ctx.workspace.id, status: "active" });
    expect(state.campaigns.by_status.active).toBe(0);
    expect(state.campaigns.top_active).toEqual([]);
    expect(state.sending_today).toMatchObject({
      day: "2026-09-22",
      emails_sent: 0,
      emails_scheduled: 0,
      email_capacity: 0,
      linkedin_sent: 0,
    });
    expect(state.replies).toEqual({ hot_waiting: 0, drafts_waiting_review: 0 });
    expect(state.meetings_this_week).toMatchObject({
      week_start: "2026-09-21",
      source: "opportunities",
      booked: 0,
      upcoming: [],
    });
    expect(state.problems).toMatchObject({ open: 0, top: [] });
    expect(state.approvals_pending).toEqual({ total: 0, by_kind: [] });
    expect(state.brain.healthy).toBe(state.brain.provider !== null);
    expect(state.recent_changes).toEqual([]);
  });

  it("sums campaigns, sending, replies, meetings, problems, approvals and changes", async () => {
    const ctx = await createTestContext({ db, now: NOW });
    const mailbox = await seedMailbox(ctx, { daily_limit: 40 });
    await seedMailbox(ctx, { status: "paused", daily_limit: 50 });
    const { campaign } = await seedCampaign(ctx, { name: "Q4 distributors", status: "active" });
    await seedCampaign(ctx, { name: "Clinics", status: "active" });
    await seedCampaign(ctx, { name: "Old test", status: "paused" });
    const dana = await seedPerson(ctx, { full_name: "Dana Reyes" });
    const sent = { direction: "outbound", status: "sent", mailbox_id: mailbox.id } as const;
    await seedMessage(ctx, { ...sent, campaign_id: campaign.id, sent_at: at(-2) });
    await seedMessage(ctx, { ...sent, campaign_id: campaign.id, sent_at: at(-1) });
    await seedMessage(ctx, { ...sent, sent_at: at(-20) });
    await seedMessage(ctx, {
      channel: "linkedin",
      action: "invite",
      status: "sent",
      sent_at: at(-3),
    });
    await seedMessage(ctx, {
      status: "scheduled",
      campaign_id: campaign.id,
      scheduled_for: at(4),
    });
    const thread = await seedThread(ctx, { person_id: dana.id, last_inbound_at: at(-5) });
    await seedMessage(ctx, {
      thread_id: thread.id,
      person_id: dana.id,
      direction: "inbound",
      status: "received",
      received_at: at(-5),
      classification: { category: "interested", confidence: 0.9, summary: "Asks for pricing." },
    });
    await ctx.db.insert(approvals).values([
      { workspace_id: ctx.workspace.id, kind: "reply", title: "Reply to Dana" },
      { workspace_id: ctx.workspace.id, kind: "message", title: "Email to Dana" },
    ]);
    const meeting = {
      workspace_id: ctx.workspace.id,
      person_id: dana.id,
      source: "manual",
      matched_by: "manual",
    } as const;
    // Recorded before Dana's reply, so the reply still waits for an answer.
    await ctx.db.insert(meetings).values([
      { ...meeting, start_at: at(48), created_at: at(-6) },
      { ...meeting, status: "held", start_at: at(-24), created_at: at(-72) },
    ]);
    const brainDown = await openProblem(ctx, {
      kind: "brain_down",
      severity: "urgent",
      title: "The AI provider does not answer",
      reason: "Three calls failed.",
      remedy: "Check the provider key with manage_providers.",
    });
    await openProblem(ctx, {
      kind: "dns_failed",
      severity: "normal",
      title: "DMARC missing on example.org",
      reason: "No DMARC record.",
      remedy: "Add it, then run manage_mailboxes action check_dns.",
    });
    await ctx.db.insert(change_log).values({
      workspace_id: ctx.workspace.id,
      version: 1,
      area: "settings",
      diff: [{ path: "booking.mode", before: "off", after: "link" }],
      reason: "Share the booking link in replies.",
      actor: { type: "human", id: "usr_test", name: "Test User" },
    });

    const state = await call(getOperatingState, ctx, {});
    expect(state.campaigns.by_status).toMatchObject({ active: 2, paused: 1 });
    expect(state.campaigns.top_active[0]).toMatchObject({
      id: campaign.id,
      sent_today: 2,
      scheduled_today: 1,
    });
    expect(state.sending_today).toMatchObject({
      emails_sent: 2,
      emails_scheduled: 1,
      email_capacity: 40,
      linkedin_sent: 1,
    });
    expect(state.sending_today.mailboxes).toMatchObject({ active: 1, paused: 1 });
    expect(state.replies).toEqual({ hot_waiting: 1, drafts_waiting_review: 1 });
    expect(state.meetings_this_week).toMatchObject({
      source: "meetings",
      booked: 1,
      held: 1,
      no_shows: 0,
    });
    expect(state.meetings_this_week.upcoming).toEqual([
      expect.objectContaining({ person_id: dana.id, person_name: "Dana Reyes" }),
    ]);
    expect(state.problems).toMatchObject({ open: 2, by_severity: { urgent: 1, normal: 1 } });
    expect(state.problems.top[0]).toMatchObject({ id: brainDown.id, kind: "brain_down" });
    expect(state.approvals_pending.total).toBe(2);
    expect(state.brain).toMatchObject({ healthy: false, problem_id: brainDown.id });
    expect(state.recent_changes).toEqual([
      expect.objectContaining({
        version: 1,
        area: "settings",
        summary: "booking.mode",
        by: "Test User",
        undone: false,
      }),
    ]);
  });
});

interface Plan {
  ctx: TestContext;
  names: Record<"ana" | "ben" | "cleo", string>;
  ids: Record<"ana" | "ben" | "cleo", string>;
  campaignId: string;
  mailboxId: string;
  refs: Record<"soon" | "overdue" | "step" | "task" | "meeting" | "later", string>;
}

/** A workspace with one of each kind of upcoming item, one of them blocked. */
async function plan(): Promise<Plan> {
  const ctx = await createTestContext({ db, now: NOW });
  const company = await seedCompany(ctx, { name: "Harbor Supply Ltd" });
  const mailbox = await seedMailbox(ctx, { email: "sam@harbor.example.org" });
  const { campaign, steps } = await seedCampaign(ctx, {
    name: "Q4 distributors",
    status: "active",
    settings: { senders: { mailbox_ids: [mailbox.id] } },
  });
  const person = (name: string) =>
    seedPerson(ctx, { full_name: name, company_id: company.id } satisfies Partial<NewPerson>);
  const ana = await person("Ana Brooks");
  const ben = await person("Ben Ortiz");
  const cleo = await person("Cleo Hart");
  const scheduled = async (who: typeof ana, when: Date) => {
    const enrollment = await seedEnrollment(ctx, {
      campaign_id: campaign.id,
      person_id: who.id,
      mailbox_id: mailbox.id,
      next_run_at: null,
    });
    return seedMessage(ctx, {
      person_id: who.id,
      company_id: company.id,
      campaign_id: campaign.id,
      enrollment_id: enrollment.id,
      step_id: steps[0]?.id ?? null,
      mailbox_id: mailbox.id,
      to_address: who.email,
      status: "scheduled",
      scheduled_for: when,
    } satisfies Partial<NewMessage>);
  };
  const soon = await scheduled(ana, at(2));
  const overdue = await scheduled(ben, at(-1));
  await ctx.db.insert(suppressions).values({
    workspace_id: ctx.workspace.id,
    type: "email",
    value: ben.email ?? "",
    reason: "manual",
    source: "test",
  });
  const step = await seedEnrollment(ctx, {
    campaign_id: campaign.id,
    person_id: cleo.id,
    mailbox_id: mailbox.id,
    current_step: 0,
    next_run_at: at(5),
  } satisfies Pick<NewEnrollment, "campaign_id" | "person_id"> & Partial<NewEnrollment>);
  const [task] = await ctx.db
    .insert(tasks)
    .values({
      workspace_id: ctx.workspace.id,
      person_id: ana.id,
      type: "promise",
      title: "Send the case study",
      due_at: at(3),
    })
    .returning();
  const [meeting] = await ctx.db
    .insert(meetings)
    .values({
      workspace_id: ctx.workspace.id,
      person_id: cleo.id,
      source: "manual",
      matched_by: "manual",
      start_at: at(6),
    })
    .returning();
  const later = await scheduled(await person("Dev Patel"), at(30));
  return {
    ctx,
    names: { ana: "Ana Brooks", ben: "Ben Ortiz", cleo: "Cleo Hart" },
    ids: { ana: ana.id, ben: ben.id, cleo: cleo.id },
    campaignId: campaign.id,
    mailboxId: mailbox.id,
    refs: {
      soon: soon.id,
      overdue: overdue.id,
      step: step.id,
      task: task?.id ?? "",
      meeting: meeting?.id ?? "",
      later: later.id,
    },
  };
}

describe("operating.next_actions", () => {
  it("lists the next 24 hours in time order with overdue items first", async () => {
    const p = await plan();
    const result = await call(getNextActions, p.ctx, {});
    expect(result.from).toBe(at(-24 * 7).toISOString());
    expect(result.to).toBe(at(24).toISOString());
    expect(result.items.map((item) => [item.kind, item.ref.id])).toEqual([
      ["send_message", p.refs.overdue],
      ["send_message", p.refs.soon],
      ["task", p.refs.task],
      ["campaign_step", p.refs.step],
      ["meeting", p.refs.meeting],
    ]);
    const [overdue, soon, task, step, meeting] = result.items;
    expect(overdue).toMatchObject({
      overdue: true,
      blocked: true,
      person_name: p.names.ben,
      company_name: "Harbor Supply Ltd",
      campaign_name: "Q4 distributors",
      what: "Email to Ben Ortiz (campaign Q4 distributors).",
    });
    expect(soon).toMatchObject({ overdue: false, blocked: false, channel: "email" });
    expect(task).toMatchObject({
      what: "Promise for Ana Brooks: Send the case study",
      ref: { type: "task" },
    });
    expect(step).toMatchObject({
      channel: "email",
      ref: { type: "enrollment" },
      what: "Step 1 (email) for Cleo Hart (campaign Q4 distributors).",
    });
    expect(meeting).toMatchObject({ what: "Meeting with Cleo Hart.", ref: { type: "meeting" } });
    expect(result.blocked).toEqual([
      expect.objectContaining({
        ref: { type: "message", id: p.refs.overdue },
        person_id: p.ids.ben,
      }),
    ]);
    expect(result.blocked[0]?.blockers[0]).toMatchObject({
      code: "suppressed_email",
      hard: true,
    });
    expect(result.blocked[0]?.blockers[0]?.fix).toContain("manage_suppressions action remove");
    expect(result.has_more).toBe(false);
  });

  it("looks further ahead with hours and pages with the cursor", async () => {
    const p = await plan();
    const wide = await call(getNextActions, p.ctx, { hours: 48 });
    expect(wide.items.map((item) => item.ref.id).at(-1)).toBe(p.refs.later);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = await call(getNextActions, p.ctx, {
        hours: 48,
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...result.items.map((item) => item.ref.id));
      if (!result.has_more) break;
      cursor = result.next_cursor ?? undefined;
    }
    expect(seen).toEqual(wide.items.map((item) => item.ref.id));
    expect(new Set(seen).size).toBe(6);

    expect(getNextActions.input.safeParse({ hours: 169 }).success).toBe(false);
    expect(getNextActions.input.safeParse({ limit: 101 }).success).toBe(false);
    await expect(call(getNextActions, p.ctx, { cursor: "not-a-cursor" })).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("never shows another workspace's items", async () => {
    await plan();
    const other = await createTestContext({ db, now: NOW });
    const result = await call(getNextActions, other, {});
    expect(result.items).toEqual([]);
    expect(result.blocked).toEqual([]);
  });
});

describe("operating.next_actions with parked messages", () => {
  it("shows an approved message of a paused sequence at the end of the pause, blocked", async () => {
    const p = await plan();
    const fay = await seedPerson(p.ctx, { full_name: "Fay Lin" });
    const enrollment = await seedEnrollment(p.ctx, {
      campaign_id: p.campaignId,
      person_id: fay.id,
      status: "paused",
      paused_until: at(3),
      next_run_at: null,
    });
    const parked = await seedMessage(p.ctx, {
      person_id: fay.id,
      campaign_id: p.campaignId,
      enrollment_id: enrollment.id,
      mailbox_id: p.mailboxId,
      status: "approved",
      scheduled_for: null,
    });
    const result = await call(getNextActions, p.ctx, {});
    const item = result.items.find((row) => row.ref.id === parked.id);
    expect(item).toMatchObject({
      at: at(3).toISOString(),
      overdue: false,
      blocked: true,
      what: "Email to Fay Lin (campaign Q4 distributors), approved and waiting to be scheduled.",
    });
    const blockers = result.blocked.find((row) => row.ref.id === parked.id)?.blockers ?? [];
    expect(blockers[0]).toMatchObject({ code: "enrollment_paused", until: at(3).toISOString() });
  });
});

describe("operating.explain", () => {
  it("says when a message goes out when nothing blocks it", async () => {
    const p = await plan();
    const result = await call(explainBlocker, p.ctx, { message_id: p.refs.soon });
    expect(result).toMatchObject({
      subject: { type: "message", id: p.refs.soon },
      blocked: false,
      blockers: [],
      next: "It goes out today 17:00 UTC.",
      message: { status: "scheduled", person_id: p.ids.ana },
      relationship: null,
    });
    expect(result.summary).toBe("Nothing blocks it. It goes out today 17:00 UTC.");
  });

  it("names every blocker of a waiting message with its fix", async () => {
    const p = await plan();
    const result = await call(explainBlocker, p.ctx, { message_id: p.refs.overdue });
    expect(result.blocked).toBe(true);
    expect(result.blockers[0]?.code).toBe("suppressed_email");
    expect(result.summary.startsWith("Not sent yet: ")).toBe(true);
    expect(result.next).toContain("manage_suppressions action remove");
  });

  it("reads the stored reason of a closed message, never an unknown reason", async () => {
    const p = await plan();
    const closed = (values: Partial<NewMessage>) =>
      seedMessage(p.ctx, { person_id: p.ids.ana, mailbox_id: p.mailboxId, ...values });
    const explainOf = async (values: Partial<NewMessage>) =>
      call(explainBlocker, p.ctx, { message_id: (await closed(values)).id });

    const skipped = await explainOf({
      status: "skipped",
      error: "not_contactable: suppressed_email, person_do_not_contact",
    });
    expect(skipped.blockers.map((item) => [item.code, item.hard])).toEqual([
      ["suppressed_email", true],
      ["person_do_not_contact", true],
    ]);
    expect(skipped.summary.startsWith("Not sent, and it will not go out: ")).toBe(true);

    const stopped = await explainOf({ status: "cancelled", error: "enrollment_stopped:replied" });
    expect(stopped.blockers[0]?.message).toBe(
      "The message was cancelled: the sequence stopped because they replied.",
    );
    expect(stopped.next).toBe(
      "Nothing to do for this message: it stays closed and nothing sends it again.",
    );
    // What the senders store when a step's sequence or campaign ended before it went out.
    const tookOver = await explainOf({
      status: "cancelled",
      error: "cancelled: enrollment_stopped:person_took_over",
    });
    expect(tookOver.blockers[0]?.message).toBe(
      "The message was cancelled: the sequence stopped because a person took over the conversation.",
    );
    const archived = await explainOf({
      status: "cancelled",
      error: "cancelled: campaign_archived",
    });
    expect(archived.blockers[0]?.message).toBe(
      "The message was cancelled: its campaign was archived.",
    );

    const bounced = await explainOf({
      status: "bounced",
      error: "hard_bounce: 550 5.1.1 user unknown",
    });
    expect(bounced.blockers[0]?.message).toBe(
      "The message bounced; the address does not receive mail.",
    );
    expect(bounced.next).toContain("enrich_leads action enrich");

    const failed = await explainOf({
      status: "failed",
      error:
        "Unresolved template variables: city. Edit the message or add fallbacks like {{first_name|there}}.",
    });
    expect(failed.blockers[0]).toMatchObject({
      code: "unresolved_variables",
      message: "The email has template variables with no value: city.",
    });

    const rejected = await closed({ status: "cancelled" });
    await p.ctx.db.insert(approvals).values({
      workspace_id: p.ctx.workspace.id,
      kind: "reply",
      title: "Reply to Ana",
      status: "rejected",
      target_type: "message",
      target_id: rejected.id,
    });
    const discarded = await call(explainBlocker, p.ctx, { message_id: rejected.id });
    expect(discarded.blockers[0]?.message).toBe(
      "The message was cancelled: a reviewer rejected it.",
    );

    const bare = await explainOf({ status: "cancelled" });
    expect(bare.blockers[0]?.message).toBe(
      "The message was cancelled: no reason was stored with it.",
    );
    for (const result of [skipped, stopped, bounced, failed, discarded, bare]) {
      expect(result.summary.toLowerCase()).not.toContain("unknown reason");
      expect(result.blocked).toBe(true);
    }
  });

  it("explains sent and inbound messages without blockers", async () => {
    const p = await plan();
    const sent = await seedMessage(p.ctx, {
      person_id: p.ids.ana,
      status: "sent",
      sent_at: at(-2),
    });
    const inbound = await seedMessage(p.ctx, {
      person_id: p.ids.ana,
      direction: "inbound",
      status: "received",
      received_at: at(-1),
    });
    expect(await call(explainBlocker, p.ctx, { message_id: sent.id })).toMatchObject({
      blocked: false,
      summary: "Sent today 13:00 UTC. Nothing blocked it.",
    });
    const answer = await call(explainBlocker, p.ctx, { message_id: inbound.id });
    expect(answer.blocked).toBe(false);
    expect(answer.summary).toContain("came from the prospect");
  });

  it("explains a person with state, next action and blockers", async () => {
    const p = await plan();
    const ana = await call(explainBlocker, p.ctx, { person_id: p.ids.ana });
    expect(ana.subject).toEqual({ type: "person", id: p.ids.ana });
    expect(ana.relationship).toMatchObject({ person_id: p.ids.ana, state: "in_sequence" });
    expect(ana.summary).toContain("Ana Brooks is in a sequence");
    expect(ana.summary).toContain("Next: ");
    expect(ana.blocked).toBe(false);
    expect(ana.next.length).toBeGreaterThan(0);

    const ben = await call(explainBlocker, p.ctx, { person_id: p.ids.ben });
    expect(ben.relationship?.state).toBe("stopped");
    expect(ben.summary).toContain("Ben Ortiz is stopped");

    const fresh = await seedPerson(p.ctx, { full_name: "Eva Lund" });
    const eva = await call(explainBlocker, p.ctx, { person_id: fresh.id });
    expect(eva.summary).toContain("Eva Lund is new");
    expect(eva.next).toBe("Nothing happens until you enroll them with enroll_leads action enroll.");
  });

  it("wants exactly one id, of the right kind, from this workspace", async () => {
    const p = await plan();
    await expect(call(explainBlocker, p.ctx, {})).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(
      call(explainBlocker, p.ctx, { message_id: p.refs.soon, person_id: p.ids.ana }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(explainBlocker.input.safeParse({ message_id: "pe_1" }).success).toBe(false);
    await expect(
      call(explainBlocker, p.ctx, { message_id: "msg_01k6a3v0q8x3m2n4p5r6s7t8v9" }),
    ).rejects.toMatchObject({ code: "not_found" });
    const other = await createTestContext({ db, now: NOW });
    await expect(call(explainBlocker, other, { message_id: p.refs.soon })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(call(explainBlocker, other, { person_id: p.ids.ana })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("performance guard", () => {
  it("keeps the query count flat on a workspace with thousands of people", async () => {
    const ctx = await createTestContext({ db, now: NOW });
    const mailbox = await seedMailbox(ctx, { daily_limit: 40 });
    const { campaign, steps } = await seedCampaign(ctx, {
      status: "active",
      settings: { senders: { mailbox_ids: [mailbox.id] } },
    });
    const SIZE = 3000;
    const personRows = Array.from({ length: SIZE }, (_, index) => ({
      workspace_id: ctx.workspace.id,
      full_name: `Lead ${index}`,
      email: `lead${index}@example.com`,
      email_status: "valid" as const,
      timezone: "America/Chicago",
    }));
    const ids: string[] = [];
    for (let start = 0; start < SIZE; start += 1000) {
      const inserted = await ctx.db
        .insert(people)
        .values(personRows.slice(start, start + 1000))
        .returning({ id: people.id });
      ids.push(...inserted.map((row) => row.id));
    }
    const enrolled = await ctx.db
      .insert(enrollments)
      .values(
        ids.map((personId, index) => ({
          workspace_id: ctx.workspace.id,
          campaign_id: campaign.id,
          person_id: personId,
          mailbox_id: mailbox.id,
          status: "active" as const,
          next_run_at: at(1 + (index % 70)),
        })),
      )
      .returning({ id: enrollments.id, person_id: enrollments.person_id });
    const messageRows = enrolled.slice(0, 1500).map((row, index) => ({
      workspace_id: ctx.workspace.id,
      channel: "email" as const,
      action: "email" as const,
      direction: "outbound" as const,
      person_id: row.person_id,
      campaign_id: campaign.id,
      enrollment_id: row.id,
      step_id: steps[0]?.id ?? null,
      mailbox_id: mailbox.id,
      subject: "Quick question",
      body_text: "Hi there.",
      ...(index % 2 === 0
        ? { status: "sent" as const, sent_at: at(-1 - (index % 10) / 10) }
        : { status: "scheduled" as const, scheduled_for: at(1 + (index % 20)) }),
    }));
    for (let start = 0; start < messageRows.length; start += 500) {
      await ctx.db.insert(messages).values(messageRows.slice(start, start + 500));
    }

    const spy = vi.spyOn(ctx.testDb.pglite, "query");
    const execSpy = vi.spyOn(ctx.testDb.pglite, "exec");
    try {
      const state = await buildOperatingState(ctx);
      expect(state.sending_today.emails_sent).toBe(750);
      expect(state.sending_today.emails_scheduled).toBeGreaterThan(0);
      const stateQueries = spy.mock.calls.length + execSpy.mock.calls.length;
      expect(stateQueries).toBeLessThanOrEqual(20);

      // Next actions: a fixed part plus the sequencer's own planning for each step on the page
      // (about five reads), whatever the size of the workspace.
      const count = async (limit: number) => {
        spy.mockClear();
        execSpy.mockClear();
        const next = await buildNextActions(ctx, { hours: 24, limit });
        expect(next.items).toHaveLength(limit);
        return spy.mock.calls.length + execSpy.mock.calls.length;
      };
      const small = await count(10);
      const large = await count(50);
      expect(small).toBeLessThanOrEqual(30 + 6 * 10);
      expect(large).toBeLessThanOrEqual(30 + 6 * 50);
      expect(large - small).toBeLessThanOrEqual(6 * 40);
    } finally {
      spy.mockRestore();
      execSpy.mockRestore();
    }
  }, 60_000);
});
