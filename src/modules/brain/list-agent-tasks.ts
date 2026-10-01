import { and, asc, eq, gt, inArray, type SQL } from "drizzle-orm";
import { z } from "zod";
import { requireWorkspace } from "../../core/context.js";
import { AGENT_TASK_STATUSES } from "../../core/enums.js";
import { defineOperation, paginated, paginationInput } from "../../core/operation.js";
import { decodeCursor, toPage } from "../../core/pagination.js";
import { agent_tasks } from "../../db/schema/index.js";
import { agentTaskSummary, toAgentTaskSummary } from "./agent-task-view.js";

export const listAgentTasks = defineOperation({
  id: "agent_tasks.list",
  summary: "List agent tasks waiting for the connected agent",
  description:
    "Lists tasks the engine handed to you, the connected agent, oldest first. With the agent brain every AI step (research briefs, email drafts, reply classification) becomes a brain task here, and the jobs behind them wait until you answer. Use it to find open work, then read one task with action get and answer with submit_agent_task; do not use it to inspect background jobs (use get_job). Tasks expire after a few days, so work through open tasks first.",
  effect: "read",
  input: paginationInput.extend({
    status: z
      .array(z.enum(AGENT_TASK_STATUSES))
      .min(1)
      .default(["open", "claimed"])
      .describe("Statuses to include (default open and claimed)"),
    kind: z.string().min(1).optional().describe('Only this kind, e.g. "brain"'),
  }),
  output: paginated(agentTaskSummary),
  http: { method: "GET", path: "/v1/agent-tasks" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    { title: "Open tasks", input: {} },
    { title: "Done brain tasks", input: { status: ["done"], kind: "brain", limit: 10 } },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const conditions: SQL[] = [
      eq(agent_tasks.workspace_id, workspace.id),
      inArray(agent_tasks.status, input.status),
    ];
    if (input.kind) conditions.push(eq(agent_tasks.kind, input.kind));
    if (input.cursor) {
      const cursor = decodeCursor<{ id?: unknown }>(input.cursor);
      if (typeof cursor.id === "string") conditions.push(gt(agent_tasks.id, cursor.id));
    }
    const rows = await ctx.db
      .select()
      .from(agent_tasks)
      .where(and(...conditions))
      .orderBy(asc(agent_tasks.id))
      .limit(input.limit + 1);
    return toPage(rows, input.limit, (row) => ({ id: row.id }), toAgentTaskSummary);
  },
});
