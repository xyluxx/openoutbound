import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { JobContext, OpContext } from "../core/context.js";
import { defineJob, type EngineModule } from "../core/operation.js";
import { approvals, audit_events, events, jobs, type Workspace } from "../db/schema/index.js";
import { createTestEngine, type TestEngine } from "../testing/engine.js";
import { seedWorkspace } from "../testing/factories.js";
import { contextForWorkspace, jobWorkspaceContext } from "./context.js";
import { parseJobError } from "./jobs/runner.js";
import { assertInFence, contextFence } from "./workspace-fence.js";

const PROBE_JOB = "test.fence_probe";

const probe: EngineModule = {
  name: "fence-test",
  jobs: [
    defineJob({
      name: PROBE_JOB,
      payload: z.object({ workspace_id: z.string().optional() }),
      maxAttempts: 1,
      handler: async (jobCtx: JobContext, payload) => {
        const ctx = await jobWorkspaceContext(jobCtx, payload.workspace_id);
        if (!ctx?.workspace) return { skipped: true };
        await ctx.events.emit("report.ready", { data: { report_id: "rpt_probe", type: "probe" } });
        return { workspace: ctx.workspace.id, principal: ctx.principal.workspaceId };
      },
    }),
  ],
};

const report = { data: { report_id: "rpt_x", type: "overview" } };

describe("workspace fence of context services", () => {
  let engine: TestEngine;
  let alpha: Workspace;
  let beta: Workspace;

  beforeAll(async () => {
    engine = await createTestEngine({ modules: [probe] });
    alpha = await seedWorkspace(engine.db, { name: "Alpha Fence", slug: "alpha-fence" });
    beta = await seedWorkspace(engine.db, { name: "Beta Fence", slug: "beta-fence" });
  });
  afterAll(() => engine.close());

  const count = async (table: typeof events | typeof approvals, workspaceId: string) =>
    (await engine.db.select().from(table).where(eq(table.workspace_id, workspaceId))).length;

  it("computes the fence from the workspace, else the principal's binding", () => {
    expect(contextFence("ws_a", { workspaceId: null })).toBe("ws_a");
    expect(contextFence(null, { workspaceId: "ws_b" })).toBe("ws_b");
    expect(contextFence(null, { workspaceId: null })).toBeNull();
    expect(() => assertInFence(null, "ws_b", "emit events")).not.toThrow();
    expect(() => assertInFence("ws_a", undefined, "emit events")).not.toThrow();
    expect(() => assertInFence("ws_a", "ws_a", "emit events")).not.toThrow();
    expect(() => assertInFence("ws_a", null, "enqueue jobs")).toThrow(/outside any workspace/);
  });

  it("refuses events, jobs and approvals for another workspace from a workspace context", async () => {
    const ctx = await engine.systemContext(alpha.id);
    const refused = {
      code: "forbidden",
      details: { reason: "workspace_scope", workspace_id: alpha.id, target_workspace_id: beta.id },
    };
    await expect(
      ctx.events.emit("report.ready", { ...report, workspaceId: beta.id }),
    ).rejects.toMatchObject(refused);
    await expect(ctx.jobs.enqueue(PROBE_JOB, {}, { workspaceId: beta.id })).rejects.toMatchObject(
      refused,
    );
    await expect(ctx.jobs.enqueue(PROBE_JOB, {}, { workspaceId: null })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      ctx.approvals.request({
        kind: "custom",
        title: "Cross workspace",
        summary: "Should never be stored.",
        payload: {},
        workspaceId: beta.id,
      }),
    ).rejects.toMatchObject(refused);
    expect(await count(events, beta.id)).toBe(0);
    expect(await count(approvals, beta.id)).toBe(0);

    // Naming its own workspace is fine.
    await ctx.events.emit("report.ready", { ...report, workspaceId: alpha.id });
    expect(await count(events, alpha.id)).toBe(1);
  });

  it("lets an instance-level context name any workspace and rebuilds every service for one", async () => {
    const root = await engine.systemContext(null);
    await root.events.emit("report.ready", { ...report, workspaceId: beta.id });
    expect(await count(events, beta.id)).toBe(1);

    const inBeta = (await contextForWorkspace(root, beta.id)) as OpContext;
    expect(inBeta.workspace?.id).toBe(beta.id);
    expect(inBeta.principal.workspaceId).toBe(beta.id);
    await inBeta.events.emit("report.ready", report);
    const job = await inBeta.jobs.enqueue(PROBE_JOB, {});
    const approval = await inBeta.approvals.request({
      kind: "custom",
      title: "In beta",
      summary: "Lands in beta.",
      payload: {},
    });
    await inBeta.audit.record({ operation: "test.fence", effect: "write", status: "ok" });

    expect(await count(events, beta.id)).toBe(3); // + approval.requested
    const [jobRow] = await engine.db.select().from(jobs).where(eq(jobs.id, job.job_id));
    expect(jobRow?.workspace_id).toBe(beta.id);
    const [approvalRow] = await engine.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval.id));
    expect(approvalRow?.workspace_id).toBe(beta.id);
    const audits = await engine.db
      .select()
      .from(audit_events)
      .where(and(eq(audit_events.operation, "test.fence"), eq(audit_events.workspace_id, beta.id)));
    expect(audits).toHaveLength(1);
    await engine.db.delete(jobs).where(eq(jobs.id, job.job_id));

    // The rebuilt context is fenced to beta, and a workspace context never switches.
    await expect(
      inBeta.events.emit("report.ready", { ...report, workspaceId: alpha.id }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(contextForWorkspace(inBeta, alpha.id)).rejects.toMatchObject({
      code: "forbidden",
      details: { reason: "workspace_scope" },
    });
    await expect(
      contextForWorkspace(await engine.systemContext(alpha.id), beta.id),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(await contextForWorkspace(root, "ws_01k6a3v0q8x3m2n4p5r6s7t8v9")).toBeNull();
    expect(await contextForWorkspace(inBeta, beta.id)).toBe(inBeta);
  });

  it("keeps a job in its own workspace and refuses a payload naming another one", async () => {
    const root = await engine.systemContext(null);
    const alphaCtx = await engine.systemContext(alpha.id);
    const instance = await root.jobs.enqueue(PROBE_JOB, { workspace_id: beta.id });
    const own = await alphaCtx.jobs.enqueue(PROBE_JOB, {});
    const crossing = await alphaCtx.jobs.enqueue(PROBE_JOB, { workspace_id: beta.id });
    const betaEvents = await count(events, beta.id);

    await engine.runJobs({ schedules: false });

    const row = async (id: string) =>
      (await engine.db.select().from(jobs).where(eq(jobs.id, id)))[0];
    expect((await row(instance.job_id))?.result).toEqual({
      workspace: beta.id,
      principal: beta.id,
    });
    expect((await row(own.job_id))?.result).toEqual({ workspace: alpha.id, principal: alpha.id });
    const failed = await row(crossing.job_id);
    expect(failed?.status).toBe("failed");
    expect(parseJobError(failed?.last_error ?? null)).toMatchObject({ code: "forbidden" });
    // Only the instance-level job wrote to beta.
    expect(await count(events, beta.id)).toBe(betaEvents + 1);
  });
});
