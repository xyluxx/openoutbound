import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { requireWorkspace } from "../core/context.js";
import { onEvent } from "../core/events.js";
import {
  defineJob,
  defineOperation,
  defineTool,
  type EngineModule,
  jobHandleOutput,
} from "../core/operation.js";
import { audit_events, jobs } from "../db/schema/index.js";
import { createEngine } from "../index.js";
import { module as system } from "../modules/system/index.js";
import { module as workspaces } from "../modules/workspaces/index.js";
import { createTestEngine, type TestEngine } from "../testing/engine.js";

const trail: string[] = [];

const demo: EngineModule = {
  name: "demo",
  operations: [
    defineOperation({
      id: "demo.import",
      summary: "Import leads in the background",
      description: "Starts a background import for the end-to-end test.",
      effect: "write",
      input: z.object({ rows: z.number().int().min(1) }),
      output: jobHandleOutput,
      http: { method: "POST", path: "/v1/demo/import" },
      dryRun: "none",
      idempotent: false,
      workspace: "required",
      examples: [{ title: "Import", input: { rows: 2 } }],
      handler: async (ctx, input) => ctx.jobs.enqueue("demo.process", { rows: input.rows }),
    }),
  ],
  tools: [
    defineTool({
      name: "demo_import",
      title: "Demo import",
      description: "Starts the demo import for the end-to-end test.",
      toolset: "core",
      operation: "demo.import",
    }),
  ],
  jobs: [
    defineJob<{ rows: number }>({
      name: "demo.process",
      handler: async (ctx, payload) => {
        const workspace = requireWorkspace(ctx);
        for (let row = 1; row <= payload.rows; row++) {
          await ctx.events.emit("lead.created", {
            subject: { type: "person", id: `per_${row}` },
            data: { kind: "person", id: `per_${row}`, source: "import", import_id: null },
          });
          await ctx.setProgress({ done: row, total: payload.rows });
        }
        const approval = await ctx.approvals.request({
          kind: "lead_import",
          title: `Import ${payload.rows} leads into ${workspace.name}`,
          summary: "Adds the rows to the lead list.",
          payload: { rows: payload.rows },
        });
        trail.push(`processed:${payload.rows}`);
        return { approval_id: approval.id };
      },
    }),
    defineJob({
      name: "demo.tick",
      handler: async (ctx) => {
        trail.push(`tick:${ctx.workspace?.slug ?? "none"}`);
        return {};
      },
    }),
  ],
  eventHandlers: [
    onEvent("lead.created", "demo.on_lead", async (ctx, event) => {
      trail.push(`lead:${event.data.id}:${ctx.workspace?.slug}`);
    }),
  ],
  approvalResolvers: [
    {
      kind: "lead_import",
      apply: async (ctx, approval, decision) => {
        trail.push(`resolved:${decision.decision}:${String(approval.payload.rows)}`);
        return { message: `Imported by ${ctx.principal.name}` };
      },
    },
  ],
  schedules: [{ name: "demo.daily", cron: "0 6 * * *", job: "demo.tick", perWorkspace: true }],
};

describe("createTestEngine end to end", () => {
  let engine: TestEngine;
  beforeAll(async () => {
    engine = await createTestEngine({ modules: [workspaces, system, demo] });
  });
  afterAll(async () => {
    await engine.close();
  });

  it("runs an operation, its job, event handlers, approvals and schedules", async () => {
    const workspace = (await engine.call("workspaces.create", { name: "Harbor Dental" })) as {
      slug: string;
    };
    const handle = (await engine.call(
      "demo.import",
      { rows: 2 },
      { workspace: workspace.slug },
    )) as {
      job_id: string;
      status: string;
    };
    expect(handle).toMatchObject({ job_id: expect.stringMatching(/^job_/), status: "queued" });

    const drained = await engine.runJobs();
    expect(drained.jobs.map((job) => [job.name, job.status])).toEqual([
      ["demo.process", "succeeded"],
      ["event:demo.on_lead", "succeeded"],
      ["event:demo.on_lead", "succeeded"],
    ]);
    expect(trail).toEqual(
      expect.arrayContaining([
        "processed:2",
        "lead:per_1:harbor-dental",
        "lead:per_2:harbor-dental",
      ]),
    );
    const job = (await engine.call("jobs.get", { job_id: handle.job_id })) as {
      status: string;
      progress: unknown;
      result: { approval_id: string };
    };
    expect(job).toMatchObject({ status: "succeeded", progress: { done: 2, total: 2 } });

    const pending = (await engine.call("approvals.list", {})) as { items: Array<{ id: string }> };
    expect(pending.items.map((item) => item.id)).toEqual([job.result.approval_id]);
    const decision = await engine.call("approvals.decide", {
      approval_id: job.result.approval_id,
      decision: "approve",
    });
    expect(decision).toMatchObject({
      approved: 1,
      results: [{ message: "Imported by Test Admin" }],
    });
    expect(trail).toContain("resolved:approve:2");

    engine.advance(24 * 3_600_000);
    await engine.runJobs();
    expect(trail).toContain("tick:harbor-dental");

    const audited = await engine.db
      .select({ operation: audit_events.operation })
      .from(audit_events);
    expect(audited.map((row) => row.operation)).toEqual(
      expect.arrayContaining(["workspaces.create", "demo.import", "approvals.decide"]),
    );
    expect(engine.registry.tools().map((tool) => tool.name)).toContain("demo_import");
    expect(Object.keys(engine.registry.inputSchema("demo.import").shape)).toEqual(
      expect.arrayContaining(["rows", "workspace", "idempotency_key"]),
    );
    const ctx = await engine.systemContext(null);
    expect(ctx.principal).toMatchObject({ type: "system" });
    expect(engine.httpRoutes()).toEqual([]);
  });

  it("hands every context the engine's DNS resolver (ctx.dns), like its safe fetch", async () => {
    engine.dns.set("mail-host.example.com", { mx: ["mx1.example.net"], txt: ["v=spf1 -all"] });
    const ctx = await engine.systemContext(null);
    expect(await ctx.dns.resolveMx("mail-host.example.com")).toEqual([
      { exchange: "mx1.example.net", priority: 10 },
    ]);
    expect(await ctx.dns.resolveTxt("mail-host.example.com")).toEqual([["v=spf1 -all"]]);
    await expect(ctx.dns.resolveMx("nowhere.example.com")).rejects.toMatchObject({
      code: "ENOTFOUND",
    });
    expect(engine.dns.lookups).toEqual([
      "mx:mail-host.example.com",
      "txt:mail-host.example.com",
      "mx:nowhere.example.com",
    ]);
  });

  it("processes jobs with the background worker", async () => {
    const ctx = await engine.systemContext(null);
    const { job_id } = await ctx.jobs.enqueue("demo.tick", {});
    await engine.startWorker({ concurrency: 1 });
    try {
      for (let i = 0; i < 100; i++) {
        const [row] = await engine.db.select().from(jobs).where(eq(jobs.id, job_id));
        if (row?.status === "succeeded") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      await engine.stopWorker();
    }
    const [row] = await engine.db.select().from(jobs).where(eq(jobs.id, job_id));
    expect(row?.status).toBe("succeeded");
    expect(trail).toContain("tick:none");
  });
});

describe("createEngine", () => {
  it("opens an in-memory engine, migrates it and closes cleanly", async () => {
    const engine = await createEngine({
      config: { databaseUrl: "memory://", logLevel: "silent" },
      modules: [workspaces, system],
    });
    try {
      const admin = engine.localPrincipal("admin", "cli");
      const created = await engine.call(
        "workspaces.create",
        { name: "Acme Robotics" },
        { principal: admin },
      );
      expect(created).toMatchObject({ slug: "acme-robotics" });
      await expect(engine.call("workspaces.nope", {}, { principal: admin })).rejects.toMatchObject({
        code: "not_found",
        hint: expect.stringContaining("workspaces."),
      });
      expect(await engine.authenticate("oo_not_a_real_key", "http")).toBeNull();
    } finally {
      await engine.close();
      await engine.close();
    }
    await expect(engine.startWorker()).rejects.toThrowError("The engine is closed.");
  });

  it("refuses to start with invalid modules", async () => {
    await expect(
      createEngine({
        config: { databaseUrl: "memory://", logLevel: "silent" },
        modules: [workspaces, workspaces],
      }),
    ).rejects.toThrowError(/Invalid engine modules/);
  });
});
