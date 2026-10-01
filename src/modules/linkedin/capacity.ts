/**
 * Loads what the pure planner needs from the database: executed counts (sender_counters) and
 * busy slots (scheduled, sending and sent LinkedIn messages of the account).
 */
import { and, between, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { parseWorkspaceSettings } from "../../core/settings.js";
import type { Db } from "../../db/client.js";
import {
  type LinkedInAccount,
  messages,
  sender_counters,
  type Workspace,
} from "../../db/schema/index.js";
import {
  type BusySlot,
  DEFAULT_WORKING_HOURS,
  LINKEDIN_ACTIONS,
  type LinkedInActionKind,
  type PlannerInput,
  resolveLimits,
} from "./limits.js";
import { addDays, dayKey, isValidTimezone, type WorkSchedule } from "./time.js";

/** Working-hours schedule of an account (account timezone, else workspace timezone, else UTC). */
export function accountSchedule(
  account: Pick<LinkedInAccount, "timezone" | "working_hours">,
  workspace: Pick<Workspace, "timezone" | "settings">,
): WorkSchedule {
  let holidays: string[] = [];
  let blackouts: Array<{ from: string; to: string }> = [];
  try {
    const settings = parseWorkspaceSettings(workspace.settings);
    holidays = settings.schedule.holidays;
    blackouts = settings.schedule.blackout_ranges;
  } catch {
    // Invalid stored settings: fall back to no holidays rather than blocking every action.
  }
  const hours = { ...DEFAULT_WORKING_HOURS, ...(account.working_hours ?? {}) };
  const timezone =
    [account.timezone, workspace.timezone].find(
      (zone): zone is string => typeof zone === "string" && isValidTimezone(zone),
    ) ?? "UTC";
  return {
    timezone,
    days: hours.days,
    startHour: hours.start_hour,
    endHour: hours.end_hour,
    holidays: new Set(holidays),
    blackouts,
  };
}

/** Executed counts of one action by local day, between two day keys (inclusive). */
export async function executedByDay(
  db: Db,
  accountId: string,
  action: string,
  fromDay: string,
  toDay: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({ day: sender_counters.day, count: sender_counters.count })
    .from(sender_counters)
    .where(
      and(
        eq(sender_counters.sender_type, "linkedin"),
        eq(sender_counters.sender_id, accountId),
        eq(sender_counters.action, action),
        between(sender_counters.day, fromDay, toDay),
      ),
    );
  const out = new Map<string, number>();
  for (const row of rows) out.set(row.day, (out.get(row.day) ?? 0) + row.count);
  return out;
}

/** Busy slots of the account between two instants, sorted by time. */
export async function busySlots(
  db: Db,
  input: {
    workspaceId: string;
    accountId: string;
    from: Date;
    to: Date;
    excludeMessageId?: string;
  },
): Promise<BusySlot[]> {
  const at = sql<Date>`coalesce(${messages.sent_at}, ${messages.scheduled_for})`;
  const conditions = [
    eq(messages.workspace_id, input.workspaceId),
    eq(messages.channel, "linkedin"),
    eq(messages.direction, "outbound"),
    eq(messages.linkedin_account_id, input.accountId),
    inArray(messages.status, ["scheduled", "sending", "unknown", "sent"]),
    gte(at, input.from),
    lte(at, input.to),
  ];
  if (input.excludeMessageId) conditions.push(ne(messages.id, input.excludeMessageId));
  const rows = await db
    .select({
      action: messages.action,
      status: messages.status,
      sent_at: messages.sent_at,
      scheduled_for: messages.scheduled_for,
    })
    .from(messages)
    .where(and(...conditions));
  const slots: BusySlot[] = [];
  for (const row of rows) {
    const when = row.sent_at ?? row.scheduled_for;
    if (!when) continue;
    slots.push({
      at: new Date(when),
      action: row.action,
      reserved: row.status !== "sent",
      started: row.status !== "scheduled",
    });
  }
  return slots.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Planner input for one account and action around `from` (about 3 weeks of data). */
export async function loadPlannerInput(
  db: Db,
  input: {
    account: LinkedInAccount;
    workspace: Pick<Workspace, "id" | "timezone" | "settings">;
    action: LinkedInActionKind;
    from: Date;
    excludeMessageId?: string;
  },
): Promise<PlannerInput> {
  const schedule = accountSchedule(input.account, input.workspace);
  const firstDay = dayKey(input.from, schedule.timezone);
  const executed = await executedByDay(
    db,
    input.account.id,
    input.action,
    addDays(firstDay, -7),
    addDays(firstDay, 23),
  );
  const busy = await busySlots(db, {
    workspaceId: input.workspace.id,
    accountId: input.account.id,
    from: new Date(input.from.getTime() - 9 * 86_400_000),
    to: new Date(input.from.getTime() + 24 * 86_400_000),
    ...(input.excludeMessageId ? { excludeMessageId: input.excludeMessageId } : {}),
  });
  return {
    accountId: input.account.id,
    action: input.action,
    schedule,
    limits: resolveLimits(input.account.limits),
    ramp: input.account.ramp ?? null,
    executed,
    busy,
  };
}

/** Adds to a daily counter (upsert). */
export async function bumpCounter(
  db: Db,
  accountId: string,
  day: string,
  action: string,
  by = 1,
): Promise<void> {
  await db
    .insert(sender_counters)
    .values({ sender_type: "linkedin", sender_id: accountId, day, action, count: by })
    .onConflictDoUpdate({
      target: [
        sender_counters.sender_type,
        sender_counters.sender_id,
        sender_counters.day,
        sender_counters.action,
      ],
      set: { count: sql`${sender_counters.count} + ${by}` },
    });
}

/** Executed + reserved actions of each kind on the account's local day containing `at`. */
export async function usageOnDay(
  db: Db,
  account: LinkedInAccount,
  workspace: Pick<Workspace, "id" | "timezone" | "settings">,
  at: Date,
): Promise<Record<LinkedInActionKind, number>> {
  const schedule = accountSchedule(account, workspace);
  const day = dayKey(at, schedule.timezone);
  const rows = await db
    .select({ action: sender_counters.action, count: sender_counters.count })
    .from(sender_counters)
    .where(
      and(
        eq(sender_counters.sender_type, "linkedin"),
        eq(sender_counters.sender_id, account.id),
        eq(sender_counters.day, day),
      ),
    );
  const out = Object.fromEntries(LINKEDIN_ACTIONS.map((action) => [action, 0])) as Record<
    LinkedInActionKind,
    number
  >;
  for (const row of rows) {
    if (row.action in out) out[row.action as LinkedInActionKind] += row.count;
  }
  const busy = await busySlots(db, {
    workspaceId: workspace.id,
    accountId: account.id,
    from: new Date(at.getTime() - 2 * 86_400_000),
    to: new Date(at.getTime() + 2 * 86_400_000),
  });
  for (const slot of busy) {
    if (slot.reserved && slot.action in out && dayKey(slot.at, schedule.timezone) === day) {
      out[slot.action as LinkedInActionKind] += 1;
    }
  }
  return out;
}
