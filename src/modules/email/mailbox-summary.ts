import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { OpContext } from "../../core/context.js";
import { MAILBOX_AUTH_TYPES, MAILBOX_PROVIDER_LABELS, MAILBOX_STATUSES } from "../../core/enums.js";
import { failureSchema } from "../../core/failures.js";
import { isoDateTime } from "../../core/operation.js";
import { type Mailbox, messages, sender_counters, type Workspace } from "../../db/schema/index.js";
import { rampStage } from "./capacity.js";
import { throttledUntil } from "./mailbox-state.js";
import { isValidTimeZone, localDate, startOfNextDay, zonedTimeToUtc } from "./timezone.js";
import { savesSentCopies } from "./unknown-sends.js";

/** Compact mailbox view with health (never contains credentials). */
export const mailboxSummarySchema = z.object({
  id: z.string(),
  email: z.string(),
  from_name: z.string().nullable(),
  provider: z.enum(MAILBOX_PROVIDER_LABELS),
  auth_type: z.enum(MAILBOX_AUTH_TYPES),
  status: z.enum(MAILBOX_STATUSES),
  status_reason: z.string().nullable(),
  daily_limit: z.number().int(),
  today_limit: z.number().int().describe("Daily limit today after the ramp"),
  sent_today: z.number().int(),
  scheduled_today: z.number().int(),
  ramp: z
    .object({
      day: z.number().int(),
      today_limit: z.number().int(),
      full_limit: z.number().int(),
      complete: z.boolean(),
    })
    .nullable(),
  gap_seconds: z.object({ min: z.number().int(), max: z.number().int() }),
  bounce_rate_7d: z.number().nullable(),
  sent_7d: z.number().int().nullable(),
  consecutive_failures: z.number().int(),
  throttled_until: isoDateTime().nullable(),
  last_error: z.string().nullable(),
  last_synced_at: isoDateTime().nullable(),
  last_sync_error: z.string().nullable(),
  last_sync_failure: failureSchema
    .nullable()
    .describe(
      "Class of the last reply sync problem: auth_invalid means the IMAP login was refused",
    ),
  saves_sent_copies: z
    .boolean()
    .nullable()
    .describe(
      "Proven that the server keeps a copy of what it sends in the Sent folder: true once the engine found one of its own emails there, false for servers that never do (smtp-relay.gmail.com), null until proven. Only a proven server gets an email with an unknown outcome sent again once on its own.",
    ),
  sent_copies_seen_at: isoDateTime()
    .nullable()
    .describe("When the engine first found one of its own emails in the Sent folder (the proof)"),
  dns: z
    .object({
      overall: z.enum(["green", "yellow", "red"]).nullable(),
      checked_at: z.string(),
      issues: z.array(z.string()),
    })
    .nullable(),
  has_credentials: z.boolean(),
  created_at: isoDateTime(),
});
export type MailboxSummary = z.input<typeof mailboxSummarySchema>;

/** Sends counted and reserved for today (workspace timezone), per mailbox. */
async function todayUsage(
  ctx: OpContext,
  workspace: Workspace,
  ids: string[],
  today: string,
  timezone: string,
): Promise<{ sent: Map<string, number>; scheduled: Map<string, number> }> {
  const sent = new Map<string, number>();
  const scheduled = new Map<string, number>();
  if (ids.length === 0) return { sent, scheduled };
  const counters = await ctx.db
    .select({
      id: sender_counters.sender_id,
      count: sql<number>`sum(${sender_counters.count})::int`,
    })
    .from(sender_counters)
    .where(
      and(
        eq(sender_counters.sender_type, "mailbox"),
        eq(sender_counters.action, "email"),
        eq(sender_counters.day, today),
        inArray(sender_counters.sender_id, ids),
      ),
    )
    .groupBy(sender_counters.sender_id);
  for (const row of counters) sent.set(row.id, row.count);
  const reserved = await ctx.db
    .select({ id: messages.mailbox_id, count: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, workspace.id),
        inArray(messages.mailbox_id, ids),
        inArray(messages.status, ["scheduled", "sending", "unknown"]),
        gte(messages.scheduled_for, zonedTimeToUtc(today, 0, 0, timezone)),
        lt(messages.scheduled_for, startOfNextDay(today, timezone)),
      ),
    )
    .groupBy(messages.mailbox_id);
  for (const row of reserved) if (row.id) scheduled.set(row.id, row.count);
  return { sent, scheduled };
}

/** Health summaries for mailboxes of one workspace (usage in the workspace timezone). */
export async function summarizeMailboxes(
  ctx: OpContext,
  workspace: Workspace,
  rows: Mailbox[],
): Promise<MailboxSummary[]> {
  const timezone = isValidTimeZone(workspace.timezone) ? workspace.timezone : "UTC";
  const now = ctx.clock.now();
  const today = localDate(now, timezone);
  const usage = await todayUsage(
    ctx,
    workspace,
    rows.map((row) => row.id),
    today,
    timezone,
  );
  return rows.map((mailbox) => {
    const stage = rampStage(
      mailbox.daily_limit,
      mailbox.ramp,
      localDate(mailbox.created_at, timezone),
      today,
    );
    const health = mailbox.health ?? {};
    return {
      id: mailbox.id,
      email: mailbox.email,
      from_name: mailbox.from_name,
      provider: mailbox.provider_label,
      auth_type: mailbox.auth_type,
      status: mailbox.status,
      status_reason: mailbox.status_reason,
      daily_limit: mailbox.daily_limit,
      today_limit: stage.today_limit,
      sent_today: usage.sent.get(mailbox.id) ?? 0,
      scheduled_today: usage.scheduled.get(mailbox.id) ?? 0,
      ramp: stage.enabled
        ? {
            day: stage.day,
            today_limit: stage.today_limit,
            full_limit: stage.full_limit,
            complete: stage.complete,
          }
        : null,
      gap_seconds: { min: mailbox.min_gap_seconds, max: mailbox.max_gap_seconds },
      bounce_rate_7d: health.bounce_rate_7d ?? null,
      sent_7d: health.sent_7d ?? null,
      consecutive_failures: health.consecutive_failures ?? 0,
      throttled_until: throttledUntil(mailbox, now),
      last_error: health.last_error ?? null,
      last_synced_at: mailbox.last_synced_at,
      last_sync_error: health.last_sync_error ?? null,
      last_sync_failure: health.last_sync_failure ?? null,
      saves_sent_copies: savesSentCopies(mailbox),
      sent_copies_seen_at: mailbox.sent_copies_seen_at,
      dns: mailbox.dns
        ? {
            overall: mailbox.dns.overall ?? null,
            checked_at: mailbox.dns.checked_at,
            issues: mailbox.dns.issues,
          }
        : null,
      has_credentials:
        mailbox.auth_type === "sandbox" ||
        Boolean(mailbox.secret_id) ||
        Boolean(mailbox.oauth?.refresh_token_secret_id),
      created_at: mailbox.created_at,
    };
  });
}
