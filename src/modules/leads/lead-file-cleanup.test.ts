/** Lead-file facts leave with the people and companies they describe. */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lead_facts, people } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedCompany, seedMessage, seedPerson } from "../../testing/factories.js";
import { deleteCompanies } from "./operations/companies.js";
import { deleteLeads } from "./operations/people.js";
import { retentionSweepJob } from "./retention.js";
import { recordFact } from "./service.js";

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});

const DAY = 86_400_000;

async function world(settings = {}) {
  const ctx = await createTestContext({ db: testDb, settings });
  const company = await seedCompany(ctx, { name: "Harbor Dental" });
  const dana = await seedPerson(ctx, { company_id: company.id });
  const sam = await seedPerson(ctx, { company_id: company.id });
  const personFact = await recordFact(ctx, {
    personId: dana.id,
    scope: "person",
    kind: "timing",
    text: "Budget review in November.",
    source: "manual",
  });
  const toldByDana = await recordFact(ctx, {
    personId: dana.id,
    companyId: company.id,
    scope: "company",
    kind: "fact",
    text: "Uses HubSpot as their CRM.",
    source: "manual",
  });
  const samFact = await recordFact(ctx, {
    personId: sam.id,
    scope: "person",
    kind: "preference",
    text: "Prefers email.",
    source: "manual",
  });
  return { ctx, company, dana, sam, personFact, toldByDana, samFact };
}

async function facts(ctx: TestContext) {
  const rows = await ctx.db
    .select()
    .from(lead_facts)
    .where(eq(lead_facts.workspace_id, ctx.workspace.id));
  return new Map(rows.map((row) => [row.id, row]));
}

describe("lead file cleanup", () => {
  it("deleting a lead deletes their facts and unlinks company facts they told us", async () => {
    const { ctx, dana, personFact, toldByDana, samFact } = await world();
    await deleteLeads.handler(ctx, { person_ids: [dana.id] });
    const left = await facts(ctx);
    expect(left.has(personFact.id)).toBe(false);
    expect(left.get(toldByDana.id)).toMatchObject({ person_id: null, scope: "company" });
    expect(left.has(samFact.id)).toBe(true);
  });

  it("deleting a company deletes its facts and unlinks its people's facts", async () => {
    const { ctx, company, personFact, toldByDana, samFact } = await world();
    await deleteCompanies.handler(ctx, { company_ids: [company.id] });
    const left = await facts(ctx);
    expect(left.has(toldByDana.id)).toBe(false);
    expect(left.get(personFact.id)).toMatchObject({ company_id: null, scope: "person" });
    expect(left.get(samFact.id)).toMatchObject({ company_id: null });
  });

  it("the retention sweep deletes the lead file of the people it deletes", async () => {
    const { ctx, company, dana, sam, personFact, toldByDana, samFact } = await world({
      compliance: { retention_days: 365 },
    });
    const old = new Date(ctx.clock.now().getTime() - 400 * DAY);
    await ctx.db.update(people).set({ updated_at: old }).where(eq(people.id, dana.id));
    const reply = await seedMessage(ctx, {
      person_id: dana.id,
      direction: "inbound",
      status: "received",
      created_at: new Date(ctx.clock.now().getTime() - 390 * DAY),
      received_at: new Date(ctx.clock.now().getTime() - 390 * DAY),
    });
    const fromReply = await recordFact(ctx, {
      companyId: company.id,
      scope: "company",
      kind: "timing",
      text: "Moving offices in October.",
      source: "reply",
      sourceRef: reply.id,
    });
    const summary = (await retentionSweepJob.handler(
      ctx.jobContext({ name: "leads.retention_sweep" }),
      {},
    )) as { people_deleted: number };
    expect(summary.people_deleted).toBe(1);
    const left = await facts(ctx);
    expect(left.has(personFact.id)).toBe(false);
    expect(left.has(fromReply.id)).toBe(false);
    expect(left.get(toldByDana.id)).toMatchObject({ person_id: null });
    expect(left.get(samFact.id)?.person_id).toBe(sam.id);
  });
});
