import { describe, expect, it } from "vitest";
import { OpenOutboundError } from "../../core/errors.js";
import { type Period, type PeriodRequest, periodDates, resolvePeriods } from "./period.js";

const iso = (period: Period) => [period.from.toISOString(), period.to.toISOString()];

function resolve(request: PeriodRequest, now: string, zone = "UTC") {
  return resolvePeriods(request, new Date(now), zone);
}

describe("period presets in UTC", () => {
  const now = "2026-09-19T12:00:00.000Z";

  it("today compares with yesterday up to the same time", () => {
    const { current, previous } = resolve({ preset: "today" }, now);
    expect(iso(current)).toEqual(["2026-09-19T00:00:00.000Z", now]);
    expect(current.partial).toBe(true);
    expect(iso(previous)).toEqual(["2026-09-18T00:00:00.000Z", "2026-09-18T12:00:00.000Z"]);
  });

  it("yesterday and the day before are full days", () => {
    const { current, previous } = resolve({ preset: "yesterday" }, now);
    expect(iso(current)).toEqual(["2026-09-18T00:00:00.000Z", "2026-09-19T00:00:00.000Z"]);
    expect(iso(previous)).toEqual(["2026-09-17T00:00:00.000Z", "2026-09-18T00:00:00.000Z"]);
  });

  it("last_7_days is the 7 full days before today (the default)", () => {
    const { current, previous } = resolve({}, now);
    expect(current.preset).toBe("last_7_days");
    expect(iso(current)).toEqual(["2026-09-12T00:00:00.000Z", "2026-09-19T00:00:00.000Z"]);
    expect(periodDates(current)).toEqual({ start_date: "2026-09-12", end_date: "2026-09-18" });
    expect(current.partial).toBe(false);
    expect(iso(previous)).toEqual(["2026-09-05T00:00:00.000Z", "2026-09-12T00:00:00.000Z"]);
  });

  it("last_30_days", () => {
    const { current, previous } = resolve({ preset: "last_30_days" }, now);
    expect(iso(current)).toEqual(["2026-08-20T00:00:00.000Z", "2026-09-19T00:00:00.000Z"]);
    expect(iso(previous)).toEqual(["2026-07-21T00:00:00.000Z", "2026-08-20T00:00:00.000Z"]);
  });

  it("this_month compares with the same days of last month", () => {
    const { current, previous } = resolve({ preset: "this_month" }, now);
    expect(iso(current)).toEqual(["2026-09-01T00:00:00.000Z", now]);
    expect(current.label).toBe("September 2026 to date");
    expect(iso(previous)).toEqual(["2026-08-01T00:00:00.000Z", "2026-08-19T12:00:00.000Z"]);
  });

  it("this_month on the 31st compares with the whole shorter month", () => {
    const { previous } = resolve({ preset: "this_month" }, "2026-03-31T10:00:00.000Z");
    expect(iso(previous)).toEqual(["2026-02-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z"]);
  });

  it("last_month and the month before", () => {
    const { current, previous } = resolve({ preset: "last_month" }, now);
    expect(iso(current)).toEqual(["2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z"]);
    expect(current.label).toBe("August 2026");
    expect(iso(previous)).toEqual(["2026-07-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z"]);
  });

  it("last_month in January reaches into the previous year", () => {
    const { current, previous } = resolve({ preset: "last_month" }, "2026-01-15T10:00:00.000Z");
    expect(iso(current)).toEqual(["2025-12-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"]);
    expect(iso(previous)).toEqual(["2025-11-01T00:00:00.000Z", "2025-12-01T00:00:00.000Z"]);
  });

  it("this_quarter compares with the same part of the previous quarter", () => {
    const { current, previous } = resolve({ preset: "this_quarter" }, now);
    expect(iso(current)).toEqual(["2026-07-01T00:00:00.000Z", now]);
    expect(current.label).toBe("Q3 2026 to date");
    expect(iso(previous)).toEqual(["2026-04-01T00:00:00.000Z", "2026-06-19T12:00:00.000Z"]);
    const clamped = resolve({ preset: "this_quarter" }, "2026-05-31T10:00:00.000Z");
    expect(iso(clamped.previous)).toEqual(["2026-01-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z"]);
  });
});

describe("period presets in other timezones", () => {
  it("uses the local day, not the UTC day", () => {
    // 03:00 UTC on the 19th is still the 18th in Chicago (UTC-5 in September).
    const { current } = resolve({ preset: "today" }, "2026-09-19T03:00:00.000Z", "America/Chicago");
    expect(current.from.toISOString()).toBe("2026-09-18T05:00:00.000Z");
    const week = resolve({ preset: "last_7_days" }, "2026-09-19T03:00:00.000Z", "America/Chicago");
    expect(iso(week.current)).toEqual(["2026-09-11T05:00:00.000Z", "2026-09-18T05:00:00.000Z"]);
    expect(periodDates(week.current)).toEqual({ start_date: "2026-09-11", end_date: "2026-09-17" });
  });

  it("a week across the spring DST change is one hour shorter", () => {
    const { current } = resolve(
      { preset: "last_7_days" },
      "2026-03-10T12:00:00.000Z",
      "America/New_York",
    );
    expect(iso(current)).toEqual(["2026-03-03T05:00:00.000Z", "2026-03-10T04:00:00.000Z"]);
    expect(current.to.getTime() - current.from.getTime()).toBe(7 * 86_400_000 - 3_600_000);
  });

  it("the day clocks turn back has 25 hours", () => {
    const { current } = resolve(
      { preset: "yesterday" },
      "2026-10-26T10:00:00.000Z",
      "Europe/Berlin",
    );
    expect(iso(current)).toEqual(["2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z"]);
    expect(current.to.getTime() - current.from.getTime()).toBe(25 * 3_600_000);
  });

  it("works with half-hour offsets", () => {
    const { current } = resolve(
      { preset: "yesterday" },
      "2026-09-19T12:00:00.000Z",
      "Asia/Kolkata",
    );
    expect(iso(current)).toEqual(["2026-09-17T18:30:00.000Z", "2026-09-18T18:30:00.000Z"]);
  });
});

describe("custom periods", () => {
  const now = "2026-09-19T12:00:00.000Z";

  it("dates are whole local days, the end date included", () => {
    const { current, previous } = resolve(
      { from: "2026-09-01", to: "2026-09-07" },
      now,
      "Europe/Berlin",
    );
    expect(iso(current)).toEqual(["2026-08-31T22:00:00.000Z", "2026-09-07T22:00:00.000Z"]);
    expect(current.label).toBe("2026-09-01 to 2026-09-07");
    expect(current.partial).toBe(false);
    expect(iso(previous)).toEqual(["2026-08-24T22:00:00.000Z", "2026-08-31T22:00:00.000Z"]);
    expect(previous.label).toBe("2026-08-25 to 2026-08-31");
  });

  it("datetimes are exact instants and the end is exclusive", () => {
    const { current, previous } = resolve(
      { from: "2026-09-01T00:00:00Z", to: "2026-09-02T12:00:00Z" },
      now,
    );
    expect(iso(current)).toEqual(["2026-09-01T00:00:00.000Z", "2026-09-02T12:00:00.000Z"]);
    expect(iso(previous)).toEqual(["2026-08-30T12:00:00.000Z", "2026-09-01T00:00:00.000Z"]);
  });

  it("a range ending in the future is partial", () => {
    const { current } = resolve({ from: "2026-09-15", to: "2026-09-30" }, now);
    expect(current.partial).toBe(true);
  });

  it.each([
    [
      { preset: "today" as const, from: "2026-09-01", to: "2026-09-02" },
      "either period or from/to",
    ],
    [{ from: "2026-09-01" }, "needs both from and to"],
    [{ from: "2026-09-10", to: "2026-09-01" }, "must be before"],
    [{ from: "2026-10-01", to: "2026-10-02" }, "in the future"],
    [{ from: "2020-01-01", to: "2026-01-01" }, "at most 731 days"],
    [{ from: "2026-02-30", to: "2026-03-02" }, "not a valid date"],
  ])("rejects %o", (request, message) => {
    let error: unknown;
    try {
      resolve(request, now);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(OpenOutboundError);
    expect((error as OpenOutboundError).code).toBe("validation_failed");
    expect((error as OpenOutboundError).message).toContain(message);
    expect((error as OpenOutboundError).hint).toContain("last_7_days");
  });
});
