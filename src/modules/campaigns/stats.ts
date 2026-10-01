import { and, asc, count, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import type { OpContext } from "../../core/context.js";
import { requireWorkspace } from "../../core/context.js";
import type { ReplyCategory } from "../../core/enums.js";
import { defineJob } from "../../core/operation.js";
import {
  type CampaignStats,
  type CampaignStepStats,
  campaigns,
  enrollments,
  messages,
  opportunities,
} from "../../db/schema/index.js";
import { getSteps } from "./repo.js";

export const STATS_JOB = "campaigns.refresh_stats";

/** Reply categories counted as positive (sequences playbook, A/B primary metric). */
export const POSITIVE_CATEGORIES: readonly ReplyCategory[] = [
  "interested",
  "meeting_request",
  "referral",
];

/** Debounced stats refresh (one queued job per campaign). */
export async function requestStatsRefresh(
  ctx: OpContext,
  campaignIds: Iterable<string | null | undefined>,
): Promise<void> {
  const unique = new Set<string>();
  for (const id of campaignIds) if (id) unique.add(id);
  for (const campaignId of unique) {
    await ctx.jobs.enqueue(
      STATS_JOB,
      { campaign_id: campaignId },
      { singletonKey: `${STATS_JOB}:${campaignId}`, delayMs: 30_000 },
    );
  }
}

interface Outbound {
  id: string;
  person_id: string | null;
  thread_id: string | null;
  step_id: string | null;
  variant: string | null;
  status: string;
  sent_at: Date | null;
}

function emptyStep(stepId: string, position: number, variant: string | null): CampaignStepStats {
  return {
    step_id: stepId,
    position,
    variant,
    sent: 0,
    replies: 0,
    positive_replies: 0,
    meetings: 0,
    bounces: 0,
  };
}

/**
 * Recomputes a campaign's counters from enrollments, messages and opportunities (idempotent):
 * enrollments by status, sent, replies (people who replied), positive replies, meetings and
 * bounces, overall and per step and A/B variant. A reply or meeting is credited to the last
 * message sent to that person before it.
 */
export async function computeCampaignStats(
  ctx: OpContext,
  campaignId: string,
): Promise<CampaignStats> {
  const workspace = requireWorkspace(ctx);
  const [statusRows, steps, outbound, meetingRows] = await Promise.all([
    ctx.db
      .select({ status: enrollments.status, n: count() })
      .from(enrollments)
      .where(
        and(eq(enrollments.workspace_id, workspace.id), eq(enrollments.campaign_id, campaignId)),
      )
      .groupBy(enrollments.status),
    getSteps(ctx.db, campaignId),
    ctx.db
      .select({
        id: messages.id,
        person_id: messages.person_id,
        thread_id: messages.thread_id,
        step_id: messages.step_id,
        variant: messages.variant,
        status: messages.status,
        sent_at: messages.sent_at,
      })
      .from(messages)
      .where(
        and(
          eq(messages.workspace_id, workspace.id),
          eq(messages.campaign_id, campaignId),
          eq(messages.direction, "outbound"),
          inArray(messages.status, ["sent", "bounced"]),
        ),
      )
      .orderBy(asc(messages.sent_at)),
    ctx.db
      .select({ person_id: opportunities.person_id })
      .from(opportunities)
      .where(
        and(
          eq(opportunities.workspace_id, workspace.id),
          eq(opportunities.campaign_id, campaignId),
          inArray(opportunities.stage, ["meeting_booked", "won"]),
        ),
      ),
  ]);

  const byStatus = new Map(statusRows.map((row) => [row.status, Number(row.n)]));
  const positions = new Map(steps.map((step) => [step.id, step.position]));
  const threadIds = [...new Set(outbound.map((m) => m.thread_id).filter((id) => id !== null))];

  const inbound: Array<{
    person_id: string | null;
    thread_id: string | null;
    at: Date;
    category: ReplyCategory | null;
  }> = [];
  const conditions = [eq(messages.campaign_id, campaignId)];
  for (let i = 0; i < threadIds.length; i += 500) {
    conditions.push(inArray(messages.thread_id, threadIds.slice(i, i + 500)));
  }
  const inboundRows = await ctx.db
    .select({
      person_id: messages.person_id,
      thread_id: messages.thread_id,
      received_at: messages.received_at,
      created_at: messages.created_at,
      classification: messages.classification,
    })
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, workspace.id),
        eq(messages.direction, "inbound"),
        or(...conditions),
      ),
    );
  for (const row of inboundRows) {
    inbound.push({
      person_id: row.person_id,
      thread_id: row.thread_id,
      at: row.received_at ?? row.created_at,
      category: row.classification?.category ?? null,
    });
  }
  inbound.sort((a, b) => a.at.getTime() - b.at.getTime());

  const buckets = new Map<string, CampaignStepStats>();
  const bucketOf = (message: Outbound): CampaignStepStats | null => {
    if (!message.step_id) return null;
    const key = `${message.step_id}|${message.variant ?? ""}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = emptyStep(message.step_id, positions.get(message.step_id) ?? -1, message.variant);
      buckets.set(key, bucket);
    }
    return bucket;
  };

  const byPerson = new Map<string, Outbound[]>();
  const byThread = new Map<string, Outbound[]>();
  let sent = 0;
  let bounces = 0;
  for (const message of outbound) {
    sent += 1;
    const bucket = bucketOf(message);
    if (bucket) bucket.sent += 1;
    if (message.status === "bounced") {
      bounces += 1;
      if (bucket) bucket.bounces += 1;
    }
    if (message.person_id) {
      byPerson.set(message.person_id, [...(byPerson.get(message.person_id) ?? []), message]);
    }
    if (message.thread_id) {
      byThread.set(message.thread_id, [...(byThread.get(message.thread_id) ?? []), message]);
    }
  }

  const lastBefore = (list: Outbound[] | undefined, at: Date): Outbound | null => {
    if (!list) return null;
    let found: Outbound | null = null;
    for (const message of list) {
      if (message.sent_at && message.sent_at.getTime() <= at.getTime()) found = message;
    }
    return found ?? list[0] ?? null;
  };

  const replied = new Set<string>();
  const positive = new Set<string>();
  for (const reply of inbound) {
    const candidates =
      (reply.thread_id ? byThread.get(reply.thread_id) : undefined) ??
      (reply.person_id ? byPerson.get(reply.person_id) : undefined);
    const credited = lastBefore(candidates, reply.at);
    const who = reply.person_id ?? credited?.person_id ?? reply.thread_id;
    if (!who) continue;
    const bucket = credited ? bucketOf(credited) : null;
    if (!replied.has(who)) {
      replied.add(who);
      if (bucket) bucket.replies += 1;
    }
    if (reply.category && POSITIVE_CATEGORIES.includes(reply.category) && !positive.has(who)) {
      positive.add(who);
      if (bucket) bucket.positive_replies += 1;
    }
  }

  const met = new Set<string>();
  for (const row of meetingRows) {
    if (!row.person_id || met.has(row.person_id)) continue;
    met.add(row.person_id);
    const list = byPerson.get(row.person_id);
    const last = list?.[list.length - 1];
    const bucket = last ? bucketOf(last) : null;
    if (bucket) bucket.meetings += 1;
  }

  const total = [...byStatus.values()].reduce((sum, n) => sum + n, 0);
  return {
    enrolled: total,
    queued: byStatus.get("queued") ?? 0,
    active:
      (byStatus.get("active") ?? 0) +
      (byStatus.get("paused") ?? 0) +
      (byStatus.get("waiting_review") ?? 0),
    completed: byStatus.get("completed") ?? 0,
    stopped: byStatus.get("stopped") ?? 0,
    failed: byStatus.get("failed") ?? 0,
    sent,
    replies: replied.size,
    positive_replies: positive.size,
    meetings: met.size,
    bounces,
    by_step: [...buckets.values()].sort(
      (a, b) => a.position - b.position || (a.variant ?? "").localeCompare(b.variant ?? ""),
    ),
    refreshed_at: ctx.clock.now().toISOString(),
  };
}

/** Recomputes and stores `campaigns.stats`. */
export async function refreshCampaignStats(
  ctx: OpContext,
  campaignId: string,
): Promise<CampaignStats> {
  const workspace = requireWorkspace(ctx);
  const stats = await computeCampaignStats(ctx, campaignId);
  await ctx.db
    .update(campaigns)
    .set({ stats })
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.workspace_id, workspace.id)));
  return stats;
}

export const refreshStatsJob = defineJob({
  name: STATS_JOB,
  payload: z.object({ campaign_id: z.string() }),
  maxAttempts: 3,
  handler: async (ctx, payload) => {
    const stats = await refreshCampaignStats(ctx, payload.campaign_id);
    return { campaign_id: payload.campaign_id, sent: stats.sent, replies: stats.replies };
  },
});
