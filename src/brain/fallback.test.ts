import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { isJobWaitError, isOpenOutboundError, type OpenOutboundError } from "../core/errors.js";
import type { LogFn, Logger } from "../core/logger.js";
import type { WorkspaceSettingsInput } from "../core/settings.js";
import { agent_tasks, problems } from "../db/schema/index.js";
import { getAgentTask } from "../modules/brain/get-agent-task.js";
import { submitAgentTask } from "../modules/brain/submit-agent-task.js";
import { createAgentBrain } from "../providers/brain/agent.js";
import { type BrainFailureReason, brainError } from "../providers/brain/errors.js";
import type { BrainProvider, BrainResponse } from "../providers/types.js";
import { createBrainHealthReporter } from "../runtime/brain-health.js";
import { createTestContext, type TestContext } from "../testing/context.js";
import { createTestDb, type TestDb } from "../testing/db.js";
import { createFakeProviders } from "../testing/fakes.js";
import { BRAIN_DOWN_REMEDY, TIME_SENSITIVE_PROMPTS } from "./fallback.js";
import { createConcurrencyLimiter } from "./limiter.js";
import { definePrompt, type PromptDefinition } from "./prompt.js";
import type { ServiceBrainRequest } from "./request.js";
import { createBrainService } from "./service.js";

const schema = z.object({ category: z.enum(["interested", "not_now", "other"]) });

const writePrompt = definePrompt({
  id: "test.write_line",
  version: 1,
  tier: "standard",
  system: () => "You sort short notes.",
  user: (vars: { note: string }) => `Sort: ${vars.note}`,
  schema,
});

/** Same shape as the real reply classifier, under its prompt id (the time-sensitive one). */
const classifyPrompt: PromptDefinition<{ note: string }, z.infer<typeof schema>> = {
  ...writePrompt,
  id: "inbox.reply.classify",
  tier: "fast",
};

const GOOD = { category: "interested" } as const;

type Step = BrainResponse | Error;

function reply(json: unknown, model: string): BrainResponse {
  return { text: JSON.stringify(json), json, model, usage: { inputTokens: 100, outputTokens: 20 } };
}

function scripted(id: string, steps: Step[]) {
  const requests: ServiceBrainRequest[] = [];
  const provider: BrainProvider = {
    id,
    capabilities: { structuredOutput: "native", maxConcurrency: 4, caching: false },
    defaultModels: { fast: `${id}-fast`, standard: `${id}-standard`, deep: `${id}-deep` },
    async generate(request) {
      requests.push(request as ServiceBrainRequest);
      const step = steps.length > 1 ? steps.shift() : steps[0];
      if (step === undefined) throw new Error("no scripted step left");
      if (step instanceof Error) throw step;
      return step;
    },
  };
  return { provider, requests };
}

function failing(id: string, reason: BrainFailureReason, retryable: boolean, extra = {}) {
  return brainError({ label: id, providerId: id }, `The ${id} brain failed (${reason}).`, {
    reason,
    retryable,
    hint: `Check the ${id} settings.`,
    ...extra,
  });
}

function recordingLogger() {
  const lines: Array<{ level: string; fields: Record<string, unknown>; msg: string }> = [];
  const method =
    (level: string): LogFn =>
    (first: object | string, msg?: string) => {
      if (typeof first === "string") lines.push({ level, fields: {}, msg: first });
      else lines.push({ level, fields: first as Record<string, unknown>, msg: msg ?? "" });
    };
  const logger: Logger = {
    level: "trace",
    trace: method("trace"),
    debug: method("debug"),
    info: method("info"),
    warn: method("warn"),
    error: method("error"),
    fatal: method("fatal"),
    child: () => logger,
  };
  return { logger, lines };
}

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

async function setup(
  brains: BrainProvider[],
  settings: WorkspaceSettingsInput = { ai: { fallback_provider: "backup" } },
  options: { sandbox?: boolean } = {},
) {
  const ctx: TestContext = await createTestContext({
    db,
    settings,
    ...(options.sandbox ? { sandbox: true } : {}),
    ...(brains.length > 0 ? { providers: { brain: brains } } : {}),
  });
  const { logger, lines } = recordingLogger();
  const brain = createBrainService({
    db: ctx.db,
    providers: ctx.providers,
    usage: ctx.usage,
    workspaceId: () => ctx.workspace.id,
    limiter: createConcurrencyLimiter(),
    sleep: async () => {},
    log: logger,
    health: createBrainHealthReporter(() => ctx),
  });
  return { ctx, brain, lines };
}

async function failure(promise: Promise<unknown>): Promise<OpenOutboundError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!isOpenOutboundError(error)) throw new Error(`expected an OpenOutboundError, got ${error}`);
  return error;
}

async function problemsOf(ctx: TestContext) {
  return ctx.db
    .select()
    .from(problems)
    .where(and(eq(problems.workspace_id, ctx.workspace.id), eq(problems.kind, "brain_down")));
}

describe("backup brain: when it answers", () => {
  const cases: Array<[BrainFailureReason, boolean, Record<string, unknown>]> = [
    ["auth", false, {}],
    ["forbidden", false, {}],
    ["rate_limited", true, {}],
    ["quota", false, {}],
    ["overloaded", true, {}],
    ["usage_limit", true, { retryAfterSeconds: 3600 }],
    ["server_error", true, {}],
    ["timeout", true, {}],
    ["network", true, {}],
    ["cli_error", false, {}],
    ["malformed_response", false, {}],
  ];

  it.each(cases)("runs the call once on the backup after %s", async (reason, retryable, extra) => {
    const main = scripted("main", [failing("main", reason, retryable, extra)]);
    const backup = scripted("backup", [reply(GOOD, "backup-standard")]);
    const { ctx, brain, lines } = await setup([main.provider, backup.provider]);

    const result = await brain.run(writePrompt, { note: "call me" }, { jobId: "job_1" });

    expect(result).toMatchObject({ output: GOOD, provider: "backup", model: "backup-standard" });
    expect(backup.requests).toHaveLength(1);
    expect(backup.requests[0]?.model).toBe("backup-standard");
    // Retryable failures used the main brain's own retries first (3 attempts).
    const plannedAttempts = retryable && reason !== "usage_limit" ? 3 : 1;
    expect(main.requests).toHaveLength(plannedAttempts);
    expect(ctx.recorded.usage.map((row) => row.provider)).toEqual(["backup"]);
    const line = lines.find((entry) => entry.fields.fallback === "backup");
    expect(line?.fields).toMatchObject({ provider: "main", reason });
    expect(line?.msg).toContain("main");
    expect(line?.msg).toContain("backup");
  });

  it("answers with the backup when the main brain is not configured", async () => {
    const backup = scripted("backup", [reply(GOOD, "backup-standard")]);
    const { brain } = await setup([backup.provider], {
      ai: {
        fallback_provider: "backup",
        task_models: { standard: { provider: "missing" } },
      },
    });
    const result = await brain.run(writePrompt, { note: "call me" });
    expect(result.provider).toBe("backup");
  });

  it("uses the backup's own model from ai.task_models", async () => {
    const main = scripted("main", [failing("main", "auth", false)]);
    const backup = scripted("backup", [reply(GOOD, "backup-pinned")]);
    const { brain } = await setup([main.provider, backup.provider], {
      ai: {
        fallback_provider: "backup",
        // The prompt runs on main; the tier entry only gives the backup its model.
        task_models: {
          "test.write_line": { provider: "main" },
          standard: { provider: "backup", model: "backup-pinned" },
        },
      },
    });
    const result = await brain.run(writePrompt, { note: "call me" });
    expect(main.requests[0]?.model).toBe("main-standard");
    expect(result.provider).toBe("backup");
    expect(backup.requests[0]?.model).toBe("backup-pinned");
  });

  it("repairs invalid backup output like any other call", async () => {
    const main = scripted("main", [failing("main", "overloaded", true)]);
    const backup = scripted("backup", [
      reply({ category: "maybe" }, "backup-standard"),
      reply(GOOD, "backup-standard"),
    ]);
    const { brain } = await setup([main.provider, backup.provider]);
    const result = await brain.run(writePrompt, { note: "call me" });
    expect(result).toMatchObject({ output: GOOD, provider: "backup", repaired: true });
    expect(backup.requests).toHaveLength(2);
  });

  it("names both brains when the backup fails too", async () => {
    const main = scripted("main", [failing("main", "quota", false)]);
    const backup = scripted("backup", [failing("backup", "rate_limited", true)]);
    const { brain } = await setup([main.provider, backup.provider]);
    const error = await failure(brain.run(writePrompt, { note: "call me" }));
    expect(error.code).toBe("provider_error");
    expect(error.message).toContain("main");
    expect(error.message).toContain("The backup brain (backup) also failed");
    expect(error.details).toMatchObject({
      provider: "main",
      reason: "quota",
      retryable: true,
      fallback_provider: "backup",
      fallback_reason: "rate_limited",
    });
  });
});

describe("backup brain: when it does not answer", () => {
  it("keeps invalid output with the main brain", async () => {
    const main = scripted("main", [reply({ category: "maybe" }, "main-standard")]);
    const backup = scripted("backup", [reply(GOOD, "backup-standard")]);
    const { brain } = await setup([main.provider, backup.provider]);
    const error = await failure(brain.run(writePrompt, { note: "call me" }));
    expect(error.details).toMatchObject({ reason: "invalid_output", provider: "main" });
    expect(backup.requests).toHaveLength(0);
  });

  it.each(["too_large", "context_window", "refusal", "bad_request"] as const)(
    "keeps %s with the main brain",
    async (reason) => {
      const main = scripted("main", [failing("main", reason, false)]);
      const backup = scripted("backup", [reply(GOOD, "backup-standard")]);
      const { brain } = await setup([main.provider, backup.provider]);
      const error = await failure(brain.run(writePrompt, { note: "call me" }));
      expect(error.details).toMatchObject({ reason });
      expect(backup.requests).toHaveLength(0);
    },
  );

  it("does nothing without a backup, or when the backup is the failing brain", async () => {
    for (const settings of [{}, { ai: { fallback_provider: "main" } }]) {
      const main = scripted("main", [failing("main", "auth", false)]);
      const backup = scripted("backup", [reply(GOOD, "backup-standard")]);
      const { brain } = await setup([main.provider, backup.provider], settings);
      const error = await failure(brain.run(writePrompt, { note: "call me" }));
      expect(error.details).toMatchObject({ reason: "auth", provider: "main" });
      expect(error.details?.fallback_provider).toBeUndefined();
      expect(backup.requests).toHaveLength(0);
    }
  });

  it("does nothing for calls that force a provider or a model (test_brain)", async () => {
    const main = scripted("main", [failing("main", "auth", false)]);
    const backup = scripted("backup", [reply(GOOD, "backup-standard")]);
    const { ctx, brain } = await setup([main.provider, backup.provider]);
    await failure(brain.run(writePrompt, { note: "call me" }, { provider: "main" }));
    await failure(brain.run(writePrompt, { note: "call me" }, { model: "main-custom" }));
    expect(backup.requests).toHaveLength(0);
    expect(await problemsOf(ctx)).toHaveLength(0);
  });

  it("does nothing for a call that asks for no fallback (test_brain with the workspace brain)", async () => {
    const main = scripted("main", [failing("main", "auth", false)]);
    const backup = scripted("backup", [reply(GOOD, "backup-standard")]);
    const { brain } = await setup([main.provider, backup.provider]);
    const error = await failure(brain.run(writePrompt, { note: "call me" }, { noFallback: true }));
    expect(error.message).not.toContain("backup");
    expect(backup.requests).toHaveLength(0);
  });

  it("does nothing in sandbox workspaces on the fake brain", async () => {
    const main = scripted("main", [failing("main", "auth", false)]);
    const backup = scripted("backup", [reply(GOOD, "backup-standard")]);
    const { brain } = await setup([main.provider, backup.provider], undefined, { sandbox: true });
    const result = await brain.run(writePrompt, { note: "call me" });
    expect(result.provider).toBe("fake");
    expect(main.requests).toHaveLength(0);
    expect(backup.requests).toHaveLength(0);
  });
});

describe("backup brain: time-sensitive prompts on the agent brain", () => {
  it("keeps the time-sensitive set in one constant", () => {
    expect([...TIME_SENSITIVE_PROMPTS]).toEqual(["inbox.reply.classify"]);
  });

  async function agentSetup(settings: WorkspaceSettingsInput) {
    const backup = scripted("backup", [reply(GOOD, "backup-fast")]);
    const context = await setup([], settings);
    const agent = createAgentBrain({ db: context.ctx.db, clock: context.ctx.clock });
    context.ctx.providers.set("brain", [agent, backup.provider]);
    const taskOf = async (key: string) => {
      const [task] = await context.ctx.db
        .select()
        .from(agent_tasks)
        .where(like(agent_tasks.task_key, `%${key}`));
      if (!task) throw new Error(`no agent task for ${key}`);
      return task;
    };
    return { ...context, backup, taskOf };
  }

  async function waitOf(promise: Promise<unknown>) {
    const error = await promise.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    if (!isJobWaitError(error)) throw new Error(`expected a JobWaitError, got ${error}`);
    return error;
  }

  const SETTINGS = { ai: { fallback_provider: "backup", agent_timeout_minutes: 30 } };

  it("waits up to agent_timeout_minutes, then closes the task and asks the backup", async () => {
    const { ctx, brain, backup, taskOf } = await agentSetup(SETTINGS);
    const options = { jobId: "job_1", taskKey: "inbox.classify:msg_1" };

    const first = await waitOf(brain.run(classifyPrompt, { note: "call me" }, options));
    expect(first.retryAt?.toISOString()).toBe("2026-09-19T12:30:00.000Z");
    const task = await taskOf("inbox.classify:msg_1");
    expect(task.status).toBe("open");

    ctx.clock.advanceBy({ minutes: 20 });
    const early = await waitOf(brain.run(classifyPrompt, { note: "call me" }, options));
    expect(early.retryAt?.toISOString()).toBe("2026-09-19T12:30:00.000Z");
    expect(backup.requests).toHaveLength(0);

    ctx.clock.advanceBy({ minutes: 11 });
    const result = await brain.run(classifyPrompt, { note: "call me" }, options);
    expect(result).toMatchObject({ output: GOOD, provider: "backup" });
    const closed = await taskOf("inbox.classify:msg_1");
    expect(closed.status).toBe("expired");
    expect(closed.completed_at).not.toBeNull();
    expect((closed.output as { expired_note?: string }).expired_note).toContain(
      "backup brain (backup)",
    );

    // Running the step again goes straight to the backup: the task is not re-opened.
    const again = await brain.run(classifyPrompt, { note: "call me" }, options);
    expect(again.provider).toBe("backup");
    expect((await taskOf("inbox.classify:msg_1")).status).toBe("expired");
  });

  it("tells the agent why the task was closed", async () => {
    const { ctx, brain, taskOf } = await agentSetup(SETTINGS);
    const options = { jobId: "job_1", taskKey: "inbox.classify:msg_5" };
    await waitOf(brain.run(classifyPrompt, { note: "call me" }, options));
    ctx.clock.advanceBy({ minutes: 31 });
    await brain.run(classifyPrompt, { note: "call me" }, options);
    const task = await taskOf("inbox.classify:msg_5");

    const view = getAgentTask.output.parse(await getAgentTask.handler(ctx, { task_id: task.id }));
    expect(view.status).toBe("expired");
    expect(view.expired_note).toContain("Not answered within 30 minutes");
    const error = await failure(
      submitAgentTask.handler(
        ctx,
        submitAgentTask.input.parse({ task_id: task.id, output: { category: "other" } }),
      ),
    );
    expect(error.code).toBe("conflict");
    expect(error.message).toContain("backup brain (backup)");
    expect(error.hint).toContain("Nothing to do");
  });

  it("uses the agent's answer when it comes in time", async () => {
    const { ctx, brain, backup, taskOf } = await agentSetup(SETTINGS);
    const options = { jobId: "job_1", taskKey: "inbox.classify:msg_2" };
    await waitOf(brain.run(classifyPrompt, { note: "call me" }, options));
    const task = await taskOf("inbox.classify:msg_2");
    await ctx.db
      .update(agent_tasks)
      .set({ status: "done", output: { category: "not_now" } })
      .where(eq(agent_tasks.id, task.id));
    ctx.clock.advanceBy({ minutes: 45 });
    const result = await brain.run(classifyPrompt, { note: "call me" }, options);
    expect(result).toMatchObject({ output: { category: "not_now" }, provider: "agent" });
    expect(backup.requests).toHaveLength(0);
  });

  it("lets other prompts wait for the agent as before", async () => {
    const { ctx, brain, backup, taskOf } = await agentSetup(SETTINGS);
    const options = { jobId: "job_1", taskKey: "write:msg_3" };
    const first = await waitOf(brain.run(writePrompt, { note: "call me" }, options));
    const task = await taskOf("write:msg_3");
    expect(first.retryAt?.getTime()).toBe(task.expires_at?.getTime());
    ctx.clock.advanceBy({ minutes: 45 });
    await waitOf(brain.run(writePrompt, { note: "call me" }, options));
    expect(backup.requests).toHaveLength(0);
    expect((await taskOf("write:msg_3")).status).toBe("open");
  });

  it("lets the classifier wait for the agent when no backup is set", async () => {
    const { ctx, brain, taskOf } = await agentSetup({ ai: { agent_timeout_minutes: 30 } });
    const options = { jobId: "job_1", taskKey: "inbox.classify:msg_4" };
    const first = await waitOf(brain.run(classifyPrompt, { note: "call me" }, options));
    const task = await taskOf("inbox.classify:msg_4");
    expect(first.retryAt?.getTime()).toBe(task.expires_at?.getTime());
    ctx.clock.advanceBy({ minutes: 45 });
    await waitOf(brain.run(classifyPrompt, { note: "call me" }, options));
    expect((await taskOf("inbox.classify:msg_4")).status).toBe("open");
  });
});

describe("backup brain: brain_down problems", () => {
  it("opens brain_down once for a failure retrying cannot fix and resolves it on success", async () => {
    const main = scripted("main", [
      failing("main", "auth", false),
      failing("main", "auth", false),
      reply(GOOD, "main-standard"),
    ]);
    const backup = scripted("backup", [reply(GOOD, "backup-standard")]);
    const { ctx, brain } = await setup([main.provider, backup.provider]);

    await brain.run(writePrompt, { note: "one" });
    await brain.run(writePrompt, { note: "two" });
    const open = await problemsOf(ctx);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      severity: "high",
      owner: "person",
      status: "open",
      remedy: BRAIN_DOWN_REMEDY,
      dedupe_key: "brain_down:main:main-standard",
      title: "The main brain is not working with model main-standard",
      data: { provider: "main", model: "main-standard", reason: "auth" },
    });
    expect(open[0]?.reason).toContain("The main brain failed (auth).");
    expect(open[0]?.reason).toContain("the backup brain (backup) answers");
    expect(ctx.emitted("problem.opened")).toHaveLength(1);

    const result = await brain.run(writePrompt, { note: "three" });
    expect(result.provider).toBe("main");
    const [resolved] = await problemsOf(ctx);
    expect(resolved).toMatchObject({ status: "resolved" });
    expect(resolved?.resolution).toBe("The main brain answered again with model main-standard.");
    expect(ctx.emitted("problem.resolved")).toHaveLength(1);
  });

  it("keeps a model's brain_down open while other models of the provider work", async () => {
    const fastPrompt = { ...writePrompt, id: "test.fast_line", tier: "fast" as const };
    const main: BrainProvider = {
      id: "main",
      capabilities: { structuredOutput: "native", maxConcurrency: 4, caching: false },
      defaultModels: { fast: "main-fast", standard: "main-standard", deep: "main-deep" },
      async generate(request) {
        if (request.model === "main-standard") throw failing("main", "model_not_found", false);
        return reply(GOOD, request.model);
      },
    };
    const { ctx, brain } = await setup([main], {});

    await failure(brain.run(writePrompt, { note: "one" }));
    await brain.run(fastPrompt, { note: "two" });
    await failure(brain.run(writePrompt, { note: "three" }));
    await brain.run(fastPrompt, { note: "four" });
    const rows = await problemsOf(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dedupe_key: "brain_down:main:main-standard", status: "open" });
    // Opened once and never closed by the fast model's answers: no flapping.
    expect(ctx.emitted("problem.opened")).toHaveLength(1);
    expect(ctx.emitted("problem.resolved")).toHaveLength(0);
  });

  it("opens brain_down without a backup and for a provider that is not configured", async () => {
    const backup = scripted("backup", [reply(GOOD, "backup-standard")]);
    const { ctx, brain } = await setup([backup.provider], {
      ai: { task_models: { standard: { provider: "missing" } } },
    });
    const error = await failure(brain.run(writePrompt, { note: "one" }));
    expect(error.code).toBe("provider_not_configured");
    const [problem] = await problemsOf(ctx);
    // Not configured: no model was chosen, so the problem is the provider's.
    expect(problem).toMatchObject({
      dedupe_key: "brain_down:missing",
      status: "open",
      title: "The missing brain is not working",
    });
    expect(problem?.reason).toContain("AI steps");
  });

  it("opens brain_down for answers that are not the API's format (a wrong base_url)", async () => {
    const main = scripted("main", [failing("main", "malformed_response", false)]);
    const backup = scripted("backup", [reply(GOOD, "backup-standard")]);
    const { ctx, brain } = await setup([main.provider, backup.provider]);
    const result = await brain.run(writePrompt, { note: "one" });
    expect(result.provider).toBe("backup");
    const [problem] = await problemsOf(ctx);
    expect(problem).toMatchObject({
      status: "open",
      dedupe_key: "brain_down:main:main-standard",
      data: { provider: "main", reason: "malformed_response" },
    });
  });

  it("does not open brain_down for failures that pass", async () => {
    const main = scripted("main", [failing("main", "rate_limited", true)]);
    const backup = scripted("backup", [reply(GOOD, "backup-standard")]);
    const { ctx, brain } = await setup([main.provider, backup.provider]);
    await brain.run(writePrompt, { note: "one" });
    expect(await problemsOf(ctx)).toHaveLength(0);
  });

  it("opens brain_down for provider none when no brain is configured; any brain resolves it", async () => {
    const { ctx, brain } = await setup([], {});
    const error = await failure(brain.run(writePrompt, { note: "one" }));
    expect(error.code).toBe("provider_not_configured");
    await failure(brain.run(writePrompt, { note: "two" }));
    const open = await problemsOf(ctx);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      dedupe_key: "brain_down:none",
      status: "open",
      severity: "high",
      title: "No AI brain is configured",
      remedy: BRAIN_DOWN_REMEDY,
    });
    expect(open[0]?.reason).toContain("No AI brain is configured for this workspace.");
    expect(open[0]?.reason).toContain("manage_providers (action set, slot brain)");

    // A brain is configured later: its first answer resolves the problem.
    const main = scripted("main", [reply(GOOD, "main-standard")]);
    const configured = createBrainService({
      db: ctx.db,
      providers: createFakeProviders({ brain: main.provider }),
      usage: ctx.usage,
      workspaceId: () => ctx.workspace.id,
      limiter: createConcurrencyLimiter(),
      sleep: async () => {},
      health: createBrainHealthReporter(() => ctx),
    });
    await configured.run(writePrompt, { note: "three" });
    const [resolved] = await problemsOf(ctx);
    expect(resolved).toMatchObject({ status: "resolved" });
    expect(resolved?.resolution).toContain("main answered");
  });

  it("opens brain_down for a backup that is down too", async () => {
    const main = scripted("main", [failing("main", "server_error", true)]);
    const backup = scripted("backup", [failing("backup", "auth", false)]);
    const { ctx, brain } = await setup([main.provider, backup.provider]);
    await failure(brain.run(writePrompt, { note: "one" }));
    const rows = await problemsOf(ctx);
    expect(rows.map((row) => row.dedupe_key)).toEqual(["brain_down:backup:backup-standard"]);
  });
});
