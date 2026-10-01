import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { agentTaskWaitKey } from "../../brain/agent-tasks.js";
import { stableStringify } from "../../brain/hash.js";
import { isJsonObject, type JsonSchema, schemaTypes } from "../../brain/json-schema.js";
import { describeIssues, stripNullOptionals } from "../../brain/output.js";
import { requireWorkspace } from "../../core/context.js";
import { AGENT_TASK_STATUSES } from "../../core/enums.js";
import { notFound, OpenOutboundError } from "../../core/errors.js";
import { idSchema } from "../../core/ids.js";
import { defineOperation } from "../../core/operation.js";
import { type AgentTask, agent_tasks } from "../../db/schema/index.js";
import { declineReasonOf, expiredNoteOf } from "./agent-task-view.js";

export type OutputCheck = { ok: true; value: unknown } | { ok: false; problems: string[] };

/**
 * Checks a submitted output against the task's JSON Schema. JSON sent as a string is parsed
 * when the schema expects an object or array, and nulls on optional fields are dropped (as the
 * brain service does for model output). A schema zod cannot rebuild is not checked here; the
 * brain service still validates the output when the waiting job resumes.
 */
export function checkTaskOutput(
  output: unknown,
  schema: JsonSchema | null | undefined,
): OutputCheck {
  let value = output;
  if (!schema || !isJsonObject(schema)) return { ok: true, value };
  if (typeof value === "string" && !schemaTypes(schema).includes("string")) {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      // validated as the string it is
    }
  }
  value = stripNullOptionals(value, schema);
  let validator: z.ZodType;
  try {
    validator = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    return { ok: true, value };
  }
  const result = validator.safeParse(value);
  return result.success
    ? { ok: true, value }
    : { ok: false, problems: describeIssues(result.error.issues) };
}

const submitOutput = z.object({
  id: z.string(),
  status: z.enum(AGENT_TASK_STATUSES),
  woke_jobs: z.number().int().describe("Waiting jobs that resume now"),
  message: z.string(),
});

function alreadyFinished(task: AgentTask, message: string) {
  return { id: task.id, status: task.status, woke_jobs: 0, message };
}

export const submitAgentTask = defineOperation({
  id: "agent_tasks.submit",
  summary: "Submit your answer to an agent task",
  description:
    "Completes an agent task with your answer: `output` must be one JSON value that matches the task's output_schema (read it with get_agent_tasks action get). The engine validates it, stores it and resumes the jobs waiting for it; invalid output is rejected with the exact fields to fix. If you cannot or should not do the task, send decline_reason instead of output. Resubmitting the same answer is safe; a different answer for a finished task is rejected.",
  effect: "write",
  input: z.object({
    task_id: idSchema("tsk").describe("Agent task id (tsk_...)"),
    output: z
      .unknown()
      .optional()
      .describe("Your answer: one JSON value matching the task's output_schema"),
    decline_reason: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .optional()
      .describe("Instead of output: why you cannot do this task"),
  }),
  output: submitOutput,
  http: { method: "POST", path: "/v1/agent-tasks/:task_id/submit" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Answer a reply classification task",
      input: {
        task_id: "tsk_01k6a3v0q8x3m2n4p5r6s7t8v9",
        output: { category: "interested", confidence: 0.9, summary: "Asks for a call next week" },
      },
    },
    {
      title: "Decline a task",
      input: {
        task_id: "tsk_01k6a3v0q8x3m2n4p5r6s7t8v9",
        decline_reason: "The input is empty, there is nothing to classify.",
      },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const hasOutput = input.output !== undefined;
    if (hasOutput === (input.decline_reason !== undefined)) {
      throw new OpenOutboundError(
        "validation_failed",
        "Send exactly one of output or decline_reason.",
        {
          hint: "Pass output (JSON matching output_schema) to complete the task, or decline_reason to decline it.",
        },
      );
    }
    const [task] = await ctx.db
      .select()
      .from(agent_tasks)
      .where(and(eq(agent_tasks.id, input.task_id), eq(agent_tasks.workspace_id, workspace.id)));
    if (!task) throw notFound("Agent task", input.task_id);

    let stored: unknown;
    if (hasOutput) {
      const check = checkTaskOutput(input.output, task.output_schema);
      if (!check.ok) {
        throw new OpenOutboundError(
          "validation_failed",
          "The output does not match the task's output_schema.",
          {
            hint: `Fix these and call submit_agent_task again: ${check.problems.join("; ")}`,
            details: { task_id: task.id, problems: check.problems },
          },
        );
      }
      stored = check.value;
    } else {
      stored = { decline_reason: input.decline_reason };
    }
    const target = hasOutput ? "done" : "failed";

    if (task.status === "done" || task.status === "failed" || task.status === "expired") {
      return finishedTask(task, target, stored);
    }

    const now = ctx.clock.now();
    const [updated] = await ctx.db
      .update(agent_tasks)
      .set({ status: target, output: stored, completed_at: now, updated_at: now })
      .where(and(eq(agent_tasks.id, task.id), inArray(agent_tasks.status, ["open", "claimed"])))
      .returning();
    if (!updated) {
      const [current] = await ctx.db.select().from(agent_tasks).where(eq(agent_tasks.id, task.id));
      if (!current) throw notFound("Agent task", task.id);
      return finishedTask(current, target, stored);
    }
    const woke = await ctx.jobs.wake(agentTaskWaitKey(task.id));
    const message =
      target === "failed"
        ? `Declined. ${woke > 0 ? `${woke} waiting job(s) resume and stop with your reason.` : "The step that asked will report your reason."}`
        : woke > 0
          ? `Saved. ${woke} waiting job(s) resume now.`
          : "Saved. The step that asked for it uses this answer when it runs again.";
    return { id: updated.id, status: updated.status, woke_jobs: woke, message };
  },
});

/** Resubmission of a finished task: idempotent for the same answer, a conflict otherwise. */
function finishedTask(task: AgentTask, target: "done" | "failed", stored: unknown) {
  const note = expiredNoteOf(task);
  if (note) {
    throw new OpenOutboundError("conflict", `Agent task ${task.id} is closed. ${note}`, {
      hint: "Nothing to do for this task. List open tasks with get_agent_tasks (action list).",
      details: { task_id: task.id, status: task.status },
    });
  }
  if (task.status === "expired") {
    throw new OpenOutboundError(
      "conflict",
      `Agent task ${task.id} expired before it was answered.`,
      {
        hint: "It re-opens when the step that created it runs again; then answer it with submit_agent_task.",
        details: { task_id: task.id, status: task.status },
      },
    );
  }
  const same =
    task.status === target &&
    (target === "done"
      ? stableStringify(task.output) === stableStringify(stored)
      : declineReasonOf(task) === (stored as { decline_reason?: string }).decline_reason);
  if (same) return alreadyFinished(task, "Already submitted with this answer; nothing changed.");
  throw new OpenOutboundError(
    "conflict",
    `Agent task ${task.id} is already ${task.status === "done" ? "done" : "declined"} with a different answer.`,
    {
      hint: "Finished tasks cannot be changed. List open tasks with get_agent_tasks (action list).",
      details: { task_id: task.id, status: task.status },
    },
  );
}
