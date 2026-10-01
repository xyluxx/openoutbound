import { describe, expect, it } from "vitest";
import { concurrencyLaneOf, createConcurrencyLimiter } from "./limiter.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createConcurrencyLimiter", () => {
  it("runs at most `limit` tasks per key and starts the next when one finishes", async () => {
    const limiter = createConcurrencyLimiter();
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    const runs = gates.map((gate, index) =>
      limiter.run("anthropic", 2, async () => {
        started.push(index);
        await gate.promise;
        return index;
      }),
    );
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    expect(limiter.active("anthropic")).toBe(2);
    expect(limiter.waiting("anthropic")).toBe(1);
    // Other keys are independent.
    await expect(limiter.run("openai", 1, async () => "free")).resolves.toBe("free");
    gates[0]?.resolve();
    await runs[0];
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);
    gates[1]?.resolve();
    gates[2]?.resolve();
    await expect(Promise.all(runs)).resolves.toEqual([0, 1, 2]);
    expect(limiter.active("anthropic")).toBe(0);
  });

  it("releases the slot when a task throws", async () => {
    const limiter = createConcurrencyLimiter();
    await expect(
      limiter.run("k", 1, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(limiter.run("k", 1, async () => "next")).resolves.toBe("next");
  });

  it("drops a waiting task when its signal aborts", async () => {
    const limiter = createConcurrencyLimiter();
    const gate = deferred();
    const first = limiter.run("k", 1, () => gate.promise);
    const controller = new AbortController();
    const second = limiter.run("k", 1, async () => "never", controller.signal);
    controller.abort(new Error("stop"));
    await expect(second).rejects.toThrow("stop");
    expect(limiter.waiting("k")).toBe(0);
    gate.resolve();
    await first;
  });
});

describe("concurrencyLaneOf", () => {
  it("uses the provider's concurrency key when it has one, else its id", () => {
    const base = {
      capabilities: { structuredOutput: "native" as const, maxConcurrency: 1, caching: false },
      defaultModels: {},
      generate: async () => ({
        text: "{}",
        model: "m",
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    };
    expect(concurrencyLaneOf({ ...base, id: "anthropic" })).toBe("anthropic");
    const local = {
      ...base,
      id: "openai_compatible",
      concurrencyKey: "openai_compatible:http://localhost:11434/v1",
    };
    expect(concurrencyLaneOf(local)).toBe("openai_compatible:http://localhost:11434/v1");
    expect(concurrencyLaneOf({ ...local, concurrencyKey: " " })).toBe("openai_compatible");
  });
});
