import { describe, expect, it } from "vitest";
import {
  DEFAULT_RAMP,
  DOMAIN_THROTTLE_PER_HOUR,
  domainThrottleAllows,
  earliestSlot,
  gapSeconds,
  nextDomainSlot,
  rampLimit,
  rampShortened,
  rampStage,
  restartedRamp,
  type SlotSearch,
  sendingStatus,
  throttleDomain,
  WARMED_UP_RAMP,
} from "./capacity.js";
import { buildWindowSpec, isInWindow, type SendWindowSpec, windowAt } from "./send-window.js";
import {
  addDays,
  daysBetween,
  isoWeekday,
  isValidTimeZone,
  localDate,
  startOfNextDay,
  zonedTimeToUtc,
} from "./timezone.js";

const HOUR = 3_600_000;
const iso = (date: Date | null | undefined) => date?.toISOString() ?? null;

function spec(overrides: Partial<SendWindowSpec> = {}): SendWindowSpec {
  return {
    timezone: "America/Chicago",
    days: [1, 2, 3, 4, 5],
    startHour: 8,
    endHour: 17,
    holidays: new Set(),
    blackouts: [],
    ...overrides,
  };
}

describe("timezone math", () => {
  it("converts wall clock times to UTC across zones", () => {
    expect(iso(zonedTimeToUtc("2026-09-21", 9, 0, "Europe/Berlin"))).toBe(
      "2026-09-21T07:00:00.000Z",
    );
    expect(iso(zonedTimeToUtc("2026-09-21", 8, 0, "America/Chicago"))).toBe(
      "2026-09-21T13:00:00.000Z",
    );
    expect(iso(zonedTimeToUtc("2026-09-21", 24, 0, "UTC"))).toBe("2026-09-22T00:00:00.000Z");
  });

  it("moves times skipped by the spring DST jump forward", () => {
    // 2026-03-08 02:30 does not exist in New York (02:00 -> 03:00).
    expect(iso(zonedTimeToUtc("2026-03-08", 2, 30, "America/New_York"))).toBe(
      "2026-03-08T07:30:00.000Z",
    );
  });

  it("resolves repeated autumn times to the earlier instant", () => {
    // 2026-11-01 01:30 happens twice in New York (EDT, then EST).
    expect(iso(zonedTimeToUtc("2026-11-01", 1, 30, "America/New_York"))).toBe(
      "2026-11-01T05:30:00.000Z",
    );
  });

  it("finds local dates, weekdays and day starts", () => {
    expect(localDate(new Date("2026-09-19T12:00:00Z"), "Pacific/Auckland")).toBe("2026-09-20");
    expect(localDate(new Date("2026-09-19T03:00:00Z"), "America/Los_Angeles")).toBe("2026-09-18");
    expect(isoWeekday("2026-09-19")).toBe(6);
    expect(isoWeekday("2026-09-20")).toBe(7);
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(daysBetween("2026-09-19", "2026-09-22")).toBe(3);
    // Europe switches to summer time on 2026-03-29: that day starts at 23:00Z the day before.
    expect(iso(startOfNextDay("2026-03-28", "Europe/Berlin"))).toBe("2026-03-28T23:00:00.000Z");
    expect(iso(startOfNextDay("2026-03-29", "Europe/Berlin"))).toBe("2026-03-29T22:00:00.000Z");
    expect(isValidTimeZone("Mars/Base")).toBe(false);
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
  });
});

describe("send windows", () => {
  const workspace = { working_days: [1, 2, 3, 4, 5], holidays: [], blackout_ranges: [] };
  const campaign = {
    days: [1, 2, 3, 4, 5, 6],
    start_hour: 8,
    end_hour: 17,
    timezone_mode: "lead" as const,
    timezone: "Europe/London",
  };

  it("uses the recipient timezone, else the campaign timezone", () => {
    expect(buildWindowSpec(campaign, workspace, "Asia/Tokyo").timezone).toBe("Asia/Tokyo");
    expect(buildWindowSpec(campaign, workspace, "Not/AZone").timezone).toBe("Europe/London");
    expect(buildWindowSpec(campaign, workspace, null).timezone).toBe("Europe/London");
    expect(
      buildWindowSpec({ ...campaign, timezone_mode: "fixed" }, workspace, "Asia/Tokyo").timezone,
    ).toBe("Europe/London");
  });

  it("keeps only campaign days that are workspace working days", () => {
    expect(buildWindowSpec(campaign, workspace, null).days).toEqual([1, 2, 3, 4, 5]);
  });

  it("skips the weekend to Monday 08:00 in the recipient timezone", () => {
    // Saturday 2026-09-19 12:00Z = 07:00 in Chicago.
    const instance = windowAt(new Date("2026-09-19T12:00:00Z"), spec());
    expect(iso(instance?.start)).toBe("2026-09-21T13:00:00.000Z");
    expect(iso(instance?.end)).toBe("2026-09-21T22:00:00.000Z");
    expect(instance?.date).toBe("2026-09-21");
  });

  it("starts now when inside the window", () => {
    const at = new Date("2026-09-21T15:00:00Z");
    expect(iso(windowAt(at, spec())?.start)).toBe(iso(at));
    expect(isInWindow(at, spec())).toBe(true);
    expect(isInWindow(new Date("2026-09-21T23:00:00Z"), spec())).toBe(false);
  });

  it("skips holidays and blackout ranges", () => {
    const at = new Date("2026-09-19T12:00:00Z");
    expect(windowAt(at, spec({ holidays: new Set(["2026-09-21"]) }))?.date).toBe("2026-09-22");
    expect(
      windowAt(at, spec({ blackouts: [{ from: "2026-09-21", to: "2026-09-23" }] }))?.date,
    ).toBe("2026-09-24");
  });

  it("follows DST changes of the recipient timezone", () => {
    const newYork = spec({ timezone: "America/New_York" });
    expect(iso(windowAt(new Date("2026-03-06T00:00:00Z"), newYork)?.start)).toBe(
      "2026-03-06T13:00:00.000Z",
    );
    expect(iso(windowAt(new Date("2026-03-07T00:00:00Z"), newYork)?.start)).toBe(
      "2026-03-09T12:00:00.000Z",
    );
  });

  it("never opens after the campaign end or with no allowed days", () => {
    const at = new Date("2026-09-21T15:00:00Z");
    expect(windowAt(at, spec({ endAt: new Date("2026-09-20T00:00:00Z") }))).toBeNull();
    expect(windowAt(at, spec({ days: [] }))).toBeNull();
    expect(windowAt(at, spec({ startHour: 17, endHour: 8 }))).toBeNull();
  });

  it("waits for the campaign start", () => {
    const instance = windowAt(
      new Date("2026-09-21T15:00:00Z"),
      spec({ startAt: new Date("2026-09-23T16:00:00Z") }),
    );
    expect(iso(instance?.start)).toBe("2026-09-23T16:00:00.000Z");
  });
});

describe("ramp", () => {
  const ramp = { enabled: true, start: 10, increment: 5, every_days: 3, started_at: "2026-09-01" };

  it("follows the deliverability playbook week by week by default", () => {
    // Playbook section 4: weeks 1-2 nothing, week 3: 5, then +5 a week, 30 from week 8.
    const started = "2026-09-01";
    const perWeek = [0, 0, 5, 10, 15, 20, 25, 30, 30];
    perWeek.forEach((limit, index) => {
      for (const offset of [0, 6]) {
        const day = addDays(started, index * 7 + offset);
        expect(rampLimit(30, { ...DEFAULT_RAMP, started_at: started }, started, day), day).toBe(
          limit,
        );
      }
    });
    // Warming until week 8, then active.
    const at = (weeks: number) => addDays(started, weeks * 7);
    expect(sendingStatus(30, { ...DEFAULT_RAMP, started_at: started }, started, at(6))).toBe(
      "warming",
    );
    expect(sendingStatus(30, { ...DEFAULT_RAMP, started_at: started }, started, at(7))).toBe(
      "active",
    );
    expect(sendingStatus(30, null, started, started)).toBe("active");
  });

  it("starts pre-warmed mailboxes at week 5 and restarts ramps at their start volume", () => {
    const today = "2026-09-21";
    const warmed = { ...WARMED_UP_RAMP, started_at: today };
    expect([0, 7, 14, 21].map((d) => rampLimit(30, warmed, today, addDays(today, d)))).toEqual([
      15, 20, 25, 30,
    ]);
    // A mailbox deep into its ramp restarts at 5 a day today, without the two setup weeks.
    const restarted = restartedRamp({ ...DEFAULT_RAMP, started_at: "2026-01-05" }, today);
    expect(restarted).toMatchObject({ start: 5, delay_days: 0, started_at: today });
    expect(rampLimit(30, restarted, today, today)).toBe(5);
    expect(rampLimit(30, restarted, today, addDays(today, 7))).toBe(10);
    expect(rampLimit(30, restartedRamp(null, today), today, today)).toBe(5);
  });

  it("adds the increment every few days up to the daily limit", () => {
    expect(rampLimit(30, ramp, "2026-09-01", "2026-09-01")).toBe(10);
    expect(rampLimit(30, ramp, "2026-09-01", "2026-09-03")).toBe(10);
    expect(rampLimit(30, ramp, "2026-09-01", "2026-09-04")).toBe(15);
    expect(rampLimit(30, ramp, "2026-09-01", "2026-09-07")).toBe(20);
    expect(rampLimit(30, ramp, "2026-09-01", "2026-10-30")).toBe(30);
  });

  it("tells when a new ramp would send more than the current one on some day", () => {
    const started = "2026-09-14";
    const current = { ...DEFAULT_RAMP, started_at: started };
    const today = "2026-09-21";
    const shorter = (next: Parameters<typeof rampShortened>[2], day = today) =>
      rampShortened(30, current, next, started, day);
    expect(shorter(null)).toBe(true);
    expect(shorter({ ...current, enabled: false })).toBe(true);
    expect(shorter({ ...current, delay_days: 7 })).toBe(true);
    expect(shorter({ ...current, increment: 10 })).toBe(true);
    expect(shorter({ ...current, every_days: 3 })).toBe(true);
    expect(shorter(restartedRamp(current, today))).toBe(true);
    expect(shorter(current)).toBe(false);
    expect(shorter({ ...current, every_days: 14 })).toBe(false);
    expect(shorter({ ...current, start: 3, delay_days: 21 })).toBe(false);
    // Once the ramp reached the daily limit (or with none) there is nothing left to shorten.
    expect(shorter(null, addDays(started, 49))).toBe(false);
    expect(rampShortened(30, null, { ...current, start: 30 }, started, today)).toBe(false);
  });

  it("uses the full limit without a ramp", () => {
    expect(rampLimit(30, null, "2026-09-01", "2026-09-01")).toBe(30);
    expect(rampLimit(30, { ...ramp, enabled: false }, "2026-09-01", "2026-09-01")).toBe(30);
  });

  it("falls back to the mailbox creation date and reports the stage", () => {
    const { started_at: _ignored, ...noStart } = ramp;
    expect(rampLimit(30, noStart, "2026-09-10", "2026-09-13")).toBe(15);
    expect(rampStage(30, ramp, "2026-09-01", "2026-09-04")).toEqual({
      enabled: true,
      day: 3,
      today_limit: 15,
      full_limit: 30,
      complete: false,
    });
  });
});

describe("gaps and domain throttle", () => {
  it("picks a deterministic gap inside the range", () => {
    const gap = gapSeconds(240, 720, "seed-a");
    expect(gap).toBeGreaterThanOrEqual(240);
    expect(gap).toBeLessThanOrEqual(720);
    expect(gapSeconds(240, 720, "seed-a")).toBe(gap);
    expect(gapSeconds(300, 300, "x")).toBe(300);
    expect(gapSeconds(720, 240, "x")).toBeGreaterThanOrEqual(240);
  });

  it("allows two sends per hour to one company domain", () => {
    const t0 = Date.parse("2026-09-21T15:00:00Z");
    expect(DOMAIN_THROTTLE_PER_HOUR).toBe(2);
    expect(domainThrottleAllows(t0, [])).toBe(true);
    expect(domainThrottleAllows(t0 + 10 * 60_000, [t0])).toBe(true);
    expect(domainThrottleAllows(t0 + 20 * 60_000, [t0, t0 + 10 * 60_000])).toBe(false);
    expect(domainThrottleAllows(t0 + 50 * 60_000, [t0, t0 + 10 * 60_000])).toBe(false);
    // One hour after the first send, only the second one is inside the last 60 minutes.
    expect(domainThrottleAllows(t0 + HOUR, [t0, t0 + 10 * 60_000])).toBe(true);
    expect(nextDomainSlot(t0 + 20 * 60_000, [t0, t0 + 10 * 60_000])).toBe(t0 + HOUR);
    expect(nextDomainSlot(t0 + 20 * 60_000, [t0 + 10 * 60_000])).toBe(t0 + 20 * 60_000);
  });

  it("does not throttle shared public providers", () => {
    expect(throttleDomain("dana@gmail.com")).toBeNull();
    expect(throttleDomain("dana@Outlook.com")).toBeNull();
    expect(throttleDomain("dana@harbor.example.com")).toBe("harbor.example.com");
  });
});

describe("earliestSlot", () => {
  const from = new Date("2026-09-21T15:00:00Z"); // Monday 10:00 in Chicago
  function search(overrides: Partial<SlotSearch> = {}): SlotSearch {
    return {
      from,
      window: spec(),
      senderTimezone: "America/Chicago",
      limitForDay: () => 30,
      usedOnDay: () => 0,
      reservations: [],
      gapMs: 5 * 60_000,
      domainTimes: null,
      horizonMs: 21 * 24 * HOUR,
      ...overrides,
    };
  }

  it("sends right away when everything is free", () => {
    expect(iso(earliestSlot(search()))).toBe(iso(from));
  });

  it("keeps the gap from the mailbox's other sends", () => {
    const reserved = from.getTime() + 60_000;
    expect(earliestSlot(search({ reservations: [reserved] }))?.getTime()).toBe(
      reserved + 5 * 60_000,
    );
  });

  it("moves to the next day's window when today's limit is used", () => {
    const slot = earliestSlot(search({ usedOnDay: (day) => (day === "2026-09-21" ? 30 : 0) }));
    expect(iso(slot)).toBe("2026-09-22T13:00:00.000Z");
  });

  it("respects the per-domain throttle across mailboxes", () => {
    const slot = earliestSlot(
      search({ domainTimes: [from.getTime() - 30 * 60_000, from.getTime() - 20 * 60_000] }),
    );
    expect(slot?.getTime()).toBe(from.getTime() + 30 * 60_000);
  });

  it("gives up when the ramp allows nothing within the horizon", () => {
    expect(earliestSlot(search({ limitForDay: () => 0, horizonMs: 3 * 24 * HOUR }))).toBeNull();
  });
});
