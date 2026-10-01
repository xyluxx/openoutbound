import type { BrainProvider } from "../providers/types.js";

/**
 * Per-key concurrency limits (one key per brain provider). In-process only: the limit caps
 * parallel calls from this engine process, which is what protects rate limits and local models.
 */
export interface ConcurrencyLimiter {
  /** Runs `task` once fewer than `limit` tasks with this key are running. */
  run<T>(key: string, limit: number, task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** Tasks currently running for the key. */
  active(key: string): number;
  /** Tasks waiting for a slot. */
  waiting(key: string): number;
}

interface Waiter {
  start: () => void;
  cancel: (reason: unknown) => void;
}

interface Lane {
  active: number;
  limit: number;
  queue: Waiter[];
}

export function createConcurrencyLimiter(): ConcurrencyLimiter {
  const lanes = new Map<string, Lane>();
  const lane = (key: string, limit: number): Lane => {
    let current = lanes.get(key);
    if (!current) {
      current = { active: 0, limit, queue: [] };
      lanes.set(key, current);
    }
    current.limit = Math.max(1, Math.floor(limit));
    return current;
  };

  const release = (key: string) => {
    const current = lanes.get(key);
    if (!current) return;
    current.active -= 1;
    while (current.active < current.limit && current.queue.length > 0) {
      const next = current.queue.shift();
      if (next) {
        current.active += 1;
        next.start();
      }
    }
    if (current.active === 0 && current.queue.length === 0) lanes.delete(key);
  };

  return {
    async run(key, limit, task, signal) {
      signal?.throwIfAborted();
      const current = lane(key, limit);
      if (current.active < current.limit) {
        current.active += 1;
      } else {
        await new Promise<void>((resolve, reject) => {
          const waiter: Waiter = {
            start: () => {
              signal?.removeEventListener("abort", onAbort);
              resolve();
            },
            cancel: reject,
          };
          const onAbort = () => {
            const index = current.queue.indexOf(waiter);
            if (index !== -1) current.queue.splice(index, 1);
            reject(signal?.reason ?? new Error("Aborted"));
          };
          signal?.addEventListener("abort", onAbort, { once: true });
          current.queue.push(waiter);
        });
      }
      try {
        return await task();
      } finally {
        release(key);
      }
    },
    active: (key) => lanes.get(key)?.active ?? 0,
    waiting: (key) => lanes.get(key)?.queue.length ?? 0,
  };
}

/** Process-wide limiter shared by every brain service instance. */
export const sharedBrainLimiter: ConcurrencyLimiter = createConcurrencyLimiter();

/**
 * The limiter lane of a brain provider: its `concurrencyKey` when it has one (providers that
 * reach different servers under one id, like openai_compatible presets), else its id.
 */
export function concurrencyLaneOf(provider: BrainProvider & { concurrencyKey?: unknown }): string {
  const key = provider.concurrencyKey;
  return typeof key === "string" && key.trim() ? key : provider.id;
}
