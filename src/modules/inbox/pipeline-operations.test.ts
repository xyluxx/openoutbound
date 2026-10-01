import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenOutboundError } from "../../core/errors.js";
import type { AnyOperation } from "../../core/operation.js";
import { tasks } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedCampaign, seedCompany, seedPerson, seedThread } from "../../testing/factories.js";
import { stopEnrollmentsForPerson } from "../campaigns/service.js";
import { setPersonStatus } from "../leads/service.js";
import {
  createOpportunityOperation,
  listOpportunities,
  lostOpportunity,
  updateOpportunityOperation,
  wonOpportunity,
} from "./opportunity-operations.js";
import { completeTask, createTaskOperation, listTasks, skipTask } from "./task-operations.js";

vi.mock("../campaigns/service.js", () => ({ stopEnrollmentsForPerson: vi.fn(async () => 1) }));
vi.mock("../leads/service.js", () => ({ setPersonStatus: vi.fn(async () => {}) }));

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});
beforeEach(() => {
  vi.clearAllMocks();
});

// biome-ignore lint/suspicious/noExplicitAny: outputs differ per operation
type AnyOutput = any;

async function run(
  op: AnyOperation,
  ctx: TestContext,
  input: Record<string, unknown>,
): Promise<AnyOutput> {
  return op.handler(ctx, op.input.parse(input));
}

async function setup() {
  const ctx = await createTestContext({ db: testDb });
  const company = await seedCompany(ctx, { name: "Harbor Dental" });
  const person = await seedPerson(ctx, { company_id: company.id, status: "replied" });
  return { ctx, company, person };
}

describe("opportunities", () => {
  it("creates, moves through the stages with side effects and closes", async () => {
    const { ctx, person, company } = await setup();
    const created = await run(createOpportunityOperation, ctx, {
      person_id: person.id,
      value: 12000,
      currency: "eur",
      notes: "Met at the fair",
    });
    expect(created).toMatchObject({
      stage: "interested",
      company_id: company.id,
      currency: "EUR",
      changed: true,
      effects: ["person_status:interested"],
    });
    expect(setPersonStatus).toHaveBeenCalledWith(ctx, person.id, "interested");

    const booked = await run(updateOpportunityOperation, ctx, {
      opportunity_id: created.id,
      stage: "meeting_booked",
      meeting_at: "2026-10-06T15:00:00Z",
    });
    expect(booked).toMatchObject({ stage: "meeting_booked", changed: true });
    expect(booked.effects).toContain("enrollments_stopped");
    expect(stopEnrollmentsForPerson).toHaveBeenCalledWith(ctx, {
      personId: person.id,
      reason: "meeting_booked",
      companyWide: expect.any(Boolean),
    });

    const same = await run(updateOpportunityOperation, ctx, {
      opportunity_id: created.id,
      stage: "meeting_booked",
    });
    expect(same).toMatchObject({ changed: false, effects: [] });

    const won = await run(wonOpportunity, ctx, { opportunity_id: created.id, value: 9600 });
    expect(won).toMatchObject({ stage: "won", value: 9600, changed: true });
    expect(won.closed_at).toBeTruthy();
    expect(stopEnrollmentsForPerson).toHaveBeenLastCalledWith(ctx, {
      personId: person.id,
      reason: "won",
      companyWide: true,
    });

    const events = ctx.emitted("opportunity.updated").map((event) => event.data.stage);
    expect(events).toEqual(["interested", "meeting_booked", "won"]);
  });

  it("records the lost reason and filters the list", async () => {
    const { ctx, person } = await setup();
    const created = await run(createOpportunityOperation, ctx, { person_id: person.id });
    const lost = await run(lostOpportunity, ctx, {
      opportunity_id: created.id,
      lost_reason: "timing",
    });
    expect(lost).toMatchObject({ stage: "lost", lost_reason: "timing" });

    const open = await run(listOpportunities, ctx, { stage: ["interested"], person_id: person.id });
    expect(open.items).toHaveLength(0);
    const closed = await run(listOpportunities, ctx, { stage: ["lost"], person_id: person.id });
    expect(closed.items.map((row: { id: string }) => row.id)).toEqual([created.id]);
  });

  it("paginates newest first", async () => {
    const { ctx, person } = await setup();
    const a = await run(createOpportunityOperation, ctx, { person_id: person.id });
    const b = await run(createOpportunityOperation, ctx, { company_id: person.company_id });
    const first = await run(listOpportunities, ctx, { limit: 1, company_id: person.company_id });
    expect(first.items[0].id).toBe(b.id);
    const second = await run(listOpportunities, ctx, {
      limit: 1,
      company_id: person.company_id,
      cursor: first.next_cursor,
    });
    expect(second.items[0].id).toBe(a.id);
  });

  it("needs a person or company and valid ids", async () => {
    const { ctx } = await setup();
    const missing = await run(createOpportunityOperation, ctx, {}).catch((e: unknown) => e);
    expect((missing as OpenOutboundError).code).toBe("validation_failed");
    const unknown = await run(createOpportunityOperation, ctx, {
      person_id: "pe_01k6a3v0q8x3m2n4p5r6s7t8v9",
    }).catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(OpenOutboundError);
    expect((unknown as OpenOutboundError).code).toBe("not_found");
    const nothing = await run(updateOpportunityOperation, ctx, {
      opportunity_id: "opp_01k6a3v0q8x3m2n4p5r6s7t8v9",
      value: 1,
    }).catch((e: unknown) => e);
    expect((nothing as OpenOutboundError).code).toBe("not_found");
  });
});

describe("tasks", () => {
  it("creates tasks linked to a thread, lists them by due date and closes them", async () => {
    const { ctx, person } = await setup();
    const { campaign } = await seedCampaign(ctx);
    const thread = await seedThread(ctx, { person_id: person.id, campaign_id: campaign.id });
    const later = await run(createTaskOperation, ctx, {
      title: "Send the case study",
      due_at: "2026-10-01T09:00:00Z",
      thread_id: thread.id,
    });
    expect(later).toMatchObject({ person_id: person.id, status: "open", type: "other" });
    const [stored] = await ctx.db.select().from(tasks).where(eq(tasks.id, later.id));
    expect(stored).toMatchObject({ thread_id: thread.id, campaign_id: campaign.id });

    const sooner = await run(createTaskOperation, ctx, {
      title: "Call Dana",
      type: "call",
      due_at: "2026-09-21T15:00:00Z",
      person_id: person.id,
    });
    const undated = await run(createTaskOperation, ctx, {
      title: "Research the group",
      person_id: person.id,
    });

    const first = await run(listTasks, ctx, { person_id: person.id, limit: 2 });
    expect(first.items.map((task: { id: string }) => task.id)).toEqual([sooner.id, later.id]);
    const rest = await run(listTasks, ctx, {
      person_id: person.id,
      limit: 2,
      cursor: first.next_cursor,
    });
    expect(rest.items.map((task: { id: string }) => task.id)).toEqual([undated.id]);
    const due = await run(listTasks, ctx, {
      person_id: person.id,
      due_before: "2026-09-30T00:00:00Z",
    });
    expect(due.items.map((task: { id: string }) => task.id)).toEqual([sooner.id]);

    const done = await run(completeTask, ctx, { task_id: sooner.id, note: "Booked a demo" });
    expect(done).toMatchObject({ status: "done", notes: "Done: Booked a demo" });
    expect(done.completed_at).toBeTruthy();
    expect(await run(completeTask, ctx, { task_id: sooner.id })).toMatchObject({ status: "done" });
    const conflict = await run(skipTask, ctx, { task_id: sooner.id }).catch((e: unknown) => e);
    expect((conflict as OpenOutboundError).code).toBe("conflict");

    const skipped = await run(skipTask, ctx, { task_id: undated.id, note: "Not needed" });
    expect(skipped.status).toBe("skipped");
    const open = await run(listTasks, ctx, { person_id: person.id });
    expect(open.items.map((task: { id: string }) => task.id)).toEqual([later.id]);
  });

  it("rejects unknown people and threads", async () => {
    const { ctx } = await setup();
    const error = await run(createTaskOperation, ctx, {
      title: "Call",
      thread_id: "thr_01k6a3v0q8x3m2n4p5r6s7t8v9",
    }).catch((e: unknown) => e);
    expect((error as OpenOutboundError).code).toBe("not_found");
  });
});
