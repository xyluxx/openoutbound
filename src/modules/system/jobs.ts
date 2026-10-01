import { and, desc, eq, lt } from "drizzle-orm";
import { z } from "zod";
import type { OpContext } from "../../core/context.js";
import { JOB_STATUSES } from "../../core/enums.js";
import { notFound } from "../../core/errors.js";
import { failureSchema } from "../../core/failures.js";
import { idSchema } from "../../core/ids.js";
import { defineOperation, isoDateTime, paginated, paginationInput } from "../../core/operation.js";
import { decodeCursor, toPage } from "../../core/pagination.js";
import { type Job, jobs } from "../../db/schema/index.js";
import { parseJobError } from "../../runtime/jobs/runner.js";

const jobError = z.object({
  code: z.string(),
  message: z.string(),
  hint: z.string().optional(),
  failure: failureSchema
    .optional()
    .describe("The provider failure behind the error: class, retryable, scope, provider, wait"),
  retry_after_seconds: z.number().optional().describe("Wait the error asked for before a retry"),
});

export const jobOutput = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(JOB_STATUSES),
  progress: z.record(z.string(), z.unknown()).nullable(),
  result: z.unknown().optional(),
  error: jobError.nullable(),
  attempts: z.number(),
  max_attempts: z.number(),
  waiting_for: z.string().nullable().describe("What a waiting job waits for (e.g. an agent task)"),
  run_at: isoDateTime().describe(
    "When it runs next; for a waiting job, the latest time it re-checks even without a wake-up",
  ),
  workspace_id: z.string().nullable(),
  created_at: isoDateTime(),
  updated_at: isoDateTime(),
  finished_at: isoDateTime().nullable(),
});

export function toJobView(job: Job, options: { result: boolean }): z.input<typeof jobOutput> {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    progress: (job.progress as Record<string, unknown> | null) ?? null,
    ...(options.result ? { result: job.result ?? null } : {}),
    error: job.status === "succeeded" ? null : parseJobError(job.last_error),
    attempts: job.attempts,
    max_attempts: job.max_attempts,
    waiting_for: job.wait_for,
    run_at: job.run_at,
    workspace_id: job.workspace_id,
    created_at: job.created_at,
    updated_at: job.updated_at,
    finished_at: job.finished_at,
  };
}

/** Workspace keys (or an explicit workspace) only see that workspace's jobs. */
function visibility(ctx: OpContext) {
  return ctx.workspace ? eq(jobs.workspace_id, ctx.workspace.id) : undefined;
}

export const getJob = defineOperation({
  id: "jobs.get",
  summary: "Get a background job's status and result",
  description:
    "Returns a background job (research, enrichment, imports, sends) with its status (queued, running, waiting, succeeded, failed, cancelled), progress, result and error with a hint; a provider error also carries its failure (class, retryable, scope) and retry_after_seconds. Use it with the job_id that long operations return; poll every few seconds while it is queued or running. A waiting job waits for something (an agent task, a brain to be configured) and continues on its own; a queued job with an error is retried at run_at. Do not poll in a tight loop.",
  effect: "read",
  input: z.object({ job_id: idSchema("job").describe("job_id returned by a long operation") }),
  output: jobOutput,
  http: { method: "GET", path: "/v1/jobs/:job_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "optional",
  examples: [{ title: "Check a job", input: { job_id: "job_01k6a3v0q8x3m2n4p5r6s7t8v9" } }],
  handler: async (ctx, input) => {
    const [job] = await ctx.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, input.job_id), visibility(ctx)))
      .limit(1);
    if (!job) throw notFound("Job", input.job_id);
    return toJobView(job, { result: true });
  },
});

export const listJobs = defineOperation({
  id: "jobs.list",
  summary: "List background jobs",
  description:
    "Lists background jobs, newest first, filtered by status or job name. Use it to find failed jobs (status failed) and their errors, or to see what is still queued. For one job use jobs.get. Results are included only with response_format detailed.",
  effect: "read",
  input: paginationInput.extend({
    status: z.enum(JOB_STATUSES).optional(),
    name: z.string().max(100).optional().describe("Job name, e.g. research.run"),
  }),
  output: paginated(jobOutput),
  http: { method: "GET", path: "/v1/jobs" },
  dryRun: "none",
  idempotent: true,
  workspace: "optional",
  examples: [{ title: "Failed jobs", input: { status: "failed" } }],
  handler: async (ctx, input) => {
    const conditions = [visibility(ctx)];
    if (input.status) conditions.push(eq(jobs.status, input.status));
    if (input.name) conditions.push(eq(jobs.name, input.name));
    if (input.cursor) {
      const cursor = decodeCursor<{ id: string }>(input.cursor);
      conditions.push(lt(jobs.id, String(cursor.id)));
    }
    const rows = await ctx.db
      .select()
      .from(jobs)
      .where(and(...conditions))
      .orderBy(desc(jobs.id))
      .limit(input.limit + 1);
    const detailed = ctx.request.responseFormat === "detailed";
    return toPage(
      rows,
      input.limit,
      (row) => ({ id: row.id }),
      (row) => toJobView(row, { result: detailed }),
    );
  },
});

export const cancelJob = defineOperation({
  id: "jobs.cancel",
  summary: "Cancel a background job",
  description:
    "Cancels a queued, waiting or running job; a running job is stopped at its next lease check (within about a minute) and its partial work is kept. Use it to stop an import, research batch or enrichment you started by mistake. Finished jobs cannot be cancelled. Cancelling does not undo what the job already did.",
  effect: "write",
  input: z.object({ job_id: idSchema("job") }),
  output: z.object({ job_id: z.string(), cancelled: z.boolean(), status: z.enum(JOB_STATUSES) }),
  http: { method: "POST", path: "/v1/jobs/:job_id/cancel" },
  dryRun: "none",
  idempotent: true,
  workspace: "optional",
  examples: [{ title: "Cancel", input: { job_id: "job_01k6a3v0q8x3m2n4p5r6s7t8v9" } }],
  handler: async (ctx, input) => {
    const [job] = await ctx.db
      .select({ id: jobs.id, status: jobs.status })
      .from(jobs)
      .where(and(eq(jobs.id, input.job_id), visibility(ctx)))
      .limit(1);
    if (!job) throw notFound("Job", input.job_id);
    const cancelled = await ctx.jobs.cancel(job.id);
    const current = cancelled ? "cancelled" : job.status;
    return { job_id: job.id, cancelled, status: current };
  },
});
