/**
 * Durable job queue on the `jobs` table (spec 5.1). Enqueue validates the job name and payload,
 * dedupes on singleton keys (partial unique index over queued/running/waiting), and nudges the
 * in-process worker.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { JobQueue } from "../../core/context.js";
import { OpenOutboundError } from "../../core/errors.js";
import { DEFAULT_JOB_MAX_ATTEMPTS } from "../../core/operation.js";
import { type Job, jobs } from "../../db/schema/index.js";
import type { Kernel } from "../kernel.js";
import { assertInFence } from "../workspace-fence.js";

export const ACTIVE_JOB_STATUSES = ["queued", "running", "waiting"] as const;

function toJson(value: unknown): unknown {
  return value === undefined ? {} : JSON.parse(JSON.stringify(value));
}

/**
 * `defaults.workspaceId` is where jobs land when `enqueue` names no workspace. `fence` (see
 * workspace-fence) is the only workspace a context's jobs may land in; null for instance-level
 * contexts and the scheduler, which may enqueue for any workspace.
 */
export function createJobQueue(
  kernel: Kernel,
  defaults: { workspaceId: string | null; fence?: string | null },
): JobQueue {
  const { db, clock, registry } = kernel;
  return {
    async enqueue(name, payload = {}, options = {}) {
      const definition = registry.job(name);
      if (!definition) {
        throw new OpenOutboundError("internal", `Unknown job "${name}".`, {
          hint: "Register the job in the module's EngineModule.jobs.",
          details: { job: name },
        });
      }
      if (definition.payload) {
        const parsed = definition.payload.safeParse(payload);
        if (!parsed.success) {
          throw new OpenOutboundError("internal", `Invalid payload for job "${name}".`, {
            hint: "Fix the enqueue call so the payload matches the job's payload schema.",
            details: {
              job: name,
              issues: parsed.error.issues.map((issue) => ({
                path: issue.path.join("."),
                message: issue.message,
              })),
            },
          });
        }
      }
      const now = clock.now();
      const runAt =
        options.runAt ??
        (options.delayMs !== undefined ? new Date(now.getTime() + options.delayMs) : now);
      const workspaceId =
        options.workspaceId !== undefined ? options.workspaceId : defaults.workspaceId;
      assertInFence(defaults.fence ?? null, workspaceId, `enqueue job "${name}"`);
      for (let attempt = 0; attempt < 3; attempt++) {
        const [row] = await db
          .insert(jobs)
          .values({
            workspace_id: workspaceId,
            name,
            payload: toJson(payload),
            status: "queued",
            priority: options.priority ?? 0,
            run_at: runAt,
            max_attempts: options.maxAttempts ?? definition.maxAttempts ?? DEFAULT_JOB_MAX_ATTEMPTS,
            singleton_key: options.singletonKey ?? null,
            created_at: now,
          })
          .onConflictDoNothing()
          .returning({ id: jobs.id, status: jobs.status });
        if (row) {
          if (runAt.getTime() <= now.getTime()) kernel.nudge();
          return { job_id: row.id, status: row.status };
        }
        if (!options.singletonKey) break;
        const [existing] = await db
          .select({ id: jobs.id, status: jobs.status })
          .from(jobs)
          .where(
            and(
              eq(jobs.singleton_key, options.singletonKey),
              inArray(jobs.status, [...ACTIVE_JOB_STATUSES]),
            ),
          )
          .limit(1);
        if (existing) return { job_id: existing.id, status: existing.status, deduplicated: true };
      }
      throw new OpenOutboundError("internal", `Could not enqueue job "${name}".`, {
        hint: "Retry; if it keeps failing, check the database logs.",
      });
    },

    async get(jobId): Promise<Job | null> {
      const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
      return row ?? null;
    },

    async cancel(jobId) {
      const now = clock.now();
      const rows = await db
        .update(jobs)
        .set({
          status: "cancelled",
          finished_at: now,
          lease_owner: null,
          lease_expires_at: null,
          wait_for: null,
        })
        .where(and(eq(jobs.id, jobId), inArray(jobs.status, [...ACTIVE_JOB_STATUSES])))
        .returning({ id: jobs.id });
      return rows.length > 0;
    },

    async wake(waitFor) {
      kernel.recentWakes.add(waitFor);
      const rows = await db
        .update(jobs)
        .set({ status: "queued", run_at: clock.now(), wait_for: null })
        .where(and(eq(jobs.status, "waiting"), eq(jobs.wait_for, waitFor)))
        .returning({ id: jobs.id });
      if (rows.length > 0) kernel.nudge();
      return rows.length;
    },
  };
}
