/** Compact output shapes for LinkedIn operations. */
import { z } from "zod";
import type { OpContext } from "../../core/context.js";
import { LINKEDIN_ACCOUNT_STATUSES, LINKEDIN_RELATION_STATUSES } from "../../core/enums.js";
import { failureSchema } from "../../core/failures.js";
import { isoDateTime } from "../../core/operation.js";
import type { LinkedInAccount, Workspace } from "../../db/schema/index.js";
import { accountSchedule, usageOnDay } from "./capacity.js";
import {
  dailyCap,
  LINKEDIN_ACTIONS,
  type LinkedInActionKind,
  noteLimit,
  rampPercent,
  rampWeek,
  resolveLimits,
  weeklyCap,
} from "./limits.js";
import { dayKey } from "./time.js";

const perAction = z.object({
  invite: z.number(),
  message: z.number(),
  visit: z.number(),
  like: z.number(),
  comment: z.number(),
});

const limitsShape = z.object({
  invites_per_day: z.number(),
  invites_per_week: z.number(),
  messages_per_day: z.number(),
  visits_per_day: z.number(),
  likes_per_day: z.number(),
  comments_per_day: z.number(),
  invite_notes_per_month: z.number().nullable().describe("null = unlimited"),
});

export const accountOutput = z.object({
  id: z.string(),
  name: z.string().nullable(),
  provider: z.string(),
  status: z.enum(LINKEDIN_ACCOUNT_STATUSES),
  status_reason: z.string().nullable(),
  profile_url: z.string().nullable(),
  premium: z.boolean(),
  timezone: z.string(),
  working_hours: z.object({
    days: z.array(z.number()),
    start_hour: z.number(),
    end_hour: z.number(),
  }),
  limits: limitsShape.describe("Configured limits (before the ramp)"),
  today: z.object({
    caps: perAction.describe("Caps for today after the ramp"),
    used: perAction.describe("Actions done or reserved today"),
    invites_week_cap: z.number(),
  }),
  ramp: z.object({
    enabled: z.boolean(),
    week: z.number().nullable().describe("Current ramp week, null when at full limits"),
    percent: z.number(),
  }),
  connected_at: isoDateTime().nullable(),
  last_synced_at: z.string().nullable(),
  last_sync_error: z
    .object({
      at: z.string(),
      step: z.enum(["relations", "messages", "actions"]),
      message: z.string(),
      failure: failureSchema,
    })
    .nullable()
    .describe("The failure of the last sync run (null after a clean run); the next run retries"),
});
export type AccountOutput = z.input<typeof accountOutput>;

/** Account row -> output (with today's caps and usage). */
export async function toAccountOutput(
  ctx: OpContext,
  account: LinkedInAccount,
  workspace: Workspace,
): Promise<AccountOutput> {
  const schedule = accountSchedule(account, workspace);
  const now = ctx.clock.now();
  const today = dayKey(now, schedule.timezone);
  const limits = resolveLimits(account.limits);
  const pct = rampPercent(account.ramp, today);
  const caps = Object.fromEntries(
    LINKEDIN_ACTIONS.map((action) => [action, dailyCap(limits, action, pct)]),
  ) as Record<LinkedInActionKind, number>;
  return {
    id: account.id,
    name: account.name,
    provider: account.provider,
    status: account.status,
    status_reason: account.status_reason,
    profile_url: account.profile_url,
    premium: account.premium,
    timezone: schedule.timezone,
    working_hours: {
      days: [...schedule.days],
      start_hour: schedule.startHour,
      end_hour: schedule.endHour,
    },
    limits: { ...limits, invite_notes_per_month: noteLimit(account) },
    today: {
      caps,
      used: await usageOnDay(ctx.db, account, workspace, now),
      invites_week_cap: weeklyCap(limits, "invite", pct) ?? 0,
    },
    ramp: {
      enabled: Boolean(account.ramp?.enabled),
      week: rampWeek(account.ramp, today),
      percent: pct,
    },
    connected_at: account.connected_at,
    last_synced_at: account.sync_state.messages_synced_at ?? null,
    last_sync_error: account.sync_state.last_error ?? null,
  };
}

export const relationOutput = z.object({
  account_id: z.string(),
  person_id: z.string(),
  person_name: z.string().nullable(),
  linkedin_url: z.string().nullable(),
  status: z.enum(LINKEDIN_RELATION_STATUSES),
  invited_at: isoDateTime().nullable(),
  connected_at: isoDateTime().nullable(),
  updated_at: isoDateTime(),
});
