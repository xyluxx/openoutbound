/** Pure rules behind the reports: signal weight suggestions, ICP calibration, send ramps, metrics. */
import { describe, expect, it } from "vitest";
import type { RampConfig } from "../../../db/schema/index.js";
import { metric, rate } from "../metric.js";
import { calibrate } from "./icp.js";
import { effectiveDailyLimit } from "./senders.js";
import { suggestWeight } from "./signals.js";

describe("suggestWeight", () => {
  const base = { baselinePeople: 400, baselinePositives: 8 };

  it("follows the playbook example: 15 of 300 against 8 of 400 moves 55 to 59", () => {
    expect(suggestWeight({ ...base, people: 300, positives: 15, currentWeight: 55 })).toBe(59);
  });

  it("moves at most 15 points per step", () => {
    expect(suggestWeight({ ...base, people: 300, positives: 60, currentWeight: 10 })).toBe(25);
    expect(suggestWeight({ ...base, people: 300, positives: 5, currentWeight: 60 })).toBe(45);
    expect(suggestWeight({ ...base, people: 300, positives: 15, currentWeight: null })).toBe(15);
  });

  it("needs 150 people and 5 positives on both sides", () => {
    expect(suggestWeight({ ...base, people: 149, positives: 15, currentWeight: 55 })).toBeNull();
    expect(suggestWeight({ ...base, people: 300, positives: 4, currentWeight: 55 })).toBeNull();
    expect(
      suggestWeight({
        people: 300,
        positives: 15,
        baselinePeople: 400,
        baselinePositives: 4,
        currentWeight: 55,
      }),
    ).toBeNull();
  });
});

describe("calibrate", () => {
  it("needs 300 contacted in tiers A and C", () => {
    expect(
      calibrate([
        { tier: "A", contacted: 299, positive_replies: 30 },
        { tier: "C", contacted: 400, positive_replies: 10 },
      ]),
    ).toEqual({
      status: "insufficient_data",
      note: "Needs 300+ contacted in tiers A and C (now A: 299, C: 400).",
    });
  });

  it("wants tier A to convert at least 1.5x tier C", () => {
    expect(
      calibrate([
        { tier: "A", contacted: 300, positive_replies: 30 },
        { tier: "C", contacted: 300, positive_replies: 15 },
      ]),
    ).toEqual({ status: "ok", note: "Tier A converts 2x tier C (target 1.5x)." });
    expect(
      calibrate([
        { tier: "A", contacted: 300, positive_replies: 12 },
        { tier: "C", contacted: 300, positive_replies: 10 },
      ]).status,
    ).toBe("miscalibrated");
    expect(
      calibrate([
        { tier: "A", contacted: 300, positive_replies: 3 },
        { tier: "C", contacted: 300, positive_replies: 0 },
      ]).status,
    ).toBe("ok");
  });
});

describe("effectiveDailyLimit", () => {
  const now = new Date("2026-09-19T12:00:00Z");
  const ramp = {
    enabled: true,
    start: 5,
    increment: 5,
    every_days: 3,
    started_at: "2026-09-10T00:00:00Z",
  };
  const mailbox = (daily_limit: number, rampConfig: RampConfig | null, created = "2026-09-10") => ({
    daily_limit,
    ramp: rampConfig,
    created_at: new Date(`${created}T08:00:00Z`),
  });

  it("ramps up from the start date and never passes the daily limit", () => {
    expect(effectiveDailyLimit(mailbox(40, ramp), now, "UTC")).toBe(20); // 9 days: 3 steps
    expect(effectiveDailyLimit(mailbox(12, ramp), now, "UTC")).toBe(12);
    expect(effectiveDailyLimit(mailbox(40, { ...ramp, enabled: false }), now, "UTC")).toBe(40);
    expect(effectiveDailyLimit(mailbox(40, null), now, "UTC")).toBe(40);
  });

  it("starts from the mailbox creation day and honors the quiet setup weeks", () => {
    const { started_at: _unused, ...rest } = ramp;
    const quiet: RampConfig = { ...rest, every_days: 7, delay_days: 14 };
    // Created 9 days ago: still in the two quiet weeks, so nothing may be sent today.
    expect(effectiveDailyLimit(mailbox(30, quiet), now, "UTC")).toBe(0);
    // Created 15 days ago: first sending week.
    expect(effectiveDailyLimit(mailbox(30, quiet, "2026-09-04"), now, "UTC")).toBe(5);
  });
});

describe("metric", () => {
  it("compares counts, rates and amounts", () => {
    expect(metric(12, 8)).toEqual({ value: 12, previous: 8, change: 4, change_pct: 50 });
    expect(metric(3, 0)).toEqual({ value: 3, previous: 0, change: 3, change_pct: null });
    expect(metric(5.26, 6.1, "rate")).toEqual({
      value: 5.3,
      previous: 6.1,
      change: -0.8,
      change_pct: null,
    });
    expect(metric(1.005, 0.5, "amount")).toEqual({
      value: 1,
      previous: 0.5,
      change: 0.5,
      change_pct: 100,
    });
    expect(metric(null, 4, "rate")).toEqual({
      value: null,
      previous: 4,
      change: null,
      change_pct: null,
    });
    expect(metric(7, undefined)).toEqual({
      value: 7,
      previous: null,
      change: null,
      change_pct: null,
    });
  });

  it("rates are percentages with one decimal, null without a denominator", () => {
    expect(rate(1, 3)).toBe(33.3);
    expect(rate(0, 0)).toBeNull();
  });
});
