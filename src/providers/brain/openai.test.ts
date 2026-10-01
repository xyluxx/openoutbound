import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { outputJsonSchema } from "../../brain/json-schema.js";
import type { ServiceBrainRequest } from "../../brain/request.js";
import { isOpenOutboundError, type OpenOutboundError } from "../../core/errors.js";
import { createFakeFetch, type FakeResponse } from "../../testing/fake-fetch.js";
import {
  buildOpenAIResponseParams,
  createOpenAIBrain,
  isOpenAIReasoningModel,
  OPENAI_DEFAULT_MODELS,
} from "./openai.js";

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
    model: "gpt-5-mini",
    maxTokens: 1000,
    metadata: { promptId: "email.draft" },
    tier: "standard",
    ...overrides,
  };
}

function brainWith(response: FakeResponse) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetch = createFakeFetch([
    {
      match: /\/v1\/responses$/,
      response: (req) => {
        bodies.push(JSON.parse(String(req.init?.body)) as Record<string, unknown>);
        return response;
      },
    },
    { match: /\/v1\/models\/gpt-5-mini$/, response: { json: fixture("openai-model.json") } },
  ]);
  const brain = createOpenAIBrain({
    apiKey: "test-key-not-real",
    config: { models: { standard: "gpt-5-mini" } },
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

describe("openai brain: request mapping", () => {
  it("sends a strict json_schema format, instructions and no temperature for reasoning models", () => {
    const params = buildOpenAIResponseParams(request({ temperature: 0.5 }));
    expect(params.instructions).toBe("You write short cold emails.");
    expect(params.input).toEqual([{ role: "user", content: "Write to Dana at Harbor Dental." }]);
    expect(params.store).toBe(false);
    expect(params.prompt_cache_key).toBe("email.draft");
    expect(params.temperature).toBeUndefined();
    expect(params.reasoning).toBeUndefined();
    expect(params.max_output_tokens).toBe(1000 + 8_000);
    const format = params.text?.format as {
      type: string;
      name: string;
      strict: boolean;
      schema: Record<string, unknown>;
    };
    expect(format.type).toBe("json_schema");
    expect(format.name).toBe("email_draft");
    expect(format.strict).toBe(true);
    expect(format.schema.required).toEqual(["subject", "body", "angle", "ps"]);
    expect((format.schema.properties as Record<string, unknown>).ps).toEqual({
      type: ["string", "null"],
    });
  });

  it("uses low reasoning effort for the fast tier and temperature for classic models", () => {
    const fast = buildOpenAIResponseParams(request({ tier: "fast" }));
    expect(fast.reasoning).toEqual({ effort: "low" });
    expect(fast.max_output_tokens).toBe(1000 + 4_000);
    const classic = buildOpenAIResponseParams(
      request({ tier: "fast", model: "gpt-4.1-mini", temperature: 0.3 }),
    );
    expect(classic.reasoning).toBeUndefined();
    expect(classic.temperature).toBe(0.3);
    expect(classic.max_output_tokens).toBe(1000);
  });

  it("falls back to JSON mode with schema instructions for shapes strict mode rejects", () => {
    const params = buildOpenAIResponseParams(
      request({
        jsonSchema: outputJsonSchema(z.object({ meta: z.record(z.string(), z.string()) })),
      }),
    );
    expect(params.text?.format).toEqual({ type: "json_object" });
    expect(params.instructions).toContain("JSON");
    expect(params.instructions).toContain("You write short cold emails.");
  });

  it("detects reasoning models", () => {
    expect(isOpenAIReasoningModel("o4-mini")).toBe(true);
    expect(isOpenAIReasoningModel("gpt-5")).toBe(true);
    expect(isOpenAIReasoningModel("openai/gpt-5-mini")).toBe(true);
    expect(isOpenAIReasoningModel("gpt-5-chat-latest")).toBe(false);
    expect(isOpenAIReasoningModel("gpt-4.1")).toBe(false);
  });
});

describe("openai brain: responses", () => {
  it("parses the structured reply and reports cached tokens without a cost", async () => {
    const { brain, bodies } = brainWith({ json: fixture("openai-response-success.json") });
    const response = await brain.generate(request());
    expect(response.json).toEqual({
      subject: "Quick idea for Harbor Dental",
      body: "Hi Dana, saw the Lakeside opening.",
      angle: "signal",
      ps: null,
    });
    expect(response.model).toBe("gpt-5-mini-2026-08-01");
    expect(response.usage).toEqual({
      inputTokens: 800,
      outputTokens: 300,
      cachedTokens: 512,
      costUsd: null,
    });
    expect(bodies[0]).toMatchObject({ model: "gpt-5-mini", store: false });
  });

  it("maps refusals and truncated replies to non-retryable errors", async () => {
    const refused = brainWith({ json: fixture("openai-response-refusal.json") });
    const refusal = await failure(refused.brain.generate(request()));
    expect(refusal.details).toMatchObject({ reason: "refusal", retryable: false });
    expect(refusal.message).toContain("can't help");

    const cut = brainWith({ json: fixture("openai-response-incomplete.json") });
    const truncated = await failure(cut.brain.generate(request()));
    expect(truncated.details).toMatchObject({ reason: "max_tokens", retryable: false });
    expect(truncated.details?.usage).toMatchObject({ outputTokens: 9000 });
  });

  it("separates rate limits from exhausted quota and explains schema rejections", async () => {
    const limited = brainWith({
      status: 429,
      headers: { "retry-after": "2" },
      json: fixture("openai-error-rate-limit.json"),
    });
    const rate = await failure(limited.brain.generate(request()));
    expect(rate.details).toMatchObject({ reason: "rate_limited", retryable: true });
    expect(rate.retryAfterSeconds).toBe(2);
    expect(limited.fetch.calls).toHaveLength(1);

    const broke = brainWith({ status: 429, json: fixture("openai-error-quota.json") });
    const quota = await failure(broke.brain.generate(request()));
    expect(quota.details).toMatchObject({ reason: "quota", retryable: false });

    const invalid = brainWith({ status: 400, json: fixture("openai-error-invalid-schema.json") });
    const bad = await failure(invalid.brain.generate(request()));
    expect(bad.details).toMatchObject({ reason: "bad_request", retryable: false });
    expect(bad.message).toContain("Invalid schema");
    expect(bad.hint).toContain("Responses API");
  });

  it("checks the configured model without generating tokens", async () => {
    const { brain, fetch } = brainWith({ json: {} });
    expect(await brain.check?.()).toEqual({
      ok: true,
      message: "Connected to OpenAI; gpt-5-mini is available.",
      details: { model: "gpt-5-mini" },
    });
    expect(fetch.calls[0]?.method).toBe("GET");
  });

  it("has a default model per tier, configured models win, and needs a key", () => {
    expect(createOpenAIBrain({ apiKey: "test-key-not-real" }).defaultModels).toEqual(
      OPENAI_DEFAULT_MODELS,
    );
    const configured = createOpenAIBrain({
      apiKey: "test-key-not-real",
      config: { models: { fast: "gpt-6-sol" } },
    });
    expect(configured.defaultModels).toEqual({
      fast: "gpt-6-sol",
      standard: "gpt-6-sol",
      deep: "gpt-6-astra",
    });
    expect(() => createOpenAIBrain({ apiKey: "" })).toThrow(/API key is missing/);
  });
});
