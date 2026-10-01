import { and, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { type CampaignSettings, parseWorkspaceSettings } from "../../core/settings.js";
import { type Mailbox, mailboxes, messages, sender_counters } from "../../db/schema/index.js";
import { earliestSlot, gapSeconds, rampLimit, throttleDomain } from "./capacity.js";
import { holdsQueuedMail, pauseRecheckAt, throttledUntil } from "./mailbox-state.js";
import { buildWindowSpec, windowAt } from "./send-window.js";
import { isValidTimeZone, localDate } from "./timezone.js";

export type PlanEmailSendResult =
  | { ok: true; mailboxId: string; sendAt: Date }
  | {
      ok: false;
      reason: "no_active_mailbox" | "no_capacity" | "outside_window" | "workspace_paused";
      /** Next moment a send could happen, when known. */
      retryAt?: Date;
    };

export interface PlanEmailSendInput {
  mailboxIds: string[];
  preferredMailboxId?: string | null;
  recipientEmail: string;
  recipientTimezone?: string | null;
  schedule: CampaignSettings["schedule"];
  notBefore?: Date;
}

/** Mailbox statuses that may send. */
export const SENDABLE_STATUSES = ["active", "warming"] as const;
/** Message statuses that hold a capacity reservation (`unknown` may have gone out). */
const RESERVED_STATUSES = ["scheduled", "sending", "unknown"] as const;
const DAY_MS = 86_400_000;
const HORIZON_MS = 21 * DAY_MS;

interface Candidate {
  mailbox: Mailbox;
  slot: Date | null;
  used: number;
  limit: number;
}

/**
 * Picks a mailbox and a send time (spec 11.8). Only allocates inside the window opening that
 * contains the start time: outside it returns `outside_window`, and when every mailbox is full
 * (daily limit, ramp, gaps, domain throttle) returns `no_capacity`; both with `retryAt` = the
 * earliest moment any mailbox could send. When every mailbox asked for is paused by the
 * engine for its health (bounce rate, provider block) the answer is `no_capacity` with the next
 * re-check, not `no_active_mailbox`, so callers wait instead of moving mail elsewhere.
 * `excludeMessageId` ignores that message's own reservation (re-planning a scheduled message).
 */
export async function planEmailSendWith(
  ctx: OpContext,
  input: PlanEmailSendInput,
  options: { excludeMessageId?: string } = {},
): Promise<PlanEmailSendResult> {
  const workspace = requireWorkspace(ctx);
  if (workspace.status !== "active") return { ok: false, reason: "workspace_paused" };
  const ids = [...new Set(input.mailboxIds.filter(Boolean))];
  if (ids.length === 0) return { ok: false, reason: "no_active_mailbox" };

  const rows = await ctx.db
    .select()
    .from(mailboxes)
    .where(
      and(
        eq(mailboxes.workspace_id, workspace.id),
        inArray(mailboxes.id, ids),
        inArray(mailboxes.status, [...SENDABLE_STATUSES]),
      ),
    );
  if (rows.length === 0) {
    // Mail bound to a mailbox the engine paused for its health waits for the resume instead of
    // moving to other mailboxes (that would route around the pause).
    const held = await ctx.db
      .select()
      .from(mailboxes)
      .where(
        and(
          eq(mailboxes.workspace_id, workspace.id),
          inArray(mailboxes.id, ids),
          eq(mailboxes.status, "paused"),
        ),
      );
    const now = ctx.clock.now();
    const rechecks = held
      .filter((mailbox) => holdsQueuedMail(mailbox))
      .map((mailbox) => pauseRecheckAt(mailbox, now).getTime());
    if (rechecks.length > 0) {
      return { ok: false, reason: "no_capacity", retryAt: new Date(Math.min(...rechecks)) };
    }
    return { ok: false, reason: "no_active_mailbox" };
  }

  const settings = parseWorkspaceSettings(workspace.settings);
  const spec = buildWindowSpec(input.schedule, settings.schedule, input.recipientTimezone);
  const now = ctx.clock.now();
  let from = input.notBefore && input.notBefore > now ? input.notBefore : now;
  if (spec.startAt && spec.startAt > from) from = spec.startAt;
  if (spec.endAt && from >= spec.endAt) return { ok: false, reason: "outside_window" };

  const current = windowAt(from, spec);
  if (!current) return { ok: false, reason: "outside_window" };
  const insideNow = current.start.getTime() <= from.getTime();

  const senderTimezone = isValidTimeZone(workspace.timezone) ? workspace.timezone : "UTC";
  const recipient = input.recipientEmail.trim().toLowerCase();
  const domain = throttleDomain(recipient);
  const domainTimes = domain
    ? await domainSendTimes(ctx, workspace.id, domain, from, options.excludeMessageId)
    : null;

  const candidates: Candidate[] = [];
  for (const mailbox of rows) {
    const throttled = throttledUntil(mailbox, now);
    const mailboxFrom = throttled && throttled > from ? throttled : from;
    const state = await mailboxLoad(ctx, mailbox, from, senderTimezone, options.excludeMessageId);
    const rampStart = localDate(mailbox.created_at, senderTimezone);
    const limitForDay = (day: string) =>
      rampLimit(mailbox.daily_limit, mailbox.ramp, rampStart, day);
    const usedOnDay = (day: string) => state.used.get(day) ?? 0;
    const gap = gapSeconds(
      mailbox.min_gap_seconds,
      mailbox.max_gap_seconds,
      `${mailbox.id}|${recipient}|${from.toISOString()}`,
    );
    const slot = earliestSlot({
      from: mailboxFrom,
      window: spec,
      senderTimezone,
      limitForDay,
      usedOnDay,
      reservations: state.times,
      gapMs: gap * 1000,
      domainTimes,
      horizonMs: HORIZON_MS,
    });
    const slotDay = localDate(slot ?? from, senderTimezone);
    candidates.push({ mailbox, slot, used: usedOnDay(slotDay), limit: limitForDay(slotDay) });
  }

  const fits = insideNow
    ? candidates.filter(
        (candidate) => candidate.slot && candidate.slot.getTime() < current.end.getTime(),
      )
    : [];
  if (fits.length > 0) {
    const preferred = fits.find((candidate) => candidate.mailbox.id === input.preferredMailboxId);
    const chosen = preferred ?? fits.sort(compareCandidates)[0];
    if (chosen?.slot) return { ok: true, mailboxId: chosen.mailbox.id, sendAt: chosen.slot };
  }

  const slots = candidates
    .map((candidate) => candidate.slot?.getTime())
    .filter((time): time is number => time !== undefined);
  const reason = insideNow ? "no_capacity" : "outside_window";
  if (slots.length > 0) return { ok: false, reason, retryAt: new Date(Math.min(...slots)) };
  // Nothing fits inside the horizon: suggest trying again after the current opening.
  return {
    ok: false,
    reason,
    retryAt: new Date(Math.max(current.end.getTime(), from.getTime() + DAY_MS)),
  };
}

/** Least-used capacity first, then fewest sends, then the earliest slot, then id. */
function compareCandidates(a: Candidate, b: Candidate): number {
  const ratio = (c: Candidate) => (c.limit > 0 ? c.used / c.limit : 1);
  return (
    ratio(a) - ratio(b) ||
    a.used - b.used ||
    (a.slot?.getTime() ?? 0) - (b.slot?.getTime() ?? 0) ||
    a.mailbox.id.localeCompare(b.mailbox.id)
  );
}

interface MailboxLoad {
  /** Sends made plus reserved per local day. */
  used: Map<string, number>;
  /** Other send times (sent and scheduled). */
  times: number[];
}

async function mailboxLoad(
  ctx: OpContext,
  mailbox: Mailbox,
  from: Date,
  senderTimezone: string,
  excludeMessageId: string | undefined,
): Promise<MailboxLoad> {
  const since = new Date(from.getTime() - DAY_MS);
  const until = new Date(from.getTime() + HORIZON_MS + DAY_MS);
  const used = new Map<string, number>();

  const counters = await ctx.db
    .select({ day: sender_counters.day, count: sender_counters.count })
    .from(sender_counters)
    .where(
      and(
        eq(sender_counters.sender_type, "mailbox"),
        eq(sender_counters.sender_id, mailbox.id),
        eq(sender_counters.action, "email"),
        gte(sender_counters.day, localDate(since, senderTimezone)),
        lte(sender_counters.day, localDate(until, senderTimezone)),
      ),
    );
  for (const row of counters) used.set(row.day, (used.get(row.day) ?? 0) + row.count);

  const exclude = excludeMessageId ? [ne(messages.id, excludeMessageId)] : [];
  const reserved = await ctx.db
    .select({ at: messages.scheduled_for })
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, mailbox.workspace_id),
        eq(messages.mailbox_id, mailbox.id),
        inArray(messages.status, [...RESERVED_STATUSES]),
        gte(messages.scheduled_for, since),
        lte(messages.scheduled_for, until),
        ...exclude,
      ),
    );
  const sent = await ctx.db
    .select({ at: messages.sent_at })
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, mailbox.workspace_id),
        eq(messages.mailbox_id, mailbox.id),
        eq(messages.direction, "outbound"),
        gte(messages.sent_at, since),
        ...exclude,
      ),
    );

  const times: number[] = [];
  for (const row of reserved) {
    if (!row.at) continue;
    times.push(row.at.getTime());
    const day = localDate(row.at, senderTimezone);
    used.set(day, (used.get(day) ?? 0) + 1);
  }
  for (const row of sent) if (row.at) times.push(row.at.getTime());
  return { used, times };
}

/** Send times (sent or reserved) to a recipient domain across the workspace. */
async function domainSendTimes(
  ctx: OpContext,
  workspaceId: string,
  domain: string,
  from: Date,
  excludeMessageId: string | undefined,
): Promise<number[]> {
  const at = sql`coalesce(${messages.sent_at}, ${messages.scheduled_for})`;
  const low = new Date(from.getTime() - 3_600_000).toISOString();
  const high = new Date(from.getTime() + HORIZON_MS).toISOString();
  const pattern = `%@${domain.replace(/[\\%_]/g, (char) => `\\${char}`)}`;
  const exclude = excludeMessageId ? [ne(messages.id, excludeMessageId)] : [];
  const rows = await ctx.db
    .select({ sent_at: messages.sent_at, scheduled_for: messages.scheduled_for })
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, workspaceId),
        eq(messages.direction, "outbound"),
        eq(messages.channel, "email"),
        inArray(messages.status, ["scheduled", "sending", "unknown", "sent"]),
        sql`lower(${messages.to_address}) like ${pattern}`,
        sql`${at} >= ${low}::timestamptz`,
        sql`${at} <= ${high}::timestamptz`,
        ...exclude,
      ),
    );
  return rows
    .map((row) => (row.sent_at ?? row.scheduled_for)?.getTime())
    .filter((time): time is number => time !== undefined);
}
