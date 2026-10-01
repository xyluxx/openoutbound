import type { EngineModule } from "../../core/operation.js";
import { expireAgentTasksJob, expireAgentTasksSchedule } from "./expire-agent-tasks.js";
import { getAgentTask } from "./get-agent-task.js";
import { listAgentTasks } from "./list-agent-tasks.js";
import { submitAgentTask } from "./submit-agent-task.js";
import { testBrain } from "./test-brain.js";
import { getAgentTasksTool, submitAgentTaskTool, testBrainTool } from "./tools.js";

/**
 * The brain module: agent tasks (the agent brain's inbox for the connected agent), the brain
 * connection test and agent task expiry. The BrainService lives in `src/brain`; the brain
 * providers are registered in `src/providers/brain/index.ts`.
 */
export const module: EngineModule = {
  name: "brain",
  operations: [listAgentTasks, getAgentTask, submitAgentTask, testBrain],
  tools: [getAgentTasksTool, submitAgentTaskTool, testBrainTool],
  jobs: [expireAgentTasksJob],
  schedules: [expireAgentTasksSchedule],
};
