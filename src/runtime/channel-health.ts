/**
 * Health of notification channels. Every failed delivery (a job attempt or a test) is counted
 * on the channel with its failure; after FAILING_AFTER failures in a row the channel is marked
 * failing (`failing_since`) and a problem asks a person to fix it. The problem is kind `custom`:
 * `provider_down` is about a provider slot of the registry, while a channel is a destination
 * the workspace configured. Any delivery that works clears the count and resolves the problem.
 * Channels stay enabled while failing, so they recover by themselves once fixed.
 */
import { eq } from "drizzle-orm";
import type { OpContext } from "../core/context.js";
import type { Failure } from "../core/failures.js";
import {
  type NotificationChannel,
  type NotificationChannelHealth,
  notification_channels,
  workspaces,
} from "../db/schema/index.js";
import { openProblem, resolveProblemsFor } from "../modules/problems/service.js";

/** Failed deliveries in a row after which a channel is marked failing. */
export const FAILING_AFTER = 5;

/** Dedupe key of the problem of a failing channel. */
export function failingKey(channelId: string): string {
  return `notification_failing:${channelId}`;
}

/** The context scoped to the channel's workspace (problems live in a workspace). */
async function scoped(ctx: OpContext, workspaceId: string): Promise<OpContext | null> {
  if (ctx.workspace?.id === workspaceId) return ctx;
  const [workspace] = await ctx.db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return workspace ? { ...ctx, workspace } : null;
}

/** Counts a failed delivery; marks the channel failing and opens its problem at the limit. */
export async function recordChannelFailure(
  ctx: OpContext,
  channel: NotificationChannel,
  error: string,
  failure: Failure,
): Promise<NotificationChannelHealth> {
  const now = ctx.clock.now().toISOString();
  const [current] = await ctx.db
    .select({ health: notification_channels.health })
    .from(notification_channels)
    .where(eq(notification_channels.id, channel.id))
    .limit(1);
  const before = current?.health ?? null;
  const count = (before?.consecutive_failures ?? 0) + 1;
  const failing = count >= FAILING_AFTER;
  const health: NotificationChannelHealth = {
    consecutive_failures: count,
    last_error: error.slice(0, 300),
    last_failure: failure,
    last_failure_at: now,
    failing_since: failing ? (before?.failing_since ?? now) : null,
  };
  await ctx.db
    .update(notification_channels)
    .set({ health })
    .where(eq(notification_channels.id, channel.id));
  if (failing) await openFailing(ctx, channel, health);
  return health;
}

/**
 * Clears the count after a delivery that worked and resolves the channel's problem. It reads
 * the health as it is now: other deliveries may have counted failures, or marked the channel
 * failing, after this one loaded the channel.
 */
export async function recordChannelSuccess(
  ctx: OpContext,
  channel: NotificationChannel,
): Promise<void> {
  const [current] = await ctx.db
    .select({ health: notification_channels.health })
    .from(notification_channels)
    .where(eq(notification_channels.id, channel.id))
    .limit(1);
  const health = current?.health ?? null;
  if (!health || (health.consecutive_failures === 0 && !health.failing_since)) return;
  await ctx.db
    .update(notification_channels)
    .set({
      health: {
        consecutive_failures: 0,
        last_error: null,
        last_failure: null,
        last_failure_at: health.last_failure_at ?? null,
        failing_since: null,
      },
    })
    .where(eq(notification_channels.id, channel.id));
  if (health.failing_since) {
    await resolveFailing(ctx, channel, "A notification went through again.");
  }
}

/** Resolves the problem of a failing channel, e.g. when the channel is removed (never throws). */
export async function resolveFailing(
  ctx: OpContext,
  channel: Pick<NotificationChannel, "id" | "workspace_id">,
  resolution: string,
): Promise<void> {
  try {
    const scope = await scoped(ctx, channel.workspace_id);
    if (scope) await resolveProblemsFor(scope, { dedupeKey: failingKey(channel.id) }, resolution);
  } catch (error) {
    ctx.log.warn({ err: String(error), channel_id: channel.id }, "could not resolve a problem");
  }
}

async function openFailing(
  ctx: OpContext,
  channel: NotificationChannel,
  health: NotificationChannelHealth,
): Promise<void> {
  try {
    const scope = await scoped(ctx, channel.workspace_id);
    if (!scope) return;
    await openProblem(scope, {
      kind: "custom",
      severity: "high",
      owner: "person",
      title: `Notification channel "${channel.name}" is failing`,
      reason: `The last ${health.consecutive_failures} notifications to this ${channel.type} channel failed (${health.last_failure?.class ?? "failed"}: ${health.last_error ?? "no detail"}). Alerts sent to it are not arriving.`,
      remedy: `Check it with manage_notifications action test (channel_id ${channel.id}). If the URL or recipients changed, add the channel again with action create and remove this one with action delete. A delivery that works closes this problem.`,
      subject: { type: "notification_channel", id: channel.id },
      data: {
        channel_id: channel.id,
        type: channel.type,
        consecutive_failures: health.consecutive_failures,
        failure: health.last_failure,
      },
      dedupeKey: failingKey(channel.id),
    });
  } catch (error) {
    ctx.log.warn({ err: String(error), channel_id: channel.id }, "could not open a problem");
  }
}
