import OpenAI from "openai";
import { z } from "zod";
import { isUnsupportedSchemaError, withSchemaInstruction } from "../../brain/json-schema.js";
import { parseJsonReply } from "../../brain/output.js";
import { toStrictJsonSchema } from "../../brain/strict-schema.js";
import type { ModelTier } from "../../core/enums.js";
import { isOpenOutboundError, OpenOutboundError } from "../../core/errors.js";
import { type Logger, silentLogger } from "../../core/logger.js";
import {
  type BrainCapabilities,
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
  type BrainModels,
  brainModelsSchema,
  type CheckableBrainProvider,
  maxConcurrencySchema,
  mergeModels,
  normalizeBaseUrl,
  testBrainProvider,
} from "./shared.js";

/** How a server takes the output schema: enforced schema, any JSON, or prompt text only. */
export type StructuredOutputMode = "json_schema" | "json_object" | "prompt";
export const STRUCTURED_OUTPUT_MODES = ["json_schema", "json_object", "prompt"] as const;

export interface OpenAICompatiblePreset {
  label: string;
  /** Default base URL; `custom` has none and needs `base_url`. */
  baseUrl?: string;
  structuredOutput: StructuredOutputMode;
  maxConcurrency: number;
  /** Local model servers: no API key needed (reached through the plain fetch, not safe fetch). */
  local: boolean;
  /** Send `temperature` when a prompt sets one. */
  sendTemperature: boolean;
  /** Extra `max_tokens` for thinking models, whose thinking counts toward the limit. */
  maxTokensHeadroom: number;
  /** Env var hint for auth errors. */
  envVar?: string;
  /** Model per tier when the config sets none (hosted presets whose models are known). */
  defaultModels?: Readonly<Record<ModelTier, string>>;
}

/**
 * OpenRouter tier defaults: the Anthropic defaults (the models the prompts are tuned on) under
 * their OpenRouter ids, checked 2026-09-27.
 */
export const OPENROUTER_DEFAULT_MODELS: Readonly<Record<ModelTier, string>> = {
  fast: "anthropic/claude-haiku-4.5",
  standard: "anthropic/claude-sonnet-5",
  deep: "anthropic/claude-opus-5",
};

/**
 * Gemini tier defaults (stable models, checked 2026-09-27): the low-cost Flash-Lite for fast,
 * the newest Flash for standard and deep (there is no stable Pro model of this generation).
 */
export const GEMINI_DEFAULT_MODELS: Readonly<Record<ModelTier, string>> = {
  fast: "gemini-3.5-flash-lite",
  standard: "gemini-3.8-flash",
  deep: "gemini-3.8-flash",
};

/**
 * Presets for OpenAI-compatible Chat Completions servers. Structured output support differs:
 * servers with `json_schema` enforce the schema, `json_object` servers only guarantee JSON
 * (the schema goes into the prompt). The brain service validates every answer either way.
 */
export const OPENAI_COMPATIBLE_PRESETS = {
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    structuredOutput: "json_schema",
    maxConcurrency: 8,
    local: false,
    sendTemperature: false,
    // Claude 5 and GPT models think by default, and OpenRouter counts that toward max_tokens.
    maxTokensHeadroom: 8_000,
    envVar: "OPENROUTER_API_KEY",
    defaultModels: OPENROUTER_DEFAULT_MODELS,
  },
  gemini: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    structuredOutput: "json_schema",
    maxConcurrency: 4,
    local: false,
    sendTemperature: true,
    maxTokensHeadroom: 8_000,
    envVar: "GEMINI_API_KEY",
    defaultModels: GEMINI_DEFAULT_MODELS,
  },
  ollama: {
    label: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    structuredOutput: "json_schema",
    maxConcurrency: 1,
    local: true,
    sendTemperature: true,
    maxTokensHeadroom: 0,
  },
  lmstudio: {
    label: "LM Studio",
    baseUrl: "http://localhost:1234/v1",
    structuredOutput: "json_schema",
    maxConcurrency: 1,
    local: true,
    sendTemperature: true,
    maxTokensHeadroom: 0,
  },
  groq: {
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    structuredOutput: "json_object",
    maxConcurrency: 4,
    local: false,
    sendTemperature: true,
    maxTokensHeadroom: 0,
  },
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    structuredOutput: "json_object",
    maxConcurrency: 4,
    local: false,
    sendTemperature: true,
    maxTokensHeadroom: 0,
  },
  together: {
    label: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    structuredOutput: "json_object",
    maxConcurrency: 4,
    local: false,
    sendTemperature: true,
    maxTokensHeadroom: 0,
  },
  mistral: {
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    structuredOutput: "json_schema",
    maxConcurrency: 4,
    local: false,
    sendTemperature: true,
    maxTokensHeadroom: 0,
  },
  custom: {
    label: "OpenAI-compatible server",
    structuredOutput: "json_object",
    maxConcurrency: 2,
    local: false,
    sendTemperature: true,
    maxTokensHeadroom: 0,
  },
} as const satisfies Record<string, OpenAICompatiblePreset>;

export type OpenAICompatiblePresetId = keyof typeof OPENAI_COMPATIBLE_PRESETS;
export const OPENAI_COMPATIBLE_PRESET_IDS = Object.keys(
  OPENAI_COMPATIBLE_PRESETS,
) as OpenAICompatiblePresetId[];

/** OpenRouter attribution headers (optional, identify the app in OpenRouter rankings). */
const OPENROUTER_HEADERS = {
  "HTTP-Referer": "https://github.com/xyluxx/openoutbound",
  "X-Title": "OpenOutbound",
};
const CLIENT_TIMEOUT_MS = 10 * 60_000;
/** Placeholder key for local servers: never let the SDK fall back to OPENAI_API_KEY. */
const NO_KEY = "not-needed";

export const openaiCompatibleConfigSchema = z.object({
  preset: z
    .enum(OPENAI_COMPATIBLE_PRESET_IDS as [OpenAICompatiblePresetId, ...OpenAICompatiblePresetId[]])
    .default("custom")
    .describe(
      "Server preset: openrouter, gemini, ollama, lmstudio, groq, deepseek, together, mistral or custom",
    ),
  base_url: z
    .url({ protocol: /^https?$/ })
    .optional()
    .describe("Base URL ending in /v1 (required for custom)"),
  models: brainModelsSchema
    .optional()
    .describe("Model id per tier (required, except for the openrouter and gemini presets)"),
  structured_output: z
    .enum(STRUCTURED_OUTPUT_MODES)
    .optional()
    .describe("Override the preset: json_schema, json_object or prompt"),
  max_concurrency: maxConcurrencySchema.optional(),
  max_tokens_headroom: z
    .number()
    .int()
    .min(0)
    .max(64_000)
    .optional()
    .describe("Extra max_tokens for thinking models (thinking counts toward the limit)"),
});
export type OpenAICompatibleConfig = z.infer<typeof openaiCompatibleConfigSchema>;

export interface ChatParamOptions {
  mode: StructuredOutputMode;
  /** The provider declared native structured output: fallbacks must add the schema text. */
  declaredNative: boolean;
  sendTemperature: boolean;
  maxTokensHeadroom: number;
  /** Extra body fields (OpenRouter routing and usage accounting). */
  extraBody?: Record<string, unknown>;
  log?: Logger;
}

type ChatParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming &
  Record<string, unknown>;

/**
 * Maps a brain request to Chat Completions parameters for the server's structured output mode:
 * `response_format` json_schema (strict schema), json_object, or none. When a strict schema
 * cannot be built the request uses JSON mode and puts the schema into the system message.
 */
export function buildChatCompletionParams(
  request: BrainRequest,
  options: ChatParamOptions,
): ChatParams {
  let system = request.system;
  let responseFormat: ChatParams["response_format"];
  if (request.jsonSchema && options.mode === "json_schema") {
    try {
      responseFormat = {
        type: "json_schema",
        json_schema: {
          name: request.schemaName ?? "output",
          schema: toStrictJsonSchema(request.jsonSchema),
          strict: true,
        },
      };
    } catch (error) {
      if (!isUnsupportedSchemaError(error)) throw error;
      options.log?.debug(
        { prompt_id: request.metadata?.promptId, reason: error.message },
        "schema not supported in strict mode; using JSON mode",
      );
      responseFormat = { type: "json_object" };
      if (options.declaredNative) system = withSchemaInstruction(system, request.jsonSchema);
    }
  } else if (request.jsonSchema && options.mode === "json_object") {
    responseFormat = { type: "json_object" };
    if (options.declaredNative) system = withSchemaInstruction(system, request.jsonSchema);
  } else if (request.jsonSchema && options.declaredNative) {
    system = withSchemaInstruction(system, request.jsonSchema);
  }
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  if (system.trim()) messages.push({ role: "system", content: system });
  for (const message of request.messages) {
    messages.push({ role: message.role, content: message.content });
  }
  const params: ChatParams = {
    model: request.model,
    messages,
    max_tokens: Math.max(1, Math.round(request.maxTokens)) + options.maxTokensHeadroom,
    ...options.extraBody,
  };
  if (responseFormat) params.response_format = responseFormat;
  if (request.temperature !== undefined && options.sendTemperature) {
    params.temperature = request.temperature;
  }
  return params;
}

/** A completion as some servers send it: OpenRouter adds `usage.cost` and in-body errors. */
type CompatCompletion = OpenAI.Chat.Completions.ChatCompletion & {
  error?: { code?: number | string; message?: string; metadata?: unknown };
  usage?: OpenAI.Completions.CompletionUsage & { cost?: number | null };
};

/** Token usage; cost only when the server reports it (OpenRouter `usage.cost`). */
export function chatUsage(usage: CompatCompletion["usage"] | undefined): BrainUsage {
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    costUsd: typeof usage?.cost === "number" && Number.isFinite(usage.cost) ? usage.cost : null,
  };
}

/** Removes a leading `<think>...</think>` block some local reasoning models emit. */
export function stripThinking(text: string): string {
  return text.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, "");
}

/** Maps a Chat Completions result; refusals, truncation and in-body errors become clear errors. */
export function mapChatCompletion(
  completion: CompatCompletion,
  context: BrainErrorContext,
): BrainResponse {
  // Neither choices nor an error: not a Chat Completions answer (an HTML page, another API).
  if (
    !completion ||
    typeof completion !== "object" ||
    (!Array.isArray(completion.choices) && !completion.error)
  ) {
    throw malformedBrainAnswer(context, "no choices");
  }
  const model = completion.model || context.model || "unknown";
  const usage = chatUsage(completion.usage);
  const errorContext = { ...context, model };
  if (completion.error) {
    const status = Number(completion.error.code);
    const rateLimited = status === 429;
    throw brainError(
      errorContext,
      `${context.label} returned an error: ${String(completion.error.message ?? "unknown error").slice(0, 300)}`,
      {
        reason: rateLimited ? "rate_limited" : "server_error",
        retryable: rateLimited || !Number.isFinite(status) || status >= 500,
        usage,
        hint: "OpenOutbound retries automatically; if it persists, pick another model for this task.",
        ...(Number.isFinite(status) ? { status } : {}),
      },
    );
  }
  const choice = completion.choices?.[0];
  if (!choice) {
    throw brainError(errorContext, `${context.label} returned no answer.`, {
      reason: "server_error",
      retryable: true,
      usage,
      hint: "OpenOutbound retries automatically; check the model server if it persists.",
    });
  }
  const refusal = choice.message?.refusal;
  if (refusal || choice.finish_reason === "content_filter") {
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
  if (choice.finish_reason === "length") {
    throw brainError(
      errorContext,
      `The reply was cut off at the max_tokens limit (${usage.outputTokens} output tokens).`,
      {
        reason: "max_tokens",
        retryable: false,
        usage,
        hint: "Shorten the input, or raise max_tokens_headroom in the provider config for thinking models.",
      },
    );
  }
  const text = stripThinking(choice.message?.content ?? "");
  const json = parseJsonReply(text);
  return { text, ...(json !== undefined ? { json } : {}), model, usage };
}

/**
 * Errors that say the server does not take the json_schema response format: a 400/422 about the
 * schema, or OpenRouter finding no endpoint that supports the requested parameters.
 */
function isSchemaRejection(error: unknown): boolean {
  if (!isOpenOutboundError(error)) return false;
  const reason = error.details?.reason;
  if (reason === "model_not_found") return /requested parameters/i.test(error.message);
  if (reason !== "bad_request") return false;
  return /schema|response_format|structured|json_object|grammar/i.test(error.message);
}

/** The SDK surface the provider uses (a fake in tests). */
export type ChatClient = Pick<OpenAI, "chat" | "models" | "get">;

export interface CreateOpenAICompatibleBrainOptions {
  /** Provider id: "openai_compatible", "openrouter" or "gemini". */
  id: string;
  preset: OpenAICompatiblePresetId;
  apiKey?: string;
  baseUrl?: string;
  models?: BrainModels;
  structuredOutput?: StructuredOutputMode;
  maxConcurrency?: number;
  maxTokensHeadroom?: number;
  fetch?: typeof globalThis.fetch;
  log?: Logger;
  client?: ChatClient;
}

const CAPABILITY: Record<StructuredOutputMode, BrainCapabilities["structuredOutput"]> = {
  json_schema: "native",
  json_object: "json_mode",
  prompt: "prompt",
};

/**
 * A brain for any OpenAI-compatible Chat Completions server (OpenRouter, Gemini, Ollama,
 * LM Studio, Groq, DeepSeek, Together, Mistral or a custom URL). When a server rejects the
 * json_schema response format, the provider switches that model to JSON mode and retries once.
 */
export function createOpenAICompatibleBrain(
  options: CreateOpenAICompatibleBrainOptions,
): CheckableBrainProvider {
  const preset: OpenAICompatiblePreset = OPENAI_COMPATIBLE_PRESETS[options.preset];
  const log = options.log ?? silentLogger();
  const baseUrl = options.baseUrl ?? preset.baseUrl;
  const configHint = `manage_providers (action set, slot brain, provider ${options.id})`;
  if (!baseUrl) {
    throw new OpenOutboundError(
      "provider_not_configured",
      `The ${preset.label} brain needs a base URL.`,
      {
        hint: `Set config base_url (for example http://localhost:8000/v1) with ${configHint}.`,
        details: { slot: "brain", provider: options.id },
      },
    );
  }
  if (!preset.local && options.preset !== "custom" && !options.apiKey && !options.client) {
    throw new OpenOutboundError(
      "provider_not_configured",
      `The ${preset.label} API key is missing.`,
      {
        hint: `Set it with ${configHint}${"envVar" in preset && preset.envVar ? ` or the ${preset.envVar} environment variable` : ""}.`,
        details: { slot: "brain", provider: options.id },
      },
    );
  }
  const isOpenRouter = options.preset === "openrouter";
  const defaultModels = mergeModels(preset.defaultModels ?? {}, options.models);
  const client: ChatClient =
    options.client ??
    new OpenAI({
      apiKey: options.apiKey || NO_KEY,
      baseURL: normalizeBaseUrl(baseUrl),
      organization: null,
      project: null,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(isOpenRouter ? { defaultHeaders: OPENROUTER_HEADERS } : {}),
      maxRetries: 0,
      timeout: CLIENT_TIMEOUT_MS,
    });
  const mode = options.structuredOutput ?? preset.structuredOutput;
  const declaredNative = mode === "json_schema";
  const downgraded = new Set<string>();
  const extraBody = isOpenRouter
    ? { provider: { require_parameters: true }, usage: { include: true } }
    : undefined;
  const envVar = "envVar" in preset ? preset.envVar : undefined;
  const contextFor = (model?: string): BrainErrorContext => ({
    label: preset.label,
    providerId: options.id,
    ...(envVar ? { envVar } : {}),
    ...(model ? { model } : {}),
    ...(options.apiKey ? { secrets: [options.apiKey] } : {}),
    badRequestHint: `Check the model id (provider config models or workspace settings ai.task_models)${preset.local ? " and that the model is pulled or loaded on the server" : ""}.`,
  });
  const paramsFor = (request: BrainRequest, requestMode: StructuredOutputMode) =>
    buildChatCompletionParams(request, {
      mode: requestMode,
      declaredNative,
      sendTemperature: preset.sendTemperature,
      maxTokensHeadroom: options.maxTokensHeadroom ?? preset.maxTokensHeadroom,
      ...(extraBody ? { extraBody } : {}),
      log,
    });
  const send = async (request: BrainRequest, params: ChatParams): Promise<BrainResponse> => {
    let completion: CompatCompletion;
    try {
      completion = (await client.chat.completions.create(
        params,
        request.signal ? { signal: request.signal } : undefined,
      )) as CompatCompletion;
    } catch (error) {
      throw mapBrainApiError(contextFor(request.model), error);
    }
    return mapChatCompletion(completion, contextFor(request.model));
  };

  return {
    id: options.id,
    concurrencyKey: `${options.id}:${normalizeBaseUrl(baseUrl)}`,
    capabilities: {
      structuredOutput: CAPABILITY[mode],
      maxConcurrency: options.maxConcurrency ?? preset.maxConcurrency,
      caching: false,
    },
    defaultModels,
    async generate(request) {
      const requestMode = downgraded.has(request.model) ? "json_object" : mode;
      try {
        return await send(request, paramsFor(request, requestMode));
      } catch (error) {
        if (requestMode !== "json_schema" || !request.jsonSchema || !isSchemaRejection(error)) {
          throw error;
        }
        log.warn(
          { provider: options.id, model: request.model, err: (error as Error).message },
          "server rejected the json_schema response format; using JSON mode for this model",
        );
        downgraded.add(request.model);
        return send(request, paramsFor(request, "json_object"));
      }
    },
    async check(): Promise<ProviderTestResult> {
      try {
        if (isOpenRouter) {
          const key = await client.get<{
            data?: { label?: string; limit_remaining?: number | null };
          }>("/key");
          const remaining = key.data?.limit_remaining;
          return {
            ok: true,
            message: `Connected to OpenRouter${typeof remaining === "number" ? ` (${remaining} credits left on this key)` : ""}.`,
          };
        }
        const page = await client.models.list();
        // Gemini lists "models/<id>"; requests take the bare id.
        const ids = page.data.map((model) => model.id.replace(/^models\//, ""));
        const used = [...new Set(Object.values(defaultModels))];
        const missing = used.filter((model) => ids.length > 0 && !ids.includes(model));
        if (missing.length > 0) {
          return {
            ok: false,
            message: `Connected to ${preset.label}, but these models are not available: ${missing.join(", ")}.`,
            details: { available: ids.slice(0, 20) },
          };
        }
        return {
          ok: true,
          message: `Connected to ${preset.label}; ${ids.length} models available.`,
          details: { available: ids.slice(0, 20) },
        };
      } catch (error) {
        const failure = mapBrainApiError(contextFor(), error);
        return {
          ok: false,
          message: failure.hint ? `${failure.message} ${failure.hint}` : failure.message,
          details: { reason: failure.details?.reason },
        };
      }
    },
  };
}

export const openaiCompatibleBrainProvider = defineProvider({
  slot: "brain",
  id: "openai_compatible",
  name: "OpenAI-compatible server",
  description:
    'Any OpenAI-compatible Chat Completions server: local models (preset ollama or lmstudio), groq, deepseek, together, mistral, or a custom base_url. Needs config models, e.g. {"preset":"ollama","models":{"standard":"<model name>"}}.',
  configSchema: openaiCompatibleConfigSchema,
  secrets: [
    {
      key: "api_key",
      label: "API key",
      required: false,
      description: "Not needed for local servers (Ollama, LM Studio).",
    },
  ],
  create: ({ config, secrets, ctx }) =>
    createOpenAICompatibleBrain({
      id: "openai_compatible",
      preset: config.preset,
      ...(secrets.api_key ? { apiKey: secrets.api_key } : {}),
      ...(config.base_url ? { baseUrl: config.base_url } : {}),
      ...(config.models ? { models: config.models } : {}),
      ...(config.structured_output ? { structuredOutput: config.structured_output } : {}),
      ...(config.max_concurrency ? { maxConcurrency: config.max_concurrency } : {}),
      ...(config.max_tokens_headroom !== undefined
        ? { maxTokensHeadroom: config.max_tokens_headroom }
        : {}),
      fetch: ctx.fetch,
      log: ctx.log,
    }),
  test: testBrainProvider,
});
