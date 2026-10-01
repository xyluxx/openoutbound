import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { outputJsonSchema, withSchemaInstruction } from "../../brain/json-schema.js";
import type { ServiceBrainRequest } from "../../brain/request.js";
import { isOpenOutboundError, type OpenOutboundError } from "../../core/errors.js";
import { createFakeFetch, type FakeRequest, type FetchRoute } from "../../testing/fake-fetch.js";
import { geminiBrainProvider } from "./gemini.js";
import {
  buildChatCompletionParams,
  createOpenAICompatibleBrain,
  GEMINI_DEFAULT_MODELS,
  OPENROUTER_DEFAULT_MODELS,
  type OpenAICompatiblePresetId,
  stripThinking,
} from "./openai-compatible.js";
import { openrouterBrainProvider } from "./openrouter.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const draftSchema = z.object({
  subject: z.string(),
  body: z.string(),
  angle: z.enum(["signal", "pain", "peer"]),
  ps: z.string().optional(),
});
const jsonSchema = outputJsonSchema(draftSchema);

function request(overrides: Partial<ServiceBrainRequest> = {}): ServiceBrainRequest {
  return {
    system: "You write short cold emails.",
    messages: [{ role: "user", content: "Write to Dana at Harbor Dental." }],
    jsonSchema,
    schemaName: "email_draft",
    model: "example-local:8b",
    maxTokens: 800,
    metadata: { promptId: "email.draft" },
    tier: "standard",
    ...overrides,
  };
}

function setup(
  preset: OpenAICompatiblePresetId,
  routes: FetchRoute[],
  extra: { apiKey?: string; baseUrl?: string; models?: Record<string, string> } = {},
) {
  const fetch = createFakeFetch(routes);
  const brain = createOpenAICompatibleBrain({
    id: preset === "openrouter" || preset === "gemini" ? preset : "openai_compatible",
    preset,
    ...extra,
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  const body = (index: number) =>
    JSON.parse(String((fetch.calls[index] as FakeRequest).init?.body)) as Record<string, unknown>;
  const headers = (index: number) => new Headers((fetch.calls[index] as FakeRequest).init?.headers);
  return { brain, fetch, body, headers };
}

async function failure(promise: Promise<unknown>): Promise<OpenOutboundError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!isOpenOutboundError(error)) throw new Error(`expected an OpenOutboundError, got ${error}`);
  return error;
}

describe("openai-compatible brain: request mapping", () => {
  it("builds a strict json_schema response format for json_schema servers", () => {
    const params = buildChatCompletionParams(request({ temperature: 0.4 }), {
      mode: "json_schema",
      declaredNative: true,
      sendTemperature: true,
      maxTokensHeadroom: 0,
    });
    expect(params.messages[0]).toEqual({ role: "system", content: "You write short cold emails." });
    expect(params.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "email_draft", strict: true },
    });
    expect(params.temperature).toBe(0.4);
    expect(params.max_tokens).toBe(800);
  });

  it("uses JSON mode without repeating instructions the service already added", () => {
    const system = withSchemaInstruction("You write short cold emails.", jsonSchema);
    const params = buildChatCompletionParams(request({ system }), {
      mode: "json_object",
      declaredNative: false,
      sendTemperature: true,
      maxTokensHeadroom: 0,
    });
    expect(params.response_format).toEqual({ type: "json_object" });
    expect(params.messages[0]?.content).toBe(system);
  });

  it("puts the schema into the prompt when a strict schema cannot be built", () => {
    const params = buildChatCompletionParams(
      request({
        jsonSchema: outputJsonSchema(z.object({ meta: z.record(z.string(), z.string()) })),
      }),
      { mode: "json_schema", declaredNative: true, sendTemperature: false, maxTokensHeadroom: 0 },
    );
    expect(params.response_format).toEqual({ type: "json_object" });
    expect(String(params.messages[0]?.content)).toContain("JSON");
  });

  it("strips a leading think block", () => {
    expect(stripThinking('<think>\nplan {x}\n</think>\n{"a":1}')).toBe('{"a":1}');
    expect(stripThinking('{"a":1}')).toBe('{"a":1}');
  });
});

describe("openai-compatible brain: presets", () => {
  it("openrouter: requires parameters, asks for usage cost and sends attribution headers", async () => {
    const { brain, body, headers } = setup(
      "openrouter",
      [
        {
          match: /openrouter\.ai\/api\/v1\/chat\/completions$/,
          response: { json: fixture("openrouter-chat-success.json") },
        },
      ],
      { apiKey: "test-key-not-real" },
    );
    expect(brain.capabilities.structuredOutput).toBe("native");
    const response = await brain.generate(
      request({ model: "examplevendor/example-large", temperature: 0.9 }),
    );
    expect(body(0)).toMatchObject({
      model: "examplevendor/example-large",
      provider: { require_parameters: true },
      usage: { include: true },
      response_format: { type: "json_schema" },
      // Thinking counts toward max_tokens on OpenRouter: the answer keeps its full budget.
      max_tokens: 800 + 8_000,
    });
    expect(body(0).temperature).toBeUndefined();
    expect(headers(0).get("x-title")).toBe("OpenOutbound");
    expect(headers(0).get("authorization")).toBe("Bearer test-key-not-real");
    expect(response.json).toMatchObject({ subject: "Quick idea for Harbor Dental", ps: null });
    expect(response.usage).toEqual({
      inputTokens: 900,
      outputTokens: 200,
      cachedTokens: 256,
      costUsd: 0.00123,
    });
  });

  it("openrouter: falls back to JSON mode when no endpoint supports json_schema", async () => {
    let calls = 0;
    const { brain, body } = setup(
      "openrouter",
      [
        {
          match: /chat\/completions$/,
          response: () =>
            ++calls === 1
              ? { status: 404, json: fixture("openrouter-error-no-endpoints.json") }
              : { json: fixture("openrouter-chat-success.json") },
        },
      ],
      { apiKey: "test-key-not-real" },
    );
    const response = await brain.generate(request({ model: "examplevendor/example-large" }));
    expect(response.json).toBeDefined();
    expect(body(1).response_format).toEqual({ type: "json_object" });
    expect(String((body(1).messages as Array<{ content: string }>)[0]?.content)).toContain(
      '"subject"',
    );
    // The model stays in JSON mode for later calls.
    await brain.generate(request({ model: "examplevendor/example-large" }));
    expect(body(2).response_format).toEqual({ type: "json_object" });
  });

  it("openrouter: reports errors sent inside a 200 body", async () => {
    const { brain } = setup(
      "openrouter",
      [
        {
          match: /chat\/completions$/,
          response: { json: fixture("openrouter-chat-error-in-body.json") },
        },
      ],
      { apiKey: "test-key-not-real" },
    );
    const error = await failure(brain.generate(request()));
    expect(error.details).toMatchObject({
      reason: "server_error",
      retryable: true,
      upstream_status: 502,
    });
  });

  it("ollama: works without a key on localhost and strips thinking", async () => {
    const { brain, headers, fetch } = setup("ollama", [
      {
        match: "http://localhost:11434/v1/chat/completions",
        response: { json: fixture("ollama-chat-success.json") },
      },
    ]);
    const response = await brain.generate(request());
    expect(fetch.calls[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(headers(0).get("authorization")).toBe("Bearer not-needed");
    expect(response.text.startsWith("{")).toBe(true);
    expect(response.json).toEqual({
      subject: "Quick idea",
      body: "Hi Dana, short note.",
      angle: "pain",
    });
    expect(response.usage.costUsd).toBeNull();
    expect(brain.capabilities.maxConcurrency).toBe(1);
  });

  it("ollama: retries once in JSON mode when the server rejects the schema", async () => {
    let calls = 0;
    const { brain, body } = setup("ollama", [
      {
        match: /chat\/completions$/,
        response: () =>
          ++calls === 1
            ? { status: 400, json: fixture("ollama-error-schema.json") }
            : { json: fixture("ollama-chat-success.json") },
      },
    ]);
    await brain.generate(request());
    expect(body(0).response_format).toMatchObject({ type: "json_schema" });
    expect(body(1).response_format).toEqual({ type: "json_object" });
  });

  it("ollama: explains an unreachable server", async () => {
    const { brain } = setup("ollama", [
      {
        match: /chat\/completions$/,
        response: () => {
          throw Object.assign(new TypeError("fetch failed"), {
            cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), {
              code: "ECONNREFUSED",
            }),
          });
        },
      },
    ]);
    const error = await failure(brain.generate(request()));
    expect(error.details).toMatchObject({ reason: "network", retryable: true });
    expect(error.hint).toContain("model server is running");
  });

  it("deepseek: JSON mode capability", async () => {
    const { brain } = setup("deepseek", [], { apiKey: "test-key-not-real" });
    expect(brain.capabilities.structuredOutput).toBe("json_mode");
  });

  it("gemini: adds thinking headroom and reports truncation", async () => {
    const { brain, body } = setup(
      "gemini",
      [
        {
          match: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
          response: { json: fixture("gemini-chat-length.json") },
        },
      ],
      { apiKey: "test-key-not-real" },
    );
    const error = await failure(brain.generate(request({ model: "example-gemini-flash" })));
    expect(body(0).max_tokens).toBe(800 + 8_000);
    expect(error.details).toMatchObject({ reason: "max_tokens", retryable: false });
    expect(error.hint).toContain("max_tokens_headroom");
  });

  it("requires a base URL for custom servers and a key for hosted presets", () => {
    expect(() =>
      createOpenAICompatibleBrain({ id: "openai_compatible", preset: "custom" }),
    ).toThrow(/needs a base URL/);
    expect(() => createOpenAICompatibleBrain({ id: "openai_compatible", preset: "groq" })).toThrow(
      /API key is missing/,
    );
    const custom = createOpenAICompatibleBrain({
      id: "openai_compatible",
      preset: "custom",
      baseUrl: "http://10.0.0.5:8000/v1/",
      models: { standard: "example-model" },
    });
    expect(custom.defaultModels).toEqual({ standard: "example-model" });
  });

  it("gives every server its own concurrency lane", () => {
    const lane = (preset: OpenAICompatiblePresetId, baseUrl?: string) =>
      createOpenAICompatibleBrain({
        id: "openai_compatible",
        preset,
        apiKey: "test-key-not-real",
        ...(baseUrl ? { baseUrl } : {}),
      }).concurrencyKey;
    expect(lane("ollama")).toBe("openai_compatible:http://localhost:11434/v1");
    expect(lane("groq")).toBe("openai_compatible:https://api.groq.com/openai/v1");
    expect(lane("custom", "http://10.0.0.5:8000/v1/")).toBe(
      "openai_compatible:http://10.0.0.5:8000/v1",
    );
  });
});

describe("openai-compatible brain: checks", () => {
  it("openrouter checks the key", async () => {
    const { brain } = setup(
      "openrouter",
      [{ match: /\/api\/v1\/key$/, response: { json: fixture("openrouter-key.json") } }],
      { apiKey: "test-key-not-real" },
    );
    expect(await brain.check?.()).toEqual({
      ok: true,
      message: "Connected to OpenRouter (18.5 credits left on this key).",
    });
  });

  it("gemini checks the models it will use, listed as models/<id>", async () => {
    const routes: FetchRoute[] = [
      {
        match: "https://generativelanguage.googleapis.com/v1beta/openai/models",
        response: { json: fixture("gemini-models.json") },
      },
    ];
    const defaults = setup("gemini", routes, { apiKey: "test-key-not-real" });
    expect(await defaults.brain.check?.()).toMatchObject({
      ok: true,
      message: "Connected to Google Gemini; 2 models available.",
    });
    const configured = setup("gemini", routes, {
      apiKey: "test-key-not-real",
      models: { deep: "example-gemini-retired" },
    });
    expect(await configured.brain.check?.()).toMatchObject({
      ok: false,
      message:
        "Connected to Google Gemini, but these models are not available: example-gemini-retired.",
    });
  });

  it("local servers list models and flag missing ones", async () => {
    const routes: FetchRoute[] = [
      { match: /localhost:11434\/v1\/models$/, response: { json: fixture("compat-models.json") } },
    ];
    const ok = setup("ollama", routes, { models: { standard: "example-local:8b" } });
    expect(await ok.brain.check?.()).toMatchObject({
      ok: true,
      message: "Connected to Ollama; 2 models available.",
    });
    const missing = setup("ollama", routes, { models: { standard: "example-missing:70b" } });
    expect(await missing.brain.check?.()).toMatchObject({
      ok: false,
      message: "Connected to Ollama, but these models are not available: example-missing:70b.",
    });
  });
});

describe("openrouter and gemini definitions", () => {
  it("have a default model per tier that configured models override", () => {
    const openrouter = createOpenAICompatibleBrain({
      id: "openrouter",
      preset: "openrouter",
      apiKey: "test-key-not-real",
    });
    expect(openrouter.defaultModels).toEqual(OPENROUTER_DEFAULT_MODELS);
    const gemini = createOpenAICompatibleBrain({
      id: "gemini",
      preset: "gemini",
      apiKey: "test-key-not-real",
      models: { fast: "example-gemini-flash" },
    });
    expect(gemini.defaultModels).toEqual({
      ...GEMINI_DEFAULT_MODELS,
      fast: "example-gemini-flash",
    });
    // Servers whose models vary (local, groq, custom) still need config models.
    const groq = createOpenAICompatibleBrain({
      id: "openai_compatible",
      preset: "groq",
      apiKey: "test-key-not-real",
    });
    expect(groq.defaultModels).toEqual({});
  });

  it("declare env fallbacks and build instances from config", async () => {
    expect(openrouterBrainProvider.secrets[0]?.env).toBe("OPENROUTER_API_KEY");
    expect(geminiBrainProvider.secrets[0]?.env).toBe("GEMINI_API_KEY");
    const config = geminiBrainProvider.configSchema?.parse({
      models: { fast: "example-gemini-flash" },
    });
    expect(config).toEqual({ models: { fast: "example-gemini-flash" } });
  });
});
