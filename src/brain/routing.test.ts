import { describe, expect, it } from "vitest";
import { parseWorkspaceSettings } from "../core/settings.js";
import type { BrainProvider } from "../providers/types.js";
import { chooseRoute, modelForTier } from "./routing.js";

const prompt = { id: "campaigns.email.write", tier: "standard" as const };

function provider(defaultModels: BrainProvider["defaultModels"]): BrainProvider {
  return {
    id: "demo",
    capabilities: { structuredOutput: "native", maxConcurrency: 1, caching: false },
    defaultModels,
    generate: async () => {
      throw new Error("not used");
    },
  };
}

describe("chooseRoute", () => {
  it("uses the prompt tier when nothing overrides it", () => {
    expect(chooseRoute(prompt)).toEqual({ tier: "standard" });
  });

  it("applies tier overrides from settings.ai.task_models", () => {
    const settings = parseWorkspaceSettings({
      ai: { task_models: { standard: { provider: "openai", model: "gpt-6-astra" } } },
    });
    expect(chooseRoute(prompt, {}, settings)).toEqual({
      tier: "standard",
      providerId: "openai",
      model: "gpt-6-astra",
    });
  });

  it("prompt id overrides beat tier overrides and can change the tier", () => {
    const settings = parseWorkspaceSettings({
      ai: {
        task_models: {
          "campaigns.email.write": { tier: "deep" },
          deep: { model: "claude-fable-5-1" },
          standard: { model: "claude-sonnet-5" },
        },
      },
    });
    expect(chooseRoute(prompt, {}, settings)).toEqual({ tier: "deep", model: "claude-fable-5-1" });
  });

  it("run options win over settings", () => {
    const settings = parseWorkspaceSettings({
      ai: {
        task_models: { "campaigns.email.write": { provider: "openai", model: "gpt-6-astra" } },
      },
    });
    expect(chooseRoute(prompt, { tier: "fast", provider: "anthropic" }, settings)).toEqual({
      tier: "fast",
      providerId: "anthropic",
    });
    // A forced model skips task_models entirely.
    expect(chooseRoute(prompt, { model: "claude-opus-5" }, settings)).toEqual({
      tier: "standard",
      model: "claude-opus-5",
    });
    // A forced provider only takes models from entries that name it.
    const tierModel = parseWorkspaceSettings({
      ai: { task_models: { standard: { model: "claude-sonnet-5" } } },
    });
    expect(chooseRoute(prompt, { provider: "openai" }, tierModel)).toEqual({
      tier: "standard",
      providerId: "openai",
    });
    expect(chooseRoute(prompt, {}, tierModel)).toEqual({
      tier: "standard",
      model: "claude-sonnet-5",
    });
  });

  it("never takes a model from a level that names another provider", () => {
    const settings = parseWorkspaceSettings({
      ai: {
        task_models: {
          "campaigns.email.write": { provider: "openrouter" },
          standard: { provider: "openai", model: "gpt-6-astra" },
        },
      },
    });
    expect(chooseRoute(prompt, {}, settings)).toEqual({
      tier: "standard",
      providerId: "openrouter",
    });
  });
});

describe("modelForTier", () => {
  it("returns the tier model or falls back to a neighboring tier", () => {
    const full = provider({ fast: "haiku", standard: "sonnet", deep: "opus" });
    expect(modelForTier(full, "fast")).toBe("haiku");
    const onlyStandard = provider({ standard: "gpt-6-astra" });
    expect(modelForTier(onlyStandard, "fast")).toBe("gpt-6-astra");
    expect(modelForTier(onlyStandard, "deep")).toBe("gpt-6-astra");
    const onlyFast = provider({ fast: "small" });
    expect(modelForTier(onlyFast, "standard")).toBe("small");
  });

  it("throws provider_not_configured with a hint when there is no model", () => {
    expect(() => modelForTier(provider({}), "standard")).toThrow(
      expect.objectContaining({ code: "provider_not_configured" }),
    );
  });
});
