/**
 * LinkedIn safety limits (spec 11.9, playbook-linkedin): defaults, ramp, gaps and the pure
 * slot planner. Everything here is deterministic so it can be tested without a database.
 */
import { createHash } from "node:crypto";
import type { LinkedInLimits, RampConfig, WorkingHours } from "../../db/schema/index.js";
import {
  addDays,
  dayKey as dayKeyOf,
  daysBetween,
  nextWindow,
  type WorkSchedule,
  type WorkWindow,
} from "./time.js";

export const LINKEDIN_ACTIONS = ["invite", "message", "visit", "like", "comment"] as const;
export type LinkedInActionKind = (typeof LINKEDIN_ACTIONS)[number];

/** The daily and weekly caps (the monthly note limit is handled by `noteLimit`). */
export type ActionLimits = Required<Omit<LinkedInLimits, "invite_notes_per_month">>;

/** Conservative per-account defaults. Raising them is allowed but warned about. */
export const DEFAULT_LINKEDIN_LIMITS: ActionLimits = {
  invites_per_day: 15,
  invites_per_week: 80,
  messages_per_day: 40,
  visits_per_day: 60,
  likes_per_day: 30,
  comments_per_day: 10,
};

/** Sanity ceilings so a typo cannot unleash thousands of actions. */
export const MAX_LINKEDIN_LIMITS: ActionLimits & { invite_notes_per_month: number } = {
  invites_per_day: 100,
  invites_per_week: 300,
  messages_per_day: 150,
  visits_per_day: 250,
  likes_per_day: 150,
  comments_per_day: 50,
  invite_notes_per_month: 300,
};

export const DEFAULT_WORKING_HOURS: WorkingHours = {
  days: [1, 2, 3, 4, 5],
  start_hour: 9,
  end_hour: 18,
};

/**
 * Ramp for new accounts. For LinkedIn, `start` and `increment` are percentages of every limit:
 * 40% in week 1, 70% in week 2, 100% from week 3.
 */
export const DEFAULT_LINKEDIN_RAMP: Omit<RampConfig, "started_at"> = {
  enabled: true,
  start: 40,
  increment: 30,
  every_days: 7,
};

export const MIN_GAP_MS = 2 * 60_000;
export const MAX_GAP_MS = 12 * 60_000;
export const AUTO_WITHDRAW_DAYS = 21;
export const REINVITE_COOLDOWN_DAYS = 30;
export const LIKE_MAX_POST_AGE_DAYS = 14;
export const NOTE_MAX_FREE = 200;
export const NOTE_MAX_PREMIUM = 300;
/** Free LinkedIn members can add a note to about 3 invitations a month. */
export const FREE_NOTES_PER_MONTH = 3;
/** Consecutive provider rate limits that count as a restriction signal. */
export const RATE_LIMIT_RESTRICT_THRESHOLD = 3;

const DAILY_KEY: Record<LinkedInActionKind, keyof ActionLimits> = {
  invite: "invites_per_day",
  message: "messages_per_day",
  visit: "visits_per_day",
  like: "likes_per_day",
  comment: "comments_per_day",
};

/** Stored overrides merged over the defaults. */
export function resolveLimits(stored: LinkedInLimits | null | undefined): ActionLimits {
  const out = { ...DEFAULT_LINKEDIN_LIMITS };
  for (const key of Object.keys(out) as Array<keyof ActionLimits>) {
    const value = stored?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      out[key] = Math.floor(value);
    }
  }
  return out;
}

/** Percentage (1-100) of the limits allowed on `day` by the ramp. */
export function rampPercent(ramp: RampConfig | null | undefined, day: string): number {
  if (!ramp?.enabled || !ramp.started_at) return 100;
  const elapsed = Math.max(0, daysBetween(ramp.started_at.slice(0, 10), day));
  const every = Math.max(1, ramp.every_days || 7);
  const pct = ramp.start + ramp.increment * Math.floor(elapsed / every);
  return Math.min(100, Math.max(1, pct));
}

/** Ramp week (1-based) on `day`, or null when the ramp is off or finished. */
export function rampWeek(ramp: RampConfig | null | undefined, day: string): number | null {
  if (!ramp?.enabled || !ramp.started_at || rampPercent(ramp, day) >= 100) return null;
  const elapsed = Math.max(0, daysBetween(ramp.started_at.slice(0, 10), day));
  return Math.floor(elapsed / Math.max(1, ramp.every_days || 7)) + 1;
}

function scaled(base: number, pct: number): number {
  if (base <= 0) return 0;
  return Math.max(1, Math.floor((base * pct) / 100));
}

/**
 * Invitation notes allowed per calendar month: the account's `invite_notes_per_month` when set
 * (null = unlimited), else 3 for free accounts and unlimited for premium ones.
 */
export function noteLimit(account: {
  premium: boolean;
  limits: LinkedInLimits | null;
}): number | null {
  const value = account.limits?.invite_notes_per_month;
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  return account.premium ? null : FREE_NOTES_PER_MONTH;
}

export function dailyCap(limits: ActionLimits, action: LinkedInActionKind, pct: number): number {
  return scaled(limits[DAILY_KEY[action]], pct);
}

/** Rolling 7-day cap; only invites have one. */
export function weeklyCap(
  limits: ActionLimits,
  action: LinkedInActionKind,
  pct: number,
): number | null {
  return action === "invite" ? scaled(limits.invites_per_week, pct) : null;
}

/** One warning per limit set above its default (and for note limits a free account cannot use). */
export function limitWarnings(limits: LinkedInLimits, premium = false): string[] {
  const warnings: string[] = [];
  for (const key of Object.keys(DEFAULT_LINKEDIN_LIMITS) as Array<keyof ActionLimits>) {
    const value = limits[key];
    const safe = DEFAULT_LINKEDIN_LIMITS[key];
    if (typeof value === "number" && value > safe) {
      warnings.push(
        `${key} = ${value} is above the safe default of ${safe}; higher volume raises the risk of a LinkedIn restriction.`,
      );
    }
  }
  const notes = limits.invite_notes_per_month;
  if (!premium && (notes === null || (typeof notes === "number" && notes > FREE_NOTES_PER_MONTH))) {
    warnings.push(
      `invite_notes_per_month above ${FREE_NOTES_PER_MONTH} on a free account: LinkedIn only allows about ${FREE_NOTES_PER_MONTH} notes a month without Premium.`,
    );
  }
  return warnings;
}

/** Deterministic pseudo-random gap (2-12 minutes) to leave after an action. */
export function actionGapMs(seed: string): number {
  const fraction = createHash("sha256").update(seed).digest().readUInt32BE(0) / 0xffffffff;
  return Math.round(MIN_GAP_MS + fraction * (MAX_GAP_MS - MIN_GAP_MS));
}

/** An action already executed or reserved on the account (for gaps and counts). */
export interface BusySlot {
  at: Date;
  action: string;
  /** true = scheduled or sending (not counted in sender_counters yet). */
  reserved: boolean;
  /** true = sending or sent (the action really started). */
  started: boolean;
}

/** Everything the pure planner needs about one account and one action kind. */
export interface PlannerInput {
  accountId: string;
  action: LinkedInActionKind;
  schedule: WorkSchedule;
  limits: ActionLimits;
  ramp: RampConfig | null;
  /** Executed counts (sender_counters) for this action by local day. */
  executed: ReadonlyMap<string, number>;
  /** Every busy slot of the account (any action), sorted by time. */
  busy: readonly BusySlot[];
}

export function gapAfter(accountId: string, at: Date): number {
  return actionGapMs(`${accountId}:${at.toISOString()}`);
}

/** Count of this action (executed + reserved) on a local day. */
export function usedOn(input: PlannerInput, day: string): number {
  let reserved = 0;
  for (const slot of input.busy) {
    if (
      slot.reserved &&
      slot.action === input.action &&
      dayKeyOf(slot.at, input.schedule.timezone) === day
    ) {
      reserved++;
    }
  }
  return (input.executed.get(day) ?? 0) + reserved;
}

/** True when the daily (and weekly, for invites) caps leave room on `day`. */
export function hasCapacity(input: PlannerInput, day: string): boolean {
  const pct = rampPercent(input.ramp, day);
  if (usedOn(input, day) >= dailyCap(input.limits, input.action, pct)) return false;
  const week = weeklyCap(input.limits, input.action, pct);
  if (week === null) return true;
  let total = 0;
  for (let i = 0; i < 7; i++) total += usedOn(input, addDays(day, -i));
  return total < week;
}

/** Earliest time >= start that keeps the random gap after earlier actions and 2 minutes before later ones. */
export function earliestFree(input: PlannerInput, start: Date): Date {
  let t = start.getTime();
  for (const slot of input.busy) {
    const at = slot.at.getTime();
    if (at + gapAfter(input.accountId, slot.at) <= t) continue;
    if (at - MIN_GAP_MS >= t) break;
    t = at + gapAfter(input.accountId, slot.at);
  }
  return new Date(t);
}

/**
 * Earliest compliant moment at or after `from`: inside working hours, with capacity on that
 * local day and the gap respected. Searches up to `maxDays` days ahead; null when none.
 */
export function findSlot(
  input: PlannerInput,
  from: Date,
  maxDays = 21,
): { at: Date; window: WorkWindow } | null {
  let t = from;
  const firstDay = dayKeyOf(from, input.schedule.timezone);
  for (let guard = 0; guard < maxDays * 3 + 3; guard++) {
    const window = nextWindow(input.schedule, t, maxDays);
    if (!window || daysBetween(firstDay, window.dayKey) > maxDays) return null;
    if (t < window.start) t = window.start;
    if (!hasCapacity(input, window.dayKey)) {
      t = window.end;
      continue;
    }
    const at = earliestFree(input, t);
    if (at.getTime() >= window.end.getTime()) {
      t = window.end;
      continue;
    }
    return { at, window };
  }
  return null;
}

export type PlanOutcome =
  | { ok: true; runAt: Date }
  | { ok: false; reason: "no_capacity" | "outside_hours"; retryAt?: Date };

/**
 * Plans one action for one account starting at `start`. Succeeds only inside the working
 * window that contains `start`; otherwise returns the reason and the next allowed moment.
 */
export function planAction(input: PlannerInput, start: Date): PlanOutcome {
  const retry = (reason: "no_capacity" | "outside_hours", from: Date): PlanOutcome => {
    const slot = findSlot(input, from);
    return slot ? { ok: false, reason, retryAt: slot.at } : { ok: false, reason };
  };
  const window = nextWindow(input.schedule, start);
  if (!window) return { ok: false, reason: "outside_hours" };
  if (start.getTime() < window.start.getTime()) return retry("outside_hours", start);
  if (!hasCapacity(input, window.dayKey)) return retry("no_capacity", window.end);
  const at = earliestFree(input, start);
  if (at.getTime() >= window.end.getTime()) return retry("outside_hours", window.end);
  return { ok: true, runAt: at };
}
