import { describe, expect, it } from "vitest";
import { OpenOutboundError } from "../core/errors.js";
import { brainBackoffMs, isRetryableBrainError, parseRetryAfter, sleep } from "./retry.js";

describe("retry helpers", () => {
  it("parses Retry-After in seconds, milliseconds, HTTP dates and reset headers", () => {
    const now = Date.parse("2026-09-27T10:00:00Z");
    expect(parseRetryAfter(new Headers({ "retry-after": "7" }), now)).toBe(7);
    expect(parseRetryAfter({ "Retry-After-Ms": "1500" }, now)).toBe(2);
    expect(parseRetryAfter({ "retry-after": "Sun, 27 Sep 2026 10:00:30 GMT" }, now)).toBe(30);
    expect(
      parseRetryAfter({ "anthropic-ratelimit-requests-reset": "2026-09-27T10:01:00Z" }, now),
    ).toBe(60);
    expect(parseRetryAfter({ "x-ratelimit-reset-tokens": "1m30s" }, now)).toBe(90);
    expect(parseRetryAfter({ "retry-after": "soon" }, now)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });

  it("backs off exponentially with jitter and a cap", () => {
    expect(brainBackoffMs(1, () => 0.5)).toBe(1000);
    expect(brainBackoffMs(3, () => 0.5)).toBe(4000);
    expect(brainBackoffMs(10, () => 0.5)).toBe(20_000);
    expect(brainBackoffMs(1, () => 0)).toBe(800);
  });

  it("only retries provider errors marked retryable", () => {
    const retryable = new OpenOutboundError("provider_error", "429", {
      details: { retryable: true },
    });
    const fatal = new OpenOutboundError("provider_error", "401", { details: { retryable: false } });
    expect(isRetryableBrainError(retryable)).toBe(true);
    expect(isRetryableBrainError(fatal)).toBe(false);
    expect(isRetryableBrainError(new Error("x"))).toBe(false);
  });

  it("sleep resolves and aborts", async () => {
    await expect(sleep(1)).resolves.toBeUndefined();
    const controller = new AbortController();
    const pending = sleep(10_000, controller.signal);
    controller.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
  });
});
