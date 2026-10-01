/**
 * Problems service: the attention queue's records. Anything that needs a person or the agent
 * (a privacy request, a send with an unknown outcome, a mailbox that stopped working, a meeting
 * to book) is one problem with a plain reason and the exact remedy. Other modules open and
 * resolve problems through these functions (binding signatures from the upgrade plan).
 */
import { and, asc, eq, gte, inArray, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import { actorRef, type OpContext, requireWorkspace } from "../../core/context.js";
import type {
  ProblemKind,
  ProblemOwner,
  ProblemSeverity,
  ProblemStatus,
} from "../../core/enums.js";
import { notFound, OpenOutboundError } from "../../core/errors.js";
import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX } from "../../core/operation.js";
import { decodeCursor, toPage } from "../../core/pagination.js";
import { problems } from "../../db/schema/index.js";

export interface OpenProblemInput {
  kind: ProblemKind;
  severity: ProblemSeverity;
  /** Default "anyone". */
  owner?: ProblemOwner;
  /** Short, plain words. */
  title: string;
  /** Why this needs someone, plain words. */
  reason: string;
  /** What to do, naming the exact tool and action. */
  remedy: string;
  subject?: { type: string; id: string } | null;
  personId?: string | null;
  companyId?: string | null;
  data?: Record<string, unknown>;
  dueAt?: Date | null;
  /** At most one unresolved problem per key: opening it again updates that problem. */
  dedupeKey?: string | null;
}

export type ProblemRecord = typeof problems.$inferSelect;

/** Severity order, most severe first. */
const SEVERITY_RANK: Record<ProblemSeverity, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

const TITLE_MAX = 300;
const TEXT_MAX = 4000;

function requiredText(value: string, field: string, max: number): string {
  const text = value.trim();
  if (!text) {
    throw new OpenOutboundError("validation_failed", `A problem needs a ${field}.`, {
      hint: `Pass a non-empty ${field} in plain words.`,
      details: { field },
    });
  }
  return text.slice(0, max);
}

/** A snoozed problem whose time has passed counts as open again. */
function effective(row: ProblemRecord, now: Date): ProblemRecord {
  if (row.status === "snoozed" && row.snoozed_until && row.snoozed_until <= now) {
    return { ...row, status: "open" };
  }
  return row;
}

async function findUnresolvedByKey(
  ctx: OpContext,
  workspaceId: string,
  dedupeKey: string,
): Promise<ProblemRecord | null> {
  const [row] = await ctx.db
    .select()
    .from(problems)
    .where(
      and(
        eq(problems.workspace_id, workspaceId),
        eq(problems.dedupe_key, dedupeKey),
        ne(problems.status, "resolved"),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Refreshes an unresolved problem opened again: new wording and due time, the owner when the
 * caller names one, the data merged (keys the new data leaves out are kept, so what a reminder
 * job stored survives), never a lower severity. False when the problem was resolved in the
 * meantime: nothing changed.
 */
async function refresh(
  ctx: OpContext,
  existing: ProblemRecord,
  input: OpenProblemInput,
  text: { title: string; reason: string; remedy: string },
): Promise<boolean> {
  const severity =
    SEVERITY_RANK[input.severity] < SEVERITY_RANK[existing.severity]
      ? input.severity
      : existing.severity;
  const rows = await ctx.db
    .update(problems)
    .set({
      ...text,
      severity,
      ...(input.owner !== undefined ? { owner: input.owner } : {}),
      ...(input.data !== undefined
        ? { data: sql`${problems.data} || ${JSON.stringify(input.data)}::jsonb` }
        : {}),
      ...(input.dueAt !== undefined ? { due_at: input.dueAt } : {}),
    })
    .where(
      and(
        eq(problems.workspace_id, existing.workspace_id),
        eq(problems.id, existing.id),
        ne(problems.status, "resolved"),
      ),
    )
    .returning({ id: problems.id });
  return rows.length > 0;
}

/** Rounds of find, refresh and insert before `openProblem` gives up on a key that keeps changing. */
const OPEN_ROUNDS = 3;

/**
 * Opens a problem. With a `dedupeKey` that matches an unresolved problem, that problem is
 * updated instead (title, reason, remedy, due time, the owner when given, the data merged into
 * its data, and the severity only when the new one is higher) and `created` is false; otherwise
 * a new problem is stored and `problem.opened` fires. A problem resolved while this runs is
 * never reopened: a new one is stored instead.
 */
export async function openProblem(
  ctx: OpContext,
  input: OpenProblemInput,
): Promise<{ id: string; created: boolean }> {
  const workspace = requireWorkspace(ctx);
  const text = {
    title: requiredText(input.title, "title", TITLE_MAX),
    reason: requiredText(input.reason, "reason", TEXT_MAX),
    remedy: requiredText(input.remedy, "remedy", TEXT_MAX),
  };
  const dedupeKey = input.dedupeKey?.trim() || null;
  for (let round = 0; round < OPEN_ROUNDS; round++) {
    if (dedupeKey) {
      const existing = await findUnresolvedByKey(ctx, workspace.id, dedupeKey);
      if (existing && (await refresh(ctx, existing, input, text))) {
        return { id: existing.id, created: false };
      }
    }
    const [row] = await ctx.db
      .insert(problems)
      .values({
        workspace_id: workspace.id,
        kind: input.kind,
        severity: input.severity,
        owner: input.owner ?? "anyone",
        ...text,
        subject_type: input.subject?.type ?? null,
        subject_id: input.subject?.id ?? null,
        person_id: input.personId ?? null,
        company_id: input.companyId ?? null,
        data: input.data ?? {},
        due_at: input.dueAt ?? null,
        dedupe_key: dedupeKey,
      })
      // Another caller opened the same key in the meantime: the next round updates theirs.
      .onConflictDoNothing()
      .returning();
    if (!row) {
      if (!dedupeKey) throw new Error("openProblem: the insert returned no row");
      continue;
    }
    await ctx.events.emit("problem.opened", {
      subject: { type: "problem", id: row.id },
      data: {
        problem_id: row.id,
        kind: row.kind,
        severity: row.severity,
        subject_type: row.subject_type,
        subject_id: row.subject_id,
      },
    });
    return { id: row.id, created: true };
  }
  throw new OpenOutboundError(
    "conflict",
    "The problem changed while it was being opened; nothing was stored.",
    {
      hint: "Try again; if it keeps happening, look for the open problem with resolve_exception action list.",
      details: { dedupe_key: dedupeKey },
    },
  );
}

async function markResolved(
  ctx: OpContext,
  where: SQL,
  resolution: string | null,
): Promise<ProblemRecord[]> {
  const workspace = requireWorkspace(ctx);
  const rows = await ctx.db
    .update(problems)
    .set({
      status: "resolved",
      resolved_at: ctx.clock.now(),
      resolved_by: actorRef(ctx.principal),
      resolution,
    })
    .where(and(eq(problems.workspace_id, workspace.id), ne(problems.status, "resolved"), where))
    .returning();
  for (const row of rows) {
    await ctx.events.emit("problem.resolved", {
      subject: { type: "problem", id: row.id },
      data: { problem_id: row.id, kind: row.kind, resolution: row.resolution },
    });
  }
  return rows;
}

/**
 * Resolves a problem. Idempotent: `resolved` is true when this call resolved it (and
 * `problem.resolved` fired), false when it was already resolved. Throws `not_found` for an id
 * outside the workspace.
 */
export async function resolveProblem(
  ctx: OpContext,
  problemId: string,
  input: { resolution?: string | null } = {},
): Promise<{ resolved: boolean }> {
  const resolution = input.resolution?.trim().slice(0, TEXT_MAX) || null;
  const rows = await markResolved(ctx, eq(problems.id, problemId), resolution);
  if (rows.length > 0) return { resolved: true };
  if (!(await getProblem(ctx, problemId))) throw notFound("Problem", problemId);
  return { resolved: false };
}

/**
 * Resolves every unresolved problem matching all given filter fields (at least one is
 * required) and returns how many were resolved; `problem.resolved` fires for each.
 */
export async function resolveProblemsFor(
  ctx: OpContext,
  filter: {
    dedupeKey?: string;
    kind?: ProblemKind;
    subjectType?: string;
    subjectId?: string;
    personId?: string;
  },
  resolution: string,
): Promise<number> {
  const conditions: SQL[] = [];
  if (filter.dedupeKey) conditions.push(eq(problems.dedupe_key, filter.dedupeKey));
  if (filter.kind) conditions.push(eq(problems.kind, filter.kind));
  if (filter.subjectType) conditions.push(eq(problems.subject_type, filter.subjectType));
  if (filter.subjectId) conditions.push(eq(problems.subject_id, filter.subjectId));
  if (filter.personId) conditions.push(eq(problems.person_id, filter.personId));
  const where = and(...conditions);
  if (conditions.length === 0 || !where) {
    throw new OpenOutboundError("validation_failed", "Say which problems to resolve.", {
      hint: "Pass at least one of dedupeKey, kind, subjectType, subjectId or personId.",
    });
  }
  const rows = await markResolved(ctx, where, resolution.trim().slice(0, TEXT_MAX) || null);
  return rows.length;
}

/** Longest snooze of an urgent problem. */
export const URGENT_SNOOZE_HOURS = 24;

const inUtc = (at: Date) => `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;

/**
 * Snoozes an open problem until a future time; after that it counts as open again. A snooze
 * never ends after the problem's due time (an overdue problem cannot be snoozed), and an urgent
 * problem is snoozed for at most URGENT_SNOOZE_HOURS. Throws `not_found` for an unknown id,
 * `conflict` for a resolved problem and `validation_failed` for a time that is not in the future
 * or breaks those limits.
 */
export async function snoozeProblem(ctx: OpContext, problemId: string, until: Date): Promise<void> {
  const workspace = requireWorkspace(ctx);
  const now = ctx.clock.now();
  if (until.getTime() <= now.getTime()) {
    throw new OpenOutboundError("validation_failed", "A snooze must end in the future.", {
      hint: "Pass a later time, or resolve the problem if it needs nothing more.",
      details: { until: until.toISOString() },
    });
  }
  const urgentLimit = new Date(now.getTime() + URGENT_SNOOZE_HOURS * 3_600_000);
  const [row] = await ctx.db
    .update(problems)
    .set({ status: "snoozed", snoozed_until: until })
    .where(
      and(
        eq(problems.workspace_id, workspace.id),
        eq(problems.id, problemId),
        ne(problems.status, "resolved"),
        // The limits are part of the write, so a problem that turned urgent meanwhile is kept.
        or(isNull(problems.due_at), gte(problems.due_at, until)),
        until.getTime() > urgentLimit.getTime() ? ne(problems.severity, "urgent") : undefined,
      ),
    )
    .returning({ id: problems.id });
  if (row) return;
  const problem = await getProblem(ctx, problemId);
  if (!problem) throw notFound("Problem", problemId);
  if (problem.status === "resolved") {
    throw new OpenOutboundError("conflict", `Problem ${problemId} is already resolved.`, {
      hint: "Only open problems can be snoozed; list open ones with their status filter.",
      details: { problem_id: problemId },
    });
  }
  const details = { problem_id: problemId, until: until.toISOString() };
  if (problem.due_at && problem.due_at.getTime() < until.getTime()) {
    const due = inUtc(problem.due_at);
    throw new OpenOutboundError(
      "validation_failed",
      `Problem ${problemId} is due ${due}; a snooze may not end after its due time.`,
      {
        hint:
          problem.due_at.getTime() > now.getTime()
            ? `Snooze it until ${due} at the latest, or do its remedy now.`
            : "Its due time has passed, so it cannot be snoozed: do its remedy now.",
        details: { ...details, due_at: problem.due_at.toISOString() },
      },
    );
  }
  if (problem.severity === "urgent" && until.getTime() > urgentLimit.getTime()) {
    throw new OpenOutboundError(
      "validation_failed",
      `Problem ${problemId} is urgent: it can be snoozed for at most ${URGENT_SNOOZE_HOURS} hours.`,
      {
        hint: `Snooze it until ${inUtc(urgentLimit)} at the latest, or do its remedy now.`,
        details: { ...details, severity: problem.severity },
      },
    );
  }
  throw new OpenOutboundError("conflict", `Problem ${problemId} changed while it was snoozed.`, {
    hint: "Read it again with get_attention_queue, then snooze it again.",
    details,
  });
}

/** One problem of the workspace (a snoozed one whose time passed shows as open), or null. */
export async function getProblem(ctx: OpContext, problemId: string): Promise<ProblemRecord | null> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select()
    .from(problems)
    .where(and(eq(problems.workspace_id, workspace.id), eq(problems.id, problemId)))
    .limit(1);
  return row ? effective(row, ctx.clock.now()) : null;
}

/**
 * Problems of the workspace, most severe first, then soonest due (no due time last), then
 * oldest. `statuses` (default ["open"]) match the effective status: a snoozed problem whose
 * time passed is open. Paginated like every list (`limit` default 25, max 100).
 */
export async function listProblems(
  ctx: OpContext,
  filter: {
    statuses?: ProblemStatus[];
    kinds?: ProblemKind[];
    personId?: string;
    limit?: number;
    cursor?: string | null;
  } = {},
): Promise<{ items: ProblemRecord[]; next_cursor: string | null; has_more: boolean }> {
  const workspace = requireWorkspace(ctx);
  const now = ctx.clock.now();
  const limit = Math.max(
    1,
    Math.min(Math.trunc(filter.limit ?? PAGE_LIMIT_DEFAULT), PAGE_LIMIT_MAX),
  );
  const statuses = filter.statuses ?? ["open"];
  const nowSql = sql`${now.toISOString()}::timestamptz`;
  const status = sql`(case when ${problems.status} = 'snoozed' and ${problems.snoozed_until} <= ${nowSql} then 'open' else ${problems.status} end)`;
  const rank = sql`(case ${problems.severity} when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end)`;
  const due = sql`coalesce(date_trunc('milliseconds', ${problems.due_at}), 'infinity'::timestamptz)`;
  const created = sql`date_trunc('milliseconds', ${problems.created_at})`;

  const conditions: SQL[] = [eq(problems.workspace_id, workspace.id)];
  if (statuses.length === 0) return { items: [], next_cursor: null, has_more: false };
  conditions.push(
    sql`${status} in (${sql.join(
      statuses.map((value) => sql`${value}`),
      sql`, `,
    )})`,
  );
  if (filter.kinds?.length) conditions.push(inArray(problems.kind, filter.kinds));
  if (filter.personId) conditions.push(eq(problems.person_id, filter.personId));
  if (filter.cursor) {
    const cursor = decodeCursor<{ s?: unknown; d?: unknown; c?: unknown; id?: unknown }>(
      filter.cursor,
    );
    if (
      typeof cursor.s !== "number" ||
      typeof cursor.d !== "string" ||
      typeof cursor.c !== "string" ||
      typeof cursor.id !== "string"
    ) {
      throw new OpenOutboundError("validation_failed", "Invalid cursor.", {
        hint: "Pass next_cursor exactly as returned by the previous page, or omit it to start over.",
      });
    }
    conditions.push(
      sql`(${rank}, ${due}, ${created}, ${problems.id}) > (${cursor.s}::int, ${cursor.d}::timestamptz, ${cursor.c}::timestamptz, ${cursor.id})`,
    );
  }
  // The sort keys come back as text so the cursor holds exactly what the database compares.
  const rows = await ctx.db
    .select({
      problem: problems,
      rank: sql<number>`${rank}`,
      due: sql<string>`${due}::text`,
      created: sql<string>`${created}::text`,
    })
    .from(problems)
    .where(and(...conditions))
    .orderBy(asc(rank), asc(due), asc(created), asc(problems.id))
    .limit(limit + 1);
  return toPage(
    rows,
    limit,
    (row) => ({ s: Number(row.rank), d: row.due, c: row.created, id: row.problem.id }),
    (row) => effective(row.problem, now),
  );
}
