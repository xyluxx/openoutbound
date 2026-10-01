import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  icps,
  list_members,
  lists,
  type Monitor,
  monitors,
  type NewMonitor,
  signal_definitions,
  signals,
  workspaces,
} from "../../../db/schema/index.js";
import type { ProviderRuntime, SignalProvider } from "../../../providers/types.js";
import { buildEvaluateCustomAnswer } from "../../../sandbox/brain/signals-answers.js";
import { createSandboxResearch } from "../../../sandbox/providers/research.js";
import { allPages } from "../../../sandbox/world/index.js";
import { createTestContext, type TestContext } from "../../../testing/context.js";
import { seedCompany, seedPerson } from "../../../testing/factories.js";
import { ensureCatalog } from "../catalog.js";
import type { CollectorSet } from "../collectors/index.js";
import { type Collector, type CollectorRun, emptyOutput } from "../collectors/types.js";
import { keepProviderSignal, runMonitor } from "./runner.js";
import { assertMonitorSchedule, nextMonitorRun, runsPerMonth } from "./schedule.js";
import { resolveTargets } from "./targets.js";

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
  ctx.recorded.brain.length = 0;
  ctx.usage.setOverBudget("data", false);
  ctx.usage.setOverBudget("ai", false);
  ctx.providers.set("signals", null);
});

function stub(name: Collector["name"], collect?: Collector["collect"]): Collector {
  return { name, collect: collect ?? (async () => emptyOutput()) };
}

function collectorSet(overrides: Partial<CollectorSet> = {}): CollectorSet {
  return {
    website_changes: stub("website_changes"),
    job_boards: stub("job_boards"),
    news_gdelt: stub("news_gdelt"),
    rss: stub("rss"),
    tech_detect: stub("tech_detect"),
    first_party: stub("first_party"),
    ...overrides,
  };
}

async function createMonitor(values: Partial<NewMonitor>): Promise<Monitor> {
  const [row] = await ctx.db
    .insert(monitors)
    .values({
      workspace_id: ctx.workspace.id,
      name: "Test monitor",
      target: { kind: "all_active" },
      collectors: ["job_boards"],
      schedule: "0 6 * * *",
      ...values,
    })
    .returning();
  if (!row) throw new Error("insert failed");
  return row;
}

function fakeProvider(overrides: Partial<SignalProvider> = {}): SignalProvider {
  return {
    id: "fake_paid",
    supportedSignals: ["funding_round", "hiring_relevant_roles"],
    creditsPerCall: 2,
    collect: async (target) => [
      {
        definition_key: "funding_round",
        title: `${target.company.name} raised a round`,
        evidence_url: `https://funding.example.org/${target.company.id}`,
        source: "fake_paid",
      },
      {
        definition_key: "hiring_relevant_roles",
        title: "Hiring: Backend Engineer",
        evidence_url: `https://jobs.example.org/${target.company.id}/backend`,
        source: "fake_paid",
      },
      {
        definition_key: "hiring_relevant_roles",
        title: "Hiring: SDR",
        evidence_url: `https://jobs.example.org/${target.company.id}/sdr`,
        source: "fake_paid",
      },
    ],
    ...overrides,
  };
}

describe("schedule helpers", () => {
  it("accepts hourly or slower crons and rejects the rest", () => {
    const now = new Date("2026-09-19T12:00:00Z");
    expect(() => assertMonitorSchedule("0 6 * * *", "UTC", now)).not.toThrow();
    expect(() => assertMonitorSchedule("*/5 * * * *", "UTC", now)).toThrow(
      /more than once per hour/,
    );
    expect(() => assertMonitorSchedule("not cron", "UTC", now)).toThrow(/Invalid cron/);
    expect(nextMonitorRun("0 6 * * *", "America/Chicago", now)?.toISOString()).toBe(
      "2026-09-20T11:00:00.000Z",
    );
    expect(runsPerMonth("0 6 * * *", "UTC", now)).toBe(30);
    expect(runsPerMonth("0 6 * * 1", "UTC", now)).toBeGreaterThanOrEqual(4);
  });
});

describe("resolveTargets", () => {
  it("resolves lists, explicit ids, ICP fit and caps the count", async () => {
    const workspace = ctx.workspace.id;
    const high = await seedCompany(ctx, { fit_score: 90 });
    const mid = await seedCompany(ctx, { fit_score: 60 });
    const low = await seedCompany(ctx, { fit_score: 20 });
    const archived = await seedCompany(ctx, { fit_score: 99, status: "archived" });
    const person = await seedPerson(ctx, { company_id: mid.id });
    const [list] = await ctx.db
      .insert(lists)
      .values({ workspace_id: workspace, name: "Watch" })
      .returning();
    if (!list) throw new Error("no list");
    await ctx.db.insert(list_members).values({ list_id: list.id, person_id: person.id });
    const [icp] = await ctx.db
      .insert(icps)
      .values({ workspace_id: workspace, name: "Core", signal_keys: ["funding_round"] })
      .returning();
    if (!icp) throw new Error("no icp");

    const byList = await resolveTargets(ctx, workspace, { kind: "list", list_id: list.id }, 10);
    expect(byList.companies.map((c) => c.id)).toEqual([mid.id]);
    const byIds = await resolveTargets(
      ctx,
      workspace,
      { kind: "companies", company_ids: [low.id, archived.id] },
      10,
    );
    expect(byIds.companies.map((c) => c.id)).toEqual([low.id]);
    const byIcp = await resolveTargets(
      ctx,
      workspace,
      { kind: "icp", icp_id: icp.id, min_fit: 55 },
      10,
    );
    expect(byIcp.companies.map((c) => c.id)).toEqual(expect.arrayContaining([high.id, mid.id]));
    expect(byIcp.companies.map((c) => c.id)).not.toContain(low.id);
    expect(byIcp.icpSignalKeys).toEqual(["funding_round"]);
    const capped = await resolveTargets(ctx, workspace, { kind: "all_active", min_fit: 50 }, 1);
    expect(capped.companies).toHaveLength(1);
    expect(capped.total).toBeGreaterThanOrEqual(2);
  });
});

describe("runMonitor", () => {
  it("records collector signals for the monitor's keys and saves a summary", async () => {
    const company = await seedCompany(ctx, { fit_score: 97, name: "Run One" });
    const seen: CollectorRun[] = [];
    const collectors = collectorSet({
      job_boards: stub("job_boards", async (run) => {
        seen.push(run);
        const out = emptyOutput(["no board"]);
        out.signals.push(
          {
            definition_key: "hiring_relevant_roles",
            title: "Hiring 2 SDRs",
            evidence_url: `https://jobs.example.org/${run.company.id}/sdr-1`,
            source: "job_boards",
          },
          {
            definition_key: "competitor_mention",
            title: "Not in this monitor's keys",
            evidence_url: `https://jobs.example.org/${run.company.id}/x`,
            source: "job_boards",
          },
        );
        return out;
      }),
    });
    const monitor = await createMonitor({
      target: { kind: "companies", company_ids: [company.id] },
      signal_keys: ["hiring_relevant_roles"],
    });
    const summary = await runMonitor(ctx, monitor, { collectors, trigger: "schedule" });
    expect(summary).toMatchObject({
      trigger: "schedule",
      companies_total: 1,
      companies_checked: 1,
      signals_new: 1,
      by_key: { hiring_relevant_roles: 1 },
      stopped: [],
    });
    expect(summary.notes).toEqual(["Run One: no board"]);
    expect(seen[0]?.definitions.map((d) => d.key)).toEqual(["hiring_relevant_roles"]);
    expect(seen[0]?.since.toISOString()).toBe("2026-08-20T12:00:00.000Z");

    const [stored] = await ctx.db.select().from(monitors).where(eq(monitors.id, monitor.id));
    expect(stored?.last_run_at?.toISOString()).toBe("2026-09-19T12:00:00.000Z");
    expect(stored?.next_run_at?.toISOString()).toBe("2026-09-20T06:00:00.000Z");
    expect(stored?.last_result).toMatchObject({ signals_new: 1 });

    const again = await runMonitor(
      ctx,
      { ...monitor, last_run_at: stored?.last_run_at ?? null },
      { collectors },
    );
    expect(again).toMatchObject({ signals_new: 0, signals_duplicate: 1 });
  });

  it("caps companies and paid credits per run, meters usage and filters provider roles", async () => {
    await ctx.db
      .update(signal_definitions)
      .set({
        detection: { collectors: ["job_boards"], keywords: ["SDR"], instructions: "", urls: [] },
      })
      .where(eq(signal_definitions.key, "hiring_relevant_roles"));
    const a = await seedCompany(ctx, { fit_score: 96 });
    const b = await seedCompany(ctx, { fit_score: 95 });
    const c = await seedCompany(ctx, { fit_score: 94 });
    ctx.providers.set("signals", fakeProvider());
    const monitor = await createMonitor({
      target: { kind: "companies", company_ids: [a.id, b.id, c.id] },
      collectors: ["fake_paid", "missing_provider"],
      signal_keys: ["funding_round", "hiring_relevant_roles"],
      budget: { max_companies: 3, max_credits_per_run: 5 },
    });
    const summary = await runMonitor(ctx, monitor, { collectors: collectorSet() });
    expect(summary.companies_checked).toBe(3);
    expect(summary.credits_used).toBe(4);
    expect(summary.stopped).toEqual(["budget_credits_run"]);
    expect(summary.notes[0]).toMatch(/"missing_provider" is not configured/);
    // Two companies x (funding + the SDR role); the backend role does not match the keywords.
    expect(summary.by_key).toEqual({ funding_round: 2, hiring_relevant_roles: 2 });
    expect(ctx.recorded.usage.map((u) => [u.slot, u.provider, u.credits])).toEqual([
      ["signals", "fake_paid", 2],
      ["signals", "fake_paid", 2],
    ]);
    const stored = await ctx.db.select().from(signals).where(eq(signals.company_id, c.id));
    expect(stored).toHaveLength(0);
  });

  it("respects the monthly monitor budget and the workspace data budget", async () => {
    const company = await seedCompany(ctx, { fit_score: 93 });
    ctx.providers.set("signals", fakeProvider());
    const monthly = await createMonitor({
      target: { kind: "companies", company_ids: [company.id] },
      collectors: ["fake_paid"],
      budget: { max_credits_per_month: 10 },
      last_result: { month: "2026-09", month_credits: 9 },
    });
    const first = await runMonitor(ctx, monthly, { collectors: collectorSet() });
    expect(first).toMatchObject({
      credits_used: 0,
      month_credits: 9,
      stopped: ["budget_credits_month"],
    });

    const newMonth = await createMonitor({
      target: { kind: "companies", company_ids: [company.id] },
      collectors: ["fake_paid"],
      budget: { max_credits_per_month: 10 },
      last_result: { month: "2026-08", month_credits: 9 },
    });
    ctx.usage.setOverBudget("data");
    const blocked = await runMonitor(ctx, newMonth, { collectors: collectorSet() });
    expect(blocked).toMatchObject({ credits_used: 0, month_credits: 0, stopped: ["budget_data"] });
    expect(ctx.recorded.usage).toHaveLength(0);
  });

  it("never starts a paid call that the workspace data budget cannot cover", async () => {
    const first = await seedCompany(ctx, { fit_score: 95 });
    const second = await seedCompany(ctx, { fit_score: 94 });
    ctx.providers.set("signals", fakeProvider());
    await ctx.db
      .update(workspaces)
      .set({ settings: { data: { monthly_credit_budget: 3 } } })
      .where(eq(workspaces.id, ctx.workspace.id));
    try {
      const monitor = await createMonitor({
        target: { kind: "companies", company_ids: [first.id, second.id] },
        collectors: ["fake_paid"],
      });
      const summary = await runMonitor(ctx, monitor, { collectors: collectorSet() });
      // Each call costs 2 credits: the first fits in 3, the second would end at 4 of 3.
      expect(summary).toMatchObject({
        companies_checked: 2,
        credits_used: 2,
        stopped: ["budget_data"],
      });
      expect(summary.notes).toContain(
        "Not enough data budget: needs 2 credits, 1 left this month (2 of 3 used). Paid signal providers stopped for the rest of this run.",
      );
      expect(ctx.recorded.usage.map((u) => [u.provider, u.credits])).toEqual([["fake_paid", 2]]);

      // A provider with nothing to look for is never called, so its price stops nothing.
      ctx.recorded.usage.length = 0;
      await ctx.db
        .update(workspaces)
        .set({ settings: { data: { monthly_credit_budget: 5 } } })
        .where(eq(workspaces.id, ctx.workspace.id));
      const unrelated = fakeProvider({
        id: "fake_tech",
        supportedSignals: ["tech_adopted"],
        creditsPerCall: 50,
      });
      ctx.providers.set("signals", [unrelated, fakeProvider()]);
      const mixed = await runMonitor(
        ctx,
        await createMonitor({
          target: { kind: "companies", company_ids: [first.id] },
          collectors: ["fake_tech", "fake_paid"],
          signal_keys: ["funding_round"],
        }),
        { collectors: collectorSet() },
      );
      expect(mixed).toMatchObject({ credits_used: 2, stopped: [] });
      expect(ctx.recorded.usage.map((u) => [u.provider, u.credits])).toEqual([["fake_paid", 2]]);
    } finally {
      await ctx.db
        .update(workspaces)
        .set({ settings: {} })
        .where(eq(workspaces.id, ctx.workspace.id));
    }
  });

  it("evaluates custom definitions on collected evidence and stops AI work over budget", async () => {
    const company = await seedCompany(ctx, { fit_score: 92 });
    await ctx.db.insert(signal_definitions).values({
      workspace_id: ctx.workspace.id,
      key: "soc2_in_progress",
      name: "SOC 2 in progress",
      kind: "custom",
      weight: 45,
      half_life_days: 45,
      min_strength: 0.5,
      detection: {
        collectors: ["job_boards"],
        keywords: [],
        instructions: "SOC 2 in progress",
        urls: [],
      },
    });
    const collectors = collectorSet({
      job_boards: stub("job_boards", async (run) => {
        const out = emptyOutput();
        out.evidence.push({
          url: `https://jobs.example.org/${run.company.id}/security`,
          title: "Security Engineer",
          text: "Help us complete our SOC 2 audit, currently in progress.",
          collector: "job_boards",
        });
        return out;
      }),
    });
    ctx.brain.on("signals.custom.evaluate", (vars: { sources: Array<{ url: string }> }) => ({
      matched: true,
      strength: 0.9,
      evidence_url: vars.sources[0]?.url ?? "",
      evidence_excerpt: "SOC 2 audit, currently in progress",
      summary: "Security hire mentions SOC 2 in progress.",
    }));
    const monitor = await createMonitor({
      target: { kind: "companies", company_ids: [company.id] },
      signal_keys: ["soc2_in_progress"],
    });
    const summary = await runMonitor(ctx, monitor, { collectors });
    expect(summary).toMatchObject({
      custom_evaluated: 1,
      brain_calls: 1,
      by_key: { soc2_in_progress: 1 },
    });

    const other = await seedCompany(ctx, { fit_score: 91 });
    ctx.usage.setOverBudget("ai");
    const overBudget = await runMonitor(
      ctx,
      await createMonitor({
        target: { kind: "companies", company_ids: [other.id] },
        signal_keys: ["soc2_in_progress"],
      }),
      { collectors },
    );
    expect(overBudget.stopped).toEqual(["budget_ai"]);
    expect(overBudget.signals_new).toBe(0);
  });

  it("stops between companies when aborted", async () => {
    const company = await seedCompany(ctx, { fit_score: 90 });
    const controller = new AbortController();
    controller.abort();
    const summary = await runMonitor(
      ctx,
      await createMonitor({ target: { kind: "companies", company_ids: [company.id] } }),
      { collectors: collectorSet(), signal: controller.signal },
    );
    expect(summary).toMatchObject({ companies_checked: 0, stopped: ["aborted"] });
  });
});

describe("runMonitor in a sandbox workspace", () => {
  it("reads custom signal urls from the sandbox's pages, so custom signals can match", async () => {
    const page = allPages().find(
      (candidate) => candidate.url.endsWith("/about") && candidate.text.includes("demand planning"),
    );
    if (!page) throw new Error("the sandbox world has no about page to read");
    const domain = new URL(page.url).hostname;
    const sandbox = await createTestContext({ sandbox: true });
    try {
      await ensureCatalog(sandbox.db, sandbox.workspace.id);
      const runtime: ProviderRuntime = {
        fetch: async () => {
          throw new Error("the sandbox research provider never calls an API");
        },
        safeFetch: sandbox.fetch,
        log: sandbox.log,
        clock: sandbox.clock,
        baseUrl: sandbox.config.baseUrl,
        workspaceId: sandbox.workspace.id,
        db: sandbox.db,
      };
      sandbox.providers.set("research", createSandboxResearch(runtime));
      sandbox.brain.on("signals.custom.evaluate", buildEvaluateCustomAnswer);
      const company = await seedCompany(sandbox, { domain, website: `https://${domain}` });
      await sandbox.db.insert(signal_definitions).values({
        workspace_id: sandbox.workspace.id,
        key: "owns_demand_planning",
        name: "Owns demand planning",
        description: "The operations team runs demand planning in house.",
        kind: "custom",
        weight: 50,
        half_life_days: 30,
        min_strength: 0.5,
        detection: {
          collectors: ["website_changes"],
          keywords: ["demand planning"],
          instructions: "",
          urls: ["/about", "/locations"],
        },
      });
      const [monitor] = await sandbox.db
        .insert(monitors)
        .values({
          workspace_id: sandbox.workspace.id,
          name: "Sandbox monitor",
          target: { kind: "companies", company_ids: [company.id] },
          collectors: ["website_changes"],
          signal_keys: ["owns_demand_planning"],
          schedule: "0 6 * * *",
        })
        .returning();
      if (!monitor) throw new Error("insert failed");

      const summary = await runMonitor(sandbox, monitor, { collectors: collectorSet() });
      expect(summary.by_key).toEqual({ owns_demand_planning: 1 });
      const stored = await sandbox.db
        .select()
        .from(signals)
        .where(eq(signals.company_id, company.id));
      expect(stored).toEqual([
        expect.objectContaining({
          definition_key: "owns_demand_planning",
          evidence_url: page.url,
          source: "custom_url",
        }),
      ]);
      // The real web is never read in the sandbox.
      expect(sandbox.recorded.fetch).toEqual([]);
    } finally {
      await sandbox.close();
    }
  });
});

describe("provider signal filter", () => {
  const signal = (definition_key: string, title: string) => ({
    definition_key,
    title,
    evidence_url: "https://www.example.org/x",
    source: "fake",
  });
  const keywords = { hiring: ["SDR"], tech: ["Examplytics"], competitors: [] };

  it("keeps hiring and tech signals only when they match the workspace keywords", () => {
    expect(keepProviderSignal(signal("hiring_relevant_roles", "Hiring: SDR"), keywords)).toBe(true);
    expect(keepProviderSignal(signal("hiring_relevant_roles", "Hiring: Chef"), keywords)).toBe(
      false,
    );
    expect(keepProviderSignal(signal("tech_adopted", "Started using Examplytics"), keywords)).toBe(
      true,
    );
    expect(keepProviderSignal(signal("tech_adopted", "Started using Fontlib"), keywords)).toBe(
      false,
    );
    expect(keepProviderSignal(signal("funding_round", "Raised $5M"), keywords)).toBe(true);
    const none = { hiring: [], tech: [], competitors: [] };
    expect(keepProviderSignal(signal("tech_removed", "Stopped using Fontlib"), none)).toBe(true);
  });
});
