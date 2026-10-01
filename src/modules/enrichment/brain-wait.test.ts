/**
 * Finding contacts with a brain that makes the job wait: without a brain the job waits before
 * it crawls anything, and with the agent brain (every company's team extraction waits for the
 * agent's answer) each run after an answer continues with the next company instead of starting
 * over, so the addresses of the companies already done are not verified (paid) again.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jobs, usage_records } from "../../db/schema/index.js";
import { createTestEngine, type TestEngine } from "../../testing/engine.js";
import { createFakeFetch, type FakeSafeFetch } from "../../testing/fake-fetch.js";

// biome-ignore lint/suspicious/noExplicitAny: results are checked with expect
type Any = any;

const HOUR = 60 * 60_000;
const SITES = ["alpha-dental.test", "beta-dental.test"];

let engine: TestEngine;
let verifier: FakeSafeFetch;
let workspaceId: string;
const opts = () => ({ workspace: workspaceId });

beforeAll(async () => {
  verifier = createFakeFetch([
    {
      match: /^https:\/\/api\.millionverifier\.com\/api\/v3\/\?/,
      response: (request) => ({
        json: {
          email: new URL(request.url).searchParams.get("email"),
          quality: "good",
          result: "ok",
          resultcode: 1,
          subresult: "ok",
          free: false,
          role: false,
          credits: 4999,
          error: "",
        },
      }),
    },
  ]);
  engine = await createTestEngine({
    config: { env: { MILLIONVERIFIER_API_KEY: "millionverifier-test-key" } },
    providerFetch: verifier as unknown as typeof globalThis.fetch,
  });
  // Websites use the reserved .test TLD: the email extractor drops example.* addresses.
  for (const site of SITES) {
    const owner = site.startsWith("alpha") ? "dana" : "marco";
    engine.fetch.route(`https://${site}/`, {
      body: `<html><head><title>${site}</title></head><body><a href="/team">Team</a></body></html>`,
    });
    engine.fetch.route(`https://${site}/team`, {
      body: `<html><body><main><h2>${owner} Rivers</h2><p>Owner, ${owner}@${site}</p></main></body></html>`,
    });
    engine.fetch.route(new RegExp(`^https://${site.replace(".", "\\.")}/(?!team$).+`), {
      status: 404,
      body: "",
    });
  }
  const created = (await engine.call("workspaces.create", { name: "Dental Outbound" })) as Any;
  workspaceId = created.id;
});
afterAll(async () => {
  await engine.close();
});

const verifications = () => verifier.calls.length;
const crawled = () => engine.fetch.calls.filter((call) => call.url.includes("-dental.test")).length;

async function verifierUsage() {
  return engine.db
    .select()
    .from(usage_records)
    .where(
      and(eq(usage_records.workspace_id, workspaceId), eq(usage_records.slot, "email_verifier")),
    );
}

async function findJobs() {
  return engine.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.workspace_id, workspaceId), eq(jobs.name, "enrichment.find_contacts")));
}

async function answerTeamTask(owner: string, site: string) {
  const tasks = (await engine.call("agent_tasks.list", { status: ["open"] }, opts())) as Any;
  const task = tasks.items.find((item: Any) => item.prompt_id === "enrichment.extract_team");
  expect(task).toBeDefined();
  await engine.call(
    "agent_tasks.submit",
    {
      task_id: task.id,
      output: {
        people: [
          {
            full_name: `${owner} Rivers`,
            title: "Owner",
            email: `${owner}@${site}`,
            decision_maker: true,
          },
        ],
      },
    },
    opts(),
  );
}

describe("finding contacts while the brain makes the job wait", () => {
  it("waits for a brain before crawling, and verifies each address once across agent answers", async () => {
    const ids: string[] = [];
    for (const site of SITES) {
      const { company } = (await engine.call(
        "companies.create",
        { name: site, domain: site, website: `https://${site}`, country: "US" },
        opts(),
      )) as Any;
      ids.push(company.id);
    }
    // Two more companies without a website: more than three makes it a background job.
    for (const name of ["Gamma Dental", "Delta Dental"]) {
      const { company } = (await engine.call("companies.create", { name }, opts())) as Any;
      ids.push(company.id);
    }
    expect(
      await engine.call("enrichment.find_contacts", { company_ids: ids }, opts()),
    ).toMatchObject({ status: "queued" });

    // No brain: the job waits before crawling or paying for anything, also at each recheck.
    await engine.runJobs({ schedules: false });
    const waitKey = `brain:configured:${workspaceId}`;
    expect(await findJobs()).toMatchObject([{ status: "waiting", wait_for: waitKey, attempts: 0 }]);
    for (let check = 0; check < 3; check += 1) {
      engine.advance(HOUR + 60_000);
      await engine.runJobs({ schedules: false });
    }
    expect(await findJobs()).toMatchObject([{ status: "waiting", wait_for: waitKey }]);
    expect(crawled()).toBe(0);
    expect(verifications()).toBe(0);

    // The connected agent becomes the brain: each company's team extraction waits for it.
    await engine.call("providers.set", { slot: "brain", provider: "agent" }, opts());
    await engine.runJobs({ schedules: false });
    expect(verifications()).toBe(0);
    await answerTeamTask("dana", "alpha-dental.test");
    await engine.runJobs({ schedules: false });
    expect(verifications()).toBe(1);
    await answerTeamTask("marco", "beta-dental.test");
    await engine.runJobs({ schedules: false });

    // Each address was verified (and paid for) once.
    expect(verifications()).toBe(2);
    expect((await verifierUsage()).map((row) => row.credits)).toEqual([1, 1]);
    const [job] = await findJobs();
    expect(job).toMatchObject({ status: "succeeded" });
    expect(job?.result).toMatchObject({
      companies: 4,
      done: 2,
      skipped: 2,
      people_created: 2,
      credits_used: 2,
    });
  });
});
