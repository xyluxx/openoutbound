import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, enrollments, lead_facts, problems } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedCampaign, seedCompany, seedEnrollment, seedPerson } from "../../testing/factories.js";
import { openProblem } from "../problems/service.js";
import { checkContactable, holdCompany, holdSuggestionKey, releaseCompany } from "./service.js";

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});

const DAY = 86_400_000;
const REASON = "Signed with a competitor until next spring";

async function setup() {
  const ctx = await createTestContext({ db: testDb });
  const company = await seedCompany(ctx, { name: "Harbor Dental" });
  const dana = await seedPerson(ctx, { company_id: company.id });
  const sam = await seedPerson(ctx, { company_id: company.id });
  const outsider = await seedPerson(ctx);
  const { campaign } = await seedCampaign(ctx, { status: "active", steps: [{ type: "email" }] });
  const running = await seedEnrollment(ctx, {
    campaign_id: campaign.id,
    person_id: dana.id,
    status: "active",
  });
  const pausedByHand = await seedEnrollment(ctx, {
    campaign_id: campaign.id,
    person_id: sam.id,
    status: "paused",
    stop_reason: "manual",
  });
  const elsewhere = await seedEnrollment(ctx, {
    campaign_id: campaign.id,
    person_id: outsider.id,
    status: "active",
  });
  const until = new Date(ctx.clock.now().getTime() + 30 * DAY);
  return { ctx, company, dana, sam, running, pausedByHand, elsewhere, until };
}

async function enrollment(ctx: TestContext, id: string) {
  const [row] = await ctx.db.select().from(enrollments).where(eq(enrollments.id, id));
  if (!row) throw new Error("enrollment missing");
  return row;
}

async function companyRow(ctx: TestContext, id: string) {
  const [row] = await ctx.db.select().from(companies).where(eq(companies.id, id));
  if (!row) throw new Error("company missing");
  return row;
}

async function holdFacts(ctx: TestContext, companyId: string) {
  return ctx.db
    .select()
    .from(lead_facts)
    .where(and(eq(lead_facts.workspace_id, ctx.workspace.id), eq(lead_facts.company_id, companyId)))
    .orderBy(lead_facts.created_at);
}

describe("holdCompany", () => {
  it("blocks outreach, pauses running sequences until the end, records a fact and emits", async () => {
    const { ctx, company, dana, running, pausedByHand, elsewhere, until } = await setup();
    expect(await holdCompany(ctx, { companyId: company.id, until, reason: REASON })).toEqual({
      changed: true,
    });

    expect(await companyRow(ctx, company.id)).toMatchObject({
      hold_until: until,
      hold_reason: REASON,
    });
    expect(await checkContactable(ctx, { personId: dana.id, channel: "email" })).toMatchObject({
      ok: false,
      reasons: expect.arrayContaining(["company_on_hold"]),
    });
    expect(await enrollment(ctx, running.id)).toMatchObject({
      status: "paused",
      stop_reason: "company_hold",
      paused_until: until,
    });
    // A pause by hand stays a pause by hand; other companies are not touched.
    expect(await enrollment(ctx, pausedByHand.id)).toMatchObject({
      status: "paused",
      stop_reason: "manual",
      paused_until: null,
    });
    expect(await enrollment(ctx, elsewhere.id)).toMatchObject({ status: "active" });

    const facts = await holdFacts(ctx, company.id);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      scope: "company",
      kind: "timing",
      source: "manual",
      source_ref: "company_hold",
      status: "active",
      expires_at: until,
      text: `No outreach until ${until.toISOString().slice(0, 10)}: ${REASON}`,
    });
    expect(ctx.emitted("company.hold_changed").map((event) => event.data)).toEqual([
      { company_id: company.id, hold_until: until.toISOString(), reason: REASON },
    ]);
  });

  it("keeps a pause that lasts longer than the hold", async () => {
    const { ctx, company, until } = await setup();
    const { campaign } = await seedCampaign(ctx, { status: "active", steps: [{ type: "email" }] });
    const away = await seedPerson(ctx, { company_id: company.id });
    const back = await seedPerson(ctx, { company_id: company.id });
    const longAway = new Date(until.getTime() + 10 * DAY);
    const shortAway = new Date(until.getTime() - 10 * DAY);
    const outlasting = await seedEnrollment(ctx, {
      campaign_id: campaign.id,
      person_id: away.id,
      status: "paused",
      stop_reason: "out_of_office",
      paused_until: longAway,
    });
    const shorter = await seedEnrollment(ctx, {
      campaign_id: campaign.id,
      person_id: back.id,
      status: "paused",
      stop_reason: "out_of_office",
      paused_until: shortAway,
    });
    await holdCompany(ctx, { companyId: company.id, until, reason: REASON });
    expect(await enrollment(ctx, outlasting.id)).toMatchObject({
      status: "paused",
      stop_reason: "out_of_office",
      paused_until: longAway,
    });
    expect(await enrollment(ctx, shorter.id)).toMatchObject({
      status: "paused",
      stop_reason: "company_hold",
      paused_until: until,
    });
    // Lifting the hold resumes only what the hold paused.
    await releaseCompany(ctx, company.id);
    expect((await enrollment(ctx, outlasting.id)).status).toBe("paused");
    expect((await enrollment(ctx, shorter.id)).status).toBe("active");
  });

  it("changes nothing for the same hold and replaces the fact for a new date", async () => {
    const { ctx, company, until } = await setup();
    await holdCompany(ctx, { companyId: company.id, until, reason: REASON });
    expect(await holdCompany(ctx, { companyId: company.id, until, reason: REASON })).toEqual({
      changed: false,
    });
    const later = new Date(until.getTime() + 10 * DAY);
    expect(await holdCompany(ctx, { companyId: company.id, until: later, reason: REASON })).toEqual(
      { changed: true },
    );
    const [first, second] = await holdFacts(ctx, company.id);
    expect(second).toMatchObject({ status: "active", expires_at: later });
    expect(first).toMatchObject({ status: "corrected", replaced_by: second?.id });
    expect(ctx.emitted("company.hold_changed")).toHaveLength(2);
  });

  it("records an agent's hold with source agent and resolves the hold suggestion", async () => {
    const { ctx, company, until } = await setup();
    const suggestion = await openProblem(ctx, {
      kind: "company_hold_suggested",
      severity: "normal",
      owner: "anyone",
      title: `Hold ${company.name}?`,
      reason: "A reply asked us to wait.",
      remedy: `If this is right, run manage_leads action hold_company with company_id ${company.id} and until 2026-10-19.`,
      subject: { type: "company", id: company.id },
      companyId: company.id,
      dedupeKey: holdSuggestionKey(company.id),
    });
    const agent = ctx.with({ principal: { type: "agent", id: "local-agent", name: "Agent" } });
    await holdCompany(agent, { companyId: company.id, until, reason: REASON });
    expect((await holdFacts(ctx, company.id))[0]?.source).toBe("agent");
    const [problem] = await ctx.db.select().from(problems).where(eq(problems.id, suggestion.id));
    expect(problem?.status).toBe("resolved");
  });

  it("refuses a hold that ends in the past or has no reason", async () => {
    const { ctx, company } = await setup();
    const past = new Date(ctx.clock.now().getTime() - DAY);
    await expect(
      holdCompany(ctx, { companyId: company.id, until: past, reason: REASON }),
    ).rejects.toMatchObject({
      code: "validation_failed",
      hint: expect.stringContaining("release_company"),
    });
    const until = new Date(ctx.clock.now().getTime() + DAY);
    await expect(
      holdCompany(ctx, { companyId: company.id, until, reason: "   " }),
    ).rejects.toMatchObject({ code: "validation_failed", details: { field: "reason" } });
    await expect(
      holdCompany(ctx, { companyId: "co_missing", until, reason: REASON }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("releaseCompany", () => {
  it("lifts the hold, resumes only the sequences paused for it and expires the hold fact", async () => {
    const { ctx, company, dana, running, pausedByHand, until } = await setup();
    await holdCompany(ctx, { companyId: company.id, until, reason: REASON });
    expect(await releaseCompany(ctx, company.id)).toEqual({ changed: true });

    expect(await companyRow(ctx, company.id)).toMatchObject({
      hold_until: null,
      hold_reason: null,
    });
    expect(await checkContactable(ctx, { personId: dana.id, channel: "email" })).toMatchObject({
      ok: true,
    });
    expect(await enrollment(ctx, running.id)).toMatchObject({
      status: "active",
      stop_reason: null,
    });
    expect(await enrollment(ctx, pausedByHand.id)).toMatchObject({
      status: "paused",
      stop_reason: "manual",
    });
    expect((await holdFacts(ctx, company.id)).map((fact) => fact.status)).toEqual(["expired"]);
    expect(ctx.emitted("company.hold_changed").at(-1)?.data).toEqual({
      company_id: company.id,
      hold_until: null,
      reason: null,
    });
  });

  it("changes nothing without a hold or after the hold ended", async () => {
    const { ctx, company, until } = await setup();
    expect(await releaseCompany(ctx, company.id)).toEqual({ changed: false });
    await holdCompany(ctx, { companyId: company.id, until, reason: REASON });
    ctx.clock.set(new Date(until.getTime() + DAY));
    expect(await releaseCompany(ctx, company.id)).toEqual({ changed: false });
    expect(ctx.emitted("company.hold_changed")).toHaveLength(1);
  });
});
