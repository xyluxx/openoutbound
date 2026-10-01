import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { companies, monitors, signal_definitions } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { seedCompany, seedWorkspace } from "../../testing/factories.js";
import { ensureCatalog } from "./catalog.js";
import { monitorRunJob, monitorsTickJob, recomputeIntentJob } from "./jobs.js";
import { storeSignal } from "./service.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  ctx.recorded.jobs.length = 0;
  ctx.clock.set("2026-09-19T12:00:00Z");
  await ctx.db.delete(monitors).where(eq(monitors.workspace_id, ctx.workspace.id));
});

async function monitor(values: Partial<typeof monitors.$inferInsert> = {}) {
  const [row] = await ctx.db
    .insert(monitors)
    .values({
      workspace_id: ctx.workspace.id,
      name: "Test monitor",
      target: { kind: "companies", company_ids: [] },
      collectors: ["first_party"],
      schedule: "0 6 * * *",
      ...values,
    })
    .returning();
  if (!row) throw new Error("monitor insert failed");
  return row;
}

describe("monitors.tick", () => {
  it("enqueues due monitors once and moves next_run_at forward", async () => {
    const due = await monitor({ next_run_at: new Date("2026-09-19T06:00:00Z") });
    const later = await monitor({ next_run_at: new Date("2026-09-20T06:00:00Z") });
    const unscheduled = await monitor({ next_run_at: null });
    const disabled = await monitor({
      enabled: false,
      next_run_at: new Date("2026-09-19T06:00:00Z"),
    });
    const result = await monitorsTickJob.handler(ctx.jobContext(), {
      workspace_id: ctx.workspace.id,
    });
    expect(result).toEqual({ due: 2, enqueued: 1 });
    const runs = ctx.enqueued("monitors.run");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.payload).toMatchObject({ monitor_id: due.id, trigger: "schedule" });
    const rows = new Map(
      (await ctx.db.select().from(monitors).where(eq(monitors.workspace_id, ctx.workspace.id))).map(
        (row) => [row.id, row],
      ),
    );
    expect(rows.get(due.id)?.next_run_at?.toISOString()).toBe("2026-09-20T06:00:00.000Z");
    expect(rows.get(unscheduled.id)?.next_run_at?.toISOString()).toBe("2026-09-20T06:00:00.000Z");
    expect(rows.get(later.id)?.next_run_at?.toISOString()).toBe("2026-09-20T06:00:00.000Z");
    expect(rows.get(disabled.id)?.next_run_at?.toISOString()).toBe("2026-09-19T06:00:00.000Z");

    const again = await monitorsTickJob.handler(ctx.jobContext(), {
      workspace_id: ctx.workspace.id,
    });
    expect(again).toEqual({ due: 0, enqueued: 0 });
  });

  it("collects nothing on schedule in a paused workspace", async () => {
    const paused = await seedWorkspace(ctx.db, { status: "paused" });
    const result = await monitorsTickJob.handler(ctx.with({ workspace: paused }).jobContext(), {
      workspace_id: paused.id,
    });
    expect(result).toEqual({ skipped: "workspace paused" });
  });
});

describe("monitors.run", () => {
  it("runs the monitor, reports progress and stores the summary", async () => {
    const company = await seedCompany(ctx);
    const row = await monitor({ target: { kind: "companies", company_ids: [company.id] } });
    const jobCtx = ctx.jobContext({ id: "job_01k6a3v0q8x3m2n4p5r6s7t8v9" });
    const result = await monitorRunJob.handler(jobCtx, {
      workspace_id: ctx.workspace.id,
      monitor_id: row.id,
      trigger: "manual",
    });
    expect(result).toMatchObject({ monitor_id: row.id, companies_checked: 1, signals_new: 0 });
    expect(ctx.recorded.progress.at(-1)?.progress).toMatchObject({ done: 1, total: 1 });
    const [stored] = await ctx.db.select().from(monitors).where(eq(monitors.id, row.id));
    expect(stored?.last_result).toMatchObject({ trigger: "manual", companies_checked: 1 });
    expect(stored?.last_run_at).toBeInstanceOf(Date);
  });

  it("skips missing monitors and disabled monitors on schedule", async () => {
    const disabled = await monitor({ enabled: false });
    expect(
      await monitorRunJob.handler(ctx.jobContext(), {
        workspace_id: ctx.workspace.id,
        monitor_id: "mon_01k6a3v0q8x3m2n4p5r6s7t8v9",
        trigger: "manual",
      }),
    ).toEqual({ skipped: "monitor not found" });
    expect(
      await monitorRunJob.handler(ctx.jobContext(), {
        workspace_id: ctx.workspace.id,
        monitor_id: disabled.id,
        trigger: "schedule",
      }),
    ).toEqual({ skipped: "monitor disabled" });
  });

  it("never crawls the web for sandbox workspaces", async () => {
    const sandbox = await createTestContext({ db: ctx.testDb, sandbox: true });
    const company = await seedCompany(sandbox);
    const [row] = await sandbox.db
      .insert(monitors)
      .values({
        workspace_id: sandbox.workspace.id,
        name: "Sandbox monitor",
        target: { kind: "companies", company_ids: [company.id] },
        collectors: ["website_changes", "job_boards"],
        schedule: "0 6 * * *",
      })
      .returning();
    if (!row) throw new Error("monitor insert failed");
    await monitorRunJob.handler(sandbox.jobContext(), {
      workspace_id: sandbox.workspace.id,
      monitor_id: row.id,
      trigger: "manual",
    });
    expect(sandbox.recorded.fetch).toHaveLength(0);
    const [stored] = await sandbox.db.select().from(monitors).where(eq(monitors.id, row.id));
    expect(JSON.stringify(stored?.last_result)).toContain("Sandbox workspace");
  });
});

describe("signals.recompute_intent", () => {
  it("re-scores intent after a definition change", async () => {
    const company = await seedCompany(ctx);
    await storeSignal(ctx, {
      definition_key: "headcount_growth",
      title: "Headcount up 30%",
      evidence_url: "https://www.example.org/headcount",
      source: "test",
      companyId: company.id,
    });
    const intent = async () =>
      (await ctx.db.select().from(companies).where(eq(companies.id, company.id)))[0]?.intent_score;
    expect(await intent()).toBeGreaterThan(0);
    await ensureCatalog(ctx.db, ctx.workspace.id);
    await ctx.db
      .update(signal_definitions)
      .set({ enabled: false })
      .where(eq(signal_definitions.key, "headcount_growth"));
    const one = await recomputeIntentJob.handler(ctx.jobContext(), {
      workspace_id: ctx.workspace.id,
      company_ids: [company.id],
    });
    expect(one).toEqual({ companies: 1 });
    expect(await intent()).toBe(0);
    const all = await recomputeIntentJob.handler(ctx.jobContext(), {
      workspace_id: ctx.workspace.id,
    });
    expect(all).toMatchObject({ changed: 0 });
  });
});
