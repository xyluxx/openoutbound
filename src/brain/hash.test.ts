import { describe, expect, it } from "vitest";
import { stableHash, stableStringify } from "./hash.js";

describe("stable hashing", () => {
  it("ignores key order and undefined fields", () => {
    expect(stableStringify({ b: 1, a: { d: [1, 2], c: undefined } })).toBe(
      '{"a":{"d":[1,2]},"b":1}',
    );
    expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1, c: undefined }));
  });

  it("normalizes dates, bigints, maps, sets and cycles", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(
      stableStringify({
        at: new Date("2026-09-27T10:00:00Z"),
        big: 10n,
        map: new Map([["k", 1]]),
        set: new Set(["x"]),
        cyclic,
      }),
    ).toBe(
      '{"at":"2026-09-27T10:00:00.000Z","big":"10","cyclic":{"name":"loop","self":"[circular]"},"map":[["k",1]],"set":["x"]}',
    );
  });

  it("changes when values change and respects the length", () => {
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
    expect(stableHash("x", 12)).toHaveLength(12);
  });
});
