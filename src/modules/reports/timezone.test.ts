import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  DAY_MS,
  daysInMonth,
  formatLocalDate,
  fromLocal,
  isValidTimeZone,
  startOfLocalDay,
  toLocal,
} from "./timezone.js";

describe("timezone helpers", () => {
  it("reads local wall-clock parts", () => {
    const instant = new Date("2026-09-19T03:30:00Z");
    expect(toLocal(instant, "UTC")).toEqual({
      year: 2026,
      month: 9,
      day: 19,
      hour: 3,
      minute: 30,
      second: 0,
    });
    expect(toLocal(instant, "America/Chicago")).toMatchObject({ day: 18, hour: 22 });
    expect(toLocal(instant, "Asia/Kolkata")).toMatchObject({ day: 19, hour: 9, minute: 0 });
  });

  it("converts local times to instants in summer and winter", () => {
    expect(fromLocal({ year: 2026, month: 7, day: 1 }, "Europe/Berlin").toISOString()).toBe(
      "2026-06-30T22:00:00.000Z",
    );
    expect(fromLocal({ year: 2026, month: 12, day: 1 }, "Europe/Berlin").toISOString()).toBe(
      "2026-11-30T23:00:00.000Z",
    );
    expect(fromLocal({ year: 2026, month: 9, day: 19 }, "Asia/Kolkata").toISOString()).toBe(
      "2026-09-18T18:30:00.000Z",
    );
  });

  it("moves times skipped by a DST jump forward", () => {
    // New York springs forward 2026-03-08 at 02:00; 02:30 does not exist.
    const skipped = fromLocal(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30 },
      "America/New_York",
    );
    expect(skipped.toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(toLocal(skipped, "America/New_York")).toMatchObject({ hour: 3, minute: 30 });
  });

  it("resolves repeated times (clocks turned back) to the earlier instant", () => {
    // New York falls back 2026-11-01 at 02:00; 01:30 happens twice.
    const repeated = fromLocal(
      { year: 2026, month: 11, day: 1, hour: 1, minute: 30 },
      "America/New_York",
    );
    expect(repeated.toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("finds the start of every local day of 2026 in zones with odd offsets and DST", () => {
    const zones = [
      "UTC",
      "America/New_York",
      "America/Santiago",
      "America/Havana",
      "Europe/Berlin",
      "Asia/Kolkata",
      "Pacific/Auckland",
      "Pacific/Chatham",
    ];
    for (const zone of zones) {
      let date = { year: 2026, month: 1, day: 1 };
      for (let i = 0; i < 365; i++) {
        const start = fromLocal(date, zone);
        const local = toLocal(start, zone);
        // Same calendar day; 00:00, or 01:00 on days whose midnight a DST jump skips.
        expect(formatLocalDate(local), `${zone} ${formatLocalDate(date)}`).toBe(
          formatLocalDate(date),
        );
        expect([0, 1]).toContain(local.hour);
        // One millisecond earlier is the previous day.
        expect(formatLocalDate(toLocal(new Date(start.getTime() - 1), zone))).toBe(
          formatLocalDate(addDays(date, -1)),
        );
        expect(startOfLocalDay(new Date(start.getTime() + 5 * 3_600_000), zone)).toEqual(start);
        date = addDays(date, 1);
      }
    }
  });

  it("does calendar arithmetic", () => {
    expect(addDays({ year: 2026, month: 12, day: 30 }, 3)).toEqual({
      year: 2027,
      month: 1,
      day: 2,
    });
    expect(addDays({ year: 2026, month: 3, day: 1 }, -1)).toEqual({
      year: 2026,
      month: 2,
      day: 28,
    });
    expect(addMonths({ year: 2026, month: 1, day: 31 }, -2)).toEqual({
      year: 2025,
      month: 11,
      day: 1,
    });
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(formatLocalDate({ year: 2026, month: 9, day: 5 })).toBe("2026-09-05");
    expect(DAY_MS).toBe(86_400_000);
  });

  it("validates IANA zones", () => {
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});
