/**
 * Signal providers that fail during a monitor run: the call is not charged unless the provider
 * answered, a check that failed part way keeps and charges what came back, the failure is stored
 * on the run, the provider is not asked again in that run after a failure of its account, and
 * last_run_at (the window the next run looks at) only moves when no failure a later run could
 * fix is left (a paid call that timed out is one).
 */
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type FailureClass, providerFailure } from "../../../core/failures.js";
import { type Monitor, monitors, type NewMonitor } from "../../../db/schema/index.js";
import { createCrustdata } from "../../../providers/signals/crustdata.js";
import { createPredictLeads } from "../../../providers/signals/predictleads.js";
import type { SignalProvider } from "../../../providers/types.js";
import { createTestContext, type TestContext } from "../../../testing/context.js";
import { seedCompany } from "../../../testing/factories.js";
import { createFakeFetch, type FakeSafeFetch } from "../../../testing/fake-fetch.js";
import { ensureCatalog } from "../catalog.js";
import type { CollectorSet } from "../collectors/index.js";
import { type Collector, emptyOutput } from "../collectors/types.js";
import { monitorView } from "../shapes.js";
import { runMonitor } from "./runner.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
  await ensureCatalog(ctx.db, ctx.workspace.id);
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(() => {
  ctx.recorded.usage.length = 0;
  ctx.providers.set("signals", null);
});

const stub = (name: Collector["name"]): Collector => ({ name, collect: async () => emptyOutput() });
const collectors: CollectorSet = {
  website_changes: stub("website_changes"),
  job_boards: stub("job_boards"),
  news_gdelt: stub("news_gdelt"),
  rss: stub("rss"),
  tech_detect: stub("tech_detect"),
  first_party: stub("first_party"),
};

const fail = (failureClass: FailureClass, retryAfterSeconds?: number) =>
  providerFailure({
    provider: "fake_paid",
    class: failureClass,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });

/** A paid provider that answers per company name: an error to throw, or a funding signal. */
function provider(answers: Record<string, Error | "ok">) {
  const calls: Array<{ company: string; since: Date | undefined }> = [];
  const instance: SignalProvider = {
    id: "fake_paid",
    supportedSignals: ["funding_round"],
    creditsPerCall: 2,
    async collect(target, options) {
      calls.push({ company: target.company.name, since: options?.since });
      const answer = answers[target.company.name] ?? "ok";
      if (answer instanceof Error) throw answer;
      return [
        {
          definition_key: "funding_round",
          title: `${target.company.name} raised a round`,
          evidence_url: `https://funding.example.org/${target.company.id}`,
          source: "fake_paid",
        },
      ];
    },
  };
  return { instance, calls };
}

const LAST_RUN = new Date("2026-09-10T06:00:00Z");
let counter = 0;

async function setup(answers: Record<string, Error | "ok">, values: Partial<NewMonitor> = {}) {
  counter += 1;
  const first = await seedCompany(ctx, { name: `Alpha ${counter}`, fit_score: 90 });
  const second = await seedCompany(ctx, { name: `Beta ${counter}`, fit_score: 89 });
  const paid = provider(
    Object.fromEntries(
      Object.entries(answers).map(([key, answer]) => [`${key} ${counter}`, answer]),
    ),
  );
  ctx.providers.set("signals", paid.instance);
  const [monitor] = await ctx.db
    .insert(monitors)
    .values({
      workspace_id: ctx.workspace.id,
      name: `Monitor ${counter}`,
      target: { kind: "companies", company_ids: [first.id, second.id] },
      collectors: ["fake_paid"],
      signal_keys: ["funding_round"],
      schedule: "0 6 * * *",
      last_run_at: LAST_RUN,
      ...values,
    })
    .returning();
  if (!monitor) throw new Error("insert failed");
  return { monitor, paid };
}

async function stored(monitor: Monitor): Promise<Monitor> {
  const [row] = await ctx.db.select().from(monitors).where(eq(monitors.id, monitor.id));
  if (!row) throw new Error("monitor gone");
  return row;
}

const charged = () => ctx.recorded.usage.map((usage) => usage.credits);

describe("a signal provider that fails", () => {
  it("is not charged after a failure of its account, is not asked again, and keeps the window", async () => {
    for (const [failureClass, retryable] of [
      ["auth_invalid", false],
      ["forbidden", false],
      ["quota_exhausted", false],
      ["rate_limited", true],
    ] as const) {
      ctx.recorded.usage.length = 0;
      const { monitor, paid } = await setup({ Alpha: fail(failureClass, 60) });
      const summary = await runMonitor(ctx, monitor, { collectors });

      expect(paid.calls).toHaveLength(1);
      expect(charged()).toEqual([]);
      expect(summary).toMatchObject({
        status: "failed",
        credits_used: 0,
        signals_new: 0,
        window_moved: false,
        since: LAST_RUN.toISOString(),
        stopped: ["provider_failed"],
        failures: [
          {
            provider: "fake_paid",
            failure: { class: failureClass, retryable, scope: "account" },
            companies: 2,
          },
        ],
      });
      const row = await stored(monitor);
      expect(row.last_run_at).toEqual(LAST_RUN);
      expect(row.last_result).toMatchObject({ status: "failed", failures: [{ companies: 2 }] });
    }
  });

  it("asks the other companies after a timeout, charges only the answers, and looks at the same window next time", async () => {
    const { monitor, paid } = await setup({ Alpha: fail("timeout"), Beta: "ok" });
    const summary = await runMonitor(ctx, monitor, { collectors });
    expect(paid.calls.map((call) => call.company)).toEqual([`Alpha ${counter}`, `Beta ${counter}`]);
    expect(charged()).toEqual([2]);
    expect(summary).toMatchObject({
      status: "partial",
      credits_used: 2,
      signals_new: 1,
      window_moved: false,
      stopped: [],
      failures: [{ provider: "fake_paid", failure: { class: "timeout" }, companies: 1 }],
    });
    expect((await stored(monitor)).last_run_at).toEqual(LAST_RUN);

    // The next run asks from the same point; a clean run moves the window and clears the failure.
    paid.instance.collect = async (_target, options) => {
      paid.calls.push({ company: "any", since: options?.since });
      return [];
    };
    ctx.clock.advance(60_000);
    const next = await runMonitor(ctx, await stored(monitor), { collectors });
    expect(paid.calls.at(-1)?.since).toEqual(LAST_RUN);
    expect(next).toMatchObject({ status: "ok", failures: [], window_moved: true });
    const row = await stored(monitor);
    expect(row.last_run_at).toEqual(new Date(next.started_at));
    expect(monitorView(row, "concise").last_result).toMatchObject({ status: "ok", failures: [] });
  });

  it("charges an answer it could not read, and moves on since asking again would not help", async () => {
    const { monitor } = await setup({ Alpha: fail("malformed"), Beta: "ok" });
    const summary = await runMonitor(ctx, monitor, { collectors });
    expect(charged()).toEqual([2, 2]);
    expect(summary).toMatchObject({
      status: "partial",
      window_moved: true,
      failures: [{ failure: { class: "malformed", retryable: false }, companies: 1 }],
    });
    expect((await stored(monitor)).last_run_at).toEqual(new Date(summary.started_at));
  });

  it("does not move the window of a run that was stopped", async () => {
    const { monitor } = await setup({});
    const controller = new AbortController();
    controller.abort();
    const summary = await runMonitor(ctx, monitor, { collectors, signal: controller.signal });
    expect(summary).toMatchObject({ stopped: ["aborted"], window_moved: false });
    expect((await stored(monitor)).last_run_at).toEqual(LAST_RUN);
  });
});

describe("real paid providers whose answer was lost or came part way", () => {
  const timedOut = () => {
    throw Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    });
  };
  const financing = JSON.parse(
    readFileSync(
      new URL(
        "../../../providers/signals/fixtures/predictleads-financing-events.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as unknown;

  async function monitorFor(instance: SignalProvider, keys: string[]) {
    counter += 1;
    const company = await seedCompany(ctx, {
      name: `Northwind ${counter}`,
      domain: `northwind-paid-${counter}.example.org`,
      fit_score: 90,
    });
    ctx.providers.set("signals", instance);
    const [monitor] = await ctx.db
      .insert(monitors)
      .values({
        workspace_id: ctx.workspace.id,
        name: `Paid monitor ${counter}`,
        target: { kind: "companies", company_ids: [company.id] },
        collectors: [instance.id],
        signal_keys: keys,
        schedule: "0 6 * * *",
        last_run_at: LAST_RUN,
      })
      .returning();
    if (!monitor) throw new Error("insert failed");
    return monitor;
  }

  const fetchOf = (fake: FakeSafeFetch) => fake as unknown as typeof globalThis.fetch;

  it("keeps the window after a paid call that timed out, which may have been charged", async () => {
    const crustdata = createCrustdata({
      apiKey: "crustdata-test-key",
      fetch: fetchOf(createFakeFetch([{ match: /crustdata/, response: timedOut }])),
      now: () => ctx.clock.now(),
    });
    const predictleads = createPredictLeads({
      apiKey: "predictleads-test-key",
      apiToken: "predictleads-test-token",
      fetch: fetchOf(createFakeFetch([{ match: /predictleads/, response: timedOut }])),
      now: () => ctx.clock.now(),
    });
    for (const instance of [crustdata, predictleads]) {
      const monitor = await monitorFor(instance, ["funding_round"]);
      const summary = await runMonitor(ctx, monitor, { collectors });
      expect(summary).toMatchObject({
        status: "failed",
        window_moved: false,
        since: LAST_RUN.toISOString(),
        failures: [
          {
            provider: instance.id,
            failure: { class: "timeout", retryable: false, scope: "call" },
          },
        ],
      });
      expect((await stored(monitor)).last_run_at).toEqual(LAST_RUN);
    }
  });

  it("moves the window after an answer it could not read", async () => {
    const crustdata = createCrustdata({
      apiKey: "crustdata-test-key",
      fetch: fetchOf(
        createFakeFetch([{ match: /crustdata/, response: { json: { not: "a list" } } }]),
      ),
      now: () => ctx.clock.now(),
    });
    const monitor = await monitorFor(crustdata, ["funding_round"]);
    const summary = await runMonitor(ctx, monitor, { collectors });
    expect(summary).toMatchObject({
      window_moved: true,
      credits_used: 1,
      failures: [{ provider: "crustdata", failure: { class: "malformed" } }],
    });
    expect((await stored(monitor)).last_run_at).toEqual(new Date(summary.started_at));
  });

  it("keeps and charges what a provider answered before it failed, and holds the window", async () => {
    let newsFails = true;
    const fake = createFakeFetch([
      { match: /\/financing_events/, response: { json: financing } },
      {
        match: /\/news_events/,
        response: () =>
          newsFails ? { status: 503, body: "Service Unavailable" } : { json: { data: [] } },
      },
    ]);
    const predictleads = createPredictLeads({
      apiKey: "predictleads-test-key",
      apiToken: "predictleads-test-token",
      fetch: fetchOf(fake),
      now: () => ctx.clock.now(),
    });
    const monitor = await monitorFor(predictleads, ["funding_round"]);
    const summary = await runMonitor(ctx, monitor, { collectors });
    expect(summary).toMatchObject({
      status: "partial",
      signals_new: 1,
      by_key: { funding_round: 1 },
      credits_used: 1,
      month_credits: 1,
      window_moved: false,
      failures: [
        {
          provider: "predictleads",
          failure: { class: "unavailable", retryable: false },
          companies: 1,
        },
      ],
    });
    expect(charged()).toEqual([1]);
    expect((await stored(monitor)).last_run_at).toEqual(LAST_RUN);

    // The next run looks at the same window and stores no duplicate.
    newsFails = false;
    ctx.recorded.usage.length = 0;
    ctx.clock.advance(60_000);
    const next = await runMonitor(ctx, await stored(monitor), { collectors });
    expect(next).toMatchObject({
      status: "ok",
      since: LAST_RUN.toISOString(),
      signals_new: 0,
      signals_duplicate: 1,
      window_moved: true,
    });
  });
});
