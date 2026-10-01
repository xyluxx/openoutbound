import { describe, expect, it } from "vitest";
import { computeCostUsd, MODEL_PRICES, priceFor } from "./pricing.js";

describe("pricing", () => {
  it("has the dated list prices per million tokens", () => {
    expect(MODEL_PRICES["claude-haiku-4-5"]).toEqual({
      input: 1,
      output: 5,
      cacheRead: 0.1,
      cacheWrite: 1.25,
    });
    expect(MODEL_PRICES["claude-sonnet-5"]).toMatchObject({ input: 2, output: 10, cacheRead: 0.2 });
    expect(MODEL_PRICES["claude-opus-5"]).toMatchObject({ input: 5, output: 25, cacheRead: 0.5 });
    expect(MODEL_PRICES["claude-opus-5-5"]).toMatchObject({ input: 4, output: 20, cacheRead: 0.2 });
    expect(MODEL_PRICES["claude-fable-5-1"]).toMatchObject({
      input: 10,
      output: 50,
      cacheRead: 0.25,
    });
  });

  it("computes cost with cache reads and writes", () => {
    // 1000 uncached in at $2, 500 out at $10, 2000 cache reads at $0.20, 400 cache writes at $2.50
    expect(
      computeCostUsd("claude-sonnet-5", {
        uncachedInputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 2000,
        cacheWriteTokens: 400,
      }),
    ).toBe(0.0084);
    expect(
      computeCostUsd("claude-opus-5", { uncachedInputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ).toBe(30);
  });

  it("accepts dated snapshots and returns null for unknown models", () => {
    expect(priceFor("claude-haiku-4-5-20251001")).toEqual(MODEL_PRICES["claude-haiku-4-5"]);
    expect(computeCostUsd("gpt-6-astra", { uncachedInputTokens: 10, outputTokens: 10 })).toBeNull();
    expect(
      computeCostUsd("anthropic/claude-sonnet-5", { uncachedInputTokens: 1, outputTokens: 1 }),
    ).toBeNull();
    expect(priceFor(undefined)).toBeNull();
  });

  it("rounds to six decimals and never goes negative", () => {
    expect(computeCostUsd("claude-haiku-4-5", { uncachedInputTokens: 1, outputTokens: 1 })).toBe(
      0.000006,
    );
    expect(computeCostUsd("claude-haiku-4-5", { uncachedInputTokens: -5, outputTokens: 0 })).toBe(
      0,
    );
  });
});
