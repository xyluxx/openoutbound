import { describe, expect, it } from "vitest";
import {
  actionGapMs,
  type BusySlot,
  dailyCap,
  earliestFree,
  findSlot,
  gapAfter,
  limitWarnings,
  MAX_GAP_MS,
  MIN_GAP_MS,
  noteLimit,
  type PlannerInput,
  planAction,
  rampPercent,
  rampWeek,
  resolveLimits,
  weeklyCap,
} from "./limits.js";
import { addDays, dayKey, daysBetween, nextWindow, type WorkSchedule, zonedTime } from "./time.js";

const CHICAGO: WorkSchedule = {
  timezone: "America/Chicago",
  days: [1, 2, 3, 4, 5],
  startHour: 9,
  endHour: 18,
  holidays: new Set(),
  blackouts: [],
};

/** Tuesday 2026-09-22 10:00 in Chicago (CDT, UTC-5). */
const TUESDAY_10 = new Date("2026-09-22T15:00:00Z");

function planner(over: Partial<PlannerInput> = {}): PlannerInput {
  return {
    accountId: "lia_test",
    action: "invite",
    schedule: CHICAGO,
    limits: resolveLimits({}),
    ramp: null,
    executed: new Map(),
    busy: [],
    ...over,
  };
}

const slot = (iso: string, over: Partial<BusySlot> = {}): BusySlot => ({
  at: new Date(iso),
  action: "invite",
  reserved: true,
  started: false,
  ...over,
});

describe("time", () => {
  it("converts local wall clock to UTC across DST", () => {
    expect(zonedTime("2026-09-22", 9, 0, "America/Chicago").toISOString()).toBe(
      "2026-09-22T14:00:00.000Z",
    );
    // US DST ended on Sunday 2026-11-01: 09:00 is now UTC-6 in Chicago.
    expect(zonedTime("2026-11-02", 9, 0, "America/Chicago").toISOString()).toBe(
      "2026-11-02T15:00:00.000Z",
    );
    expect(zonedTime("2026-11-01", 9, 0, "America/New_York").toISOString()).toBe(
      "2026-11-01T14:00:00.000Z",
    );
    // Europe/Berlin moves to CET on 2026-10-25.
    expect(zonedTime("2026-10-26", 9, 0, "Europe/Berlin").toISOString()).toBe(
      "2026-10-26T08:00:00.000Z",
    );
    expect(zonedTime("2026-09-22", 24, 0, "UTC").toISOString()).toBe("2026-09-23T00:00:00.000Z");
  });

  it("does calendar math on day keys", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-09-21", "2026-09-28")).toBe(7);
    expect(dayKey(new Date("2026-09-22T04:00:00Z"), "America/Chicago")).toBe("2026-09-21");
  });

  it("finds the current, next and post-weekend windows", () => {
    const inside = nextWindow(CHICAGO, TUESDAY_10);
    expect(inside?.start.toISOString()).toBe("2026-09-22T14:00:00.000Z");
    expect(inside?.end.toISOString()).toBe("2026-09-22T23:00:00.000Z");

    const evening = nextWindow(CHICAGO, new Date("2026-09-22T23:30:00Z"));
    expect(evening?.dayKey).toBe("2026-09-23");

    // Saturday 2026-09-19 12:00 UTC -> Monday 09:00 Chicago.
    const weekend = nextWindow(CHICAGO, new Date("2026-09-19T12:00:00Z"));
    expect(weekend?.start.toISOString()).toBe("2026-09-21T14:00:00.000Z");
  });

  it("skips holidays and blackout ranges", () => {
    const schedule = {
      ...CHICAGO,
      holidays: new Set(["2026-09-21"]),
      blackouts: [{ from: "2026-09-22", to: "2026-09-23" }],
    };
    expect(nextWindow(schedule, new Date("2026-09-19T12:00:00Z"))?.dayKey).toBe("2026-09-24");
  });

  it("returns null when no day is a working day", () => {
    expect(nextWindow({ ...CHICAGO, days: [] }, TUESDAY_10)).toBeNull();
    expect(nextWindow({ ...CHICAGO, startHour: 18, endHour: 9 }, TUESDAY_10)).toBeNull();
  });
});

describe("limits and ramp", () => {
  it("merges stored limits over the defaults", () => {
    expect(resolveLimits({ invites_per_day: 10, messages_per_day: -3 })).toEqual({
      invites_per_day: 10,
      invites_per_week: 80,
      messages_per_day: 40,
      visits_per_day: 60,
      likes_per_day: 30,
      comments_per_day: 10,
    });
  });

  it("ramps 40% in week 1, 70% in week 2, 100% after", () => {
    const ramp = {
      enabled: true,
      start: 40,
      increment: 30,
      every_days: 7,
      started_at: "2026-09-21",
    };
    expect(rampPercent(ramp, "2026-09-21")).toBe(40);
    expect(rampPercent(ramp, "2026-09-27")).toBe(40);
    expect(rampPercent(ramp, "2026-09-28")).toBe(70);
    expect(rampPercent(ramp, "2026-10-05")).toBe(100);
    expect(rampWeek(ramp, "2026-09-28")).toBe(2);
    expect(rampWeek(ramp, "2026-10-05")).toBeNull();
    expect(rampPercent({ ...ramp, enabled: false }, "2026-09-21")).toBe(100);
    expect(rampPercent(null, "2026-09-21")).toBe(100);
  });

  it("scales caps and keeps disabled actions at zero", () => {
    const limits = resolveLimits({ likes_per_day: 0 });
    expect(dailyCap(limits, "invite", 40)).toBe(6);
    expect(dailyCap(limits, "comment", 40)).toBe(4);
    expect(dailyCap(limits, "like", 40)).toBe(0);
    expect(dailyCap(limits, "message", 100)).toBe(40);
    expect(weeklyCap(limits, "invite", 40)).toBe(32);
    expect(weeklyCap(limits, "message", 100)).toBeNull();
  });

  it("limits invitation notes: 3 a month for free accounts, unlimited for premium", () => {
    expect(noteLimit({ premium: false, limits: {} })).toBe(3);
    expect(noteLimit({ premium: true, limits: {} })).toBeNull();
    expect(noteLimit({ premium: true, limits: { invite_notes_per_month: 10 } })).toBe(10);
    expect(noteLimit({ premium: false, limits: { invite_notes_per_month: 0 } })).toBe(0);
    expect(noteLimit({ premium: false, limits: { invite_notes_per_month: null } })).toBeNull();
  });

  it("warns about limits above the defaults and unusable note limits", () => {
    expect(limitWarnings({ invites_per_day: 20, messages_per_day: 30 })).toHaveLength(1);
    expect(limitWarnings({ invites_per_day: 15 })).toEqual([]);
    expect(limitWarnings({ invite_notes_per_month: 5 }, false)).toHaveLength(1);
    expect(limitWarnings({ invite_notes_per_month: 5 }, true)).toEqual([]);
  });

  it("draws deterministic gaps between 2 and 12 minutes", () => {
    const gaps = Array.from({ length: 200 }, (_, i) => actionGapMs(`lia_x:${i}`));
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(MIN_GAP_MS);
      expect(gap).toBeLessThanOrEqual(MAX_GAP_MS);
    }
    expect(new Set(gaps).size).toBeGreaterThan(50);
    expect(actionGapMs("same")).toBe(actionGapMs("same"));
  });
});

describe("planner", () => {
  it("runs now inside the window with free capacity", () => {
    expect(planAction(planner(), TUESDAY_10)).toEqual({ ok: true, runAt: TUESDAY_10 });
  });

  it("keeps the random gap after earlier actions and 2 minutes before later ones", () => {
    const before = slot("2026-09-22T14:59:00Z");
    const after = earliestFree(planner({ busy: [before] }), TUESDAY_10);
    expect(after.getTime()).toBe(before.at.getTime() + gapAfter("lia_test", before.at));

    const later = slot("2026-09-22T15:01:00Z");
    const next = earliestFree(planner({ busy: [later] }), TUESDAY_10);
    expect(next.getTime()).toBe(later.at.getTime() + gapAfter("lia_test", later.at));

    const farLater = slot("2026-09-22T15:30:00Z");
    expect(earliestFree(planner({ busy: [farLater] }), TUESDAY_10)).toEqual(TUESDAY_10);
  });

  it("reports outside_hours on weekends with the next Monday slot", () => {
    const outcome = planAction(planner(), new Date("2026-09-19T12:00:00Z"));
    expect(outcome).toEqual({
      ok: false,
      reason: "outside_hours",
      retryAt: new Date("2026-09-21T14:00:00Z"),
    });
  });

  it("reports no_capacity when the daily cap is used, retrying the next working day", () => {
    const outcome = planAction(planner({ executed: new Map([["2026-09-22", 15]]) }), TUESDAY_10);
    expect(outcome).toEqual({
      ok: false,
      reason: "no_capacity",
      retryAt: new Date("2026-09-23T14:00:00Z"),
    });
  });

  it("counts reservations toward the daily cap", () => {
    const busy = Array.from({ length: 15 }, (_, i) =>
      slot(
        `2026-09-22T${String(16 + Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}:00Z`,
      ),
    );
    expect(planAction(planner({ busy }), TUESDAY_10)).toMatchObject({ reason: "no_capacity" });
    expect(planAction(planner({ busy, action: "message" }), TUESDAY_10)).toMatchObject({
      ok: true,
    });
  });

  it("enforces the rolling weekly invitation cap", () => {
    const executed = new Map([
      ["2026-09-16", 15],
      ["2026-09-17", 15],
      ["2026-09-18", 15],
      ["2026-09-21", 15],
      ["2026-09-15", 20],
    ]);
    // 60 in the last 7 days (09-16..09-22) is under 80.
    expect(planAction(planner({ executed }), TUESDAY_10)).toMatchObject({ ok: true });
    executed.set("2026-09-22", 14);
    executed.set("2026-09-19", 10);
    // 84 >= 80: blocked until 09-16 leaves the window on 09-23.
    const outcome = planAction(planner({ executed }), TUESDAY_10);
    expect(outcome).toMatchObject({ ok: false, reason: "no_capacity" });
    if (!outcome.ok) expect(outcome.retryAt?.toISOString()).toBe("2026-09-23T14:00:00.000Z");
  });

  it("applies the ramp to new accounts", () => {
    const ramp = {
      enabled: true,
      start: 40,
      increment: 30,
      every_days: 7,
      started_at: "2026-09-22",
    };
    expect(
      planAction(planner({ ramp, executed: new Map([["2026-09-22", 5]]) }), TUESDAY_10),
    ).toMatchObject({
      ok: true,
    });
    expect(
      planAction(planner({ ramp, executed: new Map([["2026-09-22", 6]]) }), TUESDAY_10),
    ).toMatchObject({
      ok: false,
      reason: "no_capacity",
    });
  });

  it("moves to the next window when the gap passes the end of the day", () => {
    const late = new Date("2026-09-22T22:58:00Z");
    const outcome = planAction(planner({ busy: [slot("2026-09-22T22:57:00Z")] }), late);
    expect(outcome).toMatchObject({ ok: false, reason: "outside_hours" });
    if (!outcome.ok) expect(outcome.retryAt?.toISOString()).toBe("2026-09-23T14:00:00.000Z");
  });

  it("finds slots on later days and gives up when nothing fits", () => {
    const found = findSlot(planner({ executed: new Map([["2026-09-22", 15]]) }), TUESDAY_10);
    expect(found?.window.dayKey).toBe("2026-09-23");
    expect(
      findSlot(planner({ limits: { ...resolveLimits({}), invites_per_day: 0 } }), TUESDAY_10),
    ).toBeNull();
  });
});
