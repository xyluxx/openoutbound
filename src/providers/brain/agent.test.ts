import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { outputJsonSchema } from "../../brain/json-schema.js";
import type { ServiceBrainRequest } from "../../brain/request.js";
import { isJobWaitError, isOpenOutboundError, type JobWaitError } from "../../core/errors.js";
import { agent_tasks } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { AGENT_MODEL, createAgentBrain } from "./agent.js";

const schema = outputJsonSchema(
  z.object({ category: z.enum(["interested", "not_now", "other"]), note: z.string().optional() }),
);

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

function request(taskKey: string | undefined, overrides: Partial<ServiceBrainRequest> = {}) {
  const base: ServiceBrainRequest = {
    system: "Classify the reply.",
    messages: [{ role: "user", content: "Reply: sounds good, call me Tuesday." }],
    jsonSchema: schema,
    model: AGENT_MODEL,
    maxTokens: 300,
    metadata: {
      promptId: "inbox.classify_reply",
      workspaceId: ctx.workspace.id,
      ...(taskKey ? { taskKey } : {}),
    },
    tier: "fast",
    promptVersion: 3,
    ...overrides,
  };
  return base;
}

async function waitError(promise: Promise<unknown>): Promise<JobWaitError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!isJobWaitError(error)) throw new Error(`expected a JobWaitError, got ${error}`);
  return error;
}

async function taskFor(key: string) {
  const [task] = await ctx.db
    .select()
    .from(agent_tasks)
    .where(eq(agent_tasks.task_key, `brain:${ctx.workspace.id}:${key}`));
  if (!task) throw new Error(`no task for ${key}`);
  return task;
}

describe("agent brain", () => {
  it("creates one task per key and parks the caller until it is done", async () => {
    const brain = createAgentBrain({ db: ctx.db, clock: ctx.clock });
    const first = await waitError(brain.generate(request("classify:msg_1")));
    const task = await taskFor("classify:msg_1");
    expect(first.waitFor).toBe(`agent_task:${task.id}`);
    expect(first.retryAt?.getTime()).toBe(ctx.clock.now().getTime() + 168 * 3_600_000);
    expect(task).toMatchObject({
      kind: "brain",
      status: "open",
      instructions: "Classify the reply.",
      input: {
        prompt_id: "inbox.classify_reply",
        prompt_version: 3,
        tier: "fast",
        message: "Reply: sounds good, call me Tuesday.",
      },
      output_schema: schema,
    });
    const second = await waitError(brain.generate(request("classify:msg_1")));
    expect(second.waitFor).toBe(first.waitFor);
    const rows = await ctx.db
      .select()
      .from(agent_tasks)
      .where(like(agent_tasks.task_key, `%classify:msg_1`));
    expect(rows).toHaveLength(1);
  });

  it("returns the submitted output once the task is done", async () => {
    const brain = createAgentBrain({ db: ctx.db, clock: ctx.clock });
    await waitError(brain.generate(request("classify:msg_2")));
    const task = await taskFor("classify:msg_2");
    await ctx.db
      .update(agent_tasks)
      .set({ status: "done", output: { category: "interested" } })
      .where(eq(agent_tasks.id, task.id));
    const response = await brain.generate(request("classify:msg_2"));
    expect(response).toEqual({
      text: '{"category":"interested"}',
      json: { category: "interested" },
      model: AGENT_MODEL,
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: null },
    });
  });

  it("reports a declined task with the agent's reason", async () => {
    const brain = createAgentBrain({ db: ctx.db, clock: ctx.clock });
    await waitError(brain.generate(request("classify:msg_3")));
    const task = await taskFor("classify:msg_3");
    await ctx.db
      .update(agent_tasks)
      .set({ status: "failed", output: { decline_reason: "The reply is empty." } })
      .where(eq(agent_tasks.id, task.id));
    const error = await brain
      .generate(request("classify:msg_3"))
      .catch((caught: unknown) => caught);
    expect(isOpenOutboundError(error) && error.details).toMatchObject({
      reason: "declined",
      retryable: false,
      agent_task_id: task.id,
    });
    expect((error as Error).message).toContain("The reply is empty.");
  });

  it("expires overdue tasks and re-opens them when the step runs again", async () => {
    const brain = createAgentBrain({ db: ctx.db, clock: ctx.clock, expireHours: 1 });
    await waitError(brain.generate(request("classify:msg_4")));
    ctx.clock.advanceBy({ hours: 2 });
    const error = await brain
      .generate(request("classify:msg_4"))
      .catch((caught: unknown) => caught);
    expect(isOpenOutboundError(error) && error.details).toMatchObject({ reason: "expired" });
    expect((await taskFor("classify:msg_4")).status).toBe("expired");

    const again = await waitError(brain.generate(request("classify:msg_4")));
    const reopened = await taskFor("classify:msg_4");
    expect(reopened.status).toBe("open");
    expect(again.retryAt?.getTime()).toBe(ctx.clock.now().getTime() + 3_600_000);
    expect(reopened.expires_at?.getTime()).toBe(again.retryAt?.getTime());
  });

  it("keys calls without a task key by their content", async () => {
    const brain = createAgentBrain({ db: ctx.db, clock: ctx.clock });
    const a = await waitError(brain.generate(request(undefined)));
    const b = await waitError(
      brain.generate(
        request(undefined, { messages: [{ role: "user", content: "Reply: no thanks." }] }),
      ),
    );
    const c = await waitError(brain.generate(request(undefined)));
    expect(a.waitFor).not.toBe(b.waitFor);
    expect(c.waitFor).toBe(a.waitFor);
  });

  it("uses the instance workspace when the request has none, and needs one", async () => {
    const scoped = createAgentBrain({
      db: ctx.db,
      clock: ctx.clock,
      workspaceId: ctx.workspace.id,
    });
    const noWorkspace = request("classify:msg_5", {
      metadata: { promptId: "inbox.classify_reply", taskKey: "classify:msg_5" },
    });
    await waitError(scoped.generate(noWorkspace));
    expect((await taskFor("classify:msg_5")).workspace_id).toBe(ctx.workspace.id);

    const unscoped = createAgentBrain({ db: ctx.db, clock: ctx.clock });
    const error = await unscoped.generate(noWorkspace).catch((caught: unknown) => caught);
    expect(isOpenOutboundError(error) && error.code).toBe("validation_failed");
  });
});
