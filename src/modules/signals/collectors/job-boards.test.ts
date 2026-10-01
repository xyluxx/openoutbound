import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "../../../testing/context.js";
import { seedCompany } from "../../../testing/factories.js";
import { collectorRun, html } from "../test-helpers.js";
import {
  boardApiUrl,
  createJobBoardsCollector,
  findBoards,
  hiringStrength,
  parseBoardJobs,
} from "./job-boards.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const collector = createJobBoardsCollector();
let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

describe("findBoards", () => {
  it("discovers board tokens from links and embeds", () => {
    const boards = findBoards(`
      <a href="https://boards.greenhouse.io/northwind">Jobs</a>
      <script src="https://boards.greenhouse.io/embed/job_board/js?for=northwind&amp;b=x"></script>
      <iframe src="https://job-boards.eu.greenhouse.io/other-co/jobs/1"></iframe>
      <a href="https://jobs.eu.lever.co/bluefield">Lever</a>
      <a href="https://jobs.ashbyhq.com/Cedar%20Labs">Ashby</a>
      <a href="https://jobs.ashbyhq.com/">root</a>
      <a href="https://example.org/careers">unrelated</a>`);
    expect(boards).toEqual([
      { ats: "greenhouse", token: "northwind" },
      { ats: "greenhouse", token: "other-co" },
      { ats: "lever", token: "bluefield", eu: true },
    ]);
    expect(boardApiUrl({ ats: "lever", token: "bluefield", eu: true })).toBe(
      "https://api.eu.lever.co/v0/postings/bluefield?mode=json",
    );
  });

  it("maps each ATS and ignores malformed or unlisted jobs", () => {
    expect(parseBoardJobs("greenhouse", fixture("greenhouse-jobs.json"))).toHaveLength(3);
    const lever = parseBoardJobs("lever", fixture("lever-postings.json"));
    expect(lever[0]).toMatchObject({
      title: "Salesforce Administrator",
      department: "Sales",
      published_at: new Date(1789900000000).toISOString(),
    });
    expect(parseBoardJobs("ashby", fixture("ashby-board.json")).map((j) => j.id)).toEqual([
      "7458d4e9-da2e-47bd-98cb-adfda43d42b2",
    ]);
    expect(parseBoardJobs("greenhouse", { unexpected: true })).toEqual([]);
    expect(parseBoardJobs("lever", null)).toEqual([]);
  });

  it("grows strength with the number of relevant roles", () => {
    expect([1, 2, 3, 5, 9].map(hiringStrength)).toEqual([0.6, 0.7, 0.8, 1, 1]);
  });
});

describe("job_boards collector", () => {
  it("reports new relevant roles once, then only when new ones appear", async () => {
    const company = await seedCompany(ctx, {
      name: "Northwind Analytics",
      domain: "jb-one.example.com",
      website: "https://jb-one.example.com",
    });
    const base = "https://jb-one.example.com";
    ctx.fetch.route(`${base}/`, { body: html('<a href="/careers">Careers</a>') });
    ctx.fetch.route(`${base}/careers`, {
      body: html(
        '<div id="grnhse_app"></div><script src="https://boards.greenhouse.io/embed/job_board/js?for=northwindanalytics"></script>',
      ),
    });
    const board = fixture("greenhouse-jobs.json") as { jobs: unknown[] };
    ctx.fetch.route("https://boards-api.greenhouse.io/v1/boards/northwindanalytics/jobs", () => ({
      json: board,
    }));
    const keywords = { hiring: ["SDR", "Revenue Operations"] };

    const first = await collector.collect(await collectorRun(ctx, company, { keywords }));
    expect(first.signals).toHaveLength(1);
    expect(first.signals[0]).toMatchObject({
      definition_key: "hiring_relevant_roles",
      title: "Hiring 2 relevant roles: Senior SDR (Remote), Revenue Operations Manager",
      evidence_url: "https://job-boards.greenhouse.io/northwindanalytics/jobs/4012001",
      evidence_excerpt: "Senior SDR (Remote) - Remote, US",
      strength: 0.7,
      source: "job_boards",
    });
    expect(first.evidence.map((e) => e.title)).toContain("Backend Engineer");
    const apiCall = ctx.recorded.fetch.find((call) => call.url.includes("boards-api"));
    expect(apiCall?.init?.respectRobots).toBe(false);

    const second = await collector.collect(await collectorRun(ctx, company, { keywords }));
    expect(second.signals).toEqual([]);

    board.jobs.push({
      id: 4012099,
      title: "SDR Team Lead",
      first_published: "2026-09-18T09:00:00Z",
      location: { name: "Austin, TX" },
      absolute_url: "https://job-boards.greenhouse.io/northwindanalytics/jobs/4012099",
    });
    const third = await collector.collect(await collectorRun(ctx, company, { keywords }));
    expect(third.signals).toHaveLength(1);
    expect(third.signals[0]).toMatchObject({
      evidence_url: "https://job-boards.greenhouse.io/northwindanalytics/jobs/4012099",
      occurred_at: "2026-09-18T09:00:00.000Z",
      strength: 0.8,
    });
  });

  it("flags competitors named in job titles and asks for keywords", async () => {
    const company = await seedCompany(ctx, {
      domain: "jb-two.example.com",
      website: "https://jb-two.example.com",
    });
    ctx.fetch.route("https://jb-two.example.com/", {
      body: html('<a href="https://jobs.lever.co/bluefield-example">Open roles</a>'),
    });
    ctx.fetch.route("https://api.lever.co/v0/postings/bluefield-example?mode=json", {
      json: fixture("lever-postings.json"),
    });
    const out = await collector.collect(
      await collectorRun(ctx, company, { keywords: { competitors: ["Salesforce"] } }),
    );
    expect(out.notes.join(" ")).toMatch(/no role keywords/);
    expect(out.signals).toEqual([
      expect.objectContaining({
        definition_key: "competitor_mention",
        evidence_url:
          "https://jobs.lever.co/bluefield-example/ec557bc9-1cc2-4085-b920-3f123f31a2c2",
      }),
    ]);
  });

  it("notes missing boards and unreadable board APIs without saving state", async () => {
    const company = await seedCompany(ctx, {
      domain: "jb-three.example.com",
      website: "https://jb-three.example.com",
    });
    ctx.fetch.route("https://jb-three.example.com/", { body: html("<p>No jobs here</p>") });
    const none = await collector.collect(await collectorRun(ctx, company));
    expect(none.notes).toEqual(["job_boards: no Greenhouse, Lever or Ashby board found"]);

    ctx.fetch.route("https://jb-three.example.com/", {
      body: html('<a href="https://jobs.ashbyhq.com/cedarlabs">Jobs</a>'),
    });
    ctx.fetch.route("https://api.ashbyhq.com/posting-api/job-board/cedarlabs", {
      body: "<html>maintenance</html>",
    });
    const broken = await collector.collect(
      await collectorRun(ctx, company, { keywords: { hiring: ["sales development"] } }),
    );
    expect(broken.notes.join(" ")).toMatch(/unreadable \(invalid_json\)/);

    ctx.fetch.route("https://api.ashbyhq.com/posting-api/job-board/cedarlabs", {
      json: fixture("ashby-board.json"),
    });
    const fixed = await collector.collect(
      await collectorRun(ctx, company, { keywords: { hiring: ["sales development"] } }),
    );
    expect(fixed.signals.map((s) => s.title)).toEqual([
      "Hiring 1 relevant role: Head of Sales Development",
    ]);
  });
});
