import { z } from "zod";
import { defineProvider } from "../types.js";
import { createOpenAICompatibleBrain, OPENROUTER_DEFAULT_MODELS } from "./openai-compatible.js";
import { brainModelsSchema, maxConcurrencySchema, testBrainProvider } from "./shared.js";

const DEFAULTS = `fast ${OPENROUTER_DEFAULT_MODELS.fast}, standard ${OPENROUTER_DEFAULT_MODELS.standard}, deep ${OPENROUTER_DEFAULT_MODELS.deep}`;

export const openrouterConfigSchema = z.object({
  models: brainModelsSchema
    .optional()
    .describe(`OpenRouter model id per tier, e.g. "<vendor>/<model>" (default: ${DEFAULTS})`),
  max_concurrency: maxConcurrencySchema.optional().describe("Max parallel calls (default 8)"),
  max_tokens_headroom: z
    .number()
    .int()
    .min(0)
    .max(64_000)
    .optional()
    .describe("Extra max_tokens for thinking (default 8000; thinking counts toward the limit)"),
});

/**
 * OpenRouter (one key, many vendors). Requests ask for strict json_schema output with
 * `provider.require_parameters: true`, so OpenRouter only routes to endpoints that support it,
 * and for usage accounting, so each call records the real cost.
 */
export const openrouterBrainProvider = defineProvider({
  slot: "brain",
  id: "openrouter",
  name: "OpenRouter",
  description: `Models from many vendors through one OpenRouter key, with structured output routing and exact per-call cost. Tiers: ${DEFAULTS} (override with config models).`,
  docsUrl: "https://openrouter.ai/docs",
  configSchema: openrouterConfigSchema,
  secrets: [
    { key: "api_key", label: "OpenRouter API key", env: "OPENROUTER_API_KEY", required: true },
  ],
  create: ({ config, secrets, ctx }) =>
    createOpenAICompatibleBrain({
      id: "openrouter",
      preset: "openrouter",
      apiKey: secrets.api_key ?? "",
      ...(config.models ? { models: config.models } : {}),
      ...(config.max_concurrency ? { maxConcurrency: config.max_concurrency } : {}),
      ...(config.max_tokens_headroom !== undefined
        ? { maxTokensHeadroom: config.max_tokens_headroom }
        : {}),
      fetch: ctx.fetch,
      log: ctx.log,
    }),
  test: testBrainProvider,
});
