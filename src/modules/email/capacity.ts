import type { RampConfig } from "../../db/schema/index.js";
import { type SendWindowSpec, windowAt } from "./send-window.js";
import { addDays, daysBetween, localDate, startOfNextDay } from "./timezone.js";

/** Cold emails a day per mailbox once its ramp is done (deliverability playbook, section 3). */
export const DEFAULT_DAILY_LIMIT = 30;
/**
 * Above this a daily limit is high for cold email (vendors put the maximum at 40-50): adding
 * or raising a mailbox beyond it warns, and an agent needs a human approval to raise it.
 */
export const SAFE_DAILY_LIMIT = 50;

/**
 * Default ramp for new mailboxes (deliverability playbook, section 4): no cold email in weeks
 * 1 and 2, 5 a day in week 3, then +5 a week: 10, 15, 20, 25 and 30 (the default daily limit)
 * from week 8.
 */
export const DEFAULT_RAMP: Omit<RampConfig, "started_at"> = {
  enabled: true,
  start: 5,
  increment: 5,
  every_days: 7,
  delay_days: 14,
};

/** Pre-warmed mailboxes join the default ramp at week 5 (15 a day) and still ramp up. */
export const WARMED_UP_RAMP: Omit<RampConfig, "started_at"> = {
  ...DEFAULT_RAMP,
  start: 15,
  delay_days: 0,
};

/**
 * restart_ramp: the mailbox's ramp from its start volume again, today. The setup weeks are
 * skipped (the domain already sends), so the default ramp restarts at 5 a day.
 */
export function restartedRamp(ramp: RampConfig | null | undefined, today: string): RampConfig {
  return { ...DEFAULT_RAMP, ...(ramp ?? {}), enabled: true, delay_days: 0, started_at: today };
}

/** At most this many sends per hour to one recipient domain, across all mailboxes. */
export const DOMAIN_THROTTLE_PER_HOUR = 2;
const HOUR_MS = 3_600_000;

/**
 * Public mailbox providers: many unrelated people share these domains, so the per-domain
 * throttle (meant to protect one company's mail server) does not apply to them.
 */
const SHARED_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "zoho.com",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "web.de",
  "t-online.de",
  "mail.com",
  "yandex.com",
  "orange.fr",
  "free.fr",
  "libero.it",
]);

/** Recipient domain for throttling, or null when the domain is a shared public provider. */
export function throttleDomain(email: string): string | null {
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  if (!domain || SHARED_MAIL_DOMAINS.has(domain)) return null;
  return domain;
}

/**
 * Daily limit on a given local day, following the ramp (never above `dailyLimit`): 0 during
 * `delay_days`, then `start`, plus `increment` every `every_days`.
 */
export function rampLimit(
  dailyLimit: number,
  ramp: RampConfig | null | undefined,
  rampStartDate: string,
  day: string,
): number {
  if (!ramp?.enabled) return Math.max(0, dailyLimit);
  const started = ramp.started_at ? ramp.started_at.slice(0, 10) : rampStartDate;
  const elapsed = Math.max(0, daysBetween(started, day));
  const delay = Math.max(0, ramp.delay_days ?? 0);
  if (elapsed < delay) return 0;
  const steps = Math.floor((elapsed - delay) / Math.max(1, ramp.every_days));
  const limit = ramp.start + ramp.increment * steps;
  return Math.max(0, Math.min(dailyLimit, limit));
}

/**
 * Sending status for a mailbox that may send: `warming` until the ramp reaches the daily limit
 * (week 8 with the defaults), then `active`.
 */
export function sendingStatus(
  dailyLimit: number,
  ramp: RampConfig | null | undefined,
  rampStartDate: string,
  today: string,
): "active" | "warming" {
  return ramp?.enabled && rampLimit(dailyLimit, ramp, rampStartDate, today) < dailyLimit
    ? "warming"
    : "active";
}

/**
 * True when `next` would let a mailbox still on its `current` ramp send more on some day from
 * `today` on, at the same daily limit: the ramp turned off, quiet days cut, restarted without
 * them, or a higher start, bigger or more frequent steps. A ramp that already reached the daily
 * limit (or none) cannot be shortened.
 */
export function rampShortened(
  dailyLimit: number,
  current: RampConfig | null | undefined,
  next: RampConfig | null | undefined,
  rampStartDate: string,
  today: string,
): boolean {
  if (!current?.enabled) return false;
  let day = today;
  // Two years covers any ramp the inputs allow (at most 60 quiet days, steps of 1 every 30).
  for (let i = 0; i < 730; i++) {
    const before = rampLimit(dailyLimit, current, rampStartDate, day);
    if (rampLimit(dailyLimit, next, rampStartDate, day) > before) return true;
    if (before >= dailyLimit) return false;
    day = addDays(day, 1);
  }
  return false;
}

/** Where a mailbox is on its ramp today. */
export interface RampStage {
  enabled: boolean;
  /** Days since the ramp started (0 on day one; the setup weeks count). */
  day: number;
  today_limit: number;
  full_limit: number;
  complete: boolean;
}

export function rampStage(
  dailyLimit: number,
  ramp: RampConfig | null | undefined,
  rampStartDate: string,
  today: string,
): RampStage {
  const todayLimit = rampLimit(dailyLimit, ramp, rampStartDate, today);
  const started = ramp?.started_at ? ramp.started_at.slice(0, 10) : rampStartDate;
  return {
    enabled: Boolean(ramp?.enabled),
    day: ramp?.enabled ? Math.max(0, daysBetween(started, today)) : 0,
    today_limit: todayLimit,
    full_limit: dailyLimit,
    complete: todayLimit >= dailyLimit,
  };
}

/** FNV-1a 32-bit hash: cheap deterministic randomness for gaps. */
export function hash32(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A gap between `min` and `max` seconds, derived from `seed` so that planning the same send
 * twice gives the same answer.
 */
export function gapSeconds(min: number, max: number, seed: string): number {
  const low = Math.max(0, Math.min(min, max));
  const high = Math.max(min, max);
  return low + (hash32(seed) % (high - low + 1));
}

/**
 * True when one more send to the domain at `at` keeps every 60-minute window at or below the
 * per-domain limit, given the domain's other send times.
 */
export function domainThrottleAllows(
  at: number,
  others: readonly number[],
  limit = DOMAIN_THROTTLE_PER_HOUR,
): boolean {
  const near = others.filter((time) => Math.abs(time - at) < HOUR_MS).sort((a, b) => a - b);
  if (near.length < limit) return true;
  for (let i = 0; i + limit - 1 < near.length; i++) {
    const first = near[i] as number;
    const last = near[i + limit - 1] as number;
    if (Math.max(last, at) - Math.min(first, at) < HOUR_MS) return false;
  }
  return true;
}

/** Earliest time >= `at` that the domain throttle allows. */
export function nextDomainSlot(at: number, others: readonly number[]): number {
  if (domainThrottleAllows(at, others)) return at;
  const candidates = others
    .map((time) => time + HOUR_MS)
    .filter((time) => time > at)
    .sort((a, b) => a - b);
  for (const candidate of candidates) {
    if (domainThrottleAllows(candidate, others)) return candidate;
  }
  return Math.max(at, ...others) + HOUR_MS;
}

/** Everything the slot search needs for one mailbox. */
export interface SlotSearch {
  /** Earliest allowed time (now, notBefore, campaign start). */
  from: Date;
  window: SendWindowSpec;
  /** Timezone of the daily counters (the workspace timezone). */
  senderTimezone: string;
  /** Daily limit on a local day (ramp applied). */
  limitForDay(day: string): number;
  /** Sends already made plus reserved on a local day. */
  usedOnDay(day: string): number;
  /** The mailbox's other send times (sent and scheduled), in ms. */
  reservations: readonly number[];
  /** Minimum distance to any other send of the mailbox, in ms. */
  gapMs: number;
  /** Other send times to the recipient domain (all mailboxes), or null for no throttle. */
  domainTimes: readonly number[] | null;
  /** Give up after this many ms past `from`. */
  horizonMs: number;
}

/**
 * Earliest moment a mailbox can send: inside the window, under the daily limit, at least one
 * gap away from its other sends and within the per-domain throttle. Null when nothing fits
 * inside the horizon.
 */
export function earliestSlot(search: SlotSearch): Date | null {
  const until = search.from.getTime() + search.horizonMs;
  let at = Math.ceil(search.from.getTime() / 1000) * 1000;
  for (let guard = 0; guard < 2000; guard++) {
    if (at > until) return null;
    const instance = windowAt(new Date(at), search.window);
    if (!instance) return null;
    if (at < instance.start.getTime()) at = instance.start.getTime();
    if (at > until) return null;

    const day = localDate(new Date(at), search.senderTimezone);
    if (search.usedOnDay(day) >= search.limitForDay(day)) {
      at = startOfNextDay(day, search.senderTimezone).getTime();
      continue;
    }

    const conflicts = search.reservations.filter((time) => Math.abs(time - at) < search.gapMs);
    if (conflicts.length > 0) {
      at = Math.max(...conflicts) + search.gapMs;
      continue;
    }

    if (search.domainTimes && !domainThrottleAllows(at, search.domainTimes)) {
      at = nextDomainSlot(at, search.domainTimes);
      continue;
    }

    if (at >= instance.end.getTime()) continue;
    return new Date(at);
  }
  return null;
}
