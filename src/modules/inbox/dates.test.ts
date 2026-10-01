import { describe, expect, it } from "vitest";
import {
  followUpDueAt,
  isIsoDate,
  isoDateInZone,
  nextSendWindowStart,
  nextWorkingDay,
  outOfOfficeResumeAt,
  safeTimeZone,
  zonedMidnight,
} from "./dates.js";

const weekdays = [1, 2, 3, 4, 5];
// Saturday 2026-09-19 12:00 UTC (the test clock default).
const now = new Date("2026-09-19T12:00:00Z");

describe("zonedMidnight", () => {
  it("handles offsets and DST", () => {
    expect(zonedMidnight("2026-09-29", "America/Chicago").toISOString()).toBe(
      "2026-09-29T05:00:00.000Z",
    );
    // Berlin leaves summer time on 2026-10-25: midnight before is UTC+2, after is UTC+1.
    expect(zonedMidnight("2026-10-25", "Europe/Berlin").toISOString()).toBe(
      "2026-10-24T22:00:00.000Z",
    );
    expect(zonedMidnight("2026-10-26", "Europe/Berlin").toISOString()).toBe(
      "2026-10-25T23:00:00.000Z",
    );
    expect(zonedMidnight("2026-10-01", "Asia/Tokyo").toISOString()).toBe(
      "2026-09-30T15:00:00.000Z",
    );
  });

  it("falls back to UTC for unknown zones", () => {
    expect(safeTimeZone("Mars/Olympus")).toBe("UTC");
    expect(zonedMidnight("2026-10-01", "Mars/Olympus").toISOString()).toBe(
      "2026-10-01T00:00:00.000Z",
    );
  });

  it("reads local dates", () => {
    expect(isoDateInZone(new Date("2026-09-20T02:00:00Z"), "America/Chicago")).toBe("2026-09-19");
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-02-28")).toBe(true);
  });
});

describe("nextWorkingDay", () => {
  it("skips weekends and holidays", () => {
    expect(nextWorkingDay("2026-09-28", weekdays, [])).toBe("2026-09-29"); // Mon -> Tue
    expect(nextWorkingDay("2026-10-02", weekdays, [])).toBe("2026-10-05"); // Fri -> Mon
    expect(nextWorkingDay("2026-10-02", weekdays, ["2026-10-05"])).toBe("2026-10-06");
    expect(nextWorkingDay("2026-10-02", [], [])).toBe("2026-10-03");
  });
});

describe("outOfOfficeResumeAt", () => {
  it("resumes at local midnight of the first working day after the return date", () => {
    const result = outOfOfficeResumeAt({
      returnDate: "2026-09-28",
      now,
      timeZone: "America/Chicago",
      workingDays: weekdays,
      holidays: [],
    });
    expect(result).toEqual({
      until: new Date("2026-09-29T05:00:00.000Z"),
      defaulted: false,
      capped: false,
    });
  });

  it("crosses a DST change correctly", () => {
    const result = outOfOfficeResumeAt({
      returnDate: "2026-10-23",
      now,
      timeZone: "Europe/Berlin",
      workingDays: weekdays,
      holidays: [],
    });
    expect(result.until.toISOString()).toBe("2026-10-25T23:00:00.000Z"); // Monday 00:00 CET
  });

  it("defaults to 7 days for missing, invalid or past dates", () => {
    for (const returnDate of [null, undefined, "next week", "2026-09-01"]) {
      const result = outOfOfficeResumeAt({
        returnDate,
        now,
        timeZone: "UTC",
        workingDays: weekdays,
        holidays: [],
      });
      expect(result).toEqual({
        until: new Date("2026-09-26T12:00:00.000Z"),
        defaulted: true,
        capped: false,
      });
    }
  });

  it("caps long absences", () => {
    const result = outOfOfficeResumeAt({
      returnDate: "2027-12-01",
      now,
      timeZone: "UTC",
      workingDays: weekdays,
      holidays: [],
    });
    expect(result.capped).toBe(true);
    expect(result.until.toISOString()).toBe("2027-03-18T12:00:00.000Z");
  });
});

describe("nextSendWindowStart", () => {
  const window = {
    days: weekdays,
    startHour: 8,
    endHour: 17,
    timeZone: "America/Chicago",
    holidays: ["2026-09-21"],
    blackoutRanges: [{ from: "2026-12-24", to: "2026-12-26" }],
  };

  it("keeps a moment inside the window", () => {
    const tuesdayNoon = new Date("2026-09-22T17:00:00Z"); // 12:00 CDT
    expect(nextSendWindowStart(tuesdayNoon, window)).toEqual(tuesdayNoon);
  });

  it("moves weekend, holiday, night and blackout moments to the next opening", () => {
    // Saturday -> Monday is a holiday -> Tuesday 08:00 CDT.
    expect(nextSendWindowStart(now, window).toISOString()).toBe("2026-09-22T13:00:00.000Z");
    // Tuesday 22:00 CDT -> Wednesday 08:00 CDT.
    expect(nextSendWindowStart(new Date("2026-09-23T03:00:00Z"), window).toISOString()).toBe(
      "2026-09-23T13:00:00.000Z",
    );
    // Tuesday 06:00 CDT -> same day 08:00.
    expect(nextSendWindowStart(new Date("2026-09-22T11:00:00Z"), window).toISOString()).toBe(
      "2026-09-22T13:00:00.000Z",
    );
    // Christmas Eve (Thursday) -> blackout until the 26th -> Monday 28th 08:00 CST.
    expect(nextSendWindowStart(new Date("2026-12-24T16:00:00Z"), window).toISOString()).toBe(
      "2026-12-28T14:00:00.000Z",
    );
  });
});

describe("followUpDueAt", () => {
  it("uses the requested date at 09:00 local, else 90 days", () => {
    expect(
      followUpDueAt({ date: "2027-01-11", now, timeZone: "America/Chicago" }).toISOString(),
    ).toBe("2027-01-11T15:00:00.000Z");
    expect(followUpDueAt({ date: null, now, timeZone: "UTC" }).toISOString()).toBe(
      "2026-12-18T12:00:00.000Z",
    );
    expect(followUpDueAt({ date: "2026-01-01", now, timeZone: "UTC" }).toISOString()).toBe(
      "2026-12-18T12:00:00.000Z",
    );
  });
});
