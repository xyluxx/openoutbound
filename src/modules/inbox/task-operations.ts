/** tasks.* operations (manage_tasks). */
import { and, asc, eq, gt, inArray, lte, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { TASK_STATUSES, TASK_TYPES } from "../../core/enums.js";
import { notFound, OpenOutboundError } from "../../core/errors.js";
import { idSchema } from "../../core/ids.js";
import {
  dateTimeInput,
  defineOperation,
  paginated,
  paginationInput,
} from "../../core/operation.js";
import { decodeCursor, toPage } from "../../core/pagination.js";
import { type Task, tasks } from "../../db/schema/index.js";
import { resolveProblemsFor } from "../problems/service.js";
import { promiseOverdueKey } from "./promises.js";
import { findPerson, findThread } from "./reply-context.js";
import { taskView } from "./schemas.js";
import { createTask } from "./tasks.js";

const TASK_EXAMPLE_ID = "tk_01k6a3v0q8x3m2n4p5r6s7t8v9";
/** Sort key: due date (tasks without one last), then id. */
const dueKey = sql`coalesce(${tasks.due_at}, 'infinity'::timestamptz)`;

async function requireTask(ctx: OpContext, id: string): Promise<Task> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select()
    .from(tasks)
    .where(and(eq(tasks.workspace_id, workspace.id), eq(tasks.id, id)))
    .limit(1);
  if (!row) throw notFound("Task", id);
  return row;
}

export const listTasks = defineOperation({
  id: "tasks.list",
  summary: "List tasks for humans, soonest due first",
  description:
    "Lists human tasks (follow-ups, calls, manual emails, referral reviews), soonest due first. Tasks come from reply actions (not_now follow-ups in 90 days, referrals without an address, wrong-person suggestions) and campaign task steps. Use due_before to get what is due today. Use get_attention_queue for replies and approvals waiting on a human.",
  effect: "read",
  input: paginationInput.extend({
    status: z.array(z.enum(TASK_STATUSES)).default(["open"]),
    type: z.array(z.enum(TASK_TYPES)).optional(),
    person_id: idSchema("pe").optional(),
    due_before: dateTimeInput().optional().describe("Only tasks due at or before this time"),
  }),
  output: paginated(taskView),
  http: { method: "GET", path: "/v1/tasks" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Due this week", input: { due_before: "2026-10-02T23:59:59Z" } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const conditions: SQL[] = [eq(tasks.workspace_id, workspace.id)];
    if (input.status.length > 0) conditions.push(inArray(tasks.status, input.status));
    if (input.type?.length) conditions.push(inArray(tasks.type, input.type));
    if (input.person_id) conditions.push(eq(tasks.person_id, input.person_id));
    if (input.due_before) conditions.push(lte(tasks.due_at, input.due_before));
    if (input.cursor) {
      const cursor = decodeCursor<{ d: string; id: string }>(input.cursor);
      const after = or(
        sql`${dueKey} > ${cursor.d}::timestamptz`,
        and(sql`${dueKey} = ${cursor.d}::timestamptz`, gt(tasks.id, cursor.id)),
      );
      if (after) conditions.push(after);
    }
    const rows = await ctx.db
      .select()
      .from(tasks)
      .where(and(...conditions))
      .orderBy(asc(dueKey), asc(tasks.id))
      .limit(input.limit + 1);
    return toPage(rows, input.limit, (row) => ({
      d: row.due_at ? row.due_at.toISOString() : "infinity",
      id: row.id,
    }));
  },
});

export const createTaskOperation = defineOperation({
  id: "tasks.create",
  summary: "Create a task for a human",
  description:
    "Creates a task (call, manual_email, linkedin, follow_up, other) with an optional due time and a link to a person or thread. Use it for anything a human must do that the engine should not do on its own, such as a phone call or a personal note. Not for scheduling emails: campaigns and reply_to_thread send messages. Tasks never trigger sends.",
  effect: "write",
  input: z.object({
    title: z.string().min(1).max(300),
    type: z.enum(TASK_TYPES).default("other"),
    notes: z.string().max(4000).optional(),
    due_at: dateTimeInput().optional(),
    person_id: idSchema("pe").optional(),
    thread_id: idSchema("thr").optional(),
  }),
  output: taskView,
  http: { method: "POST", path: "/v1/tasks" },
  dryRun: "none",
  idempotent: false,
  workspace: "required",
  examples: [
    {
      title: "Call back",
      input: {
        title: "Call Dana about the pilot",
        type: "call",
        due_at: "2026-10-01T15:00:00Z",
        person_id: "pe_01k6a3v0q8x3m2n4p5r6s7t8v9",
      },
    },
  ],
  handler: async (ctx, input) => {
    if (input.person_id && !(await findPerson(ctx, input.person_id))) {
      throw notFound("Person", input.person_id);
    }
    const thread = input.thread_id ? await findThread(ctx, input.thread_id) : null;
    if (input.thread_id && !thread) throw notFound("Thread", input.thread_id);
    const { task } = await createTask(ctx, {
      title: input.title,
      type: input.type,
      notes: input.notes ?? null,
      dueAt: input.due_at ?? null,
      personId: input.person_id ?? thread?.person_id ?? null,
      threadId: thread?.id ?? null,
      campaignId: thread?.campaign_id ?? null,
    });
    return task;
  },
});

async function finish(ctx: OpContext, id: string, status: "done" | "skipped", note?: string) {
  const task = await requireTask(ctx, id);
  if (task.status !== "open") {
    if (task.status === status) return task;
    throw new OpenOutboundError("conflict", `Task ${id} is already ${task.status}.`, {
      hint: "Create a new task with manage_tasks (action create) if more work is needed.",
    });
  }
  const notes = note
    ? [task.notes, `${status === "done" ? "Done" : "Skipped"}: ${note}`].filter(Boolean).join("\n")
    : task.notes;
  const [row] = await ctx.db
    .update(tasks)
    .set({ status, completed_at: ctx.clock.now(), notes })
    .where(eq(tasks.id, task.id))
    .returning();
  if (task.type === "promise") {
    // A promise kept (or dropped) is no longer overdue.
    await resolveProblemsFor(
      ctx,
      { dedupeKey: promiseOverdueKey(task.id) },
      status === "done" ? "The promise was kept." : "The promise was skipped.",
    );
  }
  return row ?? task;
}

export const completeTask = defineOperation({
  id: "tasks.complete",
  summary: "Mark a task done",
  description:
    "Marks an open task done, with an optional note about the outcome. Use it after the human did the call, email or review. Use skip for tasks that are no longer needed. Completing twice is harmless.",
  effect: "write",
  input: z.object({ task_id: idSchema("tk"), note: z.string().max(1000).optional() }),
  output: taskView,
  http: { method: "POST", path: "/v1/tasks/:task_id/complete" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Done", input: { task_id: TASK_EXAMPLE_ID, note: "Booked a demo" } }],
  handler: (ctx, input) => finish(ctx, input.task_id, "done", input.note),
});

export const skipTask = defineOperation({
  id: "tasks.skip",
  summary: "Skip a task that is no longer needed",
  description:
    "Marks an open task skipped, with an optional note on why. Use it when the follow-up became irrelevant (the deal closed, the person left). Use complete when the work was done. Skipping twice is harmless.",
  effect: "write",
  input: z.object({
    task_id: idSchema("tk"),
    note: z.string().max(1000).optional().describe("Why it is no longer needed"),
  }),
  output: taskView,
  http: { method: "POST", path: "/v1/tasks/:task_id/skip" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    { title: "Skip", input: { task_id: TASK_EXAMPLE_ID, note: "Contact left the company" } },
  ],
  handler: (ctx, input) => finish(ctx, input.task_id, "skipped", input.note),
});

export const taskOperations = [listTasks, createTaskOperation, completeTask, skipTask];
