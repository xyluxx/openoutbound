/** Result of taking one token from a bucket. */
export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until one token is available again (0 when allowed). */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  take(key: string): RateLimitDecision;
}

/**
 * In-memory token bucket per key (spec 6): `perMinute` tokens, refilled continuously. Buckets
 * idle for 10 minutes are dropped so the map stays small.
 */
export function createRateLimiter(perMinute: number, now: () => number = Date.now): RateLimiter {
  const capacity = Math.max(1, perMinute);
  const refillPerMs = capacity / 60_000;
  const buckets = new Map<string, { tokens: number; at: number }>();
  let lastSweep = now();
  return {
    take(key) {
      const time = now();
      if (time - lastSweep > 600_000) {
        for (const [bucketKey, bucket] of buckets) {
          if (time - bucket.at > 600_000) buckets.delete(bucketKey);
        }
        lastSweep = time;
      }
      const bucket = buckets.get(key) ?? { tokens: capacity, at: time };
      bucket.tokens = Math.min(capacity, bucket.tokens + (time - bucket.at) * refillPerMs);
      bucket.at = time;
      buckets.set(key, bucket);
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return {
          allowed: true,
          limit: capacity,
          remaining: Math.floor(bucket.tokens),
          retryAfterSeconds: 0,
        };
      }
      return {
        allowed: false,
        limit: capacity,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerMs / 1000)),
      };
    },
  };
}
