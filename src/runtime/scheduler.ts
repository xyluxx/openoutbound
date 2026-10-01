/**
 * Cron scheduler on the `schedules` table. Built-in schedules from modules are stored as
 * instance rows (workspace_id null); `perWorkspace` ones enqueue one job per workspace that is
 * not archived (paused workspaces still get jobs such as reply sync; sending jobs check the
 * pause themselves). Rows with a workspace_id (created by modules, e.g. report schedules) run
 * for that workspace. A missed run (engine down) runs once, not once per missed slot.
 */
import { Cron } from "croner";
import { and, eq, isNull, lte, ne } from "drizzle-orm";
import { OpenOutboundError } from "../core/errors.js";
import type { Db } from "../db/client.js";
import { type Schedule, schedules, workspaces } from "../db/schema/index.js";
import { createJobQueue } from "./jobs/queue.js";
import type { Kernel } from "./kernel.js";

/** Next run strictly after `from`, or null when the cron never fires again. Throws on bad crons. */
export function nextRunAt(cron: string, timezone: string, from: Date): Date | null {
  const job = new Cron(cron, { timezone, paused: true, mode: "5-or-6-parts" });
  try {
    return job.nextRun(from);
  } finally {
    job.stop();
  }
}

/** Validates a cron expression + timezone for inputs; throws `validation_failed` with a hint. */
export function assertValidCron(cron: string, timezone = "UTC"): void {
  try {
    nextRunAt(cron, timezone, new Date());
  } catch (error) {
    throw new OpenOutboundError("validation_failed", `Invalid schedule "${cron}" (${timezone}).`, {
      hint: 'Use a 5-field cron like "0 8 * * 1-5" (08:00 on weekdays) and an IANA timezone like "Europe/Berlin".',
      details: { cron, timezone, cause: (error as Error).message },
    });
  }
}

export interface SaveScheduleInput {
  workspaceId: string | null;
  name: string;
  cron: string;
  timezone?: string;
  job: string;
  payload?: Record<string, unknown>;
  enabled?: boolean;
}

/**
 * Creates or updates a schedule row (unique per workspace + name) and computes next_run_at.
 * For modules that store user schedules (report schedules, monitors).
 */
export async function saveSchedule(db: Db, now: Date, input: SaveScheduleInput): Promise<Schedule> {
  const timezone = input.timezone ?? "UTC";
  assertValidCron(input.cron, timezone);
  const values = {
    workspace_id: input.workspaceId,
    name: input.name,
    cron: input.cron,
    timezone,
    job_name: input.job,
    payload: input.payload ?? {},
    enabled: input.enabled ?? true,
    next_run_at: nextRunAt(input.cron, timezone, now),
  };
  const [row] = await db
    .insert(schedules)
    .values(values)
    .onConflictDoUpdate({
      target: [schedules.workspace_id, schedules.name],
      set: {
        cron: values.cron,
        timezone: values.timezone,
        job_name: values.job_name,
        payload: values.payload,
        enabled: values.enabled,
        next_run_at: values.next_run_at,
      },
    })
    .returning();
  if (!row) throw new OpenOutboundError("internal", "Failed to save the schedule.");
  return row;
}

/** Stores the modules' built-in schedules; keeps next_run_at unless cron or timezone changed. */
export async function syncBuiltinSchedules(kernel: Kernel): Promise<void> {
  const now = kernel.clock.now();
  for (const builtin of kernel.registry.schedules()) {
    const timezone = builtin.timezone ?? "UTC";
    const payload = builtin.payload ?? {};
    const [existing] = await kernel.db
      .select()
      .from(schedules)
      .where(and(isNull(schedules.workspace_id), eq(schedules.name, builtin.name)))
      .limit(1);
    if (!existing) {
      await kernel.db
        .insert(schedules)
        .values({
          workspace_id: null,
          name: builtin.name,
          cron: builtin.cron,
          timezone,
          job_name: builtin.job,
          payload,
          next_run_at: nextRunAt(builtin.cron, timezone, now),
        })
        .onConflictDoNothing();
      continue;
    }
    const timingChanged = existing.cron !== builtin.cron || existing.timezone !== timezone;
    const bodyChanged =
      existing.job_name !== builtin.job ||
      JSON.stringify(existing.payload) !== JSON.stringify(payload);
    if (!timingChanged && !bodyChanged) continue;
    await kernel.db
      .update(schedules)
      .set({
        cron: builtin.cron,
        timezone,
        job_name: builtin.job,
        payload,
        ...(timingChanged ? { next_run_at: nextRunAt(builtin.cron, timezone, now) } : {}),
      })
      .where(eq(schedules.id, existing.id));
  }
}

/**
 * Fires every due schedule once (claimed with an optimistic update on next_run_at, so two
 * workers never fire the same slot) and fills next_run_at for rows created without one.
 * Returns the number of jobs enqueued.
 */
export async function schedulerTick(kernel: Kernel): Promise<number> {
  const { db, clock, registry, log } = kernel;
  const now = clock.now();

  const unset = await db
    .select()
    .from(schedules)
    .where(and(eq(schedules.enabled, true), isNull(schedules.next_run_at)));
  for (const row of unset) {
    try {
      await db
        .update(schedules)
        .set({ next_run_at: nextRunAt(row.cron, row.timezone, now) })
        .where(and(eq(schedules.id, row.id), isNull(schedules.next_run_at)));
    } catch (error) {
      log.warn({ schedule: row.name, err: error }, "invalid schedule disabled");
      await db.update(schedules).set({ enabled: false }).where(eq(schedules.id, row.id));
    }
  }

  const due = await db
    .select()
    .from(schedules)
    .where(and(eq(schedules.enabled, true), lte(schedules.next_run_at, now)));
  let enqueued = 0;
  for (const row of due) {
    if (!row.next_run_at) continue;
    let next: Date | null;
    try {
      next = nextRunAt(row.cron, row.timezone, now);
    } catch (error) {
      log.warn({ schedule: row.name, err: error }, "invalid schedule disabled");
      await db.update(schedules).set({ enabled: false }).where(eq(schedules.id, row.id));
      continue;
    }
    const [claimed] = await db
      .update(schedules)
      .set({ next_run_at: next, last_run_at: now })
      .where(and(eq(schedules.id, row.id), eq(schedules.next_run_at, row.next_run_at)))
      .returning({ id: schedules.id });
    if (!claimed) continue;
    if (!registry.job(row.job_name)) {
      log.warn({ schedule: row.name, job: row.job_name }, "schedule points at an unknown job");
      continue;
    }
    const queue = createJobQueue(kernel, { workspaceId: row.workspace_id });
    const builtin = row.workspace_id === null ? registry.schedule(row.name) : undefined;
    if (builtin?.perWorkspace) {
      const targets = await db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(ne(workspaces.status, "archived"));
      for (const target of targets) {
        await queue.enqueue(
          row.job_name,
          { ...row.payload, workspace_id: target.id },
          { workspaceId: target.id, singletonKey: `schedule:${row.name}:${target.id}` },
        );
        enqueued++;
      }
    } else {
      await queue.enqueue(row.job_name, row.payload, {
        workspaceId: row.workspace_id,
        singletonKey: `schedule:${row.id}`,
      });
      enqueued++;
    }
  }
  return enqueued;
}
