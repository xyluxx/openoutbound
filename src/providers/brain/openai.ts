import OpenAI from "openai";
import { z } from "zod";
import { isUnsupportedSchemaError, withSchemaInstruction } from "../../brain/json-schema.js";
import { parseJsonReply } from "../../brain/output.js";
import { requestExtras } from "../../brain/request.js";
import { toStrictJsonSchema } from "../../brain/strict-schema.js";
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

export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * Tier defaults (OpenAI's generally available GPT-6 models, checked 2026-09-27): the most
 * efficient one for fast, the mid one for standard, the most capable one for deep.
 */
export const OPENAI_DEFAULT_MODELS: Readonly<Record<ModelTier, string>> = {
  fast: "gpt-6-luna",
  standard: "gpt-6-sol",
  deep: "gpt-6-astra",
};

export const OPENAI_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type OpenAIEffort = (typeof OPENAI_EFFORTS)[number];

/** Reasoning effort per tier when the config sets none (fast calls are extraction-style). */
export const OPENAI_DEFAULT_EFFORT: Readonly<Partial<Record<ModelTier, OpenAIEffort>>> = {
  fast: "low",
};

/** Room for reasoning tokens on top of the prompt's answer budget, per effort. */
const REASONING_HEADROOM: Readonly<Record<string, number>> = {
  none: 0,
  minimal: 2_000,
  low: 4_000,
  medium: 8_000,
  default: 8_000,
  high: 16_000,
  xhigh: 32_000,
};
const MAX_OUTPUT_TOKENS = 64_000;
const CLIENT_TIMEOUT_MS = 10 * 60_000;

const effortSchema = z.enum(OPENAI_EFFORTS);

export const openaiConfigSchema = z.object({
  models: brainModelsSchema
    .optional()
    .describe(
      `Model id per tier (default: fast ${OPENAI_DEFAULT_MODELS.fast}, standard ${OPENAI_DEFAULT_MODELS.standard}, deep ${OPENAI_DEFAULT_MODELS.deep})`,
    ),
  base_url: z
    .url({ protocol: /^https?$/ })
    .optional()
    .describe(`API base URL (default ${OPENAI_BASE_URL})`),
  organization: z.string().optional().describe("OpenAI organization id"),
  project: z.string().optional().describe("OpenAI project id"),
  max_concurrency: maxConcurrencySchema.optional().describe("Max parallel calls (default 8)"),
  reasoning_effort: z
    .object({
      fast: effortSchema.optional(),
      standard: effortSchema.optional(),
      deep: effortSchema.optional(),
    })
    .optional()
    .describe("reasoning.effort per tier for reasoning models (default: low for fast)"),
});
export type OpenAIBrainConfig = z.infer<typeof openaiConfigSchema>;

/** Reasoning models (o-series, GPT-5 and newer) take `reasoning.effort` but no `temperature`. */
export function isOpenAIReasoningModel(model: string): boolean {
  const id = model.toLowerCase().replace(/^openai\//, "");
  if (id.includes("-chat")) return false;
  return /^(o\d|gpt-([5-9]|\d{2}))/.test(id);
}

export interface OpenAIParamOptions {
  effort?: Partial<Record<ModelTier, OpenAIEffort>>;
  log?: Logger;
}

/**
 * Maps a brain request to Responses API parameters: `instructions` + input messages,
 * `text.format` json_schema with `strict: true` (schema converted by `toStrictJsonSchema`; JSON
 * mode plus prompt instructions when strict mode cannot express it), reasoning effort for
 * reasoning models, `temperature` only for the others, and `store: false`.
 */
export function buildOpenAIResponseParams(
  request: BrainRequest,
  options: OpenAIParamOptions = {},
): OpenAI.Responses.ResponseCreateParamsNonStreaming {
  const model = request.model;
  const reasoning = isOpenAIReasoningModel(model);
  let instructions = request.system;
  let format: OpenAI.Responses.ResponseFormatTextConfig | undefined;
  if (request.jsonSchema) {
    try {
      format = {
        type: "json_schema",
        name: request.schemaName ?? "output",
        schema: toStrictJsonSchema(request.jsonSchema),
        strict: true,
      };
    } catch (error) {
      if (!isUnsupportedSchemaError(error)) throw error;
      options.log?.debug(
        { prompt_id: request.metadata?.promptId, reason: error.message },
        "schema not supported by strict structured outputs; using JSON mode",
      );
      format = { type: "json_object" };
      instructions = withSchemaInstruction(instructions, request.jsonSchema);
    }
  }
  const tier = requestExtras(request).tier;
  const effort = reasoning && tier ? (options.effort ?? OPENAI_DEFAULT_EFFORT)[tier] : undefined;
  const headroom = reasoning ? (REASONING_HEADROOM[effort ?? "default"] ?? 0) : 0;
  const params: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
    model,
    input: request.messages.map((message) => ({ role: message.role, content: message.content })),
    max_output_tokens: Math.min(
      Math.max(1, Math.round(request.maxTokens)) + headroom,
      MAX_OUTPUT_TOKENS,
    ),
    store: false,
  };
  if (instructions.trim()) params.instructions = instructions;
  // Groups calls of one prompt for automatic prompt caching.
  if (request.metadata?.promptId) params.prompt_cache_key = request.metadata.promptId;
  if (format) params.text = { format };
  if (effort) params.reasoning = { effort };
  if (request.temperature !== undefined && !reasoning) params.temperature = request.temperature;
  return params;
}

/** Text of the output messages (refusal parts excluded). */
function outputText(response: OpenAI.Responses.Response): { text: string; refusal: string | null } {
  let text = "";
  let refusal: string | null = null;
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type === "output_text") text += part.text;
      else if (part.type === "refusal") refusal = part.refusal;
    }
  }
  return { text, refusal };
}

/** Token usage of a Responses API call. OpenAI does not report cost: it stays null. */
export function openaiUsage(usage: OpenAI.Responses.ResponseUsage | null | undefined): BrainUsage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cachedTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
    costUsd: null,
  };
}

/** Maps a Responses API result; refusals, truncation and failed responses become clear errors. */
export function mapOpenAIResponse(
  response: OpenAI.Responses.Response,
  context: BrainErrorContext,
): BrainResponse {
  if (!response || typeof response !== "object" || !Array.isArray(response.output)) {
    throw malformedBrainAnswer(context, "no output items");
  }
  const model = response.model || context.model || "unknown";
  const usage = openaiUsage(response.usage);
  const errorContext = { ...context, model };
  const { text, refusal } = outputText(response);
  const incomplete = response.incomplete_details?.reason;
  if (refusal !== null || incomplete === "content_filter") {
    throw brainError(
      errorContext,
      `The model declined this request${refusal ? `: ${refusal.slice(0, 200)}` : " (content filter)."}`,
      {
        reason: "refusal",
        retryable: false,
        usage,
        hint: "Check the prompt input for content that trips safety filters, or route this task to another model with workspace settings ai.task_models.",
      },
    );
  }
  if (response.status === "incomplete" && incomplete === "max_output_tokens") {
    throw brainError(
      errorContext,
      `The reply was cut off at the output token limit (${usage.outputTokens} output tokens).`,
      {
        reason: "max_tokens",
        retryable: false,
        usage,
        hint: "Shorten the input or lower reasoning_effort for this tier in the provider config; reasoning counts toward the limit.",
      },
    );
  }
  if (response.status === "failed" || response.error) {
    const message = response.error?.message ?? "the response failed";
    throw brainError(errorContext, `OpenAI could not complete the response: ${message}`, {
      reason: "server_error",
      retryable: true,
      usage,
      hint: "OpenOutbound retries automatically; check the OpenAI status page if it persists.",
      extra: { upstream_code: response.error?.code ?? null },
    });
  }
  const json = parseJsonReply(text);
  return { text, ...(json !== undefined ? { json } : {}), model, usage };
}

/** The SDK surface the provider uses (a fake in tests). */
export type OpenAIClient = Pick<OpenAI, "responses" | "models">;

export interface CreateOpenAIBrainOptions {
  apiKey: string;
  config?: OpenAIBrainConfig;
  fetch?: typeof globalThis.fetch;
  log?: Logger;
  client?: OpenAIClient;
}

/** OpenAI models through the official SDK (Responses API, strict structured outputs). */
export function createOpenAIBrain(options: CreateOpenAIBrainOptions): CheckableBrainProvider {
  const config = options.config ?? {};
  const log = options.log ?? silentLogger();
  if (!options.client && !options.apiKey) {
    throw new OpenOutboundError("provider_not_configured", "The OpenAI API key is missing.", {
      hint: "Set it with manage_providers (action set, slot brain, provider openai) or the OPENAI_API_KEY environment variable.",
      details: { slot: "brain", provider: "openai" },
    });
  }
  const client: OpenAIClient =
    options.client ??
    new OpenAI({
      apiKey: options.apiKey,
      baseURL: normalizeBaseUrl(config.base_url ?? OPENAI_BASE_URL),
      organization: config.organization ?? null,
      project: config.project ?? null,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      maxRetries: 0,
      timeout: CLIENT_TIMEOUT_MS,
    });
  const defaultModels = mergeModels(OPENAI_DEFAULT_MODELS, config.models);
  const paramOptions: OpenAIParamOptions = {
    effort: { ...OPENAI_DEFAULT_EFFORT, ...config.reasoning_effort },
    log,
  };
  const contextFor = (model?: string): BrainErrorContext => ({
    label: "OpenAI",
    providerId: "openai",
    envVar: "OPENAI_API_KEY",
    ...(model ? { model } : {}),
    ...(options.apiKey ? { secrets: [options.apiKey] } : {}),
    badRequestHint:
      "Check the model id (provider config models or workspace settings ai.task_models) and that it supports the Responses API with structured outputs.",
  });

  return {
    id: "openai",
    capabilities: {
      structuredOutput: "native",
      maxConcurrency: config.max_concurrency ?? 8,
      caching: true,
    },
    defaultModels,
    async generate(request) {
      const params = buildOpenAIResponseParams(request, paramOptions);
      let response: OpenAI.Responses.Response;
      try {
        response = await client.responses.create(
          params,
          request.signal ? { signal: request.signal } : undefined,
        );
      } catch (error) {
        throw mapBrainApiError(contextFor(request.model), error);
      }
      return mapOpenAIResponse(response, contextFor(request.model));
    },
    async check(): Promise<ProviderTestResult> {
      const model = defaultModels.standard ?? OPENAI_DEFAULT_MODELS.standard;
      try {
        const info = await client.models.retrieve(model);
        return {
          ok: true,
          message: `Connected to OpenAI; ${info.id} is available.`,
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

export const openaiBrainProvider = defineProvider({
  slot: "brain",
  id: "openai",
  name: "OpenAI",
  description: `OpenAI models through the Responses API with strict structured outputs. Tiers: fast ${OPENAI_DEFAULT_MODELS.fast}, standard ${OPENAI_DEFAULT_MODELS.standard}, deep ${OPENAI_DEFAULT_MODELS.deep} (override with config models).`,
  docsUrl: "https://platform.openai.com/docs/guides/structured-outputs",
  configSchema: openaiConfigSchema,
  secrets: [{ key: "api_key", label: "OpenAI API key", env: "OPENAI_API_KEY", required: true }],
  create: ({ config, secrets, ctx }) =>
    createOpenAIBrain({ apiKey: secrets.api_key ?? "", config, fetch: ctx.fetch, log: ctx.log }),
  test: testBrainProvider,
});
