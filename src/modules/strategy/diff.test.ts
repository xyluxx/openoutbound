import { describe, expect, it } from "vitest";
import {
  describeValue,
  diffValues,
  formatPath,
  parsePath,
  pathsOverlap,
  revertDiff,
} from "./diff.js";

describe("diffValues", () => {
  it("returns nothing for equal values, including key order and dates", () => {
    expect(diffValues({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toEqual([]);
    const at = new Date("2026-09-19T12:00:00.000Z");
    expect(diffValues({ at }, { at: "2026-09-19T12:00:00.000Z" })).toEqual([]);
    expect(diffValues(null, null)).toEqual([]);
    expect(diffValues({}, { strategy: {} })).toEqual([]);
  });

  it("lists changed leaves of nested objects with dotted paths", () => {
    expect(
      diffValues(
        { booking: { mode: "link", default_url: null }, ai: { language: "en" } },
        { booking: { mode: "handoff", default_url: null }, ai: { language: "de" } },
      ),
    ).toEqual([
      { path: "booking.mode", before: "link", after: "handoff" },
      { path: "ai.language", before: "en", after: "de" },
    ]);
  });

  it("compares arrays as whole values", () => {
    expect(diffValues({ days: [1, 2, 3] }, { days: [1, 2, 3, 4] })).toEqual([
      { path: "days", before: [1, 2, 3], after: [1, 2, 3, 4] },
    ]);
  });

  it("marks added and removed keys by leaving out before or after", () => {
    const diff = diffValues(
      { ai: { monthly_budget_usd: 50 } },
      { strategy: { goals: "20 meetings a month" } },
    );
    expect(diff).toEqual([
      { path: "ai.monthly_budget_usd", before: 50 },
      { path: "strategy.goals", after: "20 meetings a month" },
    ]);
    expect("after" in (diff[0] ?? {})).toBe(false);
    expect("before" in (diff[1] ?? {})).toBe(false);
  });

  it("keeps null as a value and records type changes at the path", () => {
    expect(diffValues({ url: null }, { url: "https://cal.example.com/demo" })).toEqual([
      { path: "url", before: null, after: "https://cal.example.com/demo" },
    ]);
    expect(diffValues({ x: { y: 1 } }, { x: 5 })).toEqual([
      { path: "x", before: { y: 1 }, after: 5 },
    ]);
  });

  it("lists every field for a create or a delete", () => {
    expect(diffValues(null, { name: "Pilot", status: "active" })).toEqual([
      { path: "name", after: "Pilot" },
      { path: "status", after: "active" },
    ]);
    expect(diffValues({ name: "Pilot" }, undefined)).toEqual([{ path: "name", before: "Pilot" }]);
  });

  it("brackets keys that are not plain words", () => {
    const diff = diffValues(
      { ai: { task_models: { "campaigns.write_email": { model: "a" } } } },
      { ai: { task_models: { "campaigns.write_email": { model: "b" } } } },
    );
    expect(diff).toEqual([
      { path: 'ai.task_models["campaigns.write_email"].model', before: "a", after: "b" },
    ]);
  });
});

describe("paths", () => {
  it("round trips plain and bracketed segments", () => {
    for (const segments of [
      ["booking", "mode"],
      ["ai", "task_models", "campaigns.write_email", "model"],
      ["odd", 'key "with" quotes', "x"],
      ["a-b", "0"],
      [],
    ]) {
      expect(parsePath(formatPath(segments))).toEqual(segments);
    }
  });

  it("detects overlapping paths", () => {
    expect(pathsOverlap("booking.mode", "booking.mode")).toBe(true);
    expect(pathsOverlap("booking", "booking.mode")).toBe(true);
    expect(pathsOverlap("booking.mode", "booking")).toBe(true);
    expect(pathsOverlap("booking.mode", "booking.default_url")).toBe(false);
    expect(pathsOverlap("booking.mode", "bookings.mode")).toBe(false);
    expect(pathsOverlap("", "anything")).toBe(true);
  });
});

describe("revertDiff", () => {
  it("restores before values and removes paths that did not exist", () => {
    const before = { ai: { monthly_budget_usd: 50 }, booking: { mode: "link" } };
    const after = {
      ai: { monthly_budget_usd: 80 },
      booking: { mode: "link" },
      strategy: { goals: "More demos" },
    };
    const reverted = revertDiff(after, diffValues(before, after));
    expect(reverted).toEqual(before);
    expect(after.strategy.goals).toBe("More demos");
  });

  it("keeps sibling keys when removing a nested path", () => {
    const diff = diffValues({ strategy: { goals: "A" } }, { strategy: { goals: "A", notes: "B" } });
    expect(revertDiff({ strategy: { goals: "A", notes: "B" }, x: 1 }, diff)).toEqual({
      strategy: { goals: "A" },
      x: 1,
    });
  });

  it("recreates missing parents when restoring a value", () => {
    const diff = [{ path: "booking.mode", before: "link", after: "off" }];
    expect(revertDiff({}, diff)).toEqual({ booking: { mode: "link" } });
  });
});

describe("describeValue", () => {
  it("shortens long values and names missing ones", () => {
    expect(describeValue(undefined)).toBe("(none)");
    expect(describeValue("handoff")).toBe("handoff");
    expect(describeValue([1, 2])).toBe("[1,2]");
    expect(describeValue("x".repeat(60))).toHaveLength(40);
  });
});
