import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConcurrencyLimiter } from "../../brain/limiter.js";
import { createBrainService } from "../../brain/service.js";
import type { OpContext } from "../../core/context.js";
import { OpenOutboundError } from "../../core/errors.js";
import { agent_tasks } from "../../db/schema/index.js";
import { createAgentBrain } from "../../providers/brain/agent.js";
import { brainError } from "../../providers/brain/errors.js";
import type { BrainProvider } from "../../providers/types.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { connectionTestPrompt } from "./prompts/connection-test.js";
import { submitAgentTask } from "./submit-agent-task.js";
import { testBrain } from "./test-brain.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

const run = async (context: OpContext, input: Record<string, unknown> = {}) =>
  testBrain.output.parse(await testBrain.handler(context, testBrain.input.parse(input)));

function withRealBrain(context: TestContext, provider: BrainProvider | null): OpContext {
  context.providers.set("brain", provider);
  const brain = createBrainService({
    db: context.db,
    providers: context.providers,
    usage: context.usage,
    workspaceId: () => context.workspace.id,
    limiter: createConcurrencyLimiter(),
    sleep: async () => {},
  });
  return { ...context, brain };
}

describe("brain.test", () => {
  it("tests the workspace brain itself, never its backup", async () => {
    ctx.brain.on("brain.connection_test", (vars: { nonce: string }) => ({
      ok: true,
      echo: vars.nonce,
    }));
    await run(ctx, {});
    expect(ctx.brain.calls.at(-1)?.options?.noFallback).toBe(true);
  });

  it("reports provider, model, latency and usage when the brain echoes the code", async () => {
    ctx.brain.on("brain.connection_test", (vars: { nonce: string }) => ({
      ok: true,
      echo: vars.nonce,
    }));
    const result = await run(ctx, { tier: "standard" });
    expect(result).toMatchObject({
      ok: true,
      provider: "fake",
      model: "fake-standard",
      tier: "standard",
      echo_matches: true,
      error: null,
    });
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    expect(ctx.brain.calls.at(-1)?.options?.taskKey).toMatch(/^brain\.test:[0-9a-f]{8}$/);
  });

  it("fails when the answer does not contain the code", async () => {
    ctx.brain.on("brain.connection_test", { ok: true, echo: "something else" });
    const result = await run(ctx);
    expect(result.ok).toBe(false);
    expect(result.echo_matches).toBe(false);
    expect(result.error?.message).toContain("did not return the test code");
  });

  it("returns the error and its hint instead of throwing", async () => {
    ctx.brain.on("brain.connection_test", () => {
      throw new OpenOutboundError("provider_not_configured", "No AI brain is configured.", {
        hint: "Configure one with manage_providers.",
      });
    });
    const result = await run(ctx);
    expect(result).toMatchObject({
      ok: false,
      provider: null,
      usage: null,
      error: {
        code: "provider_not_configured",
        message: "No AI brain is configured.",
        hint: "Configure one with manage_providers.",
      },
    });
  });

  it("names the provider and model of a failing real brain", async () => {
    const context = await createTestContext({ db: ctx.testDb });
    const failing: BrainProvider = {
      id: "anthropic",
      capabilities: { structuredOutput: "native", maxConcurrency: 1, caching: false },
      defaultModels: { fast: "claude-haiku-4-5" },
      generate: async () => {
        throw brainError({ label: "Anthropic", providerId: "anthropic" }, "Bad key (401).", {
          reason: "auth",
          retryable: false,
          hint: "Set a valid key.",
        });
      },
    };
    const result = await run(withRealBrain(context, failing));
    expect(result).toMatchObject({
      ok: false,
      provider: "anthropic",
      model: "claude-haiku-4-5",
      tier: "fast",
      error: { code: "provider_error", hint: "Set a valid key." },
    });
  });

  it("passes provider and model options through and works in sandbox workspaces", async () => {
    const sandbox = await createTestContext({ db: ctx.testDb, sandbox: true });
    const result = await run(withRealBrain(sandbox, null), { model: "fake-anything" });
    expect(result).toMatchObject({ ok: true, provider: "fake", model: "fake-anything" });
  });
});

describe("brain.test with the agent brain", () => {
  async function agentContext() {
    const context = await createTestContext({ db: ctx.testDb });
    const agent = createAgentBrain({ db: context.db, clock: context.clock });
    return { context, op: withRealBrain(context, agent) };
  }

  async function taskNonce(taskId: string): Promise<string> {
    const [task] = await ctx.db.select().from(agent_tasks).where(eq(agent_tasks.id, taskId));
    const message = String((task?.input as { message?: unknown } | undefined)?.message);
    return /character for character: (\S+)/.exec(message)?.[1] ?? "";
  }

  it("hands the test to the connected agent, then passes once the agent answers it", async () => {
    const { context, op } = await agentContext();
    const first = await run(op);
    expect(first).toMatchObject({
      ok: false,
      provider: "agent",
      model: "agent",
      echo_matches: null,
      error: { code: "approval_required" },
    });
    const taskId = first.agent_task_id as string;
    expect(taskId).toMatch(/^tsk_/);
    expect(first.error?.message).toContain("connected agent must answer");
    expect(first.error?.hint).toContain(`get_agent_tasks (action get, task_id ${taskId})`);
    expect(first.error?.hint).toContain("submit_agent_task");
    expect(first.error?.hint).toContain("brain test");

    // Asking again before the agent answered points at the same task instead of a new one.
    expect((await run(op)).agent_task_id).toBe(taskId);

    const nonce = await taskNonce(taskId);
    await submitAgentTask.handler(
      context,
      submitAgentTask.input.parse({ task_id: taskId, output: { ok: true, echo: nonce } }),
    );
    const passed = await run(op);
    expect(passed).toMatchObject({
      ok: true,
      provider: "agent",
      echo_matches: true,
      error: null,
      agent_task_id: taskId,
    });

    // The answered test task is used once: the next test starts a new round.
    const next = await run(op);
    expect(next.ok).toBe(false);
    expect(next.agent_task_id).toMatch(/^tsk_/);
    expect(next.agent_task_id).not.toBe(taskId);
  });

  it("reports a declined test task and starts a new one next time", async () => {
    const { context, op } = await agentContext();
    const first = await run(op);
    const taskId = first.agent_task_id as string;
    await submitAgentTask.handler(
      context,
      submitAgentTask.input.parse({ task_id: taskId, decline_reason: "Not now." }),
    );
    const declined = await run(op);
    expect(declined).toMatchObject({ ok: false, provider: "agent", agent_task_id: taskId });
    expect(declined.error?.message).toContain("declined");
    const next = await run(op);
    expect(next.agent_task_id).not.toBe(taskId);
  });
});

describe("brain.connection_test prompt", () => {
  it("renders stable text", () => {
    expect(connectionTestPrompt.system({ nonce: "a1b2c3d4" })).toMatchInlineSnapshot(
      `"You are checking that an AI connection works. Reply with JSON only, exactly as the schema asks."`,
    );
    expect(connectionTestPrompt.user({ nonce: "a1b2c3d4" })).toMatchInlineSnapshot(
      `"Set ok to true and set echo to this code, character for character: a1b2c3d4"`,
    );
  });
});
