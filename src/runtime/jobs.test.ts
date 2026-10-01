import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { JobWaitError, OpenOutboundError } from "../core/errors.js";
import { providerFailure } from "../core/failures.js";
import { defineJob, type EngineModule } from "../core/operation.js";
import { jobs } from "../db/schema/index.js";
import { createTestEngine, type TestEngine } from "../testing/engine.js";
import { createJobQueue } from "./jobs/queue.js";
import { claimJobs, parseJobError, runClaimedJob, WAIT_RECHECK_MS } from "./jobs/runner.js";
import { createWorker } from "./jobs/worker.js";

const attemptsSeen = new Map<string, number>();
const ready = new Set<string>();
/** Work a `test.wait` run does before it checks whether it can go on (keyed by wait key). */
const duringRun = new Map<string, () => Promise<void>>();

const testModule: EngineModule = {
  name: "jobs-test",
  jobs: [
    defineJob({
      name: "test.ok",
      payload: z.object({ n: z.number() }),
      handler: async (ctx, payload) => {
        await ctx.setProgress({ done: 1, total: 1, stage: "done" });
        return { doubled: payload.n * 2, attempt: ctx.job.attempt };
      },
    }),
    defineJob({
      name: "test.flaky",
      maxAttempts: 3,
      backoff: { type: "exponential", baseMs: 10_000 },
      payload: z.object({ fail: z.number() }),
      handler: async (ctx, payload) => {
        const seen = (attemptsSeen.get(ctx.job.id) ?? 0) + 1;
        attemptsSeen.set(ctx.job.id, seen);
        if (seen <= payload.fail)
          throw new OpenOutboundError("provider_error", `Upstream down (${seen}).`);
        return { seen };
      },
    }),
    defineJob({
      name: "test.permanent",
      handler: async () => {
        throw new OpenOutboundError("validation_failed", "Bad payload.", { hint: "Fix it." });
      },
    }),
    defineJob({
      name: "test.not_retryable",
      maxAttempts: 3,
      handler: async () => {
        throw new OpenOutboundError("provider_error", "The model declined this request.", {
          hint: "Route this task to another model.",
          details: { provider: "anthropic", reason: "refusal", retryable: false },
        });
      },
    }),
    defineJob({
      name: "test.rate_limited",
      maxAttempts: 3,
      handler: async () => {
        throw providerFailure({
          provider: "apollo",
          name: "Apollo",
          class: "rate_limited",
          upstreamStatus: 429,
          retryAfterSeconds: 45,
        });
      },
    }),
    defineJob({
      name: "test.key_rejected",
      maxAttempts: 3,
      handler: async () => {
        // No `retryable` and no `failure`: the class read from the reason decides.
        throw new OpenOutboundError("provider_error", "Hunter rejected the API key.", {
          details: { provider: "hunter", reason: "auth" },
        });
      },
    }),
    defineJob({
      name: "test.retry_now",
      maxAttempts: 5,
      handler: async () => {
        throw providerFailure({
          provider: "apollo",
          name: "Apollo",
          class: "rate_limited",
          upstreamStatus: 429,
          retryAfterSeconds: 0,
        });
      },
    }),
    defineJob({
      name: "test.wait",
      payload: z.object({ key: z.string(), retry_in_ms: z.number().optional() }),
      handler: async (ctx, payload) => {
        await duringRun.get(payload.key)?.();
        if (!ready.has(payload.key)) {
          const retryAt =
            payload.retry_in_ms === undefined
              ? undefined
              : new Date(ctx.clock.now().getTime() + payload.retry_in_ms);
          throw new JobWaitError(payload.key, retryAt);
        }
        return { resumed: payload.key };
      },
    }),
    defineJob({
      name: "test.block",
      handler: (ctx) =>
        new Promise((_resolve, reject) => {
          ctx.job.signal.addEventListener("abort", () => reject(ctx.job.signal.reason));
        }),
    }),
    defineJob({
      name: "test.slow",
      timeoutMs: 50,
      maxAttempts: 2,
      handler: () => new Promise(() => {}),
    }),
  ],
};

let engine: TestEngine;
beforeAll(async () => {
  engine = await createTestEngine({ modules: [testModule] });
});
afterAll(async () => {
  await engine.close();
});
beforeEach(async () => {
  await engine.db.delete(jobs);
  duringRun.clear();
  ready.clear();
  attemptsSeen.clear();
});

const queue = () => createJobQueue(engine.runtime.kernel, { workspaceId: null });
const job = async (id: string) => {
  const [row] = await engine.db.select().from(jobs).where(eq(jobs.id, id));
  if (!row) throw new Error("job missing");
  return row;
};

describe("job queue", () => {
  it("validates job names and payloads at enqueue time", async () => {
    await expect(queue().enqueue("test.missing")).rejects.toMatchObject({ code: "internal" });
    await expect(queue().enqueue("test.ok", { n: "x" })).rejects.toMatchObject({
      code: "internal",
      details: { job: "test.ok" },
    });
  });

  it("runs a job, stores result and progress", async () => {
    const handle = await queue().enqueue("test.ok", { n: 21 });
    expect(handle.status).toBe("queued");
    const result = await engine.runJobs();
    expect(result.jobs).toEqual([
      { id: handle.job_id, name: "test.ok", status: "succeeded", error: null },
    ]);
    const row = await job(handle.job_id);
    expect(row.result).toEqual({ doubled: 42, attempt: 1 });
    expect(row.progress).toEqual({ done: 1, total: 1, stage: "done" });
    expect(row.finished_at).toEqual(engine.clock.now());
  });

  it("dedupes on singleton keys while a job is active", async () => {
    const first = await queue().enqueue("test.ok", { n: 1 }, { singletonKey: "one" });
    const second = await queue().enqueue("test.ok", { n: 2 }, { singletonKey: "one" });
    expect(second).toEqual({ job_id: first.job_id, status: "queued", deduplicated: true });
    await engine.runJobs();
    const third = await queue().enqueue("test.ok", { n: 3 }, { singletonKey: "one" });
    expect(third.job_id).not.toBe(first.job_id);
  });

  it("respects runAt, delay and priority", async () => {
    const later = await queue().enqueue("test.ok", { n: 1 }, { delayMs: 60_000 });
    const low = await queue().enqueue("test.ok", { n: 2 });
    const high = await queue().enqueue("test.ok", { n: 3 }, { priority: 10 });
    const first = await engine.runJobs({ max: 1 });
    expect(first.jobs[0]?.id).toBe(high.job_id);
    const rest = await engine.runJobs();
    expect(rest.jobs.map((entry) => entry.id)).toEqual([low.job_id]);
    engine.advance(60_000);
    expect((await engine.runJobs()).jobs[0]?.id).toBe(later.job_id);
  });

  it("cancels queued jobs but not finished ones", async () => {
    const handle = await queue().enqueue("test.ok", { n: 1 });
    expect(await queue().cancel(handle.job_id)).toBe(true);
    expect((await engine.runJobs()).ran).toBe(0);
    expect((await job(handle.job_id)).status).toBe("cancelled");
    const done = await queue().enqueue("test.ok", { n: 1 });
    await engine.runJobs();
    expect(await queue().cancel(done.job_id)).toBe(false);
  });
});

describe("retries, waits and timeouts", () => {
  it("retries retryable failures with exponential backoff and jitter", async () => {
    const handle = await queue().enqueue("test.flaky", { fail: 2 });
    const start = engine.clock.now().getTime();
    await engine.runJobs();
    let row = await job(handle.job_id);
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(1);
    const firstDelay = row.run_at.getTime() - start;
    expect(firstDelay).toBeGreaterThanOrEqual(8_000);
    expect(firstDelay).toBeLessThanOrEqual(12_000);
    expect(parseJobError(row.last_error)).toMatchObject({ code: "provider_error" });

    expect((await engine.runJobs()).ran).toBe(0);
    engine.advance(firstDelay);
    await engine.runJobs();
    row = await job(handle.job_id);
    const secondDelay = row.run_at.getTime() - engine.clock.now().getTime();
    expect(secondDelay).toBeGreaterThanOrEqual(16_000);
    expect(secondDelay).toBeLessThanOrEqual(24_000);

    engine.advance(secondDelay);
    await engine.runJobs();
    row = await job(handle.job_id);
    expect(row.status).toBe("succeeded");
    expect(row.attempts).toBe(3);
    expect(row.result).toEqual({ seen: 3 });
  });

  it("fails after max attempts and never retries permanent errors", async () => {
    const flaky = await queue().enqueue("test.flaky", { fail: 5 });
    for (let i = 0; i < 3; i++) {
      await engine.runJobs();
      engine.advance(60_000);
    }
    expect(await job(flaky.job_id)).toMatchObject({ status: "failed", attempts: 3 });

    const permanent = await queue().enqueue("test.permanent");
    await engine.runJobs();
    const row = await job(permanent.job_id);
    expect(row).toMatchObject({ status: "failed", attempts: 1 });
    expect(parseJobError(row.last_error)).toEqual({
      code: "validation_failed",
      message: "Bad payload.",
      hint: "Fix it.",
    });
  });

  it("fails at once on provider errors marked retryable: false, keeping the error", async () => {
    const handle = await queue().enqueue("test.not_retryable");
    const result = await engine.runJobs();
    expect(result.jobs[0]?.status).toBe("failed");
    const row = await job(handle.job_id);
    expect(row).toMatchObject({ status: "failed", attempts: 1 });
    expect(row.finished_at).toEqual(engine.clock.now());
    expect(parseJobError(row.last_error)).toEqual({
      code: "provider_error",
      message: "The model declined this request.",
      hint: "Route this task to another model.",
      failure: { class: "refused", retryable: false, scope: "call", provider: "anthropic" },
    });
  });

  it("stores the failure and its wait, and retries after the wait the provider asked for", async () => {
    const handle = await queue().enqueue("test.rate_limited");
    await engine.runJobs();
    const row = await job(handle.job_id);
    expect(row).toMatchObject({ status: "queued", attempts: 1 });
    expect(row.run_at.getTime() - engine.clock.now().getTime()).toBe(45_000);
    expect(parseJobError(row.last_error)).toMatchObject({
      code: "provider_error",
      failure: { class: "rate_limited", retryable: true, provider: "apollo", retry_after_s: 45 },
      retry_after_seconds: 45,
    });
  });

  it("applies the one retry rule to older provider errors: a rejected key fails at once", async () => {
    const handle = await queue().enqueue("test.key_rejected");
    await engine.runJobs();
    const row = await job(handle.job_id);
    expect(row).toMatchObject({ status: "failed", attempts: 1 });
    expect(parseJobError(row.last_error)?.failure).toMatchObject({
      class: "auth_invalid",
      retryable: false,
    });
  });

  it("reads job errors stored before failures were kept", () => {
    expect(
      parseJobError(JSON.stringify({ code: "provider_error", message: "Down.", hint: "Later." })),
    ).toEqual({ code: "provider_error", message: "Down.", hint: "Later." });
    expect(parseJobError("Something broke")).toEqual({
      code: "internal",
      message: "Something broke",
    });
    expect(
      parseJobError(
        JSON.stringify({ code: "provider_error", message: "Down.", failure: { class: "odd" } }),
      ),
    ).toEqual({ code: "provider_error", message: "Down." });
  });

  it("parks on JobWaitError without consuming attempts and wakes on jobs.wake", async () => {
    const handle = await queue().enqueue("test.wait", { key: "agent_task:1" });
    await engine.runJobs();
    let row = await job(handle.job_id);
    expect(row).toMatchObject({ status: "waiting", wait_for: "agent_task:1", attempts: 0 });
    expect(row.run_at.getTime() - engine.clock.now().getTime()).toBe(WAIT_RECHECK_MS);
    expect((await engine.runJobs()).ran).toBe(0);

    ready.add("agent_task:1");
    expect(await queue().wake("agent_task:1")).toBe(1);
    await engine.runJobs();
    row = await job(handle.job_id);
    expect(row).toMatchObject({
      status: "succeeded",
      attempts: 1,
      result: { resumed: "agent_task:1" },
    });
    expect(await queue().wake("agent_task:1")).toBe(0);
  });

  it("wakes waiting jobs when retryAt passes", async () => {
    const handle = await queue().enqueue("test.wait", { key: "later", retry_in_ms: 5_000 });
    await engine.runJobs();
    expect((await job(handle.job_id)).status).toBe("waiting");
    ready.add("later");
    engine.advance(5_000);
    await engine.runJobs();
    expect((await job(handle.job_id)).status).toBe("succeeded");
  });

  it("re-queues a job that parks right after its wake-up was sent", async () => {
    const handle = await queue().enqueue("test.wait", { key: "raced" });
    // The wake arrives while the job runs: it may have read the state just before.
    duringRun.set("raced", async () => {
      duringRun.delete("raced");
      await queue().wake("raced");
    });
    await engine.runJobs({ max: 1 });
    expect((await job(handle.job_id)).status).toBe("queued");
    // The next run starts after that wake: when it still waits, it parks.
    await engine.runJobs({ max: 1 });
    expect(await job(handle.job_id)).toMatchObject({ status: "waiting", wait_for: "raced" });
  });

  it("parks a job woken before its run started that still has to wait (no hot loop)", async () => {
    const handle = await queue().enqueue("test.wait", { key: "brain:configured:ws_1" });
    await engine.runJobs();
    expect((await job(handle.job_id)).status).toBe("waiting");
    // Woken, but what it waits for is still missing (a brain set without its key).
    expect(await queue().wake("brain:configured:ws_1")).toBe(1);
    const { ran } = await engine.runJobs();
    expect(ran).toBe(1);
    expect(await job(handle.job_id)).toMatchObject({
      status: "waiting",
      wait_for: "brain:configured:ws_1",
      attempts: 0,
    });
  });

  it("waits at least the backoff when a provider asks to retry at once", async () => {
    const handle = await queue().enqueue("test.retry_now");
    await engine.runJobs();
    const row = await job(handle.job_id);
    expect(row).toMatchObject({ status: "queued", attempts: 1 });
    // Retry-After: 0 (or a date already past) never spends every attempt in the same instant.
    expect(row.run_at.getTime() - engine.clock.now().getTime()).toBeGreaterThanOrEqual(24_000);
    expect((await engine.runJobs()).ran).toBe(0);
  });

  it("aborts jobs past their timeout and retries them", async () => {
    const handle = await queue().enqueue("test.slow");
    await engine.runJobs();
    const row = await job(handle.job_id);
    expect(row.status).toBe("queued");
    const error = parseJobError(row.last_error);
    expect(error?.message).toContain("timed out after 50 ms");
    expect(error?.failure).toEqual({ class: "timeout", retryable: true, scope: "call" });
  });
});

describe("leases and the worker", () => {
  it("re-claims jobs whose lease expired and fails them after the last attempt", async () => {
    const kernel = engine.runtime.kernel;
    const handle = await queue().enqueue("test.ok", { n: 1 }, { maxAttempts: 2 });
    const [claimed] = await claimJobs(kernel, "worker-a", 5, 1_000);
    expect(claimed).toMatchObject({ id: handle.job_id, lease_owner: "worker-a", attempts: 1 });
    expect(await claimJobs(kernel, "worker-b", 5, 1_000)).toEqual([]);

    engine.advance(1_001);
    const [reclaimed] = await claimJobs(kernel, "worker-b", 5, 1_000);
    expect(reclaimed).toMatchObject({ id: handle.job_id, lease_owner: "worker-b", attempts: 2 });
    // The first worker lost its lease: its result is not recorded.
    if (!claimed || !reclaimed) throw new Error("claims missing");
    expect((await runClaimedJob(kernel, claimed, { workerId: "worker-a" })).status).toBe(
      "cancelled",
    );

    engine.advance(1_001);
    const [third] = await claimJobs(kernel, "worker-c", 5, 1_000);
    if (!third) throw new Error("third claim missing");
    const outcome = await runClaimedJob(kernel, third, { workerId: "worker-c" });
    expect(outcome.status).toBe("failed");
    expect(parseJobError(outcome.error)?.message).toContain("lease expired");
  });

  it("stops a running job that gets cancelled (checked at lease renewal)", async () => {
    const kernel = engine.runtime.kernel;
    const handle = await queue().enqueue("test.block");
    const [claimed] = await claimJobs(kernel, "worker-a", 1, 3_000);
    if (!claimed) throw new Error("claim missing");
    const running = runClaimedJob(kernel, claimed, { workerId: "worker-a", leaseMs: 3_000 });
    expect(await queue().cancel(handle.job_id)).toBe(true);
    const outcome = await running;
    expect(outcome.status).toBe("cancelled");
    expect((await job(handle.job_id)).status).toBe("cancelled");
  });

  it("runs jobs in the background and releases leases on shutdown", async () => {
    const worker = createWorker(engine.runtime.kernel, { id: "bg-worker", pollMs: 20 });
    const ok = await queue().enqueue("test.ok", { n: 5 });
    const blocked = await queue().enqueue("test.block");
    worker.start({ concurrency: 2 });
    for (let i = 0; i < 100 && (await job(ok.job_id)).status !== "succeeded"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect((await job(ok.job_id)).status).toBe("succeeded");
    expect((await job(blocked.job_id)).status).toBe("running");
    await worker.stop({ graceMs: 50 });
    expect(await job(blocked.job_id)).toMatchObject({
      status: "queued",
      lease_owner: null,
      attempts: 0,
    });
    expect(worker.running).toBe(false);
  });
});
