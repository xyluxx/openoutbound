/**
 * Research when a source fails: the brief is `partial` with the failed sources and their
 * failures (never `ready`), nothing is charged for a search the provider did not answer, and a
 * later run asks only the failed searches again, reusing what the partial run kept.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type FailureClass, providerFailure } from "../../core/failures.js";
import { research_briefs } from "../../db/schema/index.js";
import type { ResearchProvider, SearchResult } from "../../providers/types.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedCompany, seedPerson } from "../../testing/factories.js";
import { researchJob } from "./jobs.js";
import { getResearch } from "./operations.js";
import type { ResearchJobResult } from "./pipeline.js";
import type { BriefOutput, BriefVars } from "./prompts/brief.js";
import { getLatestBrief, requestResearch } from "./service.js";

vi.mock("../signals/service.js", () => ({ getActiveSignals: vi.fn(async () => []) }));

const NEWS_QUERY = '"Lumen Home" news';
const HIRING_QUERY = '"Lumen Home" hiring jobs';
const PERSON_QUERY = '"Dana Reyes" "Lumen Home"';
const NEWS = "https://news.example.com/lumen-home-series-b";
const JOBS = "https://jobs.example.com/lumen-home/demand-planner";
const TALK = "https://podcast.example.org/dana-reyes";

type Answer = SearchResult[] | Error;

/** A research provider answering per query from a script (the last answer repeats). */
function scriptedProvider(script: Record<string, Answer[]>) {
  const queries: string[] = [];
  const provider: ResearchProvider = {
    id: "fake_search",
    creditsPerCall: { search: 2 },
    async search(query) {
      queries.push(query);
      const answers = script[query] ?? [[]];
      const asked = queries.filter((q) => q === query).length;
      const answer = answers[Math.min(asked - 1, answers.length - 1)] ?? [];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { provider, queries };
}

const fail = (failureClass: FailureClass, retryAfterSeconds?: number) =>
  providerFailure({
    provider: "fake_search",
    class: failureClass,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });

const news: SearchResult[] = [
  { url: NEWS, title: "Lumen Home raises Series B", snippet: "A $20M round." },
];
const jobs: SearchResult[] = [{ url: JOBS, title: "Demand planner", snippet: "Open role." }];
const talk: SearchResult[] = [{ url: TALK, title: "Dana on stockouts", snippet: "Podcast." }];

function briefAnswer(vars: BriefVars): BriefOutput {
  const url = vars.sources[0]?.url ?? NEWS;
  return {
    who: { summary: "Operations leaders.", role: null },
    company: { summary: "Lumen Home sells lighting." },
    now: [{ fact: "Something happened.", source_url: url, date: "2026-09-02" }],
    pains: [],
    angles: [],
    recommended_angle: null,
    confidence: "medium",
  };
}

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

async function setup(script: Record<string, Answer[]>) {
  const { provider, queries } = scriptedProvider(script);
  // No website: the brief comes from search and the lead record only.
  const ctx = await createTestContext({ db, providers: { research: provider } });
  ctx.brain.on("research.brief", (vars: BriefVars) => briefAnswer(vars));
  const company = await seedCompany(ctx, { name: "Lumen Home", domain: null, website: null });
  return { ctx, queries, company };
}

async function runLatestJob(ctx: TestContext): Promise<ResearchJobResult> {
  const job = ctx.enqueued("research.run").at(-1);
  if (!job) throw new Error("no research job queued");
  const payload = researchJob.payload?.parse(job.payload);
  if (!payload) throw new Error("bad payload");
  const result = (await researchJob.handler(ctx.jobContext(), payload)) as ResearchJobResult;
  job.status = "succeeded";
  return result;
}

const searchCredits = (ctx: TestContext) =>
  ctx.recorded.usage.filter((u) => u.slot === "research").map((u) => u.credits);

describe("a search that fails", () => {
  it("makes the brief partial with the failed search listed, and charges only what answered", async () => {
    const { ctx, queries, company } = await setup({
      [NEWS_QUERY]: [fail("timeout")],
      [HIRING_QUERY]: [jobs],
    });
    await requestResearch(ctx, { companyIds: [company.id] });
    const result = await runLatestJob(ctx);

    expect(queries).toEqual([NEWS_QUERY, HIRING_QUERY]);
    expect(searchCredits(ctx)).toEqual([2]);
    expect(result.briefs).toMatchObject([
      {
        status: "partial",
        gaps: [
          {
            source: "search",
            target: NEWS_QUERY,
            failure: { class: "timeout", retryable: true, provider: "fake_search" },
          },
        ],
      },
    ]);
    const [row] = await ctx.db
      .select()
      .from(research_briefs)
      .where(eq(research_briefs.company_id, company.id));
    expect(row?.status).toBe("partial");
    expect(row?.gaps).toMatchObject({
      failed: [{ source: "search", target: NEWS_QUERY, failure: { class: "timeout" } }],
      kept: [{ query: HIRING_QUERY, results: [{ url: JOBS, title: "Demand planner" }] }],
    });
    expect(ctx.emitted("research.completed").map((event) => event.data.status)).toEqual([
      "partial",
    ]);

    // Usable now, and the agent sees what is missing.
    expect((await getLatestBrief(ctx, { companyId: company.id }))?.id).toBe(row?.id);
    const view = await getResearch.handler(ctx, { company_id: company.id });
    expect(view).toMatchObject({
      status: "partial",
      fresh: true,
      gaps: [{ source: "search", target: NEWS_QUERY, failure: { class: "timeout" } }],
    });
  });

  it("is asked again on the next run, which reuses what the partial run kept", async () => {
    const { ctx, queries, company } = await setup({
      [NEWS_QUERY]: [fail("network"), news],
      [HIRING_QUERY]: [jobs, new Error("must not be asked again")],
    });
    await requestResearch(ctx, { companyIds: [company.id] });
    await runLatestJob(ctx);

    // A partial brief is not served as cached.
    const again = await requestResearch(ctx, { companyIds: [company.id] });
    expect(again.cachedBriefIds).toEqual([]);
    expect(again.jobIds).toHaveLength(1);
    const result = await runLatestJob(ctx);

    expect(queries).toEqual([NEWS_QUERY, HIRING_QUERY, NEWS_QUERY]);
    expect(searchCredits(ctx)).toEqual([2, 2]);
    expect(result.briefs).toMatchObject([{ status: "ready", gaps: [] }]);
    const vars = ctx.recorded.brain.at(-1)?.vars as BriefVars;
    expect(vars.sources.map((source) => source.url)).toEqual(expect.arrayContaining([NEWS, JOBS]));
    const latest = await getLatestBrief(ctx, { companyId: company.id });
    expect(latest).toMatchObject({ status: "ready", gaps: null });
  });

  it("stops asking after a failure of the account, and charges nothing", async () => {
    const { ctx, queries, company } = await setup({ [NEWS_QUERY]: [fail("auth_invalid")] });
    await requestResearch(ctx, { companyIds: [company.id] });
    const result = await runLatestJob(ctx);

    expect(queries).toEqual([NEWS_QUERY]);
    expect(searchCredits(ctx)).toEqual([]);
    expect(result.briefs[0]?.status).toBe("partial");
    expect(result.briefs[0]?.gaps.map((gap) => [gap.target, gap.failure.class])).toEqual([
      [NEWS_QUERY, "auth_invalid"],
      [HIRING_QUERY, "auth_invalid"],
    ]);
  });

  it("charges a search the provider answered in a shape it could not read", async () => {
    const { ctx, company } = await setup({
      [NEWS_QUERY]: [fail("malformed")],
      [HIRING_QUERY]: [jobs],
    });
    await requestResearch(ctx, { companyIds: [company.id] });
    const result = await runLatestJob(ctx);
    expect(searchCredits(ctx)).toEqual([2, 2]);
    expect(result.briefs[0]?.gaps[0]?.failure).toMatchObject({
      class: "malformed",
      retryable: false,
    });
  });
});

describe("a brain call that fails", () => {
  it("is retried with the searches the first attempt paid for, not new ones", async () => {
    const asked = new Error("must not be asked again");
    const { ctx, queries, company } = await setup({
      [NEWS_QUERY]: [news, asked],
      [HIRING_QUERY]: [jobs, asked],
    });
    let briefCalls = 0;
    ctx.brain.on("research.brief", (vars: BriefVars) => {
      briefCalls += 1;
      if (briefCalls === 1) throw providerFailure({ provider: "anthropic", class: "unavailable" });
      return briefAnswer(vars);
    });
    await requestResearch(ctx, { companyIds: [company.id] });
    const job = ctx.enqueued("research.run").at(-1);
    const payload = researchJob.payload?.parse(job?.payload);
    if (!payload) throw new Error("no research job queued");

    await expect(
      researchJob.handler(ctx.jobContext({ attempt: 1, maxAttempts: 3 }), payload),
    ).rejects.toMatchObject({ code: "provider_error" });
    const [pending] = await ctx.db
      .select()
      .from(research_briefs)
      .where(eq(research_briefs.company_id, company.id));
    expect(pending).toMatchObject({ status: "pending", gaps: { failed: [] } });
    expect(pending?.gaps?.kept.map((kept) => kept.query)).toEqual([NEWS_QUERY, HIRING_QUERY]);
    // The pending row shows no gaps while the brief is not written.
    expect(await getResearch.handler(ctx, { brief_id: pending?.id })).toMatchObject({
      status: "pending",
      gaps: [],
    });

    const retry = (await researchJob.handler(
      ctx.jobContext({ attempt: 2, maxAttempts: 3 }),
      payload,
    )) as ResearchJobResult;
    expect(queries).toEqual([NEWS_QUERY, HIRING_QUERY]);
    expect(searchCredits(ctx)).toEqual([2, 2]);
    expect(retry.briefs).toMatchObject([{ status: "ready", gaps: [] }]);
    const vars = ctx.recorded.brain.at(-1)?.vars as BriefVars;
    expect(vars.sources.map((source) => source.url)).toEqual(expect.arrayContaining([NEWS, JOBS]));
    expect(await getLatestBrief(ctx, { companyId: company.id })).toMatchObject({
      status: "ready",
      gaps: null,
    });
  });
});

describe("an AI budget that is used up", () => {
  it("fails the briefs before any search is paid for", async () => {
    const { provider, queries } = scriptedProvider({
      [NEWS_QUERY]: [news],
      [HIRING_QUERY]: [jobs],
    });
    const ctx = await createTestContext({
      db,
      providers: { research: provider },
      overBudget: ["ai"],
    });
    const company = await seedCompany(ctx, { name: "Lumen Home", domain: null, website: null });
    await requestResearch(ctx, { companyIds: [company.id] });
    const result = await runLatestJob(ctx);
    expect(result).toMatchObject({ stopped: "budget_exceeded", briefs: [{ status: "failed" }] });
    expect(queries).toEqual([]);
    expect(searchCredits(ctx)).toEqual([]);
  });
});

describe("person briefs", () => {
  it("are partial when the company brief they build on is, and the next run fills the company first", async () => {
    const { ctx, queries, company } = await setup({
      [NEWS_QUERY]: [fail("unavailable"), news],
      [HIRING_QUERY]: [jobs],
      [PERSON_QUERY]: [talk],
    });
    const person = await seedPerson(ctx, {
      company_id: company.id,
      full_name: "Dana Reyes",
      first_name: "Dana",
      last_name: "Reyes",
    });
    await requestResearch(ctx, { personIds: [person.id] });
    const first = await runLatestJob(ctx);
    const companyBrief = first.briefs.find((brief) => brief.person_id === null);
    expect(first.briefs.map((brief) => [brief.person_id, brief.status])).toEqual([
      [null, "partial"],
      [person.id, "partial"],
    ]);
    // The provider is down: the other searches of the job are not attempted.
    expect(queries).toEqual([NEWS_QUERY]);
    expect(first.briefs[1]?.gaps).toMatchObject([
      { source: "search", target: PERSON_QUERY, failure: { class: "unavailable" } },
      { target: NEWS_QUERY, company_brief_id: companyBrief?.brief_id },
      { target: HIRING_QUERY, company_brief_id: companyBrief?.brief_id },
    ]);
    expect(first.briefs[1]?.gaps[0]).not.toHaveProperty("company_brief_id");

    await requestResearch(ctx, { personIds: [person.id] });
    const second = await runLatestJob(ctx);
    expect(second.briefs.map((brief) => [brief.person_id, brief.status])).toEqual([
      [null, "ready"],
      [person.id, "ready"],
    ]);
    expect(queries).toEqual([NEWS_QUERY, NEWS_QUERY, HIRING_QUERY, PERSON_QUERY]);
  });
});
