import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EmittedEvent } from "../../core/events.js";
import { newId } from "../../core/ids.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedCompany, seedPerson } from "../../testing/factories.js";
import { autoResearchHandler } from "./auto-research.js";
import { AUTO_BATCH_DELAY_MS } from "./service.js";

vi.mock("../leads/service.js", async () => {
  const { and, eq } = await import("drizzle-orm");
  const schema = await import("../../db/schema/index.js");
  const { notFound } = await import("../../core/errors.js");
  return {
    getPersonWithCompany: vi.fn(
      async (ctx: { db: TestDb["db"]; workspace: { id: string } }, personId: string) => {
        const [person] = await ctx.db
          .select()
          .from(schema.people)
          .where(
            and(eq(schema.people.workspace_id, ctx.workspace.id), eq(schema.people.id, personId)),
          );
        if (!person) throw notFound("Person", personId);
        const [company] = person.company_id
          ? await ctx.db
              .select()
              .from(schema.companies)
              .where(eq(schema.companies.id, person.company_id))
          : [];
        return { person, company: company ?? null };
      },
    ),
  };
});

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

async function created(ctx: TestContext, kind: "person" | "company", id: string) {
  const event: EmittedEvent<"lead.created"> = {
    id: newId("evt"),
    type: "lead.created",
    workspaceId: ctx.workspace.id,
    subject: { type: kind, id },
    data: { kind, id, source: "csv", import_id: null },
    occurredAt: ctx.clock.now(),
  };
  await autoResearchHandler.handler(ctx.jobContext(), event);
}

describe("auto research on lead.created", () => {
  it("queues one delayed, low-priority job per company for people at or above the fit threshold", async () => {
    const ctx = await createTestContext({ db });
    const company = await seedCompany(ctx);
    const a = await seedPerson(ctx, { company_id: company.id, fit_score: 70 });
    const b = await seedPerson(ctx, { company_id: company.id, fit_score: 95 });
    const low = await seedPerson(ctx, { company_id: company.id, fit_score: 69 });
    const unscored = await seedPerson(ctx, { company_id: company.id, fit_score: null });

    for (const person of [a, b, low, unscored]) await created(ctx, "person", person.id);

    const jobs = ctx.enqueued("research.run");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.options).toMatchObject({
      singletonKey: `research:${ctx.workspace.id}:co:${company.id}`,
      delayMs: AUTO_BATCH_DELAY_MS,
      priority: -1,
    });
    expect(jobs[0]?.payload).toEqual({ company_id: company.id, person_id: null });
  });

  it("honors a custom threshold, skips opted-out people and respects the AI budget", async () => {
    const ctx = await createTestContext({ db, settings: { data: { auto_research_min_fit: 90 } } });
    const company = await seedCompany(ctx);
    const fit85 = await seedPerson(ctx, { company_id: company.id, fit_score: 85 });
    const unsubscribed = await seedPerson(ctx, {
      company_id: company.id,
      fit_score: 99,
      status: "unsubscribed",
    });
    await created(ctx, "person", fit85.id);
    await created(ctx, "person", unsubscribed.id);
    await created(ctx, "person", "pe_01k6a3v0q8x3m2n4p5r6s7t8v9");
    expect(ctx.enqueued("research.run")).toHaveLength(0);

    const great = await seedPerson(ctx, { company_id: company.id, fit_score: 95 });
    ctx.usage.setOverBudget("ai");
    await created(ctx, "person", great.id);
    expect(ctx.enqueued("research.run")).toHaveLength(0);
    ctx.usage.setOverBudget("ai", false);
    await created(ctx, "person", great.id);
    expect(ctx.enqueued("research.run")).toHaveLength(1);
  });

  it("researches high-fit companies and company-less people with their own key", async () => {
    const ctx = await createTestContext({ db });
    const company = await seedCompany(ctx, { fit_score: 80 });
    const weak = await seedCompany(ctx, { fit_score: 10 });
    const loner = await seedPerson(ctx, { company_id: null, fit_score: 90 });
    await created(ctx, "company", company.id);
    await created(ctx, "company", weak.id);
    await created(ctx, "person", loner.id);
    expect(ctx.enqueued("research.run").map((job) => job.options.singletonKey)).toEqual([
      `research:${ctx.workspace.id}:co:${company.id}`,
      `research:${ctx.workspace.id}:pe:${loner.id}`,
    ]);
  });
});
