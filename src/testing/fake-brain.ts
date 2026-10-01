import type { PromptDefinition } from "../brain/prompt.js";
import { sampleFromSchema } from "../brain/schema-sample.js";
import type { BrainResult, BrainRunOptions, BrainService, UsageMeter } from "../core/context.js";

/** A fake answer: a value, or a function of the prompt vars returning one. */
// biome-ignore lint/suspicious/noExplicitAny: handlers receive whatever vars the prompt declares
export type FakeBrainHandler = unknown | ((vars: any, call: FakeBrainCallInfo) => unknown);

export interface FakeBrainCallInfo {
  promptId: string;
  system: string;
  user: string;
  options: BrainRunOptions | undefined;
}

export interface BrainCall extends FakeBrainCallInfo {
  vars: unknown;
  output: unknown;
}

/** BrainService fake: answers by prompt id, else with the smallest valid output for the schema. */
export interface FakeBrain extends BrainService {
  /** Sets the answer for a prompt id (value or function). */
  on(promptId: string, handler: FakeBrainHandler): void;
  /** Every run, in order. Same array as `ctx.recorded.brain`. */
  calls: BrainCall[];
  /**
   * The same brain (answers, calls and usage meter) for another context: a run without a
   * `workspaceId` option checks the budget and records usage for `workspaceId()`, as the real
   * service built for that context does.
   */
  withWorkspace(workspaceId: () => string | null): FakeBrain;
}

export interface CreateFakeBrainOptions {
  handlers?: Record<string, FakeBrainHandler>;
  calls?: BrainCall[];
  /** When set, runs `assertBudget(ws, "ai")` and records a zero-cost usage row like the real service. */
  usage?: UsageMeter;
  /** Workspace of the calling context, used when `run()` gets no `workspaceId`. */
  workspaceId?: () => string | null;
}

export function createFakeBrain(options: CreateFakeBrainOptions = {}): FakeBrain {
  const handlers = new Map<string, FakeBrainHandler>(Object.entries(options.handlers ?? {}));
  const calls = options.calls ?? [];
  const on = (promptId: string, handler: FakeBrainHandler) => {
    handlers.set(promptId, handler);
  };
  const run = async <V, T>(
    contextWorkspace: (() => string | null) | undefined,
    prompt: PromptDefinition<V, T>,
    vars: V,
    runOptions?: BrainRunOptions,
  ): Promise<BrainResult<T>> => {
    const workspaceId =
      runOptions?.workspaceId !== undefined
        ? runOptions.workspaceId
        : (contextWorkspace?.() ?? null);
    if (options.usage && workspaceId) await options.usage.assertBudget(workspaceId, "ai");

    const info: FakeBrainCallInfo = {
      promptId: prompt.id,
      system: prompt.system(vars),
      user: prompt.user(vars),
      options: runOptions,
    };
    let raw: unknown;
    if (handlers.has(prompt.id)) {
      const handler = handlers.get(prompt.id);
      raw = typeof handler === "function" ? await handler(vars, info) : handler;
    } else {
      raw = sampleFromSchema(prompt.schema);
    }
    const parsed = prompt.schema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `FakeBrain: the fake answer for "${prompt.id}" does not match its schema: ${parsed.error.message}`,
      );
    }
    calls.push({ ...info, vars, output: parsed.data });

    const model = runOptions?.model ?? `fake-${runOptions?.tier ?? prompt.tier}`;
    if (options.usage) {
      await options.usage.record({
        workspaceId,
        slot: "brain",
        provider: "fake",
        operation: prompt.id,
        model,
        costUsd: 0,
        jobId: runOptions?.jobId ?? null,
      });
    }
    return {
      output: parsed.data,
      text: JSON.stringify(parsed.data),
      provider: "fake",
      model,
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 },
      repaired: false,
      durationMs: 0,
    };
  };

  /** One view per calling context: shared answers and calls, its own workspace. */
  const brainFor = (contextWorkspace: (() => string | null) | undefined): FakeBrain => ({
    run: (prompt, vars, runOptions) => run(contextWorkspace, prompt, vars, runOptions),
    calls,
    on,
    withWorkspace: (workspaceId) => brainFor(workspaceId),
  });

  return brainFor(options.workspaceId);
}
