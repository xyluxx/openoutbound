import { z } from "zod";
import { defineProvider } from "../types.js";
import { createOpenAICompatibleBrain, GEMINI_DEFAULT_MODELS } from "./openai-compatible.js";
import { brainModelsSchema, maxConcurrencySchema, testBrainProvider } from "./shared.js";

const DEFAULTS = `fast ${GEMINI_DEFAULT_MODELS.fast}, standard ${GEMINI_DEFAULT_MODELS.standard}, deep ${GEMINI_DEFAULT_MODELS.deep}`;

export const geminiConfigSchema = z.object({
  models: brainModelsSchema.optional().describe(`Gemini model id per tier (default: ${DEFAULTS})`),
  max_concurrency: maxConcurrencySchema.optional().describe("Max parallel calls (default 4)"),
  max_tokens_headroom: z
    .number()
    .int()
    .min(0)
    .max(64_000)
    .optional()
    .describe("Extra max_tokens for thinking (default 8000; thinking counts toward the limit)"),
});

/** Google Gemini through its OpenAI-compatible endpoint, with json_schema structured output. */
export const geminiBrainProvider = defineProvider({
  slot: "brain",
  id: "gemini",
  name: "Google Gemini",
  description: `Gemini models through Google's OpenAI-compatible endpoint with structured output. Tiers: ${DEFAULTS} (override with config models).`,
  docsUrl: "https://ai.google.dev/gemini-api/docs/openai",
  configSchema: geminiConfigSchema,
  secrets: [{ key: "api_key", label: "Gemini API key", env: "GEMINI_API_KEY", required: true }],
  create: ({ config, secrets, ctx }) =>
    createOpenAICompatibleBrain({
      id: "gemini",
      preset: "gemini",
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
