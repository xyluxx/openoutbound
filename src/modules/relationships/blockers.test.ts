/** Blocker helpers that need no database. */
import { describe, expect, it } from "vitest";
import { type Blocker, withoutTimingWaits } from "./blockers.js";

const at = (iso: string) => new Date(iso);
const item = (code: string, until: string | null, hard = false): Blocker => ({
  code,
  message: code,
  until,
  fix: null,
  hard,
});

describe("withoutTimingWaits", () => {
  it("drops a window or cap wait that ends by the item's own time", () => {
    const list = [
      item("outside_window", "2026-09-22T13:00:00.000Z"),
      item("daily_cap_reached", "2026-09-23T13:00:00.000Z"),
      item("enrollment_paused", "2026-09-22T12:00:00.000Z"),
      item("suppressed_email", null, true),
    ];
    expect(withoutTimingWaits(list, at("2026-09-22T13:00:00.000Z")).map((b) => b.code)).toEqual([
      "daily_cap_reached",
      "enrollment_paused",
      "suppressed_email",
    ]);
  });

  it("keeps everything without a planned time, and timing waits with no end", () => {
    const list = [item("outside_window", "2026-09-22T13:00:00.000Z"), item("no_capacity", null)];
    expect(withoutTimingWaits(list, null)).toEqual(list);
    expect(withoutTimingWaits(list, at("2026-09-30T00:00:00.000Z")).map((b) => b.code)).toEqual([
      "no_capacity",
    ]);
  });
});
