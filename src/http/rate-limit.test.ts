import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rate-limit.js";

describe("createRateLimiter", () => {
  it("allows the burst, then blocks with a retry delay, then refills", () => {
    let now = 0;
    const limiter = createRateLimiter(60, () => now);
    for (let i = 0; i < 60; i++) expect(limiter.take("k").allowed).toBe(true);
    const blocked = limiter.take("k");
    expect(blocked).toMatchObject({ allowed: false, remaining: 0, limit: 60 });
    expect(blocked.retryAfterSeconds).toBe(1);
    now += 1000;
    expect(limiter.take("k").allowed).toBe(true);
    expect(limiter.take("k").allowed).toBe(false);
  });

  it("keeps separate buckets per key", () => {
    const limiter = createRateLimiter(1, () => 0);
    expect(limiter.take("a").allowed).toBe(true);
    expect(limiter.take("a").allowed).toBe(false);
    expect(limiter.take("b").allowed).toBe(true);
  });

  it("drops idle buckets", () => {
    let now = 0;
    const limiter = createRateLimiter(1, () => now);
    limiter.take("a");
    now += 700_000;
    expect(limiter.take("a")).toMatchObject({ allowed: true });
  });
});
