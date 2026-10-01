import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TEST_TIME } from "../core/clock.js";
import { OpenOutboundError } from "../core/errors.js";
import { defineJob, type EngineModule } from "../core/operation.js";
import { jobs, schedules, workspaces } from "../db/schema/index.js";
import { createTestEngine, type TestEngine } from "../testing/engine.js";
import { buildRegistry } from "./registry.js";
import {
  assertValidCron,
  nextRunAt,
  saveSchedule,
  schedulerTick,
  syncBuiltinSchedules,
} from "./scheduler.js";

const ticked: Array<{ workspace: string | null; payload: unknown }> = [];

const scheduled: EngineModule = {
  name: "scheduled",
  jobs: [
    defineJob({
      name: "test.tick",
      handler: async (ctx, payload) => {
        ticked.push({ workspace: ctx.workspace?.slug ?? null, payload });
        return {};
      },
    }),
  ],
  schedules: [
    {
      name: "test.hourly",
      cron: "0 * * * *",
      job: "test.tick",
      perWorkspace: true,
      payload: { kind: "hourly" },
    },
    {
      name: "test.nightly",
      cron: "30 2 * * *",
      job: "test.tick",
      perWorkspace: false,
      timezone: "Europe/Berlin",
    },
  ],
};

let engine: TestEngine;
beforeAll(async () => {
  engine = await createTestEngine({ modules: [scheduled] });
});
afterAll(async () => {
  await engine.close();
});
beforeEach(async () => {
  ticked.length = 0;
  await engine.db.delete(jobs);
  await engine.db.delete(workspaces);
});

describe("cron math", () => {
  it("computes the next run in the schedule's timezone, across DST", () => {
    const saturdayNoon = new Date("2026-09-19T12:00:00Z");
    expect(nextRunAt("0 8 * * 1-5", "Europe/Berlin", saturdayNoon)?.toISOString()).toBe(
      "2026-09-21T06:00:00.000Z",
    );
    expect(
      nextRunAt("0 9 * * *", "Europe/Berlin", new Date("2026-10-24T12:00:00Z"))?.toISOString(),
    ).toBe("2026-10-25T08:00:00.000Z");
    expect(nextRunAt("*/15 * * * *", "UTC", new Date("2026-09-19T12:07:30Z"))?.toISOString()).toBe(
      "2026-09-19T12:15:00.000Z",
    );
  });

  it("rejects invalid crons and timezones with a hint", () => {
    expect(() => assertValidCron("every day")).toThrowError(OpenOutboundError);
    expect(() => assertValidCron("0 8 * * *", "Mars/Olympus")).toThrowError(/Invalid schedule/);
    expect(() => assertValidCron("0 8 * * 1-5", "America/New_York")).not.toThrow();
  });
});

describe("built-in schedules", () => {
  it("stores them at startup and keeps next_run_at until the cron changes", async () => {
    const rows = await engine.db.select().from(schedules).where(isNull(schedules.workspace_id));
    const byName = Object.fromEntries(rows.map((row) => [row.name, row]));
    expect(byName["test.hourly"]?.next_run_at?.toISOString()).toBe("2026-09-19T13:00:00.000Z");
    expect(byName["test.nightly"]?.timezone).toBe("Europe/Berlin");
    expect(byName["system.maintenance"]?.job_name).toBe("system.maintenance");

    const kernel = engine.runtime.kernel;
    await syncBuiltinSchedules(kernel);
    const [same] = await engine.db
      .select()
      .from(schedules)
      .where(and(isNull(schedules.workspace_id), eq(schedules.name, "test.hourly")));
    expect(same?.next_run_at).toEqual(byName["test.hourly"]?.next_run_at);

    const changed = buildRegistry([
      {
        ...scheduled,
        schedules: [
          { name: "test.hourly", cron: "*/5 * * * *", job: "test.tick", perWorkspace: true },
        ],
      },
    ]);
    await syncBuiltinSchedules({ ...kernel, registry: changed });
    const [updated] = await engine.db
      .select()
      .from(schedules)
      .where(and(isNull(schedules.workspace_id), eq(schedules.name, "test.hourly")));
    expect(updated?.cron).toBe("*/5 * * * *");
    expect(updated?.next_run_at?.toISOString()).toBe("2026-09-19T12:05:00.000Z");
    await syncBuiltinSchedules(kernel);
  });

  it("runs per-workspace schedules once per non-archived workspace, and missed runs once", async () => {
    await engine.db.insert(workspaces).values([
      { slug: "one", name: "One" },
      { slug: "two", name: "Two", status: "paused" },
      { slug: "old", name: "Old", status: "archived" },
    ]);
    expect(await schedulerTick(engine.runtime.kernel)).toBe(0);

    engine.advance(3 * 24 * 60 * 60 * 1000);
    await engine.runJobs();
    const hourly = ticked.filter((entry) => (entry.payload as { kind?: string }).kind === "hourly");
    expect(hourly.map((entry) => entry.workspace).sort()).toEqual(["one", "two"]);
    expect(hourly[0]?.payload).toMatchObject({
      kind: "hourly",
      workspace_id: expect.stringMatching(/^ws_/),
    });
    expect(ticked.filter((entry) => entry.workspace === null)).toHaveLength(1);

    const [row] = await engine.db.select().from(schedules).where(eq(schedules.name, "test.hourly"));
    expect(row?.next_run_at?.getTime()).toBeGreaterThan(engine.clock.now().getTime());
    expect(row?.last_run_at).toEqual(engine.clock.now());
    expect(await schedulerTick(engine.runtime.kernel)).toBe(0);
  });

  it("runs workspace schedules saved by modules and repairs rows without next_run_at", async () => {
    engine.clock.set(DEFAULT_TEST_TIME);
    const [workspace] = await engine.db
      .insert(workspaces)
      .values({ slug: "acme", name: "Acme" })
      .returning();
    if (!workspace) throw new Error("no workspace");
    const saved = await saveSchedule(engine.db, engine.clock.now(), {
      workspaceId: workspace.id,
      name: "reports.weekly",
      cron: "0 7 * * 1",
      timezone: "America/New_York",
      job: "test.tick",
      payload: { report: "overview" },
    });
    expect(saved.next_run_at?.toISOString()).toBe("2026-09-21T11:00:00.000Z");
    await engine.db.insert(schedules).values([
      { workspace_id: workspace.id, name: "manual", cron: "0 12 * * *", job_name: "test.tick" },
      { workspace_id: workspace.id, name: "broken", cron: "nonsense", job_name: "test.tick" },
    ]);
    await schedulerTick(engine.runtime.kernel);
    const rows = await engine.db
      .select()
      .from(schedules)
      .where(eq(schedules.workspace_id, workspace.id));
    const byName = Object.fromEntries(rows.map((row) => [row.name, row]));
    expect(byName.manual?.next_run_at?.toISOString()).toBe("2026-09-20T12:00:00.000Z");
    expect(byName.broken?.enabled).toBe(false);

    engine.advance(2 * 24 * 60 * 60 * 1000);
    await engine.runJobs();
    expect(ticked).toContainEqual({ workspace: "acme", payload: { report: "overview" } });
    await engine.db.delete(schedules).where(eq(schedules.workspace_id, workspace.id));
  });
});
