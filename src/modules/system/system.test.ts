import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { APPROVAL_KINDS } from "../../core/enums.js";
import { JobWaitError, OpenOutboundError } from "../../core/errors.js";
import { providerFailure } from "../../core/failures.js";
import { defineJob, type EngineModule } from "../../core/operation.js";
import {
  approvals,
  audit_events,
  events,
  idempotency_records,
  jobs,
  type Workspace,
  workspaces,
} from "../../db/schema/index.js";
import { runMaintenance } from "../../runtime/maintenance.js";
import { createTestEngine, type TestEngine } from "../../testing/engine.js";
import { listApprovals } from "./approvals.js";
import { module as system } from "./index.js";

const worker: EngineModule = {
  name: "worker",
  jobs: [
    defineJob<{ mode: string }>({
      name: "test.work",
      maxAttempts: 1,
      handler: async (_ctx, payload) => {
        if (payload.mode === "fail") {
          throw new OpenOutboundError("validation_failed", "Bad input row 3.", {
            hint: "Fix the CSV.",
          });
        }
        if (payload.mode === "wait") throw new JobWaitError("agent_task:tsk_1");
        if (payload.mode === "provider") {
          throw providerFailure({
            provider: "apollo",
            name: "Apollo",
            class: "quota_exhausted",
            upstreamStatus: 402,
            retryAfterSeconds: 3600,
          });
        }
        return { done: true };
      },
    }),
  ],
};

let engine: TestEngine;
let acme: Workspace;
let globex: Workspace;

interface JobView {
  id: string;
  status: string;
  error: { code: string; message: string; hint?: string } | null;
  result?: unknown;
  waiting_for: string | null;
  workspace_id: string | null;
}

const enqueue = async (workspace: Workspace | null, mode: string) => {
  const ctx = await engine.systemContext(workspace?.id ?? null);
  return (await ctx.jobs.enqueue("test.work", { mode })).job_id;
};

beforeAll(async () => {
  engine = await createTestEngine({ modules: [system, worker] });
  const rows = await engine.db
    .insert(workspaces)
    .values([
      { slug: "acme", name: "Acme" },
      { slug: "globex", name: "Globex" },
    ])
    .returning();
  [acme, globex] = rows as [Workspace, Workspace];
});
afterAll(async () => {
  await engine.close();
});
beforeEach(async () => {
  await engine.db.delete(jobs);
  await engine.db.delete(audit_events);
});

describe("approvals descriptions", () => {
  it("name every approval kind, so a reader knows what the kind filter takes", () => {
    const reviewItems = system.tools?.find((tool) => tool.name === "review_items");
    for (const kind of APPROVAL_KINDS) {
      const word = new RegExp(`\\b${kind}\\b`);
      expect(listApprovals.description, kind).toMatch(word);
      expect(reviewItems?.description, kind).toMatch(word);
    }
  });
});

describe("jobs operations", () => {
  it("shows results, errors and waits, scoped to the caller's workspace", async () => {
    const ok = await enqueue(acme, "ok");
    const failed = await enqueue(acme, "fail");
    const waiting = await enqueue(acme, "wait");
    const foreign = await enqueue(globex, "ok");
    const instance = await enqueue(null, "ok");
    await engine.runJobs();

    const get = (id: string, options: Record<string, unknown> = { workspace: "acme" }) =>
      engine.call("jobs.get", { job_id: id }, options) as Promise<JobView>;
    await expect(get(ok)).resolves.toMatchObject({
      status: "succeeded",
      result: { done: true },
      error: null,
    });
    await expect(get(failed)).resolves.toMatchObject({
      status: "failed",
      error: { code: "validation_failed", message: "Bad input row 3.", hint: "Fix the CSV." },
    });
    await expect(get(waiting)).resolves.toMatchObject({
      status: "waiting",
      waiting_for: "agent_task:tsk_1",
    });
    const provider = await enqueue(acme, "provider");
    await engine.runJobs();
    await expect(get(provider)).resolves.toMatchObject({
      status: "failed",
      error: {
        code: "provider_error",
        failure: {
          class: "quota_exhausted",
          retryable: false,
          scope: "account",
          provider: "apollo",
          retry_after_s: 3600,
          upstream_status: 402,
        },
        retry_after_seconds: 3600,
      },
    });
    await expect(get(foreign)).rejects.toMatchObject({ code: "not_found" });
    await expect(get(instance)).rejects.toMatchObject({ code: "not_found" });
    await expect(get(instance, {})).resolves.toMatchObject({ workspace_id: null });

    const bound = engine.principal({ workspaceId: acme.id });
    await expect(get(foreign, { principal: bound })).rejects.toMatchObject({ code: "not_found" });
    const mine = (await engine.call("jobs.list", {}, { principal: bound })) as { items: JobView[] };
    expect(mine.items.map((item) => item.id).sort()).toEqual(
      [ok, failed, waiting, provider].sort(),
    );
    expect(mine.items[0]).not.toHaveProperty("result");
    const everything = (await engine.call("jobs.list", { status: "succeeded" })) as {
      items: JobView[];
    };
    expect(everything.items.map((item) => item.id).sort()).toEqual([ok, foreign, instance].sort());
  });

  it("cancels queued and waiting jobs but not finished ones", async () => {
    const queued = await enqueue(acme, "ok");
    await expect(
      engine.call("jobs.cancel", { job_id: queued }, { workspace: "acme" }),
    ).resolves.toEqual({ job_id: queued, cancelled: true, status: "cancelled" });
    const done = await enqueue(acme, "ok");
    await engine.runJobs();
    await expect(
      engine.call("jobs.cancel", { job_id: done }, { workspace: "acme" }),
    ).resolves.toEqual({ job_id: done, cancelled: false, status: "succeeded" });
    await expect(
      engine.call("jobs.cancel", { job_id: done }, { workspace: "globex" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("audit log", () => {
  it("lists audited calls for admins, filtered and redacted", async () => {
    const queued = await enqueue(acme, "ok");
    await engine.call(
      "jobs.cancel",
      { job_id: queued },
      { workspace: "acme", reason: "Started by mistake" },
    );
    await expect(
      engine.call(
        "jobs.cancel",
        { job_id: "job_01k6a3v0q8x3m2n4p5r6s7t8v9" },
        { workspace: "acme" },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await engine.call(
      "webhooks.create",
      { url: "https://hooks.example.com/audit", events: ["*"] },
      { workspace: "acme" },
    );

    const list = (input: Record<string, unknown>, options: Record<string, unknown> = {}) =>
      engine.call("audit.list", input, { workspace: "acme", ...options }) as Promise<{
        items: Array<Record<string, unknown>>;
      }>;
    const cancels = await list({ operation: "jobs.cancel" });
    expect(cancels.items.map((item) => item.status)).toEqual(["error", "ok"]);
    expect(cancels.items[1]).toMatchObject({
      actor: { type: "human", id: "test-admin" },
      via: "cli",
      effect: "write",
      reason: "Started by mistake",
      target: { type: "job", id: queued },
    });
    expect(cancels.items[0]).toMatchObject({ error_code: "not_found" });
    expect(cancels.items[0]).not.toHaveProperty("input");
    const detailed = await list({ operation: "webhooks.create" }, { responseFormat: "detailed" });
    expect(detailed.items[0]?.input).toMatchObject({ url: "https://hooks.example.com/audit" });
    expect(JSON.stringify(detailed)).not.toContain("whsec_");
    expect((await list({ status: "error" })).items).toHaveLength(1);
    await expect(list({}, { scopes: ["read", "write"] })).rejects.toMatchObject({
      code: "forbidden",
    });
    expect((await list({}, { workspace: "globex" })).items).toHaveLength(0);
  });
});

describe("maintenance", () => {
  it("expires approvals and prunes old records", async () => {
    const now = engine.clock.now();
    const days = (n: number) => new Date(now.getTime() - n * 24 * 3_600_000);
    await engine.db.insert(approvals).values([
      {
        workspace_id: acme.id,
        kind: "message",
        title: "Old",
        summary: "Old",
        payload: {},
        expires_at: days(1),
      },
      {
        workspace_id: acme.id,
        kind: "message",
        title: "Fresh",
        summary: "Fresh",
        payload: {},
        expires_at: days(-1),
      },
    ]);
    await engine.db.insert(events).values([
      { workspace_id: acme.id, type: "lead.created", data: {}, occurred_at: days(91) },
      { workspace_id: acme.id, type: "lead.created", data: {}, occurred_at: days(10) },
    ]);
    await engine.db.insert(jobs).values([
      { name: "test.work", status: "succeeded", finished_at: days(31) },
      { name: "test.work", status: "failed", finished_at: days(31) },
      { name: "test.work", status: "failed", finished_at: days(91) },
      { name: "test.work", status: "succeeded", finished_at: days(1) },
    ]);
    await engine.db.insert(idempotency_records).values([
      {
        scope: acme.id,
        key: "old-key",
        operation: "jobs.cancel",
        request_hash: "x",
        expires_at: days(1),
      },
      {
        scope: acme.id,
        key: "fresh-key",
        operation: "jobs.cancel",
        request_hash: "x",
        expires_at: days(-1),
      },
    ]);
    const result = await runMaintenance(engine.db, now);
    expect(result).toEqual({
      approvals_expired: 1,
      idempotency_purged: 1,
      events_pruned: 1,
      deliveries_pruned: 0,
      jobs_pruned: 2,
    });
    const remaining = await engine.db.select().from(jobs);
    expect(remaining.map((job) => job.status).sort()).toEqual(["failed", "succeeded"]);
    expect(
      await engine.db.select().from(events).where(eq(events.workspace_id, acme.id)),
    ).toHaveLength(1);
    await engine.db.delete(approvals);
    await engine.db.delete(events);
  });
});
