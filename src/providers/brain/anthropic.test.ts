import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { outputJsonSchema } from "../../brain/json-schema.js";
import type { ServiceBrainRequest } from "../../brain/request.js";
import { isOpenOutboundError, type OpenOutboundError } from "../../core/errors.js";
import { createFakeFetch, type FakeResponse } from "../../testing/fake-fetch.js";
import {
  acceptsSamplingParams,
  anthropicUsage,
  buildAnthropicParams,
  createAnthropicBrain,
  supportsEffort,
  thinksByDefault,
} from "./anthropic.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const draftSchema = z.object({
  subject: z.string().max(80),
  body: z.string(),
  angle: z.enum(["signal", "pain", "peer"]),
  ps: z.string().optional(),
});

function request(overrides: Partial<ServiceBrainRequest> = {}): ServiceBrainRequest {
  return {
    system: "You write short cold emails.",
    messages: [{ role: "user", content: "Write to Dana at Harbor Dental." }],
    jsonSchema: outputJsonSchema(draftSchema),
    schemaName: "email_draft",
    model: "claude-sonnet-5",
    maxTokens: 1000,
    metadata: { promptId: "email.draft", taskKey: "email.draft:v1:abc" },
    tier: "standard",
    ...overrides,
  };
}

function brainWith(response: FakeResponse | ((body: Record<string, unknown>) => FakeResponse)) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetch = createFakeFetch([
    {
      match: /\/v1\/messages$/,
      response: (req) => {
        const body = JSON.parse(String(req.init?.body)) as Record<string, unknown>;
        bodies.push(body);
        return typeof response === "function" ? response(body) : response;
      },
    },
    {
      match: /\/v1\/models\/claude-sonnet-5$/,
      response: { json: fixture("anthropic-model-info.json") },
    },
  ]);
  const brain = createAnthropicBrain({
    apiKey: "test-key-not-real",
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  return { brain, bodies, fetch };
}

async function failure(promise: Promise<unknown>): Promise<OpenOutboundError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!isOpenOutboundError(error)) throw new Error(`expected an OpenOutboundError, got ${error}`);
  return error;
}

describe("anthropic brain: request mapping", () => {
  it("sends the schema via output_config.format and caches the system prompt", () => {
    const params = buildAnthropicParams(request({ temperature: 0.7 }));
    expect(params.model).toBe("claude-sonnet-5");
    expect(params.system).toEqual([
      {
        type: "text",
        text: "You write short cold emails.",
        cache_control: { type: "ephemeral" },
      },
    ]);
    const format = params.output_config?.format;
    expect(format?.type).toBe("json_schema");
    expect(format?.schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["subject", "body", "angle"],
    });
    // Claude 5 rejects sampling parameters and thinks by default: room for thinking is added.
    expect(params.temperature).toBeUndefined();
    expect(params.max_tokens).toBe(1000 + 16_000);
    expect(params.output_config?.effort).toBeUndefined();
  });

  it("uses low effort for the fast tier on models that support effort", () => {
    const fast = buildAnthropicParams(request({ tier: "fast", model: "claude-sonnet-5" }));
    expect(fast.output_config?.effort).toBe("low");
    expect(fast.max_tokens).toBe(1000 + 4_000);
    const haiku = buildAnthropicParams(
      request({ tier: "fast", model: "claude-haiku-4-5", temperature: 0.2 }),
    );
    expect(haiku.output_config?.effort).toBeUndefined();
    expect(haiku.max_tokens).toBe(1000);
    expect(haiku.temperature).toBe(0.2);
    const custom = buildAnthropicParams(request({ tier: "deep", model: "claude-opus-5" }), {
      effort: { deep: "xhigh" },
    });
    expect(custom.output_config?.effort).toBe("xhigh");
    expect(custom.max_tokens).toBe(1000 + 32_000);
  });

  it("falls back to prompt instructions when Claude cannot take the schema", () => {
    const params = buildAnthropicParams(
      request({
        jsonSchema: outputJsonSchema(z.object({ meta: z.record(z.string(), z.number()) })),
      }),
    );
    expect(params.output_config?.format).toBeUndefined();
    const system = params.system as Array<{ text: string }>;
    expect(system[0]?.text).toContain("You write short cold emails.");
    expect(system[0]?.text).toContain("JSON");
  });

  it("keeps the conversation for repair calls and skips caching when disabled", () => {
    const params = buildAnthropicParams(
      request({
        messages: [
          { role: "user", content: "Write to Dana." },
          { role: "assistant", content: '{"subject": 1}' },
          { role: "user", content: "Your previous reply does not match." },
        ],
      }),
      { cacheSystemPrompt: false },
    );
    expect(params.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(params.system).toEqual([{ type: "text", text: "You write short cold emails." }]);
  });

  it("knows which models think by default and accept sampling or effort", () => {
    expect(thinksByDefault("claude-sonnet-5")).toBe(true);
    expect(thinksByDefault("claude-opus-5-5")).toBe(true);
    expect(thinksByDefault("claude-haiku-4-5-20251001")).toBe(false);
    expect(acceptsSamplingParams("claude-haiku-4-5")).toBe(true);
    expect(acceptsSamplingParams("claude-opus-4-7")).toBe(false);
    expect(acceptsSamplingParams("claude-fable-5-1")).toBe(false);
    expect(supportsEffort("claude-haiku-4-5")).toBe(false);
    expect(supportsEffort("claude-sonnet-4-6")).toBe(true);
    expect(supportsEffort("claude-opus-4-5")).toBe(true);
    expect(supportsEffort("my-proxy-model")).toBe(false);
  });
});

describe("anthropic brain: responses", () => {
  it("parses a structured reply and prices cache reads", async () => {
    const { brain, bodies } = brainWith({ json: fixture("anthropic-message-success.json") });
    const response = await brain.generate(request());
    expect(response.json).toEqual({
      subject: "Quick idea for Harbor Dental",
      body: "Hi Dana, saw the new Lakeside clinic opening.",
      angle: "signal",
    });
    expect(response.model).toBe("claude-sonnet-5");
    // 1200 uncached * $2 + 3000 cache reads * $0.20 + 400 output * $10 per million.
    expect(response.usage).toEqual({
      inputTokens: 4200,
      outputTokens: 400,
      cachedTokens: 3000,
      costUsd: 0.007,
    });
    expect(bodies[0]?.output_config).toBeDefined();
    expect(bodies[0]?.temperature).toBeUndefined();
  });

  it("turns a refusal into a non-retryable error with the category", async () => {
    const { brain } = brainWith({ json: fixture("anthropic-message-refusal.json") });
    const error = await failure(brain.generate(request({ model: "claude-opus-5" })));
    expect(error.code).toBe("provider_error");
    expect(error.details).toMatchObject({
      provider: "anthropic",
      reason: "refusal",
      retryable: false,
      category: "cyber",
    });
    expect(error.hint).toContain("ai.task_models");
  });

  it("reports a truncated reply with the spent usage", async () => {
    const { brain } = brainWith({ json: fixture("anthropic-message-max-tokens.json") });
    const error = await failure(brain.generate(request()));
    expect(error.details).toMatchObject({ reason: "max_tokens", retryable: false });
    expect(error.details?.usage).toMatchObject({
      inputTokens: 3548,
      outputTokens: 18000,
      cachedTokens: 0,
    });
  });

  it("maps rate limits with Retry-After, overload, bad requests and auth errors", async () => {
    const rateLimited = brainWith({
      status: 429,
      headers: { "retry-after": "7" },
      json: fixture("anthropic-error-rate-limit.json"),
    });
    const limited = await failure(rateLimited.brain.generate(request()));
    expect(limited.details).toMatchObject({ reason: "rate_limited", retryable: true });
    expect(limited.retryAfterSeconds).toBe(7);
    // The SDK must not retry on its own: the brain service owns retries.
    expect(rateLimited.fetch.calls).toHaveLength(1);

    const overloaded = brainWith({ status: 529, json: fixture("anthropic-error-overloaded.json") });
    expect((await failure(overloaded.brain.generate(request()))).details).toMatchObject({
      reason: "overloaded",
      retryable: true,
    });

    const invalid = brainWith({
      status: 400,
      json: fixture("anthropic-error-invalid-request.json"),
    });
    const bad = await failure(invalid.brain.generate(request()));
    expect(bad.details).toMatchObject({ reason: "bad_request", retryable: false });
    expect(bad.message).toContain("maximum");

    const auth = brainWith({ status: 401, json: fixture("anthropic-error-auth.json") });
    const denied = await failure(auth.brain.generate(request()));
    expect(denied.details).toMatchObject({ reason: "auth", retryable: false });
    expect(denied.hint).toContain("ANTHROPIC_API_KEY");
    expect(JSON.stringify(denied.details)).not.toContain("test-key-not-real");
  });

  it("checks the connection with a model lookup (no tokens spent)", async () => {
    const { brain, fetch } = brainWith({ json: fixture("anthropic-message-success.json") });
    const result = await brain.check?.();
    expect(result).toEqual({
      ok: true,
      message: "Connected to Anthropic; Claude Sonnet 5 is available.",
      details: { model: "claude-sonnet-5" },
    });
    expect(fetch.calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("uses configured models over the defaults and requires a key", () => {
    const brain = createAnthropicBrain({
      apiKey: "test-key-not-real",
      config: { models: { fast: "claude-sonnet-5" } },
    });
    expect(brain.defaultModels).toEqual({
      fast: "claude-sonnet-5",
      standard: "claude-sonnet-5",
      deep: "claude-opus-5",
    });
    expect(() => createAnthropicBrain({ apiKey: "" })).toThrow(/API key is missing/);
  });

  it("prices unknown models as null", () => {
    expect(anthropicUsage("claude-future-9", { input_tokens: 10, output_tokens: 5 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 0,
      costUsd: null,
    });
  });
});
