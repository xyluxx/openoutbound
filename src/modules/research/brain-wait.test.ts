/**
 * Research in a workspace without a brain: the job waits for one before it pays for any search,
 * so the hourly rechecks pay nothing. The searches a run paid for stay on the pending brief, so
 * the run after a brain wait (here the connected agent answering the brief task) reuses them
 * instead of paying again.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jobs, research_briefs, usage_records } from "../../db/schema/index.js";
import { createTestEngine, type TestEngine } from "../../testing/engine.js";
import { createFakeFetch, type FakeSafeFetch } from "../../testing/fake-fetch.js";
import type { BriefOutput } from "./prompts/brief.js";

// biome-ignore lint/suspicious/noExplicitAny: results are checked with expect
type Any = any;

const TAVILY = "https://api.tavily.com/search";
const NEWS = "https://news.example.com/lumen-home-series-b";
const HOUR = 60 * 60_000;

let engine: TestEngine;
let tavily: FakeSafeFetch;
let workspaceId: string;
const opts = () => ({ workspace: workspaceId });

beforeAll(async () => {
  tavily = createFakeFetch([
    {
      match: TAVILY,
      method: "POST",
      response: {
        json: {
          query: "q",
          results: [
            {
              title: "Lumen Home raises a Series B",
              url: NEWS,
              content: "Lumen Home raised $20M to expand its warehouses.",
              score: 0.8,
              published_date: "Tue, 08 Sep 2026 17:00:00 GMT",
            },
          ],
        },
      },
    },
  ]);
  engine = await createTestEngine({
    config: { env: { TAVILY_API_KEY: "tavily-test-key" } },
    providerFetch: tavily as unknown as typeof globalThis.fetch,
  });
  const created = (await engine.call("workspaces.create", { name: "Lumen Outbound" })) as Any;
  workspaceId = created.id;
});
afterAll(async () => {
  await engine.close();
});

const searches = () => tavily.calls.filter((call) => call.url === TAVILY).length;

async function researchUsage() {
  return engine.db
    .select()
    .from(usage_records)
    .where(and(eq(usage_records.workspace_id, workspaceId), eq(usage_records.slot, "research")));
}

async function researchJobs() {
  return engine.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.workspace_id, workspaceId), eq(jobs.name, "research.run")));
}

const brief: BriefOutput = {
  who: { summary: "Not a person brief.", role: null },
  company: { summary: "Lumen Home sells home lighting online." },
  now: [{ fact: "Lumen Home raised a $20M Series B.", source_url: NEWS, date: "2026-09-08" }],
  pains: [],
  angles: [],
  recommended_angle: null,
  confidence: "medium",
};

describe("research without a brain", () => {
  it("waits before paying for searches, and reuses the paid searches once a brain answers", async () => {
    const { company } = (await engine.call(
      "companies.create",
      { name: "Lumen Home" },
      opts(),
    )) as Any;
    await engine.call("research.run", { company_ids: [company.id] }, opts());

    await engine.runJobs({ schedules: false });
    const waitKey = `brain:configured:${workspaceId}`;
    expect(await researchJobs()).toMatchObject([
      { status: "waiting", wait_for: waitKey, attempts: 0 },
    ]);
    expect(searches()).toBe(0);
    expect(await researchUsage()).toHaveLength(0);

    // The hourly rechecks find no brain either and pay for nothing.
    for (let check = 0; check < 3; check += 1) {
      engine.advance(HOUR + 60_000);
      await engine.runJobs({ schedules: false });
      expect(await researchJobs()).toMatchObject([{ status: "waiting", wait_for: waitKey }]);
    }
    expect(searches()).toBe(0);
    expect(await researchUsage()).toHaveLength(0);

    // The connected agent becomes the brain: the job searches once and waits for its answer.
    await engine.call("providers.set", { slot: "brain", provider: "agent" }, opts());
    await engine.runJobs({ schedules: false });
    expect(searches()).toBe(2);
    expect(await researchUsage()).toHaveLength(2);
    const tasks = (await engine.call("agent_tasks.list", {}, opts())) as Any;
    expect(tasks.items.map((task: Any) => task.prompt_id)).toEqual(["research.brief"]);

    // The answer wakes the job: it writes the brief from the searches it already paid for.
    await engine.call("agent_tasks.submit", { task_id: tasks.items[0].id, output: brief }, opts());
    await engine.runJobs({ schedules: false });
    expect(searches()).toBe(2);
    expect(await researchUsage()).toHaveLength(2);
    const rows = await engine.db
      .select()
      .from(research_briefs)
      .where(eq(research_briefs.company_id, company.id));
    expect(rows).toMatchObject([{ status: "ready", gaps: null }]);
    expect(rows[0]?.brief?.now).toMatchObject([{ source_url: NEWS }]);
    expect((await researchJobs()).map((job) => job.status)).toEqual(["succeeded"]);
  });
});
