/** The brain provider catalog and the fake brain. */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { outputJsonSchema } from "../../brain/json-schema.js";
import type { ServiceBrainRequest } from "../../brain/request.js";
import { createProviderCatalog } from "../registry.js";
import { clearFakeBrainAnswers, createFakeBrainProvider, setFakeBrainAnswer } from "./fake.js";
import { providers } from "./index.js";

describe("brain provider catalog", () => {
  it("registers every brain provider once, each with a connection test", () => {
    const catalog = createProviderCatalog(providers);
    expect(catalog.bySlot("brain").map((definition) => definition.id)).toEqual([
      "anthropic",
      "openai",
      "openrouter",
      "gemini",
      "openai_compatible",
      "claude_cli",
      "codex_cli",
      "agent",
      "fake",
    ]);
    for (const definition of providers) {
      expect(definition.slot).toBe("brain");
      expect(typeof definition.test, definition.id).toBe("function");
      expect(definition.configSchema?.safeParse({}).success ?? true, definition.id).toBe(true);
      expect(definition.sandbox ?? false, definition.id).toBe(definition.id === "fake");
    }
  });

  it("declares env fallbacks for API keys and never asks CLIs or the agent for secrets", () => {
    const env = Object.fromEntries(
      providers.map((definition) => [
        definition.id,
        definition.secrets.map((secret) => secret.env),
      ]),
    );
    expect(env).toMatchObject({
      anthropic: ["ANTHROPIC_API_KEY"],
      openai: ["OPENAI_API_KEY"],
      openrouter: ["OPENROUTER_API_KEY"],
      gemini: ["GEMINI_API_KEY"],
      claude_cli: [],
      codex_cli: [],
      agent: [],
    });
    const claude = providers.find((definition) => definition.id === "claude_cli");
    expect(claude?.description).toMatch(
      /uses your own Claude subscription through the official CLI; personal use/i,
    );
  });
});

describe("fake brain", () => {
  afterEach(() => clearFakeBrainAnswers());

  const schema = z.object({ category: z.enum(["a", "b"]), score: z.number().min(1) });
  const request = (promptId: string): ServiceBrainRequest => ({
    system: "s",
    messages: [{ role: "user", content: "u" }],
    jsonSchema: outputJsonSchema(schema),
    model: "fake-fast",
    maxTokens: 10,
    metadata: { promptId },
    outputSchema: schema,
    vars: { name: "Dana" },
    tier: "fast",
  });

  it("answers from the schema, shared answers and instance answers, in that order of precedence", async () => {
    const fake = createFakeBrainProvider();
    const sampled = await fake.generate(request("test.sample"));
    expect(schema.safeParse(sampled.json).success).toBe(true);
    expect(sampled.usage).toEqual({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 });

    setFakeBrainAnswer("test.sample", (vars: { name: string }) => ({
      category: "b",
      score: vars.name.length,
    }));
    expect((await fake.generate(request("test.sample"))).json).toEqual({ category: "b", score: 4 });

    fake.on("test.sample", { category: "a", score: 9 });
    expect((await fake.generate(request("test.sample"))).json).toEqual({ category: "a", score: 9 });
    expect(fake.calls.map((call) => call.promptId)).toEqual([
      "test.sample",
      "test.sample",
      "test.sample",
    ]);
  });

  it("echoes the connection test code and falls back to the JSON schema", async () => {
    const fake = createFakeBrainProvider();
    const withNonce: ServiceBrainRequest = {
      ...request("brain.connection_test"),
      vars: { nonce: "abc12345" },
    };
    const echo = await fake.generate(withNonce);
    expect(echo.json).toEqual({ ok: true, echo: "abc12345" });
    const { outputSchema: _unused, ...plain } = request("test.plugin");
    expect(schema.safeParse((await fake.generate(plain)).json).success).toBe(true);
  });
});
