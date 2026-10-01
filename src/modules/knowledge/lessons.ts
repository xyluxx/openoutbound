/**
 * Lessons: what works for this client (knowledge kind `lesson`), with a source, a sample size,
 * an author and an expiry (default 90 days). Lessons guide writers as "guidance from past
 * results", never as facts to state, and they never cross workspaces. A daily job archives
 * the expired ones.
 */
import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { type JobContext, type OpContext, requireWorkspace } from "../../core/context.js";
import { OpenOutboundError } from "../../core/errors.js";
import { type BuiltinSchedule, defineJob } from "../../core/operation.js";
import { type KnowledgeItem, knowledge_items } from "../../db/schema/index.js";
import { jobWorkspaceContext } from "../../runtime/context.js";

/** Default lifetime of a lesson. */
export const LESSON_DEFAULT_DAYS = 90;
export const LESSON_MAX_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

/** When a lesson added now expires. */
export function lessonExpiry(now: Date, days: number = LESSON_DEFAULT_DAYS): Date {
  return new Date(now.getTime() + days * DAY_MS);
}

/** `expires_in_days` and `sample_size` only make sense for lessons. */
export function assertLessonFields(
  kind: string,
  input: { expires_in_days?: number | undefined; sample_size?: number | null | undefined },
): void {
  if (kind === "lesson") return;
  const field =
    input.expires_in_days !== undefined
      ? "expires_in_days"
      : input.sample_size !== undefined && input.sample_size !== null
        ? "sample_size"
        : null;
  if (!field) return;
  throw new OpenOutboundError("validation_failed", `${field} applies to lessons only.`, {
    hint: 'Pass kind "lesson" for a lesson, or leave the field out for other knowledge items.',
    details: { field },
  });
}

/** Lessons that guide writing now: active and not expired, newest first. */
export async function listActiveLessons(
  ctx: OpContext,
  options: { limit?: number } = {},
): Promise<KnowledgeItem[]> {
  const workspace = requireWorkspace(ctx);
  const now = ctx.clock.now();
  return ctx.db
    .select()
    .from(knowledge_items)
    .where(
      and(
        eq(knowledge_items.workspace_id, workspace.id),
        eq(knowledge_items.kind, "lesson"),
        eq(knowledge_items.status, "active"),
        or(isNull(knowledge_items.expires_at), gt(knowledge_items.expires_at, now)),
      ),
    )
    .orderBy(desc(knowledge_items.updated_at), desc(knowledge_items.id))
    .limit(Math.max(1, Math.min(options.limit ?? 10, 50)));
}

/** Archives the workspace's lessons whose expiry has passed. Returns how many. */
export async function archiveExpiredLessons(ctx: OpContext): Promise<number> {
  const workspace = requireWorkspace(ctx);
  const rows = await ctx.db
    .update(knowledge_items)
    .set({ status: "archived" })
    .where(
      and(
        eq(knowledge_items.workspace_id, workspace.id),
        eq(knowledge_items.kind, "lesson"),
        inArray(knowledge_items.status, ["active", "suggested"]),
        lte(knowledge_items.expires_at, ctx.clock.now()),
      ),
    )
    .returning({ id: knowledge_items.id });
  return rows.length;
}

export const ARCHIVE_LESSONS_JOB = "knowledge.archive_expired_lessons";

/** Daily per workspace: expired lessons stop guiding writers and leave the strategy page. */
export const archiveLessonsJob = defineJob({
  name: ARCHIVE_LESSONS_JOB,
  payload: z.object({ workspace_id: z.string().min(1).optional() }),
  maxAttempts: 3,
  handler: async (jobCtx: JobContext, payload) => {
    const workspaceId = payload.workspace_id ?? jobCtx.job.workspaceId;
    if (!workspaceId) return { skipped: "no workspace" };
    const ctx = await jobWorkspaceContext(jobCtx, workspaceId);
    if (!ctx) return { skipped: "workspace not found" };
    return { archived: await archiveExpiredLessons(ctx) };
  },
});

export const archiveLessonsSchedule: BuiltinSchedule = {
  name: "knowledge.archive_expired_lessons",
  cron: "23 3 * * *",
  job: ARCHIVE_LESSONS_JOB,
  perWorkspace: true,
};

/** Counts active knowledge items of one kind (voice samples on the strategy page). */
export async function countActiveItems(
  ctx: OpContext,
  kind: KnowledgeItem["kind"],
): Promise<number> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(knowledge_items)
    .where(
      and(
        eq(knowledge_items.workspace_id, workspace.id),
        eq(knowledge_items.kind, kind),
        eq(knowledge_items.status, "active"),
      ),
    );
  return row?.n ?? 0;
}

/** Titles of the active hard rules (never say, never promise), oldest first. */
export async function listRuleTitles(ctx: OpContext): Promise<string[]> {
  const workspace = requireWorkspace(ctx);
  const rows = await ctx.db
    .select({ title: knowledge_items.title })
    .from(knowledge_items)
    .where(
      and(
        eq(knowledge_items.workspace_id, workspace.id),
        eq(knowledge_items.kind, "rule"),
        eq(knowledge_items.status, "active"),
      ),
    )
    .orderBy(knowledge_items.id)
    .limit(50);
  return rows.map((row) => row.title);
}
