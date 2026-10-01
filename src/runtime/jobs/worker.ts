/**
 * The worker loop: every poll (1 s, or right away when nudged) it fires due schedules and
 * claims as many jobs as free slots allow. `stop()` waits for running jobs (grace period),
 * then aborts them and releases their leases so another worker can pick them up.
 */
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { and, eq, sql } from "drizzle-orm";
import { jobs } from "../../db/schema/index.js";
import type { Kernel } from "../kernel.js";
import { schedulerTick } from "../scheduler.js";
import { claimJobs, DEFAULT_LEASE_MS, type JobOutcome, runClaimedJob } from "./runner.js";

export interface WorkerOptions {
  id?: string;
  pollMs?: number;
  leaseMs?: number;
}

export interface DrainResult {
  ran: number;
  jobs: JobOutcome[];
}

export interface Worker {
  readonly id: string;
  readonly running: boolean;
  start(options?: { concurrency?: number }): void;
  stop(options?: { graceMs?: number }): Promise<void>;
  nudge(): void;
  /** Runs due jobs one by one until none is due or `max` ran (tests, CLI one-shots). */
  drain(options?: { max?: number; schedules?: boolean }): Promise<DrainResult>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createWorker(kernel: Kernel, options: WorkerOptions = {}): Worker {
  const id = options.id ?? `worker-${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;
  const pollMs = options.pollMs ?? 1000;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const log = kernel.log.child({ component: "worker", worker: id });
  const active = new Set<Promise<unknown>>();
  let concurrency = 4;
  let running = false;
  let ticking = false;
  let again = false;
  let timer: NodeJS.Timeout | null = null;
  let shutdown = new AbortController();

  const schedule = (ms: number) => {
    if (!running) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, ms);
  };

  const tick = async () => {
    if (!running) return;
    if (ticking) {
      again = true;
      return;
    }
    ticking = true;
    try {
      await schedulerTick(kernel).catch((error: unknown) =>
        log.error({ err: error }, "scheduler tick failed"),
      );
      const free = concurrency - active.size;
      if (free > 0 && running) {
        const claimed = await claimJobs(kernel, id, free, leaseMs);
        for (const job of claimed) {
          const run: Promise<unknown> = runClaimedJob(kernel, job, {
            workerId: id,
            leaseMs,
            shutdown: shutdown.signal,
          })
            .catch((error: unknown) => log.error({ err: error, job_id: job.id }, "job crashed"))
            .finally(() => {
              active.delete(run);
              if (running) nudge();
            });
          active.add(run);
        }
      }
    } catch (error) {
      log.error({ err: error }, "worker poll failed");
    } finally {
      ticking = false;
      if (again) {
        again = false;
        schedule(0);
      } else schedule(pollMs);
    }
  };

  const nudge = () => {
    if (!running) return;
    if (ticking) again = true;
    else schedule(0);
  };

  return {
    id,
    get running() {
      return running;
    },
    start(startOptions = {}) {
      concurrency = Math.max(1, startOptions.concurrency ?? concurrency);
      if (running) return;
      running = true;
      log.info({ concurrency }, "worker started");
      schedule(0);
    },
    async stop(stopOptions = {}) {
      if (!running && active.size === 0) return;
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
      while (ticking) await sleep(10);
      const graceMs = stopOptions.graceMs ?? 10_000;
      const settled = Promise.allSettled([...active]);
      const finished = await Promise.race([
        settled.then(() => true),
        sleep(graceMs).then(() => false),
      ]);
      if (!finished) {
        shutdown.abort();
        await Promise.race([Promise.allSettled([...active]), sleep(2000)]);
      }
      await kernel.db
        .update(jobs)
        .set({
          status: "queued",
          lease_owner: null,
          lease_expires_at: null,
          attempts: sql`greatest(${jobs.attempts} - 1, 0)`,
        })
        .where(and(eq(jobs.lease_owner, id), eq(jobs.status, "running")))
        .catch((error: unknown) => log.error({ err: error }, "releasing leases failed"));
      shutdown = new AbortController();
      log.info("worker stopped");
    },
    nudge,
    async drain(drainOptions = {}) {
      const max = drainOptions.max ?? 100;
      if (drainOptions.schedules !== false) await schedulerTick(kernel);
      const outcomes: JobOutcome[] = [];
      while (outcomes.length < max) {
        const [job] = await claimJobs(kernel, id, 1, leaseMs);
        if (!job) break;
        outcomes.push(await runClaimedJob(kernel, job, { workerId: id, leaseMs }));
      }
      return { ran: outcomes.length, jobs: outcomes };
    },
  };
}
