import { z } from "zod";
import { lastUserMessage, requestExtras } from "../../brain/request.js";
import { sampleFromSchema } from "../../brain/schema-sample.js";
import type { ModelTier } from "../../core/enums.js";
import { OpenOutboundError } from "../../core/errors.js";
import { type BrainProvider, defineProvider } from "../types.js";

/** What the fake brain saw for one call (handlers receive it as their second argument). */
export interface FakeBrainCall {
  promptId: string;
  system: string;
  user: string;
  model: string;
  tier: ModelTier | undefined;
  /** 1 for the first call, 2 for the repair call. */
  attempt: number;
}

/**
 * A fake answer for one prompt id: a value, or a function of the prompt vars returning one
 * (the same shape as `ctx.brain.on(...)` in tests).
 */
// biome-ignore lint/suspicious/noExplicitAny: handlers receive whatever vars the prompt declares
export type FakeBrainAnswer = unknown | ((vars: any, call: FakeBrainCall) => unknown);

const sharedAnswers = new Map<string, FakeBrainAnswer>();

/** Built-in answers (used when neither the instance nor the sandbox registered one). */
const BUILTIN_ANSWERS: Record<string, FakeBrainAnswer> = {
  // brain.test: echo the code back so the connection test passes in sandbox workspaces.
  "brain.connection_test": (vars: { nonce?: string } | undefined) => ({
    ok: true,
    echo: vars?.nonce ?? "",
  }),
};

/**
 * Registers an answer for a prompt id in every fake brain that has no own answer for it. The
 * sandbox uses this to give prospects realistic outputs (reply classifications, drafts).
 */
export function setFakeBrainAnswer(promptId: string, answer: FakeBrainAnswer): void {
  sharedAnswers.set(promptId, answer);
}

/** Removes shared answers (all, or one prompt id). */
export function clearFakeBrainAnswers(promptId?: string): void {
  if (promptId === undefined) sharedAnswers.clear();
  else sharedAnswers.delete(promptId);
}

export interface FakeBrainProvider extends BrainProvider {
  /** Sets this instance's answer for a prompt id. */
  on(promptId: string, answer: FakeBrainAnswer): void;
  /** Every call, in order. */
  calls: FakeBrainCall[];
}

export interface CreateFakeBrainOptions {
  answers?: Record<string, FakeBrainAnswer>;
}

/**
 * Deterministic brain without a model: the registered answer for the prompt id (instance first,
 * then shared), otherwise the smallest valid output for the prompt's zod schema (the same rule
 * as the test FakeBrain). Costs nothing and never touches the network.
 */
export function createFakeBrainProvider(options: CreateFakeBrainOptions = {}): FakeBrainProvider {
  const answers = new Map<string, FakeBrainAnswer>(Object.entries(options.answers ?? {}));
  const calls: FakeBrainCall[] = [];
  return {
    id: "fake",
    capabilities: { structuredOutput: "native", maxConcurrency: 64, caching: false },
    defaultModels: { fast: "fake-fast", standard: "fake-standard", deep: "fake-deep" },
    calls,
    on(promptId, answer) {
      answers.set(promptId, answer);
    },
    async generate(request) {
      const extras = requestExtras(request);
      const promptId = request.metadata?.promptId ?? "unknown";
      const call: FakeBrainCall = {
        promptId,
        system: request.system,
        user: lastUserMessage(request),
        model: request.model,
        tier: extras.tier,
        attempt: extras.attempt ?? 1,
      };
      calls.push(call);
      let value: unknown;
      const answer = answers.has(promptId)
        ? answers.get(promptId)
        : sharedAnswers.has(promptId)
          ? sharedAnswers.get(promptId)
          : BUILTIN_ANSWERS[promptId];
      if (answer !== undefined) {
        value = typeof answer === "function" ? await answer(extras.vars, call) : answer;
      } else {
        value = sampleAnswer(promptId, extras.outputSchema, request.jsonSchema);
      }
      return {
        text: JSON.stringify(value ?? null),
        json: value,
        model: request.model,
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 },
      };
    },
  };
}

function sampleAnswer(
  promptId: string,
  schema: z.ZodType | undefined,
  jsonSchema: Record<string, unknown> | undefined,
): unknown {
  try {
    if (schema) return sampleFromSchema(schema);
    if (jsonSchema) return sampleFromSchema(z.fromJSONSchema(jsonSchema));
    return {};
  } catch (error) {
    throw new OpenOutboundError(
      "provider_error",
      `The fake brain cannot invent an answer for "${promptId}": ${(error as Error).message}`,
      {
        hint: `Register an answer for this prompt id: setFakeBrainAnswer("${promptId}", value) for the sandbox, or ctx.brain.on("${promptId}", value) in tests.`,
        details: { provider: "fake", reason: "invalid_output", retryable: false },
      },
    );
  }
}

/** Registered under slot brain, id "fake". Serves sandbox workspaces (and tests). */
export const fakeBrainProvider = defineProvider({
  slot: "brain",
  id: "fake",
  name: "Fake brain (sandbox)",
  description:
    "Deterministic answers without any model: a registered answer per prompt id, otherwise the smallest valid output for the prompt's schema. Used by the sandbox and tests; free and offline.",
  secrets: [],
  sandbox: true,
  create: () => createFakeBrainProvider(),
  test: async () => ({ ok: true, message: "Fake brain answers locally without a network call." }),
});
