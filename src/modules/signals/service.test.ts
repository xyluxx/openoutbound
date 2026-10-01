import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { companies, signal_definitions, signals } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { seedCompany, seedPerson, seedWorkspace } from "../../testing/factories.js";
import { BUILTIN_DEFINITIONS, ensureCatalog, seedCatalog } from "./catalog.js";
import {
  getActiveSignals,
  markSignalsUsed,
  recomputeCompanyIntent,
  recomputeWorkspaceIntent,
  recordSignal,
  storeSignal,
} from "./service.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(() => {
  ctx.recorded.events.length = 0;
  ctx.clock.set("2026-09-19T12:00:00Z");
});

async function setDefinition(key: string, values: Partial<typeof signal_definitions.$inferInsert>) {
  await ensureCatalog(ctx.db, ctx.workspace.id);
  await ctx.db
    .update(signal_definitions)
    .set(values)
    .where(
      and(eq(signal_definitions.workspace_id, ctx.workspace.id), eq(signal_definitions.key, key)),
    );
}

describe("catalog", () => {
  it("seeds the 15 built-in definitions once and keeps user tuning", async () => {
    const workspace = await seedWorkspace(ctx.db);
    expect(await seedCatalog(ctx.db, workspace.id)).toBe(15);
    await ctx.db
      .update(signal_definitions)
      .set({ weight: 99, enabled: false })
      .where(
        and(
          eq(signal_definitions.workspace_id, workspace.id),
          eq(signal_definitions.key, "funding_round"),
        ),
      );
    expect(await seedCatalog(ctx.db, workspace.id)).toBe(0);
    const rows = await ctx.db
      .select()
      .from(signal_definitions)
      .where(eq(signal_definitions.workspace_id, workspace.id));
    expect(rows).toHaveLength(BUILTIN_DEFINITIONS.length);
    const funding = rows.find((row) => row.key === "funding_round");
    expect(funding).toMatchObject({ weight: 99, enabled: false, kind: "builtin" });
    expect(rows.find((row) => row.key === "job_change")).toMatchObject({
      weight: 80,
      half_life_days: 60,
      min_strength: 0.3,
    });
  });
});

describe("recordSignal", () => {
  it("rejects signals without a valid evidence URL", async () => {
    const company = await seedCompany(ctx);
    const base = {
      definition_key: "funding_round",
      title: "Raised a Series A",
      source: "test",
      companyId: company.id,
    };
    await expect(recordSignal(ctx, { ...base, evidence_url: "" })).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(
      recordSignal(ctx, { ...base, evidence_url: "javascript:alert(1)" }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    const stored = await ctx.db.select().from(signals).where(eq(signals.company_id, company.id));
    expect(stored).toHaveLength(0);
    expect(ctx.emitted("signal.detected")).toHaveLength(0);
  });

  it("rejects unknown and disabled keys with a hint", async () => {
    const company = await seedCompany(ctx);
    const input = {
      title: "x",
      source: "test",
      evidence_url: "https://example.com/a",
      companyId: company.id,
    };
    await expect(recordSignal(ctx, { ...input, definition_key: "nope" })).rejects.toMatchObject({
      code: "validation_failed",
      hint: expect.stringMatching(/define_custom/),
    });
    await setDefinition("review_activity", { enabled: false });
    await expect(
      recordSignal(ctx, { ...input, definition_key: "review_activity" }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await setDefinition("review_activity", { enabled: true });
  });

  it("dedupes on key + subject + canonical URL and emits once", async () => {
    const company = await seedCompany(ctx);
    const first = await recordSignal(ctx, {
      definition_key: "funding_round",
      title: "Raised a $12M Series A",
      evidence_url: "https://news.example.org/story?utm_source=feed#top",
      source: "news_gdelt",
      companyId: company.id,
      occurred_at: "2026-09-18T12:00:00Z",
    });
    const second = await recordSignal(ctx, {
      definition_key: "funding_round",
      title: "Raised a $12M Series A (again)",
      evidence_url: "https://NEWS.example.org/story/",
      source: "rss",
      companyId: company.id,
    });
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
    expect(ctx.emitted("signal.detected")).toHaveLength(1);
    expect(ctx.emitted("signal.detected")[0]?.data).toMatchObject({
      signal_id: first.id,
      definition_key: "funding_round",
      company_id: company.id,
      evidence_url: "https://news.example.org/story",
      strength: 1,
      score: 44, // 45 x 0.5^(1/60), one day old
    });
  });

  it("uses a provided dedupe key", async () => {
    const company = await seedCompany(ctx);
    const input = {
      definition_key: "news_mention",
      title: "Launched a product",
      source: "predictleads",
      companyId: company.id,
      dedupe_key: "predictleads:news:abc",
    };
    const a = await recordSignal(ctx, { ...input, evidence_url: "https://example.org/a" });
    const b = await recordSignal(ctx, { ...input, evidence_url: "https://example.org/b" });
    expect(b).toEqual({ id: a.id, created: false });
  });

  it("scores with decay at detection and skips events below min_strength", async () => {
    const company = await seedCompany(ctx);
    const old = await storeSignal(ctx, {
      definition_key: "hiring_relevant_roles",
      title: "Hiring an SDR",
      evidence_url: "https://jobs.example.com/1",
      source: "job_boards",
      companyId: company.id,
      strength: 0.8,
      occurred_at: "2026-09-12T12:00:00Z",
    });
    expect(old.score).toBe(37);
    const weak = await storeSignal(ctx, {
      definition_key: "hiring_relevant_roles",
      title: "Maybe hiring",
      evidence_url: "https://jobs.example.com/2",
      source: "job_boards",
      companyId: company.id,
      strength: 0.2,
    });
    expect(weak).toMatchObject({ created: true, score: 0, emitted: false });
    expect(ctx.emitted("signal.detected").map((e) => e.data.signal_id)).toEqual([old.id]);
  });

  it("resolves subjects by domain, email and person company", async () => {
    const company = await seedCompany(ctx, { domain: "lumen-subjects.example.com" });
    const person = await seedPerson(ctx, {
      company_id: company.id,
      email: "dana@lumen.example.com",
    });
    const byDomain = await storeSignal(ctx, {
      definition_key: "news_mention",
      title: "Partnership",
      evidence_url: "https://example.org/p1",
      source: "webhook",
      company: { domain: "https://www.lumen-subjects.example.com/about" },
    });
    expect(byDomain.companyId).toBe(company.id);
    const byEmail = await storeSignal(ctx, {
      definition_key: "leadership_content",
      title: "Wrote about forecasting",
      evidence_url: "https://blog.example.org/post",
      source: "rss",
      person: { email: "DANA@lumen.example.com" },
    });
    expect(byEmail).toMatchObject({ personId: person.id, companyId: company.id });
    await expect(
      storeSignal(ctx, {
        definition_key: "news_mention",
        title: "x",
        evidence_url: "https://example.org/p2",
        source: "webhook",
        company: { domain: "unknown-co.example.com" },
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    const created = await storeSignal(
      ctx,
      {
        definition_key: "news_mention",
        title: "x",
        evidence_url: "https://example.org/p3",
        source: "webhook",
        company: { domain: "brand-new.example.com", name: "Brand New" },
      },
      { createCompanies: true },
    );
    expect(created.createdCompany).toBe(true);
    expect(ctx.emitted("lead.created")).toHaveLength(1);
  });

  it("refuses ids from another workspace", async () => {
    const other = await createTestContext({ db: ctx.testDb });
    const foreign = await seedCompany(other);
    await expect(
      recordSignal(ctx, {
        definition_key: "news_mention",
        title: "x",
        evidence_url: "https://example.org/foreign",
        source: "test",
        companyId: foreign.id,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("updates the company intent score (strongest signal per key, noisy-OR)", async () => {
    const company = await seedCompany(ctx);
    const record = (key: string, url: string, strength: number, occurred: string) =>
      recordSignal(ctx, {
        definition_key: key,
        title: key,
        evidence_url: url,
        source: "test",
        companyId: company.id,
        strength,
        occurred_at: occurred,
      });
    await record("funding_round", "https://example.org/f", 1, "2026-08-20T12:00:00Z");
    await record("hiring_relevant_roles", "https://example.org/h", 0.8, "2026-09-12T12:00:00Z");
    await record("website_change", "https://example.org/w", 0.5, "2026-09-16T12:00:00Z");
    await record("website_change", "https://example.org/w2", 0.2, "2026-09-16T12:00:00Z");
    const [row] = await ctx.db.select().from(companies).where(eq(companies.id, company.id));
    expect(row?.intent_score).toBe(62);

    ctx.clock.advanceBy({ days: 60 });
    const result = await recomputeWorkspaceIntent(ctx, ctx.workspace.id);
    expect(result.changed).toBeGreaterThan(0);
    const [later] = await ctx.db.select().from(companies).where(eq(companies.id, company.id));
    expect(later?.intent_score).toBeLessThanOrEqual(26);
    expect(later?.intent_score).toBeGreaterThanOrEqual(22);
  });
});

describe("getActiveSignals", () => {
  it("orders by current score and scopes person queries", async () => {
    const company = await seedCompany(ctx);
    const dana = await seedPerson(ctx, { company_id: company.id });
    const omar = await seedPerson(ctx, { company_id: company.id });
    const make = (key: string, url: string, extra: Record<string, unknown> = {}) =>
      recordSignal(ctx, {
        definition_key: key,
        title: key,
        evidence_url: url,
        source: "test",
        companyId: company.id,
        ...extra,
      });
    const funding = await make("funding_round", "https://example.org/g1");
    const news = await make("news_mention", "https://example.org/g2");
    const danaSignal = await make("leadership_content", "https://example.org/g3", {
      personId: dana.id,
    });
    const omarSignal = await make("job_change", "https://example.org/g4", { personId: omar.id });
    const dismissed = await make("tech_adopted", "https://example.org/g5");
    await ctx.db.update(signals).set({ status: "dismissed" }).where(eq(signals.id, dismissed.id));

    const forCompany = await getActiveSignals(ctx, { companyId: company.id });
    // Equal scores (45): the newer signal first.
    expect(forCompany.map((s) => s.id)).toEqual([
      omarSignal.id,
      danaSignal.id,
      funding.id,
      news.id,
    ]);
    expect(forCompany[0]).toMatchObject({ current_score: 80, age_days: 0 });

    const forDana = await getActiveSignals(ctx, { personId: dana.id });
    expect(forDana.map((s) => s.id)).toEqual([danaSignal.id, funding.id, news.id]);

    const strong = await getActiveSignals(ctx, { companyId: company.id, minScore: 45, limit: 1 });
    expect(strong.map((s) => s.id)).toEqual([omarSignal.id]);

    await setDefinition("job_change", { enabled: false });
    const withoutDisabled = await getActiveSignals(ctx, { companyId: company.id });
    expect(withoutDisabled.map((s) => s.id)).not.toContain(omarSignal.id);
    await setDefinition("job_change", { enabled: true });

    ctx.clock.advanceBy({ days: 600 });
    expect(await getActiveSignals(ctx, { companyId: company.id })).toEqual([]);
  });
});

describe("markSignalsUsed", () => {
  it("marks used, records message ids once and ignores other workspaces", async () => {
    const company = await seedCompany(ctx);
    const { id } = await recordSignal(ctx, {
      definition_key: "funding_round",
      title: "Raised",
      evidence_url: "https://example.org/used",
      source: "test",
      companyId: company.id,
    });
    await markSignalsUsed(ctx, [id, id], { messageId: "msg_1" });
    await markSignalsUsed(ctx, [id], { messageId: "msg_1" });
    await markSignalsUsed(ctx, [id], { messageId: "msg_2" });
    await markSignalsUsed(ctx, []);
    const [row] = await ctx.db.select().from(signals).where(eq(signals.id, id));
    expect(row).toMatchObject({ status: "used", used_message_ids: ["msg_1", "msg_2"] });
    expect(row?.used_at).toEqual(new Date("2026-09-19T12:00:00Z"));

    const other = await createTestContext({ db: ctx.testDb });
    await markSignalsUsed(other, [id], { messageId: "msg_x" });
    const [unchanged] = await ctx.db.select().from(signals).where(eq(signals.id, id));
    expect(unchanged?.used_message_ids).toEqual(["msg_1", "msg_2"]);
  });

  it("recomputes intent to zero when every signal is dismissed", async () => {
    const company = await seedCompany(ctx);
    const { id } = await recordSignal(ctx, {
      definition_key: "news_mention",
      title: "News",
      evidence_url: "https://example.org/dismiss",
      source: "test",
      companyId: company.id,
    });
    await ctx.db.update(signals).set({ status: "dismissed" }).where(eq(signals.id, id));
    expect(await recomputeCompanyIntent(ctx, ctx.workspace.id, company.id)).toBe(0);
  });
});
