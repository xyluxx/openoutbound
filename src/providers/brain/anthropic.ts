import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { toAnthropicJsonSchema } from "../../brain/anthropic-schema.js";
import { isUnsupportedSchemaError, withSchemaInstruction } from "../../brain/json-schema.js";
import { parseJsonReply } from "../../brain/output.js";
import { computeCostUsd } from "../../brain/pricing.js";
import { requestExtras } from "../../brain/request.js";
import type { ModelTier } from "../../core/enums.js";
import { OpenOutboundError } from "../../core/errors.js";
import { type Logger, silentLogger } from "../../core/logger.js";
import {
  type BrainRequest,
  type BrainResponse,
  type BrainUsage,
  defineProvider,
  type ProviderTestResult,
} from "../types.js";
import {
  type BrainErrorContext,
  brainError,
  malformedBrainAnswer,
  mapBrainApiError,
} from "./errors.js";
import {
  brainModelsSchema,
  type CheckableBrainProvider,
  maxConcurrencySchema,
  mergeModels,
  normalizeBaseUrl,
  testBrainProvider,
} from "./shared.js";

/** Tier defaults (spec section 10). */
export const ANTHROPIC_DEFAULT_MODELS: Readonly<Record<ModelTier, string>> = {
  fast: "claude-haiku-4-5",
  standard: "claude-sonnet-5",
  deep: "claude-opus-5",
};

export const ANTHROPIC_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AnthropicEffort = (typeof ANTHROPIC_EFFORTS)[number];

/**
 * Effort per tier when the config sets none: `low` for the fast tier (short, extraction-style
 * calls, as the model guide recommends), the model's own default otherwise.
 */
export const ANTHROPIC_DEFAULT_EFFORT: Readonly<Partial<Record<ModelTier, AnthropicEffort>>> = {
  fast: "low",
};

/** Room for adaptive thinking on top of the prompt's answer budget, per effort. */
const THINKING_HEADROOM: Readonly<Record<AnthropicEffort | "default", number>> = {
  low: 4_000,
  medium: 8_000,
  high: 16_000,
  default: 16_000,
  xhigh: 32_000,
  max: 32_000,
};
const MAX_OUTPUT_TOKENS = 64_000;
/** The SDK asks for streaming when a call may exceed 10 minutes; an explicit timeout skips that. */
const CLIENT_TIMEOUT_MS = 10 * 60_000;

const effortSchema = z.enum(ANTHROPIC_EFFORTS);

export const anthropicConfigSchema = z.object({
  models: brainModelsSchema.optional(),
  base_url: z
    .url({ protocol: /^https?$/ })
    .optional()
    .describe("API base URL (default https://api.anthropic.com)"),
  max_concurrency: maxConcurrencySchema.optional().describe("Max parallel calls (default 8)"),
  effort: z
    .object({
      fast: effortSchema.optional(),
      standard: effortSchema.optional(),
      deep: effortSchema.optional(),
    })
    .optional()
    .describe("output_config.effort per tier (default: low for fast, the model default otherwise)"),
  cache_system_prompt: z
    .boolean()
    .optional()
    .describe("Mark the system prompt cacheable (default true)"),
});
export type AnthropicBrainConfig = z.infer<typeof anthropicConfigSchema>;

/** Model generation from its id (`claude-sonnet-5` -> 5, `claude-haiku-4-5` -> 4, legacy ids -> 0). */
function generation(model: string): { major: number; minor: number; family: string } {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(model.toLowerCase());
  if (!match) return { major: 0, minor: 0, family: "" };
  return { family: match[1] ?? "", major: Number(match[2]), minor: Number(match[3] ?? 0) };
}

/** Claude 5 and newer: adaptive thinking runs by default and sampling parameters are rejected. */
export function thinksByDefault(model: string): boolean {
  return generation(model).major >= 5;
}

/** Whether the model accepts `temperature` (rejected from Opus 4.7 and Claude 5 onwards). */
export function acceptsSamplingParams(model: string): boolean {
  const { family, major, minor } = generation(model);
  if (major >= 5) return false;
  return !(family === "opus" && major === 4 && minor >= 7);
}

/** Whether the model accepts `output_config.effort` (Opus 4.5+, Sonnet 4.6+, Claude 5+). */
export function supportsEffort(model: string): boolean {
  const { family, major, minor } = generation(model);
  if (major >= 5) return true;
  if (major !== 4) return false;
  return (family === "opus" && minor >= 5) || (family === "sonnet" && minor >= 6);
}

export interface AnthropicParamOptions {
  cacheSystemPrompt?: boolean;
  effort?: Partial<Record<ModelTier, AnthropicEffort>>;
  log?: Logger;
}

/**
 * Maps a brain request to Messages API parameters: the system prompt as one cacheable block,
 * the output schema through `output_config.format` (or, for schemas Claude cannot take, as
 * prompt instructions), effort per tier, extra `max_tokens` room when the model thinks by
 * default, and `temperature` only for models that accept it.
 */
export function buildAnthropicParams(
  request: BrainRequest,
  options: AnthropicParamOptions = {},
): Anthropic.MessageCreateParamsNonStreaming {
  const model = request.model;
  let system = request.system;
  let format: Anthropic.JSONOutputFormat | undefined;
  if (request.jsonSchema) {
    try {
      format = { type: "json_schema", schema: toAnthropicJsonSchema(request.jsonSchema) };
    } catch (error) {
      if (!isUnsupportedSchemaError(error)) throw error;
      options.log?.debug(
        { prompt_id: request.metadata?.promptId, reason: error.message },
        "schema not supported by Claude structured outputs; using prompt instructions",
      );
      system = withSchemaInstruction(system, request.jsonSchema);
    }
  }
  const tier = requestExtras(request).tier;
  const effortByTier = options.effort ?? ANTHROPIC_DEFAULT_EFFORT;
  const effort = tier && supportsEffort(model) ? effortByTier[tier] : undefined;
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: maxTokensFor(model, request.maxTokens, effort),
    messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
  };
  if (system.trim()) {
    params.system = [
      {
        type: "text",
        text: system,
        ...(options.cacheSystemPrompt === false ? {} : { cache_control: { type: "ephemeral" } }),
      },
    ];
  }
  const outputConfig: Anthropic.OutputConfig = {};
  if (format) outputConfig.format = format;
  if (effort) outputConfig.effort = effort;
  if (Object.keys(outputConfig).length > 0) params.output_config = outputConfig;
  if (request.temperature !== undefined && acceptsSamplingParams(model)) {
    params.temperature = request.temperature;
  }
  return params;
}

function maxTokensFor(model: string, answerTokens: number, effort: AnthropicEffort | undefined) {
  const base = Math.max(1, Math.round(answerTokens));
  if (!thinksByDefault(model)) return Math.min(base, MAX_OUTPUT_TOKENS);
  return Math.min(base + THINKING_HEADROOM[effort ?? "default"], MAX_OUTPUT_TOKENS);
}

/** Token usage and cost of a Messages API response (cache writes and reads priced separately). */
export function anthropicUsage(model: string, usage: Partial<Anthropic.Usage>): BrainUsage {
  const uncached = count(usage.input_tokens);
  const cacheWrite = count(usage.cache_creation_input_tokens);
  const cacheRead = count(usage.cache_read_input_tokens);
  const outputTokens = count(usage.output_tokens);
  return {
    inputTokens: uncached + cacheWrite + cacheRead,
    outputTokens,
    cachedTokens: cacheRead,
    costUsd: computeCostUsd(model, {
      uncachedInputTokens: uncached,
      outputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
    }),
  };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Maps a Messages API response to a brain response. Refusals, truncated replies and context
 * overflows become clear, non-retryable errors (with the spent usage in `details.usage`).
 */
export function mapAnthropicMessage(
  message: Anthropic.Message,
  context: BrainErrorContext,
): BrainResponse {
  if (!message || typeof message !== "object" || !Array.isArray(message.content)) {
    throw malformedBrainAnswer(context, "no content blocks");
  }
  const model = message.model || context.model || "unknown";
  const usage = anthropicUsage(model, message.usage ?? {});
  const errorContext = { ...context, model };
  if (message.stop_reason === "refusal") {
    const category = message.stop_details?.category ?? null;
    throw brainError(
      errorContext,
      `Claude declined this request${category ? ` (safety category: ${category})` : ""}.`,
      {
        reason: "refusal",
        retryable: false,
        usage,
        extra: { category },
        hint: "Check the prompt input for content that trips safety filters, or route this task to another model with workspace settings ai.task_models.",
      },
    );
  }
  const text = (message.content ?? [])
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
  if (message.stop_reason === "max_tokens") {
    throw brainError(
      errorContext,
      `The Claude reply was cut off at the max_tokens limit (${usage.outputTokens} output tokens).`,
      {
        reason: "max_tokens",
        retryable: false,
        usage,
        hint: "Shorten the input or pick a lower effort for this tier (provider config effort); thinking counts toward max_tokens.",
      },
    );
  }
  if (message.stop_reason === "model_context_window_exceeded") {
    throw brainError(errorContext, "The input is larger than the Claude context window.", {
      reason: "context_window",
      retryable: false,
      usage,
      hint: "Shorten the input (fewer sources or a shorter thread).",
    });
  }
  const json = parseJsonReply(text);
  return { text, ...(json !== undefined ? { json } : {}), model, usage };
}

/** The SDK surface the provider uses (a fake in tests). */
export type AnthropicClient = Pick<Anthropic, "messages" | "models">;

export interface CreateAnthropicBrainOptions {
  apiKey: string;
  config?: AnthropicBrainConfig;
  /** The provider runtime's fetch (tests pass a fake). */
  fetch?: typeof globalThis.fetch;
  log?: Logger;
  /** Replaces the SDK client (tests). */
  client?: AnthropicClient;
}

/** Claude through the official SDK (Messages API, native structured output, prompt caching). */
export function createAnthropicBrain(options: CreateAnthropicBrainOptions): CheckableBrainProvider {
  const config = options.config ?? {};
  const log = options.log ?? silentLogger();
  if (!options.client && !options.apiKey) {
    throw new OpenOutboundError("provider_not_configured", "The Anthropic API key is missing.", {
      hint: "Set it with manage_providers (action set, slot brain, provider anthropic) or the ANTHROPIC_API_KEY environment variable.",
      details: { slot: "brain", provider: "anthropic" },
    });
  }
  const client: AnthropicClient =
    options.client ??
    new Anthropic({
      apiKey: options.apiKey,
      authToken: null,
      ...(config.base_url ? { baseURL: normalizeBaseUrl(config.base_url) } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      maxRetries: 0,
      timeout: CLIENT_TIMEOUT_MS,
    });
  const defaultModels = mergeModels(ANTHROPIC_DEFAULT_MODELS, config.models);
  const paramOptions: AnthropicParamOptions = {
    cacheSystemPrompt: config.cache_system_prompt ?? true,
    effort: { ...ANTHROPIC_DEFAULT_EFFORT, ...config.effort },
    log,
  };
  const contextFor = (model?: string): BrainErrorContext => ({
    label: "Anthropic",
    providerId: "anthropic",
    envVar: "ANTHROPIC_API_KEY",
    ...(model ? { model } : {}),
    ...(options.apiKey ? { secrets: [options.apiKey] } : {}),
    badRequestHint:
      "Check the model id (provider config models or workspace settings ai.task_models). If the message is about the output schema, route this prompt to another provider.",
  });

  return {
    id: "anthropic",
    capabilities: {
      structuredOutput: "native",
      maxConcurrency: config.max_concurrency ?? 8,
      caching: true,
    },
    defaultModels,
    async generate(request) {
      const params = buildAnthropicParams(request, paramOptions);
      let message: Anthropic.Message;
      try {
        message = await client.messages.create(
          params,
          request.signal ? { signal: request.signal } : undefined,
        );
      } catch (error) {
        throw mapBrainApiError(contextFor(request.model), error);
      }
      return mapAnthropicMessage(message, contextFor(request.model));
    },
    async check(): Promise<ProviderTestResult> {
      const model = defaultModels.standard ?? defaultModels.fast ?? defaultModels.deep ?? "";
      try {
        const info = await client.models.retrieve(model);
        return {
          ok: true,
          message: `Connected to Anthropic; ${info.display_name || info.id} is available.`,
          details: { model: info.id },
        };
      } catch (error) {
        const failure = mapBrainApiError(contextFor(model), error);
        return {
          ok: false,
          message: failure.hint ? `${failure.message} ${failure.hint}` : failure.message,
          details: { reason: failure.details?.reason },
        };
      }
    },
  };
}

export const anthropicBrainProvider = defineProvider({
  slot: "brain",
  id: "anthropic",
  name: "Anthropic (Claude)",
  description:
    "Claude through the Anthropic API with native structured output and system prompt caching. Tiers: fast claude-haiku-4-5, standard claude-sonnet-5, deep claude-opus-5 (override with config models).",
  docsUrl: "https://platform.claude.com/docs/en/api/overview",
  configSchema: anthropicConfigSchema,
  secrets: [
    { key: "api_key", label: "Anthropic API key", env: "ANTHROPIC_API_KEY", required: true },
  ],
  create: ({ config, secrets, ctx }) =>
    createAnthropicBrain({
      apiKey: secrets.api_key ?? "",
      config,
      fetch: ctx.fetch,
      log: ctx.log,
    }),
  test: testBrainProvider,
});
