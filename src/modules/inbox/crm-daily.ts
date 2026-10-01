/**
 * `crm.timing: daily`: the live CRM handlers do nothing, and once a day this job replays the
 * events since its last run through `processCrmEvent`, oldest first. It reads them with the
 * change feed (`readEvents`) as the named consumer `crm.builtin`, so its position is stored and
 * shown like any other consumer's (`event_feed` action `consumers`); the first run starts 24
 * hours back. It stops at an event that fails for a temporary reason (keeping its position, so
 * the retry or the next run starts there), and continues in a follow-up job when a day holds
 * more than 5000 events. While the built-in sync is not daily (or no CRM is configured) the job
 * only forgets its position, so a later switch to daily starts fresh.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import type { EventData } from "../../core/events.js";
import { type BuiltinSchedule, defineJob } from "../../core/operation.js";
import { event_consumers } from "../../db/schema/index.js";
import {
  acknowledgeEvents,
  consumerPosition,
  cursorAt,
  type FeedEvent,
  readEvents,
} from "../system/event-feed.js";
import { CRM_SYNC_EVENT_TYPES, type CrmEvent, processCrmEvent } from "./crm-events.js";
import { crmPreferences } from "./crm-sync.js";

export const CRM_DAILY_JOB = "inbox.crm_daily";
/** Consumer name of the built-in daily sync in `event_consumers`. */
export const CRM_CONSUMER = "crm.builtin";
const PAGE_SIZE = 200;
const MAX_EVENTS_PER_RUN = 5000;
const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** The last replayed event: its time (milliseconds, ISO 8601) and id. */
export interface CrmReplayPosition {
  at: string;
  id: string;
}

export interface CrmReplayResult {
  status: "done" | "more" | "skipped";
  reason: string | null;
  processed: number;
  /** Time of the last replayed event, or of the starting point. */
  position_at: string | null;
}

/** The daily consumer's stored position, or null when it has none (or an unreadable one). */
export async function readReplayPosition(ctx: OpContext): Promise<CrmReplayPosition | null> {
  const position = await consumerPosition(ctx, CRM_CONSUMER);
  return position ? { at: position.at, id: position.id } : null;
}

async function clearReplayPosition(ctx: OpContext): Promise<void> {
  const workspace = requireWorkspace(ctx);
  await ctx.db
    .delete(event_consumers)
    .where(
      and(eq(event_consumers.workspace_id, workspace.id), eq(event_consumers.name, CRM_CONSUMER)),
    );
}

function toCrmEvent(item: FeedEvent): CrmEvent {
  return {
    id: item.id,
    type: item.type,
    data: item.data as unknown as EventData["reply.classified"],
    occurredAt: new Date(item.occurred_at),
  } as CrmEvent;
}

/**
 * Replays the CRM events after the daily consumer's position (see the file comment). Returns
 * how many it processed; throws when an event fails for a temporary reason.
 */
export async function replayCrmEvents(
  ctx: OpContext,
  options: { maxEvents?: number } = {},
): Promise<CrmReplayResult> {
  const workspace = requireWorkspace(ctx);
  const { mode, timing } = crmPreferences(ctx);
  if (mode !== "built_in" || timing !== "daily") {
    await clearReplayPosition(ctx);
    const reason = mode !== "built_in" ? `mode_${mode}` : "timing_live";
    return { status: "skipped", reason, processed: 0, position_at: null };
  }
  if ((await ctx.providers.list("crm")).length === 0) {
    await clearReplayPosition(ctx);
    return { status: "skipped", reason: "no_crm_provider", processed: 0, position_at: null };
  }
  const max = Math.max(1, options.maxEvents ?? MAX_EVENTS_PER_RUN);
  const stored = await consumerPosition(ctx, CRM_CONSUMER);
  const start = new Date(ctx.clock.now().getTime() - FIRST_RUN_LOOKBACK_MS);
  let cursor = stored?.cursor ?? cursorAt(start);
  let positionAt = stored?.at ?? start.toISOString();
  let processed = 0;
  for (;;) {
    const page = await readEvents(ctx, {
      after: cursor,
      types: [...CRM_SYNC_EVENT_TYPES],
      limit: Math.min(PAGE_SIZE, max - processed),
    });
    for (const item of page.items) {
      try {
        await processCrmEvent(ctx, toCrmEvent(item));
      } catch (error) {
        await acknowledgeEvents(ctx, CRM_CONSUMER, cursor);
        throw error;
      }
      cursor = item.cursor;
      positionAt = item.occurred_at;
      processed += 1;
    }
    if (!page.has_more) {
      // The last page ends at the newest settled event, one the sync uses or not, so the
      // position never waits on old events it skips (they are pruned after 90 days).
      const end = page.next_cursor ?? cursor;
      await acknowledgeEvents(ctx, CRM_CONSUMER, end);
      if (end !== cursor)
        positionAt = (await consumerPosition(ctx, CRM_CONSUMER))?.at ?? positionAt;
      return { status: "done", reason: null, processed, position_at: positionAt };
    }
    await acknowledgeEvents(ctx, CRM_CONSUMER, cursor);
    if (processed >= max) {
      await ctx.jobs.enqueue(
        CRM_DAILY_JOB,
        { workspace_id: workspace.id },
        { singletonKey: `${CRM_DAILY_JOB}:more:${workspace.id}`, delayMs: 1000 },
      );
      return { status: "more", reason: null, processed, position_at: positionAt };
    }
  }
}

export const crmDailyJob = defineJob({
  name: CRM_DAILY_JOB,
  payload: z.object({}).passthrough(),
  maxAttempts: 5,
  backoff: { type: "exponential", baseMs: 5 * 60_000, maxMs: 3 * 3_600_000 },
  timeoutMs: 15 * 60_000,
  handler: async (ctx) => {
    if (!ctx.workspace) return { status: "skipped", reason: "no_workspace", processed: 0 };
    return replayCrmEvents(ctx);
  },
});

/** Once a day per workspace; it does nothing unless `crm.timing` is daily. */
export const crmDailySchedule: BuiltinSchedule = {
  name: "inbox.crm_daily",
  cron: "40 2 * * *",
  job: CRM_DAILY_JOB,
  perWorkspace: true,
};
