/** Shared helpers for agent tasks (the agent brain provider and the agent_tasks operations). */

/** agent_tasks.kind for prompts delegated by the agent brain. */
export const BRAIN_TASK_KIND = "brain";

/** Jobs waiting for a task park with `JobWaitError(agentTaskWaitKey(id))`. */
export function agentTaskWaitKey(taskId: string): string {
  return `agent_task:${taskId}`;
}

/** The task id inside a wait key, or undefined for other keys. */
export function agentTaskIdFromWaitKey(waitFor: string): string | undefined {
  return waitFor.startsWith("agent_task:") ? waitFor.slice("agent_task:".length) : undefined;
}

/**
 * agent_tasks.task_key for a brain call. The column is unique across the instance, so the key
 * includes the workspace. `taskKey` comes from the brain service: the caller's stable key, or
 * prompt id + version + a hash of the vars (plus ":repair" for the repair call).
 */
export function brainTaskKey(workspaceId: string, taskKey: string): string {
  return `brain:${workspaceId}:${taskKey}`;
}

/** Default lifetime of an open agent task. */
export const AGENT_TASK_DEFAULT_EXPIRE_HOURS = 7 * 24;
