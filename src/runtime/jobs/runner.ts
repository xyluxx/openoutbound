/**
 * Claims and runs jobs. Claims use `FOR UPDATE SKIP LOCKED` so several workers (pg) never take
 * the same job; on PGlite (one connection) the same query simply runs serialized.
 *
 * A claimed job holds a lease (default 5 minutes) renewed while it runs; a job whose lease
 * expired (crashed worker) is claimed again. Failures follow the engine's one retry rule
 * (`isRetryable` in core/failures): retryable ones retry after the wait the error asks for, or
 * the job's backoff (exponential with jitter), until max_attempts; the others fail the job at
 * once. `JobWaitError` parks the job as `waiting` without consuming an attempt until
 * `jobs.wake(waitFor)` or its retryAt. `last_error` keeps the code, message, hint, the
 * provider failure and the wait, so `get_job` can show them.
 */
import { and, asc, desc, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import type { JobStatus } from "../../core/enums.js";
import { isJobWaitError, OpenOutboundError, toOpenOutboundError } from "../../core/errors.js";
import {
  type Failure,
  failureOf,
  failureSchema,
  isRetryable,
  retryAfterOf,
} from "../../core/failures.js";
import {
  backoffDelayMs,
  DEFAULT_JOB_BACKOFF,
  DEFAULT_JOB_TIMEOUT_MS,
} from "../../core/operation.js";
import { type Job, jobs, type NewJob } from "../../db/schema/index.js";
import { createJobContext, loadWorkspace } from "../context.js";
import type { Kernel } from "../kernel.js";

export const DEFAULT_LEASE_MS = 5 * 60_000;
/** A job waiting without retryAt is re-run after this long, in case a wake-up was missed. */
export const WAIT_RECHECK_MS = 24 * 60 * 60_000;

export interface JobOutcome {
  id: string;
  name: string;
  status: JobStatus;
  error: string | null;
}

/** A job's last error, as stored in `jobs.last_error` and shown by `get_job`. */
export interface JobErrorRecord {
  code: string;
  message: string;
  hint?: string;
  /** The provider failure behind it (class, retryable, scope, provider, wait, status). */
  failure?: Failure;
  /** How long the error asked to wait before a retry. */
  retry_after_seconds?: number;
}

/**
 * Stored in jobs.last_error: JSON `{ code, message, hint?, failure?, retry_after_seconds? }`.
 * `failure` is the provider failure (classified for raw network errors and older provider
 * errors too).
 */
export function serializeJobError(error: unknown): string {
  const normalized = toOpenOutboundError(error);
  const message =
    normalized.code === "internal" && error instanceof Error ? error.message : normalized.message;
  const failure = failureOf(error);
  const wait = retryAfterOf(error);
  const record: JobErrorRecord = {
    code: normalized.code,
    message: message.slice(0, 1000),
    ...(normalized.hint ? { hint: normalized.hint } : {}),
    ...(failure ? { failure } : {}),
    ...(wait === undefined ? {} : { retry_after_seconds: wait }),
  };
  return JSON.stringify(record);
}

/**
 * Parses jobs.last_error back into a {@link JobErrorRecord}. Older rows (`{ code, message,
 * hint? }`, or plain text) still read; fields that do not parse are left out.
 */
export function parseJobError(lastError: string | null): JobErrorRecord | null {
  if (!lastError) return null;
  try {
    const parsed = JSON.parse(lastError) as Record<string, unknown>;
    if (typeof parsed.code === "string" && typeof parsed.message === "string") {
      const failure = failureSchema.safeParse(parsed.failure);
      const wait = parsed.retry_after_seconds;
      return {
        code: parsed.code,
        message: parsed.message,
        ...(typeof parsed.hint === "string" ? { hint: parsed.hint } : {}),
        ...(failure.success ? { failure: failure.data } : {}),
        ...(typeof wait === "number" && Number.isFinite(wait) && wait >= 0
          ? { retry_after_seconds: wait }
          : {}),
      };
    }
  } catch {
    // plain text
  }
  return { code: "internal", message: lastError };
}

/** The error of a job that ran past its timeout: a `timeout` failure, retried. */
function jobTimeoutError(timeoutMs: number): OpenOutboundError {
  const failure: Failure = { class: "timeout", retryable: true, scope: "call" };
  return new OpenOutboundError("provider_error", `The job timed out after ${timeoutMs} ms.`, {
    hint: "It will be retried; raise the job's timeoutMs if it regularly needs longer.",
    details: { reason: "timeout", retryable: true, failure },
  });
}

/** Claims up to `limit` due jobs for this worker, highest priority first. */
export async function claimJobs(
  kernel: Kernel,
  workerId: string,
  limit: number,
  leaseMs = DEFAULT_LEASE_MS,
): Promise<Job[]> {
  if (limit <= 0) return [];
  const now = kernel.clock.now();
  const names = kernel.registry.jobNames();
  if (names.length === 0) return [];
  const candidates = kernel.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        or(
          and(inArray(jobs.status, ["queued", "waiting"]), lte(jobs.run_at, now)),
          and(eq(jobs.status, "running"), lt(jobs.lease_expires_at, now)),
        ),
        inArray(jobs.name, names),
      ),
    )
    .orderBy(desc(jobs.priority), asc(jobs.run_at), asc(jobs.id))
    .limit(limit)
    .for("update", { skipLocked: true });
  const claimed = await kernel.db
    .update(jobs)
    .set({
      status: "running",
      lease_owner: workerId,
      lease_expires_at: new Date(now.getTime() + leaseMs),
      attempts: sql`${jobs.attempts} + 1`,
      wait_for: null,
    })
    .where(inArray(jobs.id, candidates))
    .returning();
  return claimed.sort(
    (a, b) =>
      b.priority - a.priority || a.run_at.getTime() - b.run_at.getTime() || (a.id < b.id ? -1 : 1),
  );
}

type AbortReason = "timeout" | "cancelled" | "shutdown";

/** Runs one claimed job to its next state and records it. Never throws. */
export async function runClaimedJob(
  kernel: Kernel,
  job: Job,
  options: { workerId: string; leaseMs?: number; shutdown?: AbortSignal },
): Promise<JobOutcome> {
  const { db, clock } = kernel;
  // Only a wake-up sent after this point can make a job that parks run again at once.
  const wakeMark = kernel.recentWakes.mark();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const log = kernel.log.child({ job_id: job.id, job: job.name });
  const owned = and(
    eq(jobs.id, job.id),
    eq(jobs.status, "running"),
    eq(jobs.lease_owner, options.workerId),
  );
  const finish = async (set: Partial<NewJob>): Promise<boolean> => {
    const rows = await db
      .update(jobs)
      .set({ lease_owner: null, lease_expires_at: null, ...set })
      .where(owned)
      .returning({ id: jobs.id });
    return rows.length > 0;
  };
  const result = (status: JobStatus, error: string | null = null): JobOutcome => ({
    id: job.id,
    name: job.name,
    status,
    error,
  });

  const definition = kernel.registry.job(job.name);
  if (!definition) {
    const error = serializeJobError(
      new OpenOutboundError("internal", `No handler is registered for job "${job.name}".`),
    );
    await finish({ status: "failed", finished_at: clock.now(), last_error: error });
    return result("failed", error);
  }
  if (job.attempts > job.max_attempts) {
    const error = serializeJobError(
      new OpenOutboundError("internal", "The lease expired during the last attempt.", {
        hint: "The worker stopped or the job ran longer than its lease; check the logs.",
      }),
    );
    await finish({ status: "failed", finished_at: clock.now(), last_error: error });
    return result("failed", error);
  }

  const controller = new AbortController();
  let abortReason: AbortReason | null = null;
  const abort = (reason: AbortReason) => {
    if (abortReason) return;
    abortReason = reason;
    controller.abort(new OpenOutboundError("internal", `Job aborted (${reason}).`));
  };
  const timeoutMs = definition.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  const timer = setTimeout(() => abort("timeout"), timeoutMs);
  timer.unref?.();
  const onShutdown = () => abort("shutdown");
  if (options.shutdown?.aborted) abort("shutdown");
  options.shutdown?.addEventListener("abort", onShutdown, { once: true });
  const renew = setInterval(
    () => {
      db.update(jobs)
        .set({ lease_expires_at: new Date(clock.now().getTime() + leaseMs) })
        .where(owned)
        .returning({ id: jobs.id })
        .then((rows) => {
          if (rows.length === 0) abort("cancelled");
        })
        .catch((error: unknown) => log.warn({ err: error }, "lease renewal failed"));
    },
    Math.max(1000, Math.floor(leaseMs / 3)),
  );
  renew.unref?.();

  try {
    const workspace = job.workspace_id ? await loadWorkspace(kernel, job.workspace_id) : null;
    if (job.workspace_id && !workspace) {
      await finish({ status: "cancelled", finished_at: clock.now() });
      return result("cancelled");
    }
    const ctx = createJobContext(kernel, job, workspace, controller.signal);
    const payload = definition.payload ? definition.payload.parse(job.payload) : job.payload;
    const aborted = new Promise<never>((_, reject) => {
      if (controller.signal.aborted) reject(controller.signal.reason);
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
        once: true,
      });
    });
    const value = await Promise.race([
      Promise.resolve().then(() => definition.handler(ctx, payload)),
      aborted,
    ]);
    const stored = await finish({
      status: "succeeded",
      result: value === undefined ? null : JSON.parse(JSON.stringify(value)),
      finished_at: clock.now(),
      last_error: null,
    });
    return result(stored ? "succeeded" : "cancelled");
  } catch (error) {
    const now = clock.now();
    if (abortReason === "cancelled") return result("cancelled");
    if (abortReason === "shutdown") {
      await finish({ status: "queued", run_at: now, attempts: Math.max(0, job.attempts - 1) });
      return result("queued");
    }
    if (isJobWaitError(error)) {
      // Woken while it ran: it may have read the state just before the wake, so it runs again.
      // A wake sent before it started does not count: it saw that state and still waits.
      const wokenRecently = kernel.recentWakes.addedSince(error.waitFor, wakeMark);
      const runAt = wokenRecently
        ? now
        : (error.retryAt ?? new Date(now.getTime() + WAIT_RECHECK_MS));
      await finish({
        status: wokenRecently ? "queued" : "waiting",
        wait_for: wokenRecently ? null : error.waitFor,
        run_at: runAt,
        attempts: Math.max(0, job.attempts - 1),
      });
      return result(wokenRecently ? "queued" : "waiting");
    }
    const cause = abortReason === "timeout" ? jobTimeoutError(timeoutMs) : error;
    const failure = toOpenOutboundError(cause);
    const serialized = serializeJobError(cause);
    // The one retry rule: permanent codes never, provider failures by their class.
    const retryable = isRetryable(cause);
    if (retryable && job.attempts < job.max_attempts) {
      // At least what the provider asked for, and never less than the backoff: a Retry-After
      // of 0 (or a date already past) must not spend every attempt in the same instant.
      const wait = retryAfterOf(cause);
      const backoff = backoffDelayMs(definition.backoff ?? DEFAULT_JOB_BACKOFF, job.attempts);
      const delay = wait !== undefined ? Math.max(wait * 1000, backoff) : backoff;
      await finish({
        status: "queued",
        run_at: new Date(now.getTime() + delay),
        last_error: serialized,
      });
      log.warn({ attempt: job.attempts, code: failure.code }, "job failed; will retry");
      return result("queued", serialized);
    }
    await finish({ status: "failed", finished_at: now, last_error: serialized });
    log.error({ attempt: job.attempts, code: failure.code, err: error }, "job failed");
    return result("failed", serialized);
  } finally {
    clearTimeout(timer);
    clearInterval(renew);
    options.shutdown?.removeEventListener("abort", onShutdown);
  }
}
