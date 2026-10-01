import { and, asc, eq, inArray, lt } from "drizzle-orm";
import { agentTaskWaitKey } from "../../brain/agent-tasks.js";
import type { OpContext } from "../../core/context.js";
import { type BuiltinSchedule, defineJob } from "../../core/operation.js";
import { agent_tasks, jobs } from "../../db/schema/index.js";

const BATCH = 500;

/**
 * Housekeeping for agent tasks past `expires_at`. Tasks with a waiting job are left to that job:
 * it is woken, sees the expiry and fails with a clear error (the task re-opens when the step runs
 * again). Tasks nobody waits for are marked expired.
 */
export async function expireAgentTasks(
  ctx: Pick<OpContext, "db" | "clock" | "jobs">,
): Promise<{ expired: number; woken: number }> {
  const now = ctx.clock.now();
  const due = await ctx.db
    .select({ id: agent_tasks.id })
    .from(agent_tasks)
    .where(and(inArray(agent_tasks.status, ["open", "claimed"]), lt(agent_tasks.expires_at, now)))
    .orderBy(asc(agent_tasks.expires_at))
    .limit(BATCH);
  if (due.length === 0) return { expired: 0, woken: 0 };
  const keys = due.map((task) => agentTaskWaitKey(task.id));
  const waiting = await ctx.db
    .select({ wait_for: jobs.wait_for })
    .from(jobs)
    .where(and(eq(jobs.status, "waiting"), inArray(jobs.wait_for, keys)));
  const waited = new Set(waiting.map((job) => job.wait_for));
  const orphaned = due
    .filter((task) => !waited.has(agentTaskWaitKey(task.id)))
    .map((task) => task.id);
  let expired = 0;
  if (orphaned.length > 0) {
    const rows = await ctx.db
      .update(agent_tasks)
      .set({ status: "expired", updated_at: now })
      .where(
        and(inArray(agent_tasks.id, orphaned), inArray(agent_tasks.status, ["open", "claimed"])),
      )
      .returning({ id: agent_tasks.id });
    expired = rows.length;
  }
  let woken = 0;
  for (const key of keys) {
    if (waited.has(key)) woken += await ctx.jobs.wake(key);
  }
  return { expired, woken };
}

export const expireAgentTasksJob = defineJob({
  name: "brain.expire_agent_tasks",
  handler: (ctx) => expireAgentTasks(ctx),
  maxAttempts: 3,
});

/** Hourly, instance-wide. */
export const expireAgentTasksSchedule: BuiltinSchedule = {
  name: "brain.expire_agent_tasks",
  cron: "17 * * * *",
  job: "brain.expire_agent_tasks",
  perWorkspace: false,
};
