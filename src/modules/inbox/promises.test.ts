import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EventData, EventHandlerDefinition, EventType } from "../../core/events.js";
import type { WorkspaceSettingsInput } from "../../core/settings.js";
import { lead_facts, people, problems, tasks } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedMessage, seedPerson, seedThread } from "../../testing/factories.js";
import { addSuppression, recordFact } from "../leads/service.js";
import {
  checkOverduePromises,
  EXTRACT_PROMISES_JOB,
  extractPromises,
  extractPromisesJob,
  leadFileDailyJob,
  promiseDueAt,
  promisesOnReplySent,
  promisesOnTakeover,
} from "./promises.js";
import type { PromisesOutput, PromisesVars } from "./prompts/promises.js";
import { completeTask } from "./task-operations.js";

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});

const DAY = 86_400_000;
const WEEKDAYS = [1, 2, 3, 4, 5];
/** Tuesday 2026-09-22, 10:00 in Chicago. */
const SENT_AT = new Date("2026-09-22T15:00:00Z");

describe("promiseDueAt", () => {
  it.each([
    ["the promised working day", "2026-09-28", "2026-09-28T09:00:00.000Z"],
    ["the next working day after a weekend day", "2026-09-26", "2026-09-28T09:00:00.000Z"],
    ["the next working day without a date", null, "2026-09-23T09:00:00.000Z"],
    ["the next working day for a date before the send", "2026-09-01", "2026-09-23T09:00:00.000Z"],
    ["the same day when promised for today", "2026-09-22", "2026-09-22T09:00:00.000Z"],
  ])("is 09:00 UTC on %s", (_label, due, expected) => {
    expect(
      promiseDueAt({
        due,
        sentOn: "2026-09-22",
        workingDays: WEEKDAYS,
        holidays: [],
      }).toISOString(),
    ).toBe(expected);
  });

  it("skips holidays", () => {
    expect(
      promiseDueAt({
        due: "2026-09-28",
        sentOn: "2026-09-22",
        workingDays: WEEKDAYS,
        holidays: ["2026-09-28"],
      }).toISOString(),
    ).toBe("2026-09-29T09:00:00.000Z");
  });
});

async function world(settings: WorkspaceSettingsInput = {}) {
  const ctx = await createTestContext({
    db: testDb,
    settings,
    workspace: { timezone: "America/Chicago" },
    now: "2026-09-22T16:00:00.000Z",
  });
  const person = await seedPerson(ctx, { full_name: "Dana Reyes" });
  const thread = await seedThread(ctx, { person_id: person.id });
  const reply = await seedMessage(ctx, {
    thread_id: thread.id,
    person_id: person.id,
    action: "reply",
    status: "sent",
    sent_at: SENT_AT,
    subject: "Re: pricing",
    body_text:
      "Hi Dana, I'll send the case study on Monday and share pricing soon.\n\nOn Mon, Dana wrote:\n> Can you send more details?",
  });
  return { ctx, person, thread, reply };
}

async function promiseTasks(ctx: TestContext) {
  return ctx.db
    .select()
    .from(tasks)
    .where(and(eq(tasks.workspace_id, ctx.workspace.id), eq(tasks.type, "promise")))
    .orderBy(tasks.dedupe_key);
}

const TWO_PROMISES: PromisesOutput = {
  promises: [
    { text: "Send the case study", due: "2026-09-28" },
    { text: "Share pricing", due: null },
  ],
};

describe("extractPromises", () => {
  it("turns each promise in a sent reply into a task, once", async () => {
    const { ctx, person, thread, reply } = await world();
    ctx.brain.on("inbox.reply.promises", TWO_PROMISES);
    const job = extractPromisesJob.handler(ctx.jobContext({ name: EXTRACT_PROMISES_JOB }), {
      message_id: reply.id,
    });
    expect(await job).toEqual({ message_id: reply.id, promises: 2, created: 2 });

    const call = ctx.recorded.brain.find((entry) => entry.promptId === "inbox.reply.promises");
    expect(call?.vars).toMatchObject({ sentOn: "2026-09-22", weekday: "Tuesday" });
    expect((call?.vars as PromisesVars | undefined)?.text).not.toContain(
      "Can you send more details",
    );
    expect(call?.user).toContain('<untrusted_content source="our_sent_reply">');

    expect(await promiseTasks(ctx)).toEqual([
      expect.objectContaining({
        title: "Send the case study",
        status: "open",
        due_at: new Date("2026-09-28T09:00:00Z"),
        person_id: person.id,
        thread_id: thread.id,
        dedupe_key: `promise:${reply.id}:0`,
      }),
      expect.objectContaining({
        title: "Share pricing",
        due_at: new Date("2026-09-23T09:00:00Z"),
        dedupe_key: `promise:${reply.id}:1`,
      }),
    ]);

    expect(await extractPromises(ctx, reply.id)).toMatchObject({ promises: 2, created: 0 });
    expect(await promiseTasks(ctx)).toHaveLength(2);
  });

  it("creates nothing when the reply promises nothing", async () => {
    const { ctx, reply } = await world();
    ctx.brain.on("inbox.reply.promises", { promises: [] });
    expect(await extractPromises(ctx, reply.id)).toEqual({
      message_id: reply.id,
      promises: 0,
      created: 0,
    });
    expect(await promiseTasks(ctx)).toHaveLength(0);
  });

  it("skips replies not sent, inbound messages and workspaces with the setting off", async () => {
    const { ctx, person } = await world();
    const draft = await seedMessage(ctx, {
      person_id: person.id,
      action: "reply",
      status: "draft",
    });
    const inbound = await seedMessage(ctx, {
      person_id: person.id,
      direction: "inbound",
      status: "received",
    });
    expect(await extractPromises(ctx, draft.id)).toMatchObject({ skipped: "status_draft" });
    expect(await extractPromises(ctx, inbound.id)).toMatchObject({ skipped: "not_found" });
    const off = await world({ lead_file: { extract_promises: false } });
    expect(await extractPromises(off.ctx, off.reply.id)).toMatchObject({ skipped: "setting_off" });
    expect(ctx.recorded.brain).toHaveLength(0);
  });
});

async function fire<T extends EventType>(
  ctx: TestContext,
  handler: EventHandlerDefinition<T>,
  data: EventData[T],
): Promise<void> {
  await handler.handler(ctx.jobContext(), {
    id: "evt_test",
    type: handler.event,
    workspaceId: ctx.workspace.id,
    subject: null,
    data,
    occurredAt: ctx.clock.now(),
  });
}

describe("promise event handlers", () => {
  it("looks for promises in sent replies and in replies a person wrote", async () => {
    const { ctx, person, thread, reply } = await world();
    const sent = (action: "reply" | "email") => ({
      message_id: reply.id,
      thread_id: thread.id,
      person_id: person.id,
      campaign_id: null,
      channel: "email" as const,
      action,
      sent_at: SENT_AT.toISOString(),
    });
    await fire(ctx, promisesOnReplySent, sent("email"));
    expect(ctx.enqueued(EXTRACT_PROMISES_JOB)).toHaveLength(0);
    await fire(ctx, promisesOnReplySent, sent("reply"));
    expect(ctx.enqueued(EXTRACT_PROMISES_JOB)).toEqual([
      expect.objectContaining({
        payload: { message_id: reply.id },
        options: expect.objectContaining({ singletonKey: `${EXTRACT_PROMISES_JOB}:${reply.id}` }),
      }),
    ]);
    await fire(ctx, promisesOnTakeover, {
      thread_id: thread.id,
      person_id: person.id,
      message_id: "msg_01k6a3v0q8x3m2n4p5r6s7t8w9",
    });
    await fire(ctx, promisesOnTakeover, {
      thread_id: thread.id,
      person_id: person.id,
      message_id: null,
    });
    expect(ctx.enqueued(EXTRACT_PROMISES_JOB)).toHaveLength(2);
  });

  it("does nothing when the setting is off", async () => {
    const { ctx, person, thread, reply } = await world({ lead_file: { extract_promises: false } });
    await fire(ctx, promisesOnReplySent, {
      message_id: reply.id,
      thread_id: thread.id,
      person_id: person.id,
      campaign_id: null,
      channel: "email",
      action: "reply",
      sent_at: SENT_AT.toISOString(),
    });
    expect(ctx.enqueued(EXTRACT_PROMISES_JOB)).toHaveLength(0);
  });
});

describe("overdue promises", () => {
  async function overdueWorld() {
    const world = await createTestContext({ db: testDb, now: "2026-09-22T16:00:00.000Z" });
    const person = await seedPerson(world, { full_name: "Dana Reyes" });
    const now = world.clock.now().getTime();
    const [late, recent, chore] = await world.db
      .insert(tasks)
      .values([
        {
          workspace_id: world.workspace.id,
          person_id: person.id,
          type: "promise",
          title: "Send the case study",
          due_at: new Date(now - 2 * DAY),
        },
        {
          workspace_id: world.workspace.id,
          person_id: person.id,
          type: "promise",
          title: "Share pricing",
          due_at: new Date(now - DAY / 2),
        },
        {
          workspace_id: world.workspace.id,
          person_id: person.id,
          type: "follow_up",
          title: "Call back",
          due_at: new Date(now - 5 * DAY),
        },
      ])
      .returning();
    if (!late || !recent || !chore) throw new Error("tasks missing");
    return { ctx: world, person, late, recent, chore };
  }

  async function overdueProblems(ctx: TestContext) {
    return ctx.db
      .select()
      .from(problems)
      .where(
        and(eq(problems.workspace_id, ctx.workspace.id), eq(problems.kind, "promise_overdue")),
      );
  }

  it("opens one problem per promise more than a day late, for a person", async () => {
    const { ctx, person, late } = await overdueWorld();
    expect(await checkOverduePromises(ctx)).toEqual({
      promises_overdue: 1,
      problems_opened: 1,
      problems_resolved: 0,
    });
    expect(await checkOverduePromises(ctx)).toMatchObject({ problems_opened: 0 });
    const [problem, ...others] = await overdueProblems(ctx);
    expect(others).toHaveLength(0);
    expect(problem).toMatchObject({
      severity: "normal",
      owner: "person",
      status: "open",
      title: "Promise overdue: Send the case study",
      remedy: `Do it, then mark the task done with manage_tasks action complete and task_id ${late.id} (or skip it there if it no longer applies).`,
      subject_type: "task",
      subject_id: late.id,
      person_id: person.id,
      dedupe_key: `promise_overdue:${late.id}`,
    });
    expect(problem?.reason).toContain("Dana Reyes");
  });

  it("resolves the problem when the promise is kept, skipped or gone", async () => {
    const { ctx, late } = await overdueWorld();
    await checkOverduePromises(ctx);
    await completeTask.handler(ctx, { task_id: late.id, note: "Sent it." });
    expect((await overdueProblems(ctx))[0]).toMatchObject({
      status: "resolved",
      resolution: "The promise was kept.",
    });

    const other = await overdueWorld();
    await checkOverduePromises(other.ctx);
    await other.ctx.db.update(tasks).set({ status: "skipped" }).where(eq(tasks.id, other.late.id));
    expect(await checkOverduePromises(other.ctx)).toMatchObject({ problems_resolved: 1 });
    expect((await overdueProblems(other.ctx))[0]).toMatchObject({
      status: "resolved",
      resolution: "The task was marked skipped.",
    });

    const gone = await overdueWorld();
    await checkOverduePromises(gone.ctx);
    await gone.ctx.db.delete(tasks).where(eq(tasks.id, gone.late.id));
    await checkOverduePromises(gone.ctx);
    expect((await overdueProblems(gone.ctx))[0]).toMatchObject({
      status: "resolved",
      resolution: "The task no longer exists.",
    });
  });

  it("skips people who may not be contacted, and resolves a problem already open for them", async () => {
    // Opted out before the promise was due: no problem prompts anyone to contact them.
    const blocked = await overdueWorld();
    await blocked.ctx.db
      .update(people)
      .set({ status: "unsubscribed" })
      .where(eq(people.id, blocked.person.id));
    expect(await checkOverduePromises(blocked.ctx)).toMatchObject({ problems_opened: 0 });
    expect(await overdueProblems(blocked.ctx)).toHaveLength(0);

    // Suppressed after the problem opened: the next run resolves it; the task stays open.
    const later = await overdueWorld();
    await checkOverduePromises(later.ctx);
    await addSuppression(later.ctx, {
      type: "person",
      value: later.person.id,
      reason: "do_not_contact",
      source: "reply",
    });
    expect(await checkOverduePromises(later.ctx)).toMatchObject({
      problems_opened: 0,
      problems_resolved: 1,
    });
    expect((await overdueProblems(later.ctx))[0]).toMatchObject({
      status: "resolved",
      resolution: "The person may not be contacted any more.",
    });
  });
});

describe("daily lead file job", () => {
  it("marks expired facts and checks overdue promises", async () => {
    const ctx = await createTestContext({ db: testDb });
    const person = await seedPerson(ctx);
    const expired = await recordFact(ctx, {
      personId: person.id,
      scope: "person",
      kind: "timing",
      text: "On leave until September 10.",
      source: "reply",
      expiresAt: new Date(ctx.clock.now().getTime() + DAY),
    });
    const lasting = await recordFact(ctx, {
      personId: person.id,
      scope: "person",
      kind: "fact",
      text: "Uses HubSpot as their CRM.",
      source: "manual",
    });
    ctx.clock.advance(2 * DAY);
    expect(await leadFileDailyJob.handler(ctx.jobContext(), {})).toEqual({
      facts_expired: 1,
      promises_overdue: 0,
      problems_opened: 0,
      problems_resolved: 0,
    });
    const rows = await ctx.db
      .select({ id: lead_facts.id, status: lead_facts.status })
      .from(lead_facts)
      .where(eq(lead_facts.workspace_id, ctx.workspace.id));
    expect(new Map(rows.map((row) => [row.id, row.status]))).toEqual(
      new Map([
        [expired.id, "expired"],
        [lasting.id, "active"],
      ]),
    );
  });
});
