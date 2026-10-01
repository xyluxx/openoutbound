/** Date the price table was checked against the provider pricing pages. */
export const PRICES_AS_OF = "2026-09-27";

/** USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  /** Cache read price (Anthropic: 0.1x input unless the pricing page says otherwise). */
  cacheRead: number;
  /** 5-minute cache write price (1.25x input). */
  cacheWrite: number;
}

const price = (input: number, output: number, cacheReadFactor = 0.1): ModelPrice => ({
  input,
  output,
  cacheRead: round(input * cacheReadFactor, 6),
  cacheWrite: round(input * 1.25, 6),
});

/**
 * Known model prices (Anthropic list prices, 2026-09-27). Models not listed have unknown cost
 * (null) unless the provider reports a cost itself (OpenRouter does).
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = Object.freeze({
  "claude-haiku-4-5": price(1, 5),
  "claude-sonnet-5": price(2, 10),
  "claude-opus-5": price(5, 25),
  // Cache reads are cheaper than 0.1x on these two: $0.20 and $0.25 per million.
  "claude-opus-5-5": price(4, 20, 0.05),
  "claude-fable-5-1": price(10, 50, 0.025),
});

/** Price of a model, accepting dated snapshot ids (`claude-haiku-4-5-20251001`). */
export function priceFor(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  const id = model.trim().toLowerCase();
  return MODEL_PRICES[id] ?? MODEL_PRICES[id.replace(/-\d{8}$/, "")] ?? null;
}

export interface TokenCounts {
  /** Input tokens billed at the full rate (not read from or written to the cache). */
  uncachedInputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Cost in USD (6 decimals) for a call, or null when the model has no known price. */
export function computeCostUsd(
  model: string | null | undefined,
  tokens: TokenCounts,
): number | null {
  const p = priceFor(model);
  if (!p) return null;
  const cost =
    (Math.max(0, tokens.uncachedInputTokens) * p.input +
      Math.max(0, tokens.outputTokens) * p.output +
      Math.max(0, tokens.cacheReadTokens ?? 0) * p.cacheRead +
      Math.max(0, tokens.cacheWriteTokens ?? 0) * p.cacheWrite) /
    1_000_000;
  return round(cost, 6);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
