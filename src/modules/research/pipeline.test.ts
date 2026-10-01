import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Signal } from "../../db/schema/index.js";
import { companies, offers, research_briefs } from "../../db/schema/index.js";
import type { ResearchProvider, SearchResult } from "../../providers/types.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedCompany, seedPerson } from "../../testing/factories.js";
import { getActiveSignals, type SignalWithScore } from "../signals/service.js";
import { researchJob } from "./jobs.js";
import type { ResearchJobResult } from "./pipeline.js";
import type { BriefOutput, BriefVars } from "./prompts/brief.js";
import { getLatestBrief, requestResearch } from "./service.js";

vi.mock("../leads/service.js", async () => {
  const { and: sqlAnd, eq: sqlEq } = await import("drizzle-orm");
  const schema = await import("../../db/schema/index.js");
  const { notFound } = await import("../../core/errors.js");
  return {
    getPersonWithCompany: vi.fn(
      async (ctx: { db: TestDb["db"]; workspace: { id: string } }, personId: string) => {
        const [person] = await ctx.db
          .select()
          .from(schema.people)
          .where(
            sqlAnd(
              sqlEq(schema.people.workspace_id, ctx.workspace.id),
              sqlEq(schema.people.id, personId),
            ),
          );
        if (!person) throw notFound("Person", personId);
        const [company] = person.company_id
          ? await ctx.db
              .select()
              .from(schema.companies)
              .where(sqlEq(schema.companies.id, person.company_id))
          : [];
        return { person, company: company ?? null };
      },
    ),
  };
});
vi.mock("../signals/service.js", () => ({ getActiveSignals: vi.fn(async () => []) }));

const SITE = "https://lumenhome.example.com";
const NEWS = "https://news.example.com/lumen-home-series-b";
const TALK = "https://podcast.example.org/dana-reyes";
const SIGNAL_URL = "https://jobs.example.com/lumen-home/demand-planner";

function fakeProvider(): ResearchProvider & { queries: string[] } {
  const queries: string[] = [];
  return {
    id: "fake_search",
    creditsPerCall: { search: 2 },
    queries,
    async search(query): Promise<SearchResult[]> {
      queries.push(query);
      if (query.includes("news")) {
        return [
          {
            url: NEWS,
            title: "Lumen Home raises Series B",
            snippet: "A $20M round.",
            publishedAt: "2026-09-02T00:00:00.000Z",
          },
        ];
      }
      if (query.includes("Dana")) {
        return [{ url: TALK, title: "Dana Reyes on stockouts", snippet: "Podcast episode." }];
      }
      return [];
    },
  };
}

function routeSite(ctx: TestContext) {
  const html = (body: string) => ({ headers: { "content-type": "text/html" }, body });
  ctx.fetch.route(
    `${SITE}/`,
    html(
      '<html><title>Lumen Home</title><body><h1>Lumen Home</h1><p>Lighting for small apartments.</p><a href="/about">About</a><a href="/careers">Careers</a></body></html>',
    ),
  );
  ctx.fetch.route(
    `${SITE}/about`,
    html("<html><body><h1>About</h1><p>Founded 2019.</p></body></html>"),
  );
  ctx.fetch.route(
    `${SITE}/careers`,
    html("<html><body><h1>Careers</h1><p>Demand planner.</p></body></html>"),
  );
}

/** Fake brain answer: one sourced fact, one invented, offer refs good and bad. */
function briefAnswer(vars: BriefVars): BriefOutput {
  const urls = vars.sources.map((source) => source.url);
  const offerId = vars.offers[0]?.id ?? null;
  return {
    who: {
      summary:
        vars.target === "person"
          ? "Dana leads operations at Lumen Home."
          : "Buyers: operations leaders.",
      role: vars.target === "person" ? "VP Operations" : null,
    },
    company: { summary: "Lumen Home sells lighting for small apartments." },
    now: [
      {
        fact: "Raised a Series B.",
        source_url: urls.includes(NEWS) ? NEWS : (urls[0] ?? NEWS),
        date: "2026-09-02",
      },
      {
        fact: "Invented expansion to Mars.",
        source_url: "https://invented.example.net/mars",
        date: "2026-09-10",
      },
    ],
    pains: [
      {
        hypothesis: "Stockouts while scaling.",
        evidence_urls: [NEWS, "https://invented.example.net/x"],
      },
    ],
    angles: [
      {
        angle: "Forecast demand after the raise",
        why: "New money, more SKUs.",
        offer_id: offerId,
        evidence_urls: [NEWS],
      },
      { angle: "Other", why: "x", offer_id: "off_unknown", evidence_urls: [] },
    ],
    recommended_angle: "Forecast demand after the raise",
    confidence: "high",
  };
}

async function runQueuedJob(ctx: TestContext, index = -1): Promise<ResearchJobResult> {
  const jobs = ctx.enqueued("research.run");
  const job = jobs.at(index);
  if (!job) throw new Error("no research job queued");
  const payload = researchJob.payload?.parse(job.payload);
  if (!payload) throw new Error("bad payload");
  const result = (await researchJob.handler(ctx.jobContext(), payload)) as ResearchJobResult;
  job.status = "succeeded";
  return result;
}

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

async function setup() {
  const provider = fakeProvider();
  const ctx = await createTestContext({ db, providers: { research: provider } });
  routeSite(ctx);
  ctx.brain.on("research.brief", (vars: BriefVars) => briefAnswer(vars));
  const company = await seedCompany(ctx, {
    name: "Lumen Home",
    domain: "lumenhome.example.com",
    website: SITE,
  });
  const person = await seedPerson(ctx, {
    company_id: company.id,
    full_name: "Dana Reyes",
    first_name: "Dana",
    last_name: "Reyes",
    title: "VP Operations",
    linkedin_url: "https://www.linkedin.com/in/dana-reyes-example",
  });
  const [offer] = await ctx.db
    .insert(offers)
    .values({
      workspace_id: ctx.workspace.id,
      name: "Forecast Pilot",
      summary: "30 day pilot",
      is_default: true,
    })
    .returning();
  return { ctx, provider, company, person, offerId: offer?.id ?? "" };
}

describe("research.run job", () => {
  it("builds the company brief first, then the person brief, dropping unsourced claims", async () => {
    const { ctx, provider, company, person, offerId } = await setup();
    const signal = {
      id: "sig_01k6a3v0q8x3m2n4p5r6s7t8v9",
      definition_key: "hiring_relevant_roles",
      title: "Hiring a demand planner",
      summary: "Open role",
      evidence_url: SIGNAL_URL,
      evidence_excerpt: "Own our forecast",
      occurred_at: new Date("2026-09-15T00:00:00Z"),
      detected_at: new Date("2026-09-16T00:00:00Z"),
    } as unknown as Signal;
    vi.mocked(getActiveSignals).mockResolvedValueOnce([
      { ...signal, current_score: 50, age_days: 3 } as SignalWithScore,
    ]);

    const requested = await requestResearch(ctx, { personIds: [person.id] });
    expect(requested.cachedBriefIds).toEqual([]);
    expect(requested.jobIds).toHaveLength(1);
    expect(ctx.enqueued("research.run")[0]?.options.singletonKey).toBe(
      `research:${ctx.workspace.id}:co:${company.id}`,
    );

    const result = await runQueuedJob(ctx);
    expect(result.briefs.map((b) => [b.person_id, b.status, b.confidence, b.dropped])).toEqual([
      [null, "ready", "high", 2],
      [person.id, "ready", "high", 2],
    ]);
    expect(ctx.recorded.brain).toHaveLength(2);
    const companyVars = ctx.recorded.brain[0]?.vars as BriefVars;
    expect(companyVars.target).toBe("company");
    expect(companyVars.sources.map((s) => s.url)).toEqual(
      expect.arrayContaining([`${SITE}/`, `${SITE}/about`, `${SITE}/careers`, NEWS, SIGNAL_URL]),
    );
    expect(ctx.recorded.brain[0]?.user).toContain(`<untrusted_content source="${NEWS}">`);
    const personVars = ctx.recorded.brain[1]?.vars as BriefVars;
    expect(personVars.target).toBe("person");
    expect(personVars.companyBrief).toContain("Raised a Series B.");
    expect(personVars.sources.map((s) => s.url)).toEqual(
      expect.arrayContaining([TALK, NEWS, "https://www.linkedin.com/in/dana-reyes-example"]),
    );
    expect(provider.queries).toEqual([
      '"Lumen Home" news',
      '"Lumen Home" hiring jobs',
      '"Dana Reyes" "Lumen Home"',
    ]);
    expect(ctx.recorded.usage.filter((u) => u.slot === "research").map((u) => u.credits)).toEqual([
      2, 2, 2,
    ]);

    const personBrief = await getLatestBrief(ctx, { personId: person.id });
    expect(personBrief?.brief?.now).toEqual([
      { fact: "Raised a Series B.", source_url: NEWS, date: "2026-09-02" },
    ]);
    expect(personBrief?.brief?.angles.map((a) => a.offer_id)).toEqual([offerId, null]);
    expect(personBrief?.brief?.pains[0]?.evidence_urls).toEqual([NEWS]);
    expect(personBrief?.summary).toBe(
      "Dana leads operations at Lumen Home. (2 unsourced claims dropped)",
    );
    expect(personBrief?.sources.length).toBeGreaterThan(3);
    expect(personBrief?.provider).toBe("fake");

    const events = ctx.emitted("research.completed");
    expect(events.map((e) => [e.data.person_id, e.data.status])).toEqual([
      [null, "ready"],
      [person.id, "ready"],
    ]);
    expect(events[1]?.data).toMatchObject({ confidence: "high" });
    const [updatedCompany] = await ctx.db
      .select()
      .from(companies)
      .where(eq(companies.id, company.id));
    expect(updatedCompany?.last_researched_at).toEqual(ctx.clock.now());
    expect(ctx.recorded.fetch.every((request) => request.init?.respectRobots === true)).toBe(true);
  });

  it("reuses a fresh company brief for the next person and serves cached briefs", async () => {
    const { ctx, company, person } = await setup();
    await requestResearch(ctx, { personIds: [person.id] });
    await runQueuedJob(ctx);
    const colleague = await seedPerson(ctx, { company_id: company.id, full_name: "Omar Haddad" });

    await requestResearch(ctx, { personIds: [colleague.id] });
    const second = await runQueuedJob(ctx);
    expect(second.briefs.map((b) => b.person_id)).toEqual([colleague.id]);
    expect(ctx.recorded.brain).toHaveLength(3);
    const companyRows = await ctx.db
      .select()
      .from(research_briefs)
      .where(
        and(
          eq(research_briefs.company_id, company.id),
          eq(research_briefs.workspace_id, ctx.workspace.id),
        ),
      );
    expect(companyRows.filter((row) => row.person_id === null)).toHaveLength(1);

    const cached = await requestResearch(ctx, { personIds: [person.id, colleague.id] });
    expect(cached.jobIds).toEqual([]);
    expect(cached.cachedBriefIds).toHaveLength(2);

    // A third person without a brief falls back to the company brief.
    const third = await seedPerson(ctx, { company_id: company.id });
    expect((await getLatestBrief(ctx, { personId: third.id }))?.person_id).toBeNull();

    ctx.clock.advanceBy({ days: 31 });
    const stale = await requestResearch(ctx, { personIds: [person.id] });
    expect(stale.jobIds).toHaveLength(1);
    const forced = await requestResearch(ctx, { companyIds: [company.id], force: true });
    expect(forced.jobIds).toEqual(stale.jobIds);
  });

  it("still writes a brief without a research provider, from the company site", async () => {
    const ctx = await createTestContext({ db });
    routeSite(ctx);
    ctx.brain.on("research.brief", (vars: BriefVars) => briefAnswer(vars));
    const company = await seedCompany(ctx, {
      name: "Lumen Home",
      domain: "lumenhome.example.com",
      website: SITE,
    });
    await requestResearch(ctx, { companyIds: [company.id] });
    const result = await runQueuedJob(ctx);
    expect(result.briefs).toHaveLength(1);
    expect(result.briefs[0]?.status).toBe("ready");
    expect(result.warnings.join(" ")).toContain("No research provider configured");
    const brief = await getLatestBrief(ctx, { companyId: company.id });
    // The Series B URL was never gathered here, so the fact cites the home page instead.
    expect(brief?.brief?.now[0]?.source_url).toBe(`${SITE}/`);
  });

  it("never touches the network in sandbox workspaces (site comes from the provider)", async () => {
    const provider = {
      ...fakeProvider(),
      fetch: vi.fn(async (url: string) => ({
        url,
        title: "Lumen Home",
        text: "Sandbox home page.",
      })),
    };
    const ctx = await createTestContext({ db, sandbox: true, providers: { research: provider } });
    ctx.brain.on("research.brief", (vars: BriefVars) => briefAnswer(vars));
    const company = await seedCompany(ctx, {
      name: "Lumen Home",
      domain: "lumenhome.example.com",
      website: SITE,
    });
    await requestResearch(ctx, { companyIds: [company.id] });
    await runQueuedJob(ctx);
    expect(ctx.recorded.fetch).toHaveLength(0);
    expect(provider.fetch).toHaveBeenCalledWith(SITE);
    const vars = ctx.recorded.brain[0]?.vars as BriefVars;
    expect(vars.sources.map((source) => source.url)).toEqual(expect.arrayContaining([SITE, NEWS]));
  });

  it("runs a web search only when the data budget has room for it, and says what it skipped", async () => {
    const provider = fakeProvider();
    const ctx = await createTestContext({
      db,
      providers: { research: provider },
      settings: { data: { monthly_credit_budget: 5 } },
    });
    routeSite(ctx);
    ctx.brain.on("research.brief", (vars: BriefVars) => briefAnswer(vars));
    const company = await seedCompany(ctx, {
      name: "Lumen Home",
      domain: "lumenhome.example.com",
      website: SITE,
    });
    const person = await seedPerson(ctx, {
      company_id: company.id,
      full_name: "Dana Reyes",
      first_name: "Dana",
      last_name: "Reyes",
    });
    await requestResearch(ctx, { personIds: [person.id] });
    const result = await runQueuedJob(ctx);

    // Each search costs 2 credits: the company's two fit in 5, the person's third would not.
    expect(provider.queries).toEqual(['"Lumen Home" news', '"Lumen Home" hiring jobs']);
    expect(ctx.recorded.usage.filter((u) => u.slot === "research").map((u) => u.credits)).toEqual([
      2, 2,
    ]);
    expect(result.warnings).toContain(
      "Not enough data budget: needs 2 credits, 1 left this month (4 of 5 used). Skipped web search.",
    );
    expect(result.briefs.map((b) => b.status)).toEqual(["ready", "ready"]);
  });

  it("skips the searches of a brief that no longer fit, keeping the ones that do", async () => {
    const provider = fakeProvider();
    const ctx = await createTestContext({
      db,
      providers: { research: provider },
      settings: { data: { monthly_credit_budget: 3 } },
    });
    routeSite(ctx);
    ctx.brain.on("research.brief", (vars: BriefVars) => briefAnswer(vars));
    const company = await seedCompany(ctx, {
      name: "Lumen Home",
      domain: "lumenhome.example.com",
      website: SITE,
    });
    await requestResearch(ctx, { companyIds: [company.id] });
    const result = await runQueuedJob(ctx);
    expect(provider.queries).toEqual(['"Lumen Home" news']);
    expect(result.warnings).toContain(
      "Not enough data budget: needs 2 credits, 1 left this month (2 of 3 used). Skipped the last web search.",
    );
  });

  it("marks briefs failed when the AI budget is used up, without retrying", async () => {
    const { ctx, person } = await setup();
    await requestResearch(ctx, { personIds: [person.id] });
    ctx.usage.setOverBudget("ai");
    const result = await runQueuedJob(ctx);
    expect(result.stopped).toBe("budget_exceeded");
    expect(result.briefs.every((b) => b.status === "failed")).toBe(true);
    const events = ctx.emitted("research.completed");
    expect(events.every((e) => e.data.status === "failed")).toBe(true);
    const rows = await ctx.db
      .select()
      .from(research_briefs)
      .where(eq(research_briefs.workspace_id, ctx.workspace.id));
    expect(rows.every((row) => row.status === "failed" && row.error?.includes("budget"))).toBe(
      true,
    );
  });

  it("retries on brain errors and fails the brief on the last attempt", async () => {
    const { ctx, company } = await setup();
    ctx.brain.on("research.brief", () => {
      throw new Error("model overloaded");
    });
    await requestResearch(ctx, { companyIds: [company.id] });
    const payload = { company_id: company.id, person_id: null };
    await expect(
      researchJob.handler(ctx.jobContext({ attempt: 1, maxAttempts: 3 }), payload),
    ).rejects.toThrow("model overloaded");
    const [pending] = await ctx.db
      .select()
      .from(research_briefs)
      .where(eq(research_briefs.company_id, company.id));
    expect(pending?.status).toBe("pending");
    const last = (await researchJob.handler(
      ctx.jobContext({ attempt: 3, maxAttempts: 3 }),
      payload,
    )) as ResearchJobResult;
    expect(last.briefs[0]).toMatchObject({ status: "failed" });
    const [failed] = await ctx.db
      .select()
      .from(research_briefs)
      .where(eq(research_briefs.company_id, company.id));
    expect(failed).toMatchObject({
      status: "failed",
      error: "Research failed with an internal error.",
    });
    expect(await getLatestBrief(ctx, { companyId: company.id })).toBeNull();
  });
});
