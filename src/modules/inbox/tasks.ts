/**
 * Tasks for humans (follow-ups, referral reviews, manual steps). Automatic actions pass a
 * `dedupeKey` so re-running a classification never creates the same task twice.
 */
import { and, eq, sql } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import type { TaskType } from "../../core/enums.js";
import { type Task, tasks } from "../../db/schema/index.js";

export interface CreateTaskInput {
  title: string;
  type?: TaskType;
  notes?: string | null;
  dueAt?: Date | null;
  personId?: string | null;
  campaignId?: string | null;
  enrollmentId?: string | null;
  threadId?: string | null;
  dedupeKey?: string | null;
}

/** Creates a task in the context workspace; returns the existing one for a known dedupe key. */
export async function createTask(
  ctx: OpContext,
  input: CreateTaskInput,
): Promise<{ task: Task; created: boolean }> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .insert(tasks)
    .values({
      workspace_id: workspace.id,
      title: input.title.slice(0, 300),
      type: input.type ?? "other",
      notes: input.notes ?? null,
      due_at: input.dueAt ?? null,
      person_id: input.personId ?? null,
      campaign_id: input.campaignId ?? null,
      enrollment_id: input.enrollmentId ?? null,
      thread_id: input.threadId ?? null,
      dedupe_key: input.dedupeKey ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return { task: row, created: true };
  if (!input.dedupeKey) throw new Error("createTask: insert returned no row");
  const [existing] = await ctx.db
    .select()
    .from(tasks)
    .where(and(eq(tasks.workspace_id, workspace.id), eq(tasks.dedupe_key, input.dedupeKey)))
    .limit(1);
  if (!existing) throw new Error("createTask: dedupe conflict without an existing row");
  return { task: existing, created: false };
}

/**
 * Marks every open task of a person skipped (calls, manual emails and LinkedIn steps, follow-ups,
 * promises), with `Skipped: <why>` added to the notes. Returns how many.
 */
export async function skipOpenTasksForPerson(
  ctx: OpContext,
  personId: string,
  why: string,
): Promise<number> {
  const workspace = requireWorkspace(ctx);
  const rows = await ctx.db
    .update(tasks)
    .set({
      status: "skipped",
      completed_at: ctx.clock.now(),
      notes: sql`concat_ws(chr(10), ${tasks.notes}, ${`Skipped: ${why}`}::text)`,
    })
    .where(
      and(
        eq(tasks.workspace_id, workspace.id),
        eq(tasks.person_id, personId),
        eq(tasks.status, "open"),
      ),
    )
    .returning({ id: tasks.id });
  return rows.length;
}
