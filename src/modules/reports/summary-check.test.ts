import { describe, expect, it } from "vitest";
import { allowedNumbers, unsupportedNumbers } from "./summary-check.js";

const report = {
  period: { start_date: "2026-09-14", end_date: "2026-09-20", label: "Last 7 days" },
  data: {
    metrics: {
      contacted: { value: 1240, previous: 1100, change: 140, change_pct: 12.7 },
      reply_rate: { value: 5.26, previous: 6.1, change: -0.84, change_pct: null },
      ai_cost_usd: { value: 12.5, previous: 10, change: 2.5, change_pct: 25 },
    },
    campaigns: [{ name: "Q4 push 2026" }],
  },
};

describe("summary number guard", () => {
  it("accepts numbers from the report in the forms a writer cites them", () => {
    expect(
      unsupportedNumbers(
        "Contacted 1,240 people (+140, up 12.7%). Reply rate fell 0.84 points to 5.3% (about 5%). AI cost $12.50, campaign Q4 push 2026 ran September 14 to 20.",
        report,
      ),
    ).toEqual([]);
  });

  it("always allows small counts", () => {
    expect(unsupportedNumbers("Two replies came from 3 people in 7 days.", report)).toEqual([]);
  });

  it("flags invented numbers", () => {
    expect(
      unsupportedNumbers("Reply rate doubled to 10.5% from 1,500 sends, 37 meetings.", report),
    ).toEqual(["10.5", "1500", "37"]);
  });

  it("collects numbers from nested values and strings", () => {
    const allowed = allowedNumbers(report);
    for (const value of [
      "1240",
      "12.7",
      "5.26",
      "5.3",
      "5",
      "0.84",
      "2026",
      "14",
      "20",
      "12.5",
      "13",
    ]) {
      expect(allowed.has(value), value).toBe(true);
    }
    expect(allowed.has("11")).toBe(false);
  });
});
