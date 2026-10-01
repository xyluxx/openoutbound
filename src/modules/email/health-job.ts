import { and, eq, gte, inArray, like, or, sql } from "drizzle-orm";
import { type JobContext, requireWorkspace } from "../../core/context.js";
import { defineJob } from "../../core/operation.js";
import { type Mailbox, mailboxes, messages, type SenderHealth } from "../../db/schema/index.js";
import { notify } from "../../runtime/notify.js";
import { HARD_BOUNCE_PREFIX } from "./bounce.js";
import { sendingStatus } from "./capacity.js";
import { autoPauseMailbox, endTimedPauses, MAX_CONSECUTIVE_FAILURES } from "./mailbox-state.js";
import { isValidTimeZone, localDate } from "./timezone.js";

export const HEALTH_JOB = "email.health_check";

/** Deliverability playbook section 8: warn at 2%, pause over 3%, 7 days, at least 20 sends. */
export const BOUNCE_WARN_RATE = 0.02;
export const BOUNCE_PAUSE_RATE = 0.03;
export const BOUNCE_MIN_SENDS = 20;
const WINDOW_MS = 7 * 86_400_000;

export interface MailboxHealthResult {
  mailbox_id: string;
  sent_7d: number;
  bounced_7d: number;
  bounce_rate_7d: number;
  action: "none" | "warned" | "paused";
}

/**
 * 7-day sends and hard bounces of a mailbox (synchronous rejections count as attempts). After a
 * person resumed it, only messages sent (or refused) since the resume count.
 */
export async function bounceStats(
  ctx: JobContext,
  mailbox: Mailbox,
  now: Date,
): Promise<{ sent: number; bounced: number }> {
  const since = new Date(now.getTime() - WINDOW_MS);
  const resumed = mailbox.health?.resumed_at ? new Date(mailbox.health.resumed_at) : null;
  const afterResume =
    resumed && !Number.isNaN(resumed.getTime())
      ? [
          sql`coalesce(${messages.sent_at}, ${messages.updated_at}) >= ${resumed.toISOString()}::timestamptz`,
        ]
      : [];
  const [row] = await ctx.db
    .select({
      sent: sql<number>`count(*)::int`,
      bounced: sql<number>`count(*) filter (where ${messages.status} = 'bounced' and ${messages.error} like ${`${HARD_BOUNCE_PREFIX}%`})::int`,
    })
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, mailbox.workspace_id),
        eq(messages.mailbox_id, mailbox.id),
        eq(messages.direction, "outbound"),
        // A person's own emails from the mailbox are not the engine's sending.
        eq(messages.origin, "engine"),
        inArray(messages.status, ["sent", "bounced"]),
        or(
          gte(messages.sent_at, since),
          and(
            eq(messages.status, "bounced"),
            like(messages.error, `${HARD_BOUNCE_PREFIX}%`),
            gte(messages.updated_at, since),
          ),
        ),
        ...afterResume,
      ),
    );
  return { sent: row?.sent ?? 0, bounced: row?.bounced ?? 0 };
}

/**
 * Hourly mailbox health: 7-day hard bounce rate (warn at 2%, pause over 3% with 20+ sends;
 * counted from the latest resume when that is more recent) and the consecutive failure streak
 * (pause at 5). Stores the numbers in `mailboxes.health`.
 */
export async function checkMailboxHealth(
  ctx: JobContext,
  mailbox: Mailbox,
): Promise<MailboxHealthResult> {
  const now = ctx.clock.now();
  const { sent, bounced } = await bounceStats(ctx, mailbox, now);
  const rate = sent > 0 ? bounced / sent : 0;
  const health = (mailbox.health ?? {}) as SenderHealth;
  const patch: SenderHealth = {
    sent_7d: sent,
    bounced_7d: bounced,
    bounce_rate_7d: Math.round(rate * 10_000) / 10_000,
  };
  let action: MailboxHealthResult["action"] = "none";
  const percent = `${(rate * 100).toFixed(1)}%`;
  if (sent >= BOUNCE_MIN_SENDS && rate > BOUNCE_PAUSE_RATE) {
    // Its queued mail waits for the resume: moving it to other mailboxes would spread the bad list.
    const paused = await autoPauseMailbox(
      ctx,
      mailbox,
      `Bounce rate ${percent} over the last 7 days (${bounced} of ${sent} sends). Re-verify the list source, then resume with manage_mailboxes action resume and restart_ramp.`,
      { kind: "bounce_rate" },
    );
    if (paused) action = "paused";
  } else if ((health.consecutive_failures ?? 0) >= MAX_CONSECUTIVE_FAILURES) {
    const paused = await autoPauseMailbox(
      ctx,
      mailbox,
      `${health.consecutive_failures} send failures in a row. Check credentials and provider status with manage_mailboxes action test.`,
      { kind: "failures" },
    );
    if (paused) action = "paused";
  } else if (sent >= BOUNCE_MIN_SENDS && rate >= BOUNCE_WARN_RATE) {
    const lastWarning = health.bounce_warning_at ? new Date(health.bounce_warning_at).getTime() : 0;
    if (now.getTime() - lastWarning > 86_400_000) {
      patch.bounce_warning_at = now.toISOString();
      action = "warned";
      try {
        await notify(ctx, {
          title: `Bounce rate warning for ${mailbox.email}: ${percent}`,
          lines: [
            `${bounced} hard bounces in ${sent} sends over 7 days. The mailbox pauses above 3%.`,
            "Re-verify the addresses of the lists you are sending to before the next batch.",
          ],
          severity: "warning",
        });
      } catch (error) {
        ctx.log.warn({ err: String(error) }, "email: bounce warning notification failed");
      }
    }
  }
  await ctx.db
    .update(mailboxes)
    .set({ health: sql`${mailboxes.health} || ${JSON.stringify(patch)}::jsonb` })
    .where(eq(mailboxes.id, mailbox.id));
  return {
    mailbox_id: mailbox.id,
    sent_7d: sent,
    bounced_7d: bounced,
    bounce_rate_7d: patch.bounce_rate_7d ?? 0,
    action,
  };
}

/** Warming mailboxes whose ramp reached the daily limit become `active` (playbook: week 8). */
async function finishWarmup(ctx: JobContext, rows: Mailbox[], timezone: string): Promise<number> {
  const today = localDate(ctx.clock.now(), timezone);
  let finished = 0;
  for (const mailbox of rows) {
    if (mailbox.status !== "warming") continue;
    const status = sendingStatus(
      mailbox.daily_limit,
      mailbox.ramp,
      localDate(mailbox.created_at, timezone),
      today,
    );
    if (status !== "active") continue;
    const [row] = await ctx.db
      .update(mailboxes)
      .set({ status: "active" })
      .where(and(eq(mailboxes.id, mailbox.id), eq(mailboxes.status, "warming")))
      .returning({ id: mailboxes.id });
    if (row) finished += 1;
  }
  return finished;
}

export const healthJob = defineJob({
  name: HEALTH_JOB,
  maxAttempts: 2,
  handler: async (ctx) => {
    const workspace = requireWorkspace(ctx);
    const resumed = await endTimedPauses(ctx, workspace);
    const rows = await ctx.db
      .select()
      .from(mailboxes)
      .where(
        and(
          eq(mailboxes.workspace_id, workspace.id),
          inArray(mailboxes.status, ["active", "warming"]),
        ),
      );
    const results: MailboxHealthResult[] = [];
    for (const mailbox of rows) results.push(await checkMailboxHealth(ctx, mailbox));
    const timezone = isValidTimeZone(workspace.timezone) ? workspace.timezone : "UTC";
    const pausedIds = new Set(
      results.filter((r) => r.action === "paused").map((r) => r.mailbox_id),
    );
    const warmed = await finishWarmup(
      ctx,
      rows.filter((row) => !pausedIds.has(row.id)),
      timezone,
    );
    return {
      checked: results.length,
      paused: pausedIds.size,
      resumed: resumed.length,
      warmed_up: warmed,
      results,
    };
  },
});
