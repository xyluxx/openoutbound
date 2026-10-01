/**
 * `content.publish_due` (every 5 minutes per workspace): settles publish attempts that stopped
 * mid-call (their posts become unknown), then publishes scheduled posts that are due and approved
 * posts a stopped run left before its claim.
 */
import { and, asc, eq, isNull, lt, lte, or } from "drizzle-orm";
import { z } from "zod";
import type { JobContext } from "../../core/context.js";
import { defineJob } from "../../core/operation.js";
import { posts, workspaces } from "../../db/schema/index.js";
import { publishPost, sweepStuckPublishes } from "./publish.js";

const BATCH = 10;

/**
 * Approving a post publishes it at once, so a post still `approved` after this long was left by a
 * run that stopped before its claim: nothing reached LinkedIn, and it is published now (or at its
 * time, when it has one still ahead).
 */
export const APPROVED_LEFT_MS = 10 * 60_000;

export interface PublishDueResult {
  published: number;
  failed: number;
  /** Posts whose outcome is unknown now (a stopped attempt or no clear answer): a person decides. */
  unknown: number;
  /**
   * Posts that failed before anything reached LinkedIn and are tried again later, or wait while
   * their publisher is paused.
   */
  retrying: number;
  skipped?: string;
}

export async function publishDuePosts(
  ctx: JobContext,
  workspaceId: string,
): Promise<PublishDueResult> {
  const result: PublishDueResult = { published: 0, failed: 0, unknown: 0, retrying: 0 };
  const [workspace] = await ctx.db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) return { ...result, skipped: "no_workspace" };
  // Stopped attempts are settled whatever the workspace status: that sends nothing.
  result.unknown += await sweepStuckPublishes(ctx, workspaceId);
  if (workspace.status !== "active") return { ...result, skipped: `workspace_${workspace.status}` };
  const due = await ctx.db
    .select()
    .from(posts)
    .where(
      and(
        eq(posts.workspace_id, workspaceId),
        eq(posts.status, "scheduled"),
        lte(posts.scheduled_for, ctx.clock.now()),
      ),
    )
    .orderBy(asc(posts.scheduled_for))
    .limit(BATCH);
  const left = await ctx.db
    .select()
    .from(posts)
    .where(
      and(
        eq(posts.workspace_id, workspaceId),
        eq(posts.status, "approved"),
        lt(posts.updated_at, new Date(ctx.clock.now().getTime() - APPROVED_LEFT_MS)),
        or(isNull(posts.scheduled_for), lte(posts.scheduled_for, ctx.clock.now())),
      ),
    )
    .orderBy(asc(posts.updated_at))
    .limit(BATCH);
  for (const post of [...due, ...left]) {
    // Out of time or cancelled: a post claimed now could not be sent, so it is left for the next
    // run instead of being claimed and refused.
    if (ctx.job.signal.aborted) break;
    const after = await publishPost(ctx, post, { signal: ctx.job.signal });
    if (after.status === "published") result.published++;
    else if (after.status === "failed") result.failed++;
    else if (after.status === "unknown") result.unknown++;
    else if (after.status === "scheduled" && after.publish_attempt > post.publish_attempt) {
      result.retrying++;
    }
  }
  return result;
}

export const publishDueJob = defineJob({
  name: "content.publish_due",
  payload: z.object({ workspace_id: z.string().optional() }).loose(),
  maxAttempts: 3,
  handler: async (ctx, payload) => {
    const workspaceId = ctx.workspace?.id ?? payload.workspace_id ?? ctx.job.workspaceId;
    if (!workspaceId) {
      return { published: 0, failed: 0, unknown: 0, retrying: 0, skipped: "no_workspace" };
    }
    return publishDuePosts(ctx, workspaceId);
  },
});
