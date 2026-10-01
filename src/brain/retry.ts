import { isOpenOutboundError } from "../core/errors.js";
import { isRetryable } from "../core/failures.js";

/**
 * True for provider errors worth retrying right away (rate limits, 5xx, overloaded, timeouts,
 * dropped connections): the engine's one rule, `isRetryable` from core/failures.
 */
export function isRetryableBrainError(error: unknown): boolean {
  return isOpenOutboundError(error) && error.code === "provider_error" && isRetryable(error);
}

/** Exponential backoff for attempt n (1-based): 1s, 2s, 4s ... capped at 20s, with 20% jitter. */
export function brainBackoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(1000 * 2 ** Math.max(0, attempt - 1), 20_000);
  return Math.round(base * (0.8 + random() * 0.4));
}

/** Resolves after `ms`, or rejects with the signal's reason when it aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Seconds to wait from rate-limit headers: `retry-after-ms`, `retry-after` (seconds or an HTTP
 * date) or the Anthropic/OpenAI reset headers. Undefined when none is usable.
 */
export function parseRetryAfter(
  headers: Headers | Record<string, string | undefined> | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (!headers) return undefined;
  const get = (name: string): string | undefined => {
    if (typeof (headers as Headers).get === "function") {
      return (headers as Headers).get(name) ?? undefined;
    }
    const record = headers as Record<string, string | undefined>;
    const key = Object.keys(record).find((k) => k.toLowerCase() === name);
    return key ? record[key] : undefined;
  };
  const ms = Number(get("retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return Math.ceil(ms / 1000);
  const raw = get("retry-after")?.trim();
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
    const date = Date.parse(raw);
    if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - now) / 1000));
  }
  for (const name of [
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-reset",
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
  ]) {
    const value = get(name)?.trim();
    if (!value) continue;
    const date = Date.parse(value);
    if (!Number.isNaN(date) && /\d{4}-\d{2}-\d{2}/.test(value)) {
      return Math.max(0, Math.ceil((date - now) / 1000));
    }
    const duration = parseDuration(value);
    if (duration !== undefined) return duration;
  }
  return undefined;
}

/** "1m30s", "6s", "250ms" -> seconds (rounded up). */
function parseDuration(value: string): number | undefined {
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let total = 0;
  let matched = false;
  for (const match of value.matchAll(pattern)) {
    matched = true;
    const amount = Number(match[1]);
    const unit = match[2];
    total +=
      unit === "ms"
        ? amount / 1000
        : unit === "s"
          ? amount
          : unit === "m"
            ? amount * 60
            : amount * 3600;
  }
  return matched ? Math.ceil(total) : undefined;
}
