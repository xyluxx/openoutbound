/** Source of "now". Always use `ctx.clock.now()` instead of `new Date()` so tests can pin time. */
export interface Clock {
  now(): Date;
}

/** Real wall clock. */
export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock that only moves when told to (tests, simulations, evals). */
export interface FixedClock extends Clock {
  set(time: Date | string): void;
  /** Moves time forward by milliseconds (negative moves back). */
  advance(ms: number): void;
  advanceBy(delta: { days?: number; hours?: number; minutes?: number; seconds?: number }): void;
}

/** Default test time: Saturday 2026-09-19 12:00 UTC. */
export const DEFAULT_TEST_TIME = "2026-09-19T12:00:00.000Z";

export function fixedClock(start: Date | string = DEFAULT_TEST_TIME): FixedClock {
  let current = toMs(start);
  return {
    now: () => new Date(current),
    set(time) {
      current = toMs(time);
    },
    advance(ms) {
      current += ms;
    },
    advanceBy({ days = 0, hours = 0, minutes = 0, seconds = 0 }) {
      current += ((days * 24 + hours) * 60 * 60 + minutes * 60 + seconds) * 1000;
    },
  };
}

function toMs(time: Date | string): number {
  const ms = typeof time === "string" ? Date.parse(time) : time.getTime();
  if (Number.isNaN(ms)) throw new RangeError(`Invalid time: ${String(time)}`);
  return ms;
}
