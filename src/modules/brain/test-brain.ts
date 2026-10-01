import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, like } from "drizzle-orm";
import { z } from "zod";
import { BRAIN_TASK_KIND, brainTaskKey } from "../../brain/agent-tasks.js";
import type { BrainServiceWithRoute } from "../../brain/service.js";
import { type BrainRunOptions, type OpContext, requireWorkspace } from "../../core/context.js";
import { MODEL_TIERS } from "../../core/enums.js";
import { toOpenOutboundError } from "../../core/errors.js";
import { defineOperation } from "../../core/operation.js";
import { agent_tasks } from "../../db/schema/index.js";
import { connectionTestPrompt } from "./prompts/connection-test.js";

const testBrainOutput = z.object({
  ok: z.boolean(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  tier: z.enum(MODEL_TIERS),
  latency_ms: z.number().int(),
  echo_matches: z.boolean().nullable().describe("The model returned the test code unchanged"),
  usage: z
    .object({
      input_tokens: z.number().int(),
      output_tokens: z.number().int(),
      cost_usd: z.number().nullable(),
    })
    .nullable(),
  agent_task_id: z
    .string()
    .nullable()
    .describe(
      "Agent brain only: the test task the connected agent answers; run the test again after it is answered",
    ),
  error: z
    .object({ code: z.string(), message: z.string(), hint: z.string().nullable() })
    .nullable(),
});

const TASK_KEY_PREFIX = "brain.test:";

/** The latest brain-test task of the agent brain in this workspace, not yet used up. */
async function pendingAgentTest(
  ctx: OpContext,
  workspaceId: string,
): Promise<{ id: string; nonce: string } | null> {
  const prefix = brainTaskKey(workspaceId, TASK_KEY_PREFIX);
  const [task] = await ctx.db
    .select({ id: agent_tasks.id, task_key: agent_tasks.task_key })
    .from(agent_tasks)
    .where(
      and(
        eq(agent_tasks.workspace_id, workspaceId),
        eq(agent_tasks.kind, BRAIN_TASK_KIND),
        like(agent_tasks.task_key, `${prefix}%`),
        inArray(agent_tasks.status, ["open", "claimed", "done", "failed"]),
      ),
    )
    .orderBy(desc(agent_tasks.created_at))
    .limit(1);
  const nonce = task
    ? /^([0-9a-f]{8})(?::repair)?$/.exec(task.task_key.slice(prefix.length))
    : null;
  return task && nonce?.[1] ? { id: task.id, nonce: nonce[1] } : null;
}

/** Removes a finished test round (the task and its repair task), so the next test starts anew. */
async function clearAgentTest(ctx: OpContext, workspaceId: string, nonce: string): Promise<void> {
  await ctx.db
    .delete(agent_tasks)
    .where(
      and(
        eq(agent_tasks.workspace_id, workspaceId),
        like(agent_tasks.task_key, `${brainTaskKey(workspaceId, `${TASK_KEY_PREFIX}${nonce}`)}%`),
      ),
    );
}

export const testBrain = defineOperation({
  id: "brain.test",
  summary: "Check the AI brain with a tiny structured prompt",
  description:
    "Runs a tiny structured prompt (echo a code as JSON) against the workspace brain, or a given provider, tier or model, and reports provider, model, latency and whether it worked, with the error and its fix on failure. Use it after configuring a brain provider or when AI steps keep failing. Do not use it for data providers (use manage_providers action test). It spends a few tokens on API brains. With the agent brain it creates a small agent task (agent_task_id): the connected agent answers it with submit_agent_task, then run the test again to check the answer.",
  effect: "admin",
  input: z.object({
    tier: z.enum(MODEL_TIERS).optional().describe("Tier to test (default fast)"),
    provider: z
      .string()
      .min(1)
      .optional()
      .describe("Brain provider id to test, e.g. anthropic (default: the workspace brain)"),
    model: z.string().min(1).optional().describe("Model id to test (skips tier routing)"),
  }),
  output: testBrainOutput,
  http: { method: "POST", path: "/v1/brain/test" },
  dryRun: "none",
  idempotent: false,
  workspace: "required",
  examples: [
    { title: "Test the workspace brain", input: {} },
    { title: "Test the deep tier on Anthropic", input: { provider: "anthropic", tier: "deep" } },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const tier = input.tier ?? connectionTestPrompt.tier;
    // The test checks the brain itself: a failing main brain must not pass through the backup.
    const options: BrainRunOptions = { tier, noFallback: true };
    if (input.provider) options.provider = input.provider;
    if (input.model) options.model = input.model;
    const router = ctx.brain as Partial<BrainServiceWithRoute>;
    const routeOf = async () => {
      if (typeof router.route !== "function") return null;
      try {
        return await router.route(connectionTestPrompt, options);
      } catch {
        return null; // no route: running the prompt reports why
      }
    };
    // The agent brain answers later: reuse the open test task instead of creating a new one.
    const agent = (await routeOf())?.provider.id === "agent";
    const pending = agent ? await pendingAgentTest(ctx, workspace.id) : null;
    const nonce = pending?.nonce ?? randomBytes(4).toString("hex");
    options.taskKey = `${TASK_KEY_PREFIX}${nonce}`;
    const started = performance.now();
    const latency = () => Math.round(performance.now() - started);
    try {
      const result = await ctx.brain.run(connectionTestPrompt, { nonce }, options);
      if (pending) await clearAgentTest(ctx, workspace.id, nonce);
      const echoMatches = result.output.echo.trim() === nonce;
      const ok = result.output.ok === true && echoMatches;
      return {
        ok,
        provider: result.provider,
        model: result.model,
        tier,
        latency_ms: latency(),
        echo_matches: echoMatches,
        usage: {
          input_tokens: result.usage.inputTokens,
          output_tokens: result.usage.outputTokens,
          cost_usd: result.usage.costUsd,
        },
        agent_task_id: pending?.id ?? null,
        error: ok
          ? null
          : {
              code: "provider_error",
              message: `The brain answered but did not return the test code (expected ${nonce}, got ${JSON.stringify(result.output.echo).slice(0, 60)}).`,
              hint: "The model may be too small for structured tasks; configure a stronger model for this tier (provider config models or workspace settings ai.task_models).",
            },
      };
    } catch (caught) {
      const error = toOpenOutboundError(caught);
      const details = error.details ?? {};
      const taskId = typeof details.agent_task_id === "string" ? details.agent_task_id : null;
      if (error.code === "approval_required" && taskId) {
        return {
          ok: false,
          provider: "agent",
          model: typeof details.model === "string" ? details.model : "agent",
          tier,
          latency_ms: latency(),
          echo_matches: null,
          usage: null,
          agent_task_id: taskId,
          error: {
            code: error.code,
            message: `The agent brain is set up and created test task ${taskId}. The connected agent must answer it; every AI step waits for the agent the same way.`,
            hint: `In the connected agent, answer it with get_agent_tasks (action get, task_id ${taskId}) and submit_agent_task (CLI: openoutbound agent-tasks get --task-id ${taskId}, then agent-tasks submit), then run brain test (MCP: test_brain) again to check the answer.`,
          },
        };
      }
      // A declined or expired test task is finished: the next test starts a new one.
      if (pending) await clearAgentTest(ctx, workspace.id, nonce);
      let provider = typeof details.provider === "string" ? details.provider : null;
      let model = typeof details.model === "string" ? details.model : null;
      if (!provider || !model) {
        const route = await routeOf();
        provider ??= route?.provider.id ?? null;
        model ??= route?.model ?? null;
      }
      return {
        ok: false,
        provider,
        model,
        tier,
        latency_ms: latency(),
        echo_matches: null,
        usage: null,
        agent_task_id: taskId ?? pending?.id ?? null,
        error: { code: error.code, message: error.message, hint: error.hint ?? null },
      };
    }
  },
});
