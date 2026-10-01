import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  isJobWaitError,
  isOpenOutboundError,
  JobWaitError,
  type OpenOutboundError,
} from "../core/errors.js";
import { brainError } from "../providers/brain/errors.js";
import type { BrainProvider, BrainResponse } from "../providers/types.js";
import {
  createTestContext,
  type TestContext,
  type TestContextOptions,
} from "../testing/context.js";
import type { TestDb } from "../testing/db.js";
import { createTestDb } from "../testing/db.js";
import { createFakeBrain } from "../testing/fake-brain.js";
import type { BrainHealthReporter } from "./fallback.js";
import { type ConcurrencyLimiter, createConcurrencyLimiter } from "./limiter.js";
import { definePrompt } from "./prompt.js";
import type { ServiceBrainRequest } from "./request.js";
import { assertBrainReady, type BrainServiceDeps, createBrainService } from "./service.js";

const draftPrompt = definePrompt({
  id: "test.write_draft",
  version: 2,
  tier: "standard",
  system: (vars: { name: string }) => `You write short emails for ${vars.name}.`,
  user: (vars: { name: string }) => `Write to ${vars.name}.`,
  schema: z.object({
    subject: z.string().min(3),
    body: z.string(),
    ps: z.string().optional(),
  }),
  maxTokens: 500,
});

type Step = BrainResponse | Error | ((request: ServiceBrainRequest) => Promise<BrainResponse>);

function reply(json: unknown, overrides: Partial<BrainResponse> = {}): BrainResponse {
  return {
    text: JSON.stringify(json),
    json,
    model: "claude-sonnet-5",
    usage: { inputTokens: 1000, outputTokens: 200 },
    ...overrides,
  };
}

const GOOD = { subject: "Quick idea", body: "Hi Dana." };

function scripted(steps: Step[], overrides: Partial<BrainProvider> = {}) {
  const requests: ServiceBrainRequest[] = [];
  const provider: BrainProvider = {
    id: "scripted",
    capabilities: { structuredOutput: "native", maxConcurrency: 4, caching: false },
    defaultModels: { fast: "claude-haiku-4-5", standard: "claude-sonnet-5", deep: "claude-opus-5" },
    async generate(request) {
      requests.push(request as ServiceBrainRequest);
      const step = steps.length > 1 ? steps.shift() : steps[0];
      if (step === undefined) throw new Error("no scripted step left");
      if (step instanceof Error) throw step;
      return typeof step === "function" ? step(request as ServiceBrainRequest) : step;
    },
    ...overrides,
  };
  return { provider, requests };
}

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

async function setup(
  provider: BrainProvider | BrainProvider[] | null,
  options: Omit<TestContextOptions, "db"> = {},
  deps: Partial<BrainServiceDeps> = {},
) {
  const ctx: TestContext = await createTestContext({
    db,
    ...options,
    ...(provider ? { providers: { brain: provider } } : {}),
  });
  const sleeps: number[] = [];
  const brain = createBrainService({
    db: ctx.db,
    providers: ctx.providers,
    usage: ctx.usage,
    workspaceId: () => ctx.workspace.id,
    limiter: createConcurrencyLimiter(),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...deps,
  });
  return { ctx, brain, sleeps };
}

async function failure(promise: Promise<unknown>): Promise<OpenOutboundError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!isOpenOutboundError(error)) throw new Error(`expected an OpenOutboundError, got ${error}`);
  return error;
}

describe("brain service: structured output", () => {
  it("runs a prompt, validates the output and meters usage with cost", async () => {
    const { provider, requests } = scripted([reply(GOOD)]);
    const { ctx, brain } = await setup(provider);
    const result = await brain.run(draftPrompt, { name: "Dana" }, { jobId: "job_1" });
    expect(result).toMatchObject({
      output: GOOD,
      provider: "scripted",
      model: "claude-sonnet-5",
      repaired: false,
      usage: { inputTokens: 1000, outputTokens: 200, cachedTokens: 0, costUsd: 0.004 },
    });
    const request = requests[0] as ServiceBrainRequest;
    expect(request.system).toBe("You write short emails for Dana.");
    expect(request.messages).toEqual([{ role: "user", content: "Write to Dana." }]);
    expect(request.model).toBe("claude-sonnet-5");
    expect(request.maxTokens).toBe(500);
    expect(request.tier).toBe("standard");
    expect(request.schemaName).toBe("test_write_draft");
    expect(request.jsonSchema).toMatchObject({ type: "object" });
    expect(request.metadata?.taskKey).toMatch(/^test\.write_draft:v2:[0-9a-f]{24}$/);
    expect(ctx.recorded.usage).toEqual([
      expect.objectContaining({
        workspaceId: ctx.workspace.id,
        slot: "brain",
        provider: "scripted",
        operation: "test.write_draft",
        model: "claude-sonnet-5",
        inputTokens: 1000,
        outputTokens: 200,
        costUsd: 0.004,
        jobId: "job_1",
      }),
    ]);
  });

  it("describes the schema in the system prompt for providers without native structured output", async () => {
    const { provider, requests } = scripted([reply(GOOD)], {
      capabilities: { structuredOutput: "json_mode", maxConcurrency: 1, caching: false },
    });
    const { brain } = await setup(provider);
    await brain.run(draftPrompt, { name: "Dana" });
    expect(requests[0]?.system).toContain("You write short emails for Dana.");
    expect(requests[0]?.system).toContain('"subject"');
  });

  it("drops nulls strict providers send for optional fields and parses JSON text", async () => {
    const { provider } = scripted([
      {
        text: `Sure:\n\`\`\`json\n${JSON.stringify({ ...GOOD, ps: null })}\n\`\`\``,
        model: "claude-sonnet-5",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    const { brain } = await setup(provider);
    const result = await brain.run(draftPrompt, { name: "Dana" });
    expect(result.output).toEqual(GOOD);
    expect(result.repaired).toBe(false);
  });

  it("repairs invalid output once, with the problems and the previous reply", async () => {
    const { provider, requests } = scripted([reply({ subject: "Hi" }), reply(GOOD)]);
    const { ctx, brain } = await setup(provider);
    const result = await brain.run(draftPrompt, { name: "Dana" });
    expect(result.repaired).toBe(true);
    expect(result.output).toEqual(GOOD);
    expect(result.usage).toMatchObject({ inputTokens: 2000, outputTokens: 400, costUsd: 0.008 });
    const repair = requests[1] as ServiceBrainRequest;
    expect(repair.attempt).toBe(2);
    expect(repair.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(repair.messages[1]?.content).toBe('{"subject":"Hi"}');
    expect(repair.messages[2]?.content).toContain("subject:");
    expect(repair.messages[2]?.content).toContain("body:");
    expect(repair.metadata?.taskKey).toMatch(/:repair$/);
    expect(ctx.recorded.usage).toHaveLength(2);
  });

  it("fails with the remaining problems when the repair is invalid too", async () => {
    const { provider } = scripted([
      {
        text: "I cannot answer in JSON.",
        model: "claude-sonnet-5",
        usage: { inputTokens: 5, outputTokens: 5 },
      },
      reply({ subject: "Hi" }),
    ]);
    const { brain } = await setup(provider);
    const error = await failure(brain.run(draftPrompt, { name: "Dana" }));
    expect(error.code).toBe("provider_error");
    expect(error.details).toMatchObject({
      reason: "invalid_output",
      prompt_id: "test.write_draft",
    });
    expect(((error.details?.problems ?? []) as string[]).join(" ")).toContain("subject");
    expect(error.hint).toContain('ai.task_models["test.write_draft"]');
  });
});

describe("brain service: budgets, limits and failures", () => {
  it("checks the AI budget before calling the provider", async () => {
    const { provider, requests } = scripted([reply(GOOD)]);
    const { brain } = await setup(provider, { overBudget: ["ai"] });
    const error = await failure(brain.run(draftPrompt, { name: "Dana" }));
    expect(error.code).toBe("budget_exceeded");
    expect(requests).toHaveLength(0);
  });

  it("limits parallel calls per provider", async () => {
    let inFlight = 0;
    let peak = 0;
    const { provider } = scripted(
      [
        async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 15));
          inFlight--;
          return reply(GOOD);
        },
      ],
      { capabilities: { structuredOutput: "native", maxConcurrency: 2, caching: false } },
    );
    const { brain } = await setup(provider);
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) => brain.run(draftPrompt, { name: `Lead ${index}` })),
    );
    expect(results).toHaveLength(5);
    expect(peak).toBe(2);
  });

  it("keys the concurrency limit by the provider's lane", async () => {
    const lanes: string[] = [];
    const inner = createConcurrencyLimiter();
    const limiter: ConcurrencyLimiter = {
      ...inner,
      run(key, limit, task, signal) {
        lanes.push(`${key}/${limit}`);
        return inner.run(key, limit, task, signal);
      },
    };
    const lane = { id: "scripted", concurrencyKey: "scripted:http://localhost:11434/v1" };
    const { provider } = scripted([reply(GOOD)], lane);
    const { brain } = await setup(provider, {}, { limiter });
    await brain.run(draftPrompt, { name: "Dana" });
    expect(lanes).toEqual(["scripted:http://localhost:11434/v1/4"]);
  });

  it("times out a hanging call, aborts its signal and retries it", async () => {
    const signals: AbortSignal[] = [];
    const { provider } = scripted([
      (request) => {
        if (request.signal) signals.push(request.signal);
        return new Promise<BrainResponse>(() => {});
      },
      async () => reply(GOOD),
    ]);
    const { brain, sleeps } = await setup(provider, {}, { timeoutMs: 20 });
    const result = await brain.run(draftPrompt, { name: "Dana" });
    expect(result.output).toEqual(GOOD);
    expect(signals[0]?.aborted).toBe(true);
    expect(sleeps).toHaveLength(1);

    const hanging = scripted([() => new Promise<BrainResponse>(() => {})]);
    const once = await setup(hanging.provider, {}, { timeoutMs: 20, maxAttempts: 1 });
    const error = await failure(once.brain.run(draftPrompt, { name: "Dana" }));
    expect(error.details).toMatchObject({ reason: "timeout", provider: "scripted" });
  });

  it("retries rate limits honoring Retry-After, and fails fast on long waits", async () => {
    const context = { label: "Scripted", providerId: "scripted" };
    const limited = () =>
      brainError(context, "rate limited", {
        reason: "rate_limited",
        retryable: true,
        retryAfterSeconds: 7,
        usage: { inputTokens: 10, outputTokens: 0 },
      });
    const { provider, requests } = scripted([limited(), reply(GOOD)]);
    const { ctx, brain, sleeps } = await setup(provider);
    await brain.run(draftPrompt, { name: "Dana" });
    expect(requests).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(7000);
    // The failed call's spend is metered too.
    expect(ctx.recorded.usage.map((row) => row.inputTokens)).toEqual([10, 1000]);

    const slow = scripted([
      brainError(context, "rate limited", {
        reason: "rate_limited",
        retryable: true,
        retryAfterSeconds: 600,
      }),
    ]);
    const fast = await setup(slow.provider);
    const error = await failure(fast.brain.run(draftPrompt, { name: "Dana" }));
    expect(error.retryAfterSeconds).toBe(600);
    expect(slow.requests).toHaveLength(1);
  });

  it("gives up after max attempts and never retries permanent errors", async () => {
    const context = { label: "Scripted", providerId: "scripted" };
    const overloaded = scripted([
      brainError(context, "overloaded", { reason: "overloaded", retryable: true }),
    ]);
    const first = await setup(overloaded.provider, {}, { maxAttempts: 3 });
    await failure(first.brain.run(draftPrompt, { name: "Dana" }));
    expect(overloaded.requests).toHaveLength(3);
    expect(first.sleeps).toHaveLength(2);

    const auth = scripted([brainError(context, "bad key", { reason: "auth", retryable: false })]);
    const second = await setup(auth.provider);
    const error = await failure(second.brain.run(draftPrompt, { name: "Dana" }));
    expect(auth.requests).toHaveLength(1);
    expect(error.details).toMatchObject({
      reason: "auth",
      provider: "scripted",
      model: "claude-sonnet-5",
      prompt_id: "test.write_draft",
    });
  });

  it("wraps plain errors from plug-ins and retries network failures", async () => {
    const network = scripted([new TypeError("fetch failed"), reply(GOOD)]);
    const first = await setup(network.provider);
    await first.brain.run(draftPrompt, { name: "Dana" });
    expect(network.requests).toHaveLength(2);

    const broken = scripted([new Error("plug-in exploded")]);
    const second = await setup(broken.provider);
    const error = await failure(second.brain.run(draftPrompt, { name: "Dana" }));
    expect(error.code).toBe("provider_error");
    expect(error.message).toContain("plug-in exploded");
    expect(error.details).toMatchObject({ reason: "provider_failure", retryable: false });
    expect(broken.requests).toHaveLength(1);
  });

  it("stops when the caller aborts", async () => {
    const { provider } = scripted([() => new Promise<BrainResponse>(() => {})]);
    const { brain } = await setup(provider);
    const controller = new AbortController();
    const running = brain.run(draftPrompt, { name: "Dana" }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const error = await failure(running);
    expect(error.details).toMatchObject({ reason: "aborted", retryable: false });
  });
});

describe("brain service: routing", () => {
  it("uses the prompt tier, run options and workspace task_models", async () => {
    const { provider, requests } = scripted([reply(GOOD)]);
    const other = scripted([reply(GOOD, { model: "gpt-6-astra" })], {
      id: "other",
      defaultModels: { standard: "other-standard" },
    });
    const { brain } = await setup([provider, other.provider], {
      settings: {
        ai: {
          task_models: {
            deep: { model: "claude-fable-5-1" },
            "test.write_draft": { provider: "other", model: "gpt-6-astra" },
          },
        },
      },
    });
    const routed = await brain.run(draftPrompt, { name: "Dana" });
    expect(routed.provider).toBe("other");
    expect(other.requests[0]?.model).toBe("gpt-6-astra");

    await brain.run(draftPrompt, { name: "Dana" }, { provider: "scripted", tier: "fast" });
    expect(requests[0]?.model).toBe("claude-haiku-4-5");
    expect(requests[0]?.tier).toBe("fast");

    await brain.run(draftPrompt, { name: "Dana" }, { provider: "scripted", model: "my-model" });
    expect(requests[1]?.model).toBe("my-model");

    const route = await brain.route({ ...draftPrompt, id: "test.other" }, { tier: "deep" });
    expect(route).toMatchObject({ tier: "deep", model: "claude-fable-5-1" });
    expect(route.provider.id).toBe("scripted");
  });

  it("explains a missing brain provider", async () => {
    const { brain } = await setup(null);
    const error = await failure(brain.run(draftPrompt, { name: "Dana" }));
    expect(error.code).toBe("provider_not_configured");
    expect(error.hint).toContain("manage_providers");
    expect(error.hint).toContain("ANTHROPIC_API_KEY");
  });

  it("parks a job until a brain is configured, without using an attempt", async () => {
    const { ctx, brain } = await setup(null);
    const error = await brain
      .run(draftPrompt, { name: "Dana" }, { jobId: "job_1" })
      .catch((caught: unknown) => caught);
    expect(isJobWaitError(error)).toBe(true);
    expect((error as JobWaitError).waitFor).toBe(`brain:configured:${ctx.workspace.id}`);
    // A provider the caller forced is reported, never waited for.
    const forced = await failure(
      brain.run(draftPrompt, { name: "Dana" }, { jobId: "job_1", provider: "anthropic" }),
    );
    expect(forced.code).toBe("provider_not_configured");
  });

  it("checks that a brain is ready the way run decides, without calling a model", async () => {
    const downs: string[] = [];
    const health: BrainHealthReporter = {
      down: async (input) => {
        downs.push(input.provider);
      },
      up: async () => {},
    };
    // No brain: in a job the same wait as run (reported as brain_down), else the same error.
    const none = await setup(null, {}, { health });
    const wait = await none.brain
      .ready(draftPrompt, { jobId: "job_1" })
      .catch((caught: unknown) => caught);
    expect(isJobWaitError(wait)).toBe(true);
    expect((wait as JobWaitError).waitFor).toBe(`brain:configured:${none.ctx.workspace.id}`);
    expect(downs).toEqual(["none"]);
    expect((await failure(none.brain.ready(draftPrompt))).code).toBe("provider_not_configured");

    // A configured brain, or a backup brain while the routed one is missing: ready, no call.
    const { provider, requests } = scripted([reply(GOOD)]);
    const configured = await setup(provider);
    await expect(configured.brain.ready(draftPrompt, { jobId: "job_1" })).resolves.toBeUndefined();
    const backedUp = await setup(provider, {
      settings: {
        ai: {
          task_models: { "test.write_draft": { provider: "missing" } },
          fallback_provider: "scripted",
        },
      },
    });
    await expect(backedUp.brain.ready(draftPrompt, { jobId: "job_1" })).resolves.toBeUndefined();
    expect(requests).toHaveLength(0);
    expect(configured.ctx.recorded.usage).toHaveLength(0);

    // A brain without the check (a test fake) counts as ready.
    await expect(assertBrainReady(createFakeBrain(), draftPrompt)).resolves.toBeUndefined();
    await expect(
      assertBrainReady(none.brain, draftPrompt, { jobId: "job_1" }),
    ).rejects.toBeInstanceOf(JobWaitError);
  });

  it("uses the fake brain in sandbox workspaces unless use_real_brain is on", async () => {
    const { provider, requests } = scripted([reply(GOOD)]);
    const sandbox = await setup(provider, { sandbox: true });
    const result = await sandbox.brain.run(draftPrompt, { name: "Dana" });
    expect(result.provider).toBe("fake");
    expect(draftPrompt.schema.safeParse(result.output).success).toBe(true);
    expect(result.usage.costUsd).toBe(0);
    expect(requests).toHaveLength(0);

    const real = await setup(provider, {
      sandbox: true,
      settings: { sandbox: { use_real_brain: true } },
    });
    expect((await real.brain.run(draftPrompt, { name: "Dana" })).provider).toBe("scripted");
  });

  it("skips budgets and records usage without a workspace for instance-level calls", async () => {
    const { provider } = scripted([reply(GOOD)]);
    const { ctx, brain } = await setup(provider, { overBudget: ["ai"] });
    await brain.run(draftPrompt, { name: "Dana" }, { workspaceId: null });
    expect(ctx.recorded.usage[0]?.workspaceId).toBeNull();
  });
});

describe("brain service: agent brain waits", () => {
  const waiting = () => scripted([new JobWaitError("agent_task:tsk_01k6a3v0q8x3m2n4p5r6s7t8v9")]);

  it("passes JobWaitError through inside jobs", async () => {
    const { provider } = waiting();
    const { brain } = await setup(provider);
    const error = await brain
      .run(draftPrompt, { name: "Dana" }, { jobId: "job_1" })
      .catch((caught: unknown) => caught);
    expect(isJobWaitError(error)).toBe(true);
  });

  it("asks synchronous callers to finish the agent task first", async () => {
    const { provider } = waiting();
    const { brain } = await setup(provider);
    const error = await failure(brain.run(draftPrompt, { name: "Dana" }));
    expect(error.code).toBe("approval_required");
    expect(error.details).toMatchObject({ agent_task_id: "tsk_01k6a3v0q8x3m2n4p5r6s7t8v9" });
    expect(error.hint).toContain("submit_agent_task");
  });
});
