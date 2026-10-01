import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  AGENT_TASK_DEFAULT_EXPIRE_HOURS,
  agentTaskWaitKey,
  BRAIN_TASK_KIND,
  brainTaskKey,
} from "../../brain/agent-tasks.js";
import { stableHash } from "../../brain/hash.js";
import { renderTranscript, requestExtras, type ServiceBrainRequest } from "../../brain/request.js";
import type { Clock } from "../../core/clock.js";
import { JobWaitError, OpenOutboundError } from "../../core/errors.js";
import { type Logger, silentLogger } from "../../core/logger.js";
import type { Db } from "../../db/client.js";
import { type AgentTask, agent_tasks } from "../../db/schema/index.js";
import { type BrainProvider, type BrainRequest, defineProvider } from "../types.js";
import { type BrainErrorContext, brainError } from "./errors.js";
import { testBrainProvider } from "./shared.js";

/** The model name recorded for agent-brain calls. */
export const AGENT_MODEL = "agent";

export const agentBrainConfigSchema = z.object({
  expire_hours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .optional()
    .describe(
      `Hours an open task waits for the agent (default ${AGENT_TASK_DEFAULT_EXPIRE_HOURS})`,
    ),
});
export type AgentBrainConfig = z.infer<typeof agentBrainConfigSchema>;

/** What an agent task stores as `input` for a delegated prompt. */
export interface AgentBrainTaskInput {
  prompt_id: string;
  prompt_version: number | null;
  tier: string | null;
  /** The prompt to answer (for repair calls: the conversation so far). */
  message: string;
  [key: string]: unknown;
}

/** `output` of a declined task. */
export interface DeclinedTaskOutput {
  decline_reason: string;
}

export interface CreateAgentBrainOptions {
  db: Db;
  clock: Clock;
  /** Workspace of the provider instance; the request's workspace wins. */
  workspaceId?: string | null;
  expireHours?: number;
  log?: Logger;
}

const CONTEXT: BrainErrorContext = { label: "Agent brain", providerId: "agent" };

/**
 * Delegates prompts to the connected agent (spec 11.2): each call becomes an `agent_tasks` row
 * with a deterministic task key (workspace + prompt id + vars hash, or the caller's task key).
 * While the task is open the call throws `JobWaitError("agent_task:<id>")`, which parks the job
 * until `submit_agent_task` wakes it; once done, the call returns the submitted output (the brain
 * service validates it like any model output). Tasks that expire fail the waiting call; running
 * the step again re-opens them.
 */
export function createAgentBrain(options: CreateAgentBrainOptions): BrainProvider {
  const expireMs = (options.expireHours ?? AGENT_TASK_DEFAULT_EXPIRE_HOURS) * 3_600_000;
  const log = options.log ?? silentLogger();

  async function findTask(taskKey: string): Promise<AgentTask | undefined> {
    const [row] = await options.db
      .select()
      .from(agent_tasks)
      .where(eq(agent_tasks.task_key, taskKey));
    return row;
  }

  /** Parks the caller until the task is answered, or until its deadline or expiry. */
  function wait(task: AgentTask, deadline: Date | null = null): never {
    const expiresAt = task.expires_at ?? null;
    const retryAt =
      deadline && (!expiresAt || deadline.getTime() < expiresAt.getTime()) ? deadline : expiresAt;
    throw new JobWaitError(agentTaskWaitKey(task.id), retryAt ?? undefined);
  }

  /**
   * Closes an open task whose time-sensitive wait ran out, with a note for the agent. False when
   * the agent answered it in the meantime.
   */
  async function closeForBackup(
    task: AgentTask,
    timeout: AgentTimeout,
    promptId: string,
    now: Date,
  ): Promise<boolean> {
    const closed = await options.db
      .update(agent_tasks)
      .set({
        status: "expired",
        output: { expired_note: backupNote(timeout, promptId) },
        completed_at: now,
        updated_at: now,
      })
      .where(and(eq(agent_tasks.id, task.id), inArray(agent_tasks.status, ["open", "claimed"])))
      .returning({ id: agent_tasks.id });
    if (closed.length > 0) {
      log.info(
        { task_id: task.id, prompt_id: promptId, fallback: timeout.fallback },
        "agent task not answered in time; the backup brain answers",
      );
    }
    return closed.length > 0;
  }

  async function createTask(
    workspaceId: string,
    taskKey: string,
    request: BrainRequest,
  ): Promise<AgentTask> {
    const extras = requestExtras(request);
    const now = options.clock.now();
    const input: AgentBrainTaskInput = {
      prompt_id: request.metadata?.promptId ?? "unknown",
      prompt_version: extras.promptVersion ?? null,
      tier: extras.tier ?? null,
      message: renderTranscript(request),
    };
    await options.db
      .insert(agent_tasks)
      .values({
        workspace_id: workspaceId,
        kind: BRAIN_TASK_KIND,
        task_key: taskKey,
        status: "open",
        instructions: request.system,
        input,
        output_schema: request.jsonSchema ?? null,
        expires_at: new Date(now.getTime() + expireMs),
        created_at: now,
        updated_at: now,
      })
      .onConflictDoNothing({ target: agent_tasks.task_key });
    const task = await findTask(taskKey);
    if (!task) throw new Error(`agent task ${taskKey} could not be created`);
    log.info(
      { task_id: task.id, prompt_id: input.prompt_id, workspace_id: workspaceId },
      "agent task created; waiting for the connected agent",
    );
    return task;
  }

  return {
    id: "agent",
    capabilities: { structuredOutput: "native", maxConcurrency: 32, caching: false },
    defaultModels: { fast: AGENT_MODEL, standard: AGENT_MODEL, deep: AGENT_MODEL },
    async generate(request) {
      const workspaceId = request.metadata?.workspaceId ?? options.workspaceId ?? null;
      if (!workspaceId) {
        throw new OpenOutboundError(
          "validation_failed",
          "The agent brain needs a workspace to create agent tasks.",
          { hint: "Run this step in a workspace (pass `workspace`)." },
        );
      }
      const promptId = request.metadata?.promptId ?? "unknown";
      const baseKey =
        request.metadata?.taskKey ??
        `${promptId}:${stableHash({ system: request.system, messages: request.messages, schema: request.jsonSchema ?? null }, 24)}`;
      const taskKey = brainTaskKey(workspaceId, baseKey);
      const now = options.clock.now();
      const timeout = requestExtras(request).agentTimeout;
      const deadlineOf = (row: AgentTask): Date | null =>
        timeout ? new Date(row.created_at.getTime() + timeout.limitMs) : null;
      let task = await findTask(taskKey);
      if (!task) {
        const created = await createTask(workspaceId, taskKey, request);
        return wait(created, deadlineOf(created));
      }

      if (task.workspace_id !== workspaceId) {
        throw new OpenOutboundError("conflict", "The agent task belongs to another workspace.", {
          details: { task_id: task.id },
        });
      }
      switch (task.status) {
        case "done":
          return doneResponse(task, request);
        case "failed": {
          const reason = (task.output as Partial<DeclinedTaskOutput> | null)?.decline_reason;
          throw brainError(
            CONTEXT,
            `The connected agent declined agent task ${task.id}${reason ? `: ${reason}` : "."}`,
            {
              reason: "declined",
              retryable: false,
              extra: { agent_task_id: task.id },
              hint: "Change the input and run the step again, or configure another brain provider with manage_providers (slot brain).",
            },
          );
        }
        case "expired": {
          // A time-sensitive task is not re-opened: the backup brain answers right away.
          if (timeout) throw timedOut(task, timeout, promptId);
          const expiresAt = new Date(now.getTime() + expireMs);
          await options.db
            .update(agent_tasks)
            .set({
              status: "open",
              claimed_by: null,
              claimed_at: null,
              output: null,
              completed_at: null,
              expires_at: expiresAt,
              updated_at: now,
            })
            .where(and(eq(agent_tasks.id, task.id), eq(agent_tasks.status, "expired")));
          log.info({ task_id: task.id }, "expired agent task re-opened");
          return wait({ ...task, expires_at: expiresAt });
        }
        default: {
          const deadline = deadlineOf(task);
          if (timeout && deadline && deadline.getTime() <= now.getTime()) {
            if (await closeForBackup(task, timeout, promptId, now)) {
              throw timedOut(task, timeout, promptId);
            }
            // The agent answered just now: use its answer.
            task = (await findTask(taskKey)) ?? task;
            if (task.status === "done") return doneResponse(task, request);
            throw timedOut(task, timeout, promptId);
          }
          if (task.expires_at && task.expires_at.getTime() <= now.getTime()) {
            await options.db
              .update(agent_tasks)
              .set({ status: "expired", updated_at: now })
              .where(
                and(eq(agent_tasks.id, task.id), inArray(agent_tasks.status, ["open", "claimed"])),
              );
            throw brainError(
              CONTEXT,
              `The connected agent did not complete agent task ${task.id} before it expired.`,
              {
                reason: "expired",
                retryable: false,
                extra: { agent_task_id: task.id },
                hint: "Run the step again to re-open the task, then complete it with get_agent_tasks and submit_agent_task; or configure another brain provider with manage_providers.",
              },
            );
          }
          return wait(task, deadline);
        }
      }
    },
  };
}

type AgentTimeout = NonNullable<ServiceBrainRequest["agentTimeout"]>;

function minutesOf(timeout: AgentTimeout): number {
  return Math.max(1, Math.round(timeout.limitMs / 60_000));
}

/** The note stored on a task closed for the backup brain (shown to the agent). */
function backupNote(timeout: AgentTimeout, promptId: string): string {
  return `Not answered within ${minutesOf(timeout)} minutes, so the backup brain (${timeout.fallback}) answered this ${promptId} task instead. Nothing to submit.`;
}

/** The failure that lets the backup brain answer a time-sensitive prompt. */
function timedOut(task: AgentTask, timeout: AgentTimeout, promptId: string): OpenOutboundError {
  return brainError(
    CONTEXT,
    `The connected agent did not answer agent task ${task.id} (${promptId}) within ${minutesOf(timeout)} minutes.`,
    {
      reason: "timeout",
      retryable: false,
      extra: { agent_task_id: task.id, fallback_provider: timeout.fallback },
      hint: `The backup brain (${timeout.fallback}) answers instead. Change the wait with workspace settings ai.agent_timeout_minutes.`,
    },
  );
}

function doneResponse(task: AgentTask, request: BrainRequest) {
  return {
    text: JSON.stringify(task.output ?? null),
    json: task.output,
    model: request.model || AGENT_MODEL,
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: null },
  };
}

export const agentBrainProvider = defineProvider({
  slot: "brain",
  id: "agent",
  name: "Your connected agent",
  description:
    "Delegates the AI work to the agent connected over MCP (for example Claude Code or Codex). Each prompt becomes an agent task: the agent reads it with get_agent_tasks and answers with submit_agent_task, and waiting jobs resume. No model keys needed; results wait until the agent answers.",
  configSchema: agentBrainConfigSchema,
  secrets: [],
  create: ({ config, ctx }) =>
    createAgentBrain({
      db: ctx.db,
      clock: ctx.clock,
      workspaceId: ctx.workspaceId,
      ...(config.expire_hours ? { expireHours: config.expire_hours } : {}),
      log: ctx.log,
    }),
  test: testBrainProvider,
});
