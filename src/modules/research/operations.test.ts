import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { AnyZodObject, OperationDefinition } from "../../core/operation.js";
import { research_briefs, workspaces } from "../../db/schema/index.js";
import { createBuiltinResearch } from "../../providers/research/builtin.js";
import type { ResearchProvider } from "../../providers/types.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedCompany, seedPerson } from "../../testing/factories.js";
import { module } from "./index.js";
import { getResearch, runResearch, searchWeb } from "./operations.js";

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

async function call<In extends AnyZodObject, Out extends z.ZodType>(
  op: OperationDefinition<In, Out>,
  ctx: TestContext,
  input: unknown,
): Promise<z.output<Out>> {
  return op.output.parse(await op.handler(ctx, op.input.parse(input))) as z.output<Out>;
}

const searcher: ResearchProvider = {
  id: "fake_search",
  creditsPerCall: { search: 3 },
  search: vi.fn(async () => [
    {
      url: "https://news.example.com/a",
      title: "Lumen Home expands",
      publishedAt: "2026-09-01T00:00:00.000Z",
    },
    { url: "https://news.example.com/b", title: "Second", snippet: "More" },
  ]),
};

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

describe("module registration", () => {
  it("exposes research_lead with run, get and search", () => {
    const ids = new Set(module.operations?.map((op) => op.id));
    const tool = module.tools?.[0];
    expect(tool?.name).toBe("research_lead");
    expect(Object.keys(tool?.actions ?? {})).toEqual(["run", "get", "search"]);
    for (const id of Object.values(tool?.actions ?? {})) expect(ids.has(id)).toBe(true);
    expect(module.eventHandlers?.map((h) => [h.event, h.name])).toEqual([
      ["lead.created", "research.auto_research"],
    ]);
  });
});

describe("research.run", () => {
  it("previews without writing, then queues and reports unknown ids", async () => {
    const ctx = await createTestContext({ db });
    const company = await seedCompany(ctx);
    const person = await seedPerson(ctx, { company_id: company.id });
    const input = { person_ids: [person.id, "pe_01k6a3v0q8x3m2n4p5r6s7t8v9"] };

    const preview = await call(runResearch, ctx.with({ request: { dryRun: true } }), input);
    expect(preview).toMatchObject({
      dry_run: true,
      preview: { to_research: 1, cached: 0 },
      warnings: ["pe_01k6a3v0q8x3m2n4p5r6s7t8v9: not_found"],
    });
    expect(ctx.enqueued()).toHaveLength(0);
    expect(await ctx.db.select().from(research_briefs)).toHaveLength(0);

    const result = await call(runResearch, ctx, input);
    if (!("items" in result)) throw new Error("expected a run result");
    expect(result.items.map((item) => [item.person_id, item.status, item.reason])).toEqual([
      [person.id, "queued", null],
      ["pe_01k6a3v0q8x3m2n4p5r6s7t8v9", "skipped", "not_found"],
    ]);
    expect(result.job_ids).toHaveLength(1);
    expect(() => runResearch.input.parse({})).toThrow();
  });

  it("shows the data budget in the dry run and warns when its web searches do not fit", async () => {
    const ctx = await createTestContext({
      db,
      providers: { research: searcher },
      settings: { data: { monthly_credit_budget: 16 } },
    });
    await ctx.usage.record({
      slot: "lead_source",
      provider: "apollo",
      operation: "leads.find_import",
      credits: 14,
    });
    const company = await seedCompany(ctx);
    const person = await seedPerson(ctx, { company_id: company.id });
    const other = await seedCompany(ctx);
    const dry = ctx.with({ request: { dryRun: true } });
    const preview = await call(runResearch, dry, {
      person_ids: [person.id],
      company_ids: [company.id, other.id],
    });
    // The person's search, and two searches per company (the person's company counted once),
    // at 3 credits each.
    expect(preview).toMatchObject({
      dry_run: true,
      preview: {
        to_research: 3,
        budget: { monthly_credits: 16, used_this_month: 14, left_this_month: 2 },
      },
      estimated_cost: { credits: 15 },
    });
    expect((preview as { warnings: string[] }).warnings).toEqual([
      "Not enough data budget: needs 15 credits, 2 left this month (14 of 16 used), so the web searches that do not fit are skipped and those briefs use the company site and signals only. Research fewer leads, or ask the human to raise settings.data.monthly_credit_budget (openoutbound workspaces update).",
    ]);

    // Without a research provider there is no web search to pay for.
    const none = await createTestContext({ db });
    const free = await call(runResearch, none.with({ request: { dryRun: true } }), {
      company_ids: [(await seedCompany(none)).id],
    });
    expect(free).toMatchObject({
      preview: {
        to_research: 1,
        budget: { monthly_credits: null, used_this_month: 0, left_this_month: null },
      },
      estimated_cost: { credits: 0 },
      warnings: [],
    });
  });
});

describe("research.get", () => {
  it("returns pending research, then the ready brief flagged untrusted and fresh", async () => {
    const ctx = await createTestContext({ db });
    const other = await createTestContext({ db });
    const company = await seedCompany(ctx);
    const person = await seedPerson(ctx, { company_id: company.id });

    await expect(call(getResearch, ctx, { person_id: person.id })).rejects.toMatchObject({
      code: "not_found",
      hint: expect.stringContaining("research_lead action run"),
    });
    await call(runResearch, ctx, { person_ids: [person.id] });
    expect(await call(getResearch, ctx, { person_id: person.id })).toMatchObject({
      status: "pending",
      scope: "person",
      brief: null,
      pending_research: true,
      untrusted: true,
    });

    const [ready] = await ctx.db
      .insert(research_briefs)
      .values({
        workspace_id: ctx.workspace.id,
        company_id: company.id,
        person_id: null,
        status: "ready",
        summary: "Company summary",
        brief: {
          who: { summary: "Buyers", role: null },
          company: { summary: "Lighting" },
          now: [{ fact: "Raised", source_url: "https://news.example.com/a", date: "2026-09-01" }],
          pains: [],
          angles: [],
          recommended_angle: null,
          confidence: "medium",
        },
        sources: [
          { url: "https://news.example.com/a", title: "News" },
          { url: "https://lumenhome.example.com/", title: "Home" },
        ],
        updated_at: ctx.clock.now(),
      })
      .returning();
    const byCompany = await call(getResearch, ctx, { company_id: company.id });
    expect(byCompany).toMatchObject({
      id: ready?.id,
      status: "ready",
      fresh: true,
      scope: "company",
    });
    expect(byCompany.brief?.now[0]?.source_url).toBe("https://news.example.com/a");
    expect(byCompany.sources.map((s) => s.url)).toEqual(["https://news.example.com/a"]);
    expect(byCompany.sources_total).toBe(2);
    const detailed = ctx.with({ request: { responseFormat: "detailed" } });
    expect((await call(getResearch, detailed, { company_id: company.id })).sources).toHaveLength(2);
    // The person's own brief is still running: the company brief is served meanwhile.
    expect(await call(getResearch, ctx, { person_id: person.id })).toMatchObject({
      id: ready?.id,
      scope: "company",
      pending_research: true,
    });
    expect((await call(getResearch, ctx, { brief_id: ready?.id })).id).toBe(ready?.id);
    await expect(call(getResearch, other, { brief_id: ready?.id })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(call(getResearch, ctx, {})).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("research.search", () => {
  it("searches with the configured provider, records credits and supports dry runs", async () => {
    const ctx = await createTestContext({ db, providers: { research: searcher } });
    const preview = await call(searchWeb, ctx.with({ request: { dryRun: true } }), {
      query: "Lumen Home",
    });
    expect(preview).toMatchObject({
      dry_run: true,
      preview: { provider: "fake_search" },
      estimated_cost: { credits: 3 },
    });
    expect(searcher.search).not.toHaveBeenCalled();

    const result = await call(searchWeb, ctx, {
      query: "Lumen Home",
      limit: 1,
      recency_days: 30,
      include_domains: ["news.example.com"],
    });
    expect(result).toEqual({
      provider: "fake_search",
      items: [
        {
          url: "https://news.example.com/a",
          title: "Lumen Home expands",
          snippet: null,
          published_at: "2026-09-01T00:00:00.000Z",
        },
      ],
      untrusted: true,
    });
    expect(searcher.search).toHaveBeenCalledWith("Lumen Home", {
      limit: 1,
      recencyDays: 30,
      includeDomains: ["news.example.com"],
    });
    expect(ctx.recorded.usage).toContainEqual(
      expect.objectContaining({ slot: "research", provider: "fake_search", credits: 3 }),
    );
  });

  it("explains missing providers, fetch-only providers and budgets", async () => {
    const none = await createTestContext({ db });
    await expect(call(searchWeb, none, { query: "anything" })).rejects.toMatchObject({
      code: "provider_not_configured",
    });
    const builtin = createBuiltinResearch({ safeFetch: vi.fn() });
    const fetchOnly = await createTestContext({ db, providers: { research: builtin } });
    await expect(call(searchWeb, fetchOnly, { query: "anything" })).rejects.toMatchObject({
      code: "unsupported",
      hint: expect.stringContaining("parallel"),
    });
    const broke = await createTestContext({
      db,
      providers: { research: searcher },
      overBudget: ["data"],
    });
    await expect(call(searchWeb, broke, { query: "anything" })).rejects.toMatchObject({
      code: "budget_exceeded",
    });
  });

  it("checks the search cost against what the data budget has left", async () => {
    const ctx = await createTestContext({
      db,
      providers: { research: searcher },
      settings: { data: { monthly_credit_budget: 16 } },
    });
    await ctx.usage.record({
      slot: "lead_source",
      provider: "apollo",
      operation: "leads.find_import",
      credits: 14,
    });
    vi.mocked(searcher.search).mockClear();
    const preview = await call(searchWeb, ctx.with({ request: { dryRun: true } }), {
      query: "Lumen Home",
    });
    expect(preview).toMatchObject({
      preview: {
        provider: "fake_search",
        budget: { monthly_credits: 16, used_this_month: 14, left_this_month: 2 },
      },
      estimated_cost: { credits: 3 },
    });
    expect((preview as { warnings: string[] }).warnings).toEqual([
      "Not enough data budget: needs 3 credits, 2 left this month (14 of 16 used), so the real run will be refused. Wait until next month, or ask the human to raise settings.data.monthly_credit_budget (openoutbound workspaces update).",
    ]);
    await expect(call(searchWeb, ctx, { query: "Lumen Home" })).rejects.toMatchObject({
      code: "budget_exceeded",
      message: "Not enough data budget: needs 3 credits, 2 left this month (14 of 16 used).",
      hint: "Wait until next month, or ask the human to raise settings.data.monthly_credit_budget (openoutbound workspaces update).",
    });
    expect(searcher.search).not.toHaveBeenCalled();

    await ctx.db
      .update(workspaces)
      .set({ settings: { data: { monthly_credit_budget: 17 } } })
      .where(eq(workspaces.id, ctx.workspace.id));
    expect(await call(searchWeb, ctx, { query: "Lumen Home" })).toMatchObject({
      provider: "fake_search",
    });
    expect(searcher.search).toHaveBeenCalledTimes(1);
  });
});
