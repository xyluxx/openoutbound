/**
 * Daily retention sweep (settings.compliance.retention_days, default 1095; null disables):
 * deletes prospects with no message activity and no update in that period, with their lead-file
 * facts. Never deletes customers (person or company status), people with open opportunities,
 * or people in queued, active, paused or review-waiting enrollments. Suppressions are kept.
 * Also drops find previews that were never imported after 30 days.
 */
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { type BuiltinSchedule, defineJob } from "../../core/operation.js";
import { parseWorkspaceSettings } from "../../core/settings.js";
import { imports, messages, people } from "../../db/schema/index.js";
import { deleteFactsForPeople } from "./facts.js";
import { emptyScrubCounts, type ScrubCounts, scrubPeopleData } from "./forget.js";

export const RETENTION_JOB = "leads.retention_sweep";
const BATCH = 500;
const MAX_BATCHES = 20;
const PREVIEW_DAYS = 30;
const DAY_MS = 86_400_000;

export interface RetentionSummary {
  retention_days: number | null;
  people_deleted: number;
  previews_deleted: number;
  more_left: boolean;
  scrubbed: ScrubCounts;
}

/** Ids of people the retention rule allows deleting (oldest first). */
export async function expiredPeople(
  ctx: OpContext,
  cutoff: Date,
  limit: number,
): Promise<string[]> {
  const workspace = requireWorkspace(ctx);
  const rows = await ctx.db
    .select({ id: people.id })
    .from(people)
    .where(
      and(
        eq(people.workspace_id, workspace.id),
        lt(people.updated_at, cutoff),
        sql`${people.status} <> 'customer'`,
        sql`(${people.last_contacted_at} is null or ${people.last_contacted_at} < ${cutoff})`,
        sql`not exists (select 1 from companies c where c.id = ${people.company_id} and c.status = 'customer')`,
        sql`not exists (select 1 from messages m where m.person_id = ${people.id} and m.workspace_id = ${workspace.id} and greatest(m.created_at, coalesce(m.sent_at, m.created_at), coalesce(m.received_at, m.created_at)) >= ${cutoff})`,
        sql`not exists (select 1 from opportunities o where o.person_id = ${people.id} and o.workspace_id = ${workspace.id} and o.stage in ('interested', 'meeting_booked'))`,
        sql`not exists (select 1 from enrollments e where e.person_id = ${people.id} and e.status in ('queued', 'active', 'paused', 'waiting_review'))`,
      ),
    )
    .orderBy(people.updated_at)
    .limit(limit);
  return rows.map((row) => row.id);
}

/**
 * Deletes the lead-file facts of people about to be deleted (`lead_facts` has no foreign
 * keys): their person facts and every fact taken from their replies, in a few batched
 * statements for the whole batch of people.
 */
async function deleteLeadFiles(ctx: OpContext, personIds: string[]): Promise<number> {
  const workspace = requireWorkspace(ctx);
  const replies = await ctx.db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, workspace.id),
        inArray(messages.person_id, personIds),
        eq(messages.direction, "inbound"),
      ),
    );
  return deleteFactsForPeople(ctx, personIds, { messageIds: replies.map((row) => row.id) });
}

export const retentionSweepJob = defineJob({
  name: RETENTION_JOB,
  payload: z.object({}).passthrough(),
  maxAttempts: 3,
  timeoutMs: 15 * 60_000,
  handler: async (ctx): Promise<RetentionSummary | { skipped: string }> => {
    if (!ctx.workspace) return { skipped: "no_workspace" };
    const workspace = ctx.workspace;
    const days = parseWorkspaceSettings(workspace.settings).compliance.retention_days;
    const now = ctx.clock.now();
    const summary: RetentionSummary = {
      retention_days: days,
      people_deleted: 0,
      previews_deleted: 0,
      more_left: false,
      scrubbed: emptyScrubCounts(),
    };

    const previewCutoff = new Date(now.getTime() - PREVIEW_DAYS * DAY_MS);
    const previews = await ctx.db
      .delete(imports)
      .where(
        and(
          eq(imports.workspace_id, workspace.id),
          eq(imports.status, "previewed"),
          lt(imports.created_at, previewCutoff),
        ),
      )
      .returning({ id: imports.id });
    summary.previews_deleted = previews.length;

    if (days !== null) {
      const cutoff = new Date(now.getTime() - days * DAY_MS);
      for (let batch = 0; batch < MAX_BATCHES; batch++) {
        ctx.job.signal.throwIfAborted();
        const ids = await expiredPeople(ctx, cutoff, BATCH);
        if (ids.length === 0) break;
        await deleteLeadFiles(ctx, ids);
        const scrubbed = await scrubPeopleData(ctx, ids, true);
        for (const key of Object.keys(scrubbed) as Array<keyof ScrubCounts>) {
          summary.scrubbed[key] += scrubbed[key];
        }
        const deleted = await ctx.db
          .delete(people)
          .where(and(eq(people.workspace_id, workspace.id), inArray(people.id, ids)))
          .returning({ id: people.id });
        summary.people_deleted += deleted.length;
        if (ids.length < BATCH) break;
        if (batch === MAX_BATCHES - 1) summary.more_left = true;
      }
    }

    await ctx.audit.record({
      operation: RETENTION_JOB,
      effect: "destructive",
      status: "ok",
      summary:
        days === null
          ? `Retention is off (compliance.retention_days is null); deleted ${summary.previews_deleted} old find previews`
          : `Retention sweep (${days} days) deleted ${summary.people_deleted} people and ${summary.previews_deleted} old find previews`,
      input: {
        retention_days: days,
        people_deleted: summary.people_deleted,
        previews_deleted: summary.previews_deleted,
        messages_scrubbed: summary.scrubbed.messages_scrubbed,
        more_left: summary.more_left,
      },
    });
    return summary;
  },
});

export const retentionSchedule: BuiltinSchedule = {
  name: "leads.retention_sweep",
  cron: "17 3 * * *",
  job: RETENTION_JOB,
  perWorkspace: true,
};
