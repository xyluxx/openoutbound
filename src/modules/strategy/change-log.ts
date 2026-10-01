/**
 * The change log: every change to workspace settings, offers, ICPs and campaigns with its
 * paths, values before and after, actor, reason and a workspace version that grows by one per
 * change. `recordChange` is called inside the functions that apply those changes, so every
 * path that changes them (any door, a proposal, an undo) is recorded.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { actorRef, type OpContext } from "../../core/context.js";
import type { ChangeArea } from "../../core/enums.js";
import { type ChangeLogEntry, change_log } from "../../db/schema/index.js";
import { currentChangeScope } from "./change-scope.js";
import { describeValue, diffValues } from "./diff.js";

export interface RecordChangeInput {
  area: ChangeArea;
  /** The offer, ICP or campaign id; the workspace id for settings. */
  targetId?: string | null;
  /** Operation that made the change, e.g. "offers.update". */
  operation?: string | null;
  before: unknown;
  after: unknown;
  /** Default: the call's `reason`. */
  reason?: string | null;
  /** Default: the proposal being applied, if any. */
  proposalId?: string | null;
}

const VERSION_ATTEMPTS = 10;

/** SQLSTATE 23505 from pg or PGlite, possibly wrapped by drizzle. */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current === "object" && (current as { code?: unknown }).code === "23505") {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Records one change with the next workspace version and emits `change.recorded`. Returns null
 * when nothing changed (before and after are equal) or when there is no workspace. The actor,
 * door and reason come from the context. A recording failure is logged and never breaks the
 * change itself. Never call it inside a database transaction callback.
 */
export async function recordChange(
  ctx: OpContext,
  input: RecordChangeInput,
): Promise<{ changeId: string; version: number } | null> {
  const workspace = ctx.workspace;
  if (!workspace) return null;
  try {
    const diff = diffValues(input.before, input.after);
    if (diff.length === 0) return null;
    const scope = currentChangeScope();
    const inScope = scope?.workspaceId === workspace.id ? scope : undefined;
    const proposalId = input.proposalId ?? inScope?.proposalId ?? null;
    // A whole record that did not exist before (or no longer exists after) keeps its create or
    // delete operation: the operation is what tells creates and deletes apart (changeKind).
    const wholeRecord = input.before == null || input.after == null;
    const operation = wholeRecord
      ? (input.operation ?? inScope?.operation ?? null)
      : (inScope?.operation ?? input.operation ?? null);
    const values = {
      workspace_id: workspace.id,
      area: input.area,
      target_id: input.targetId ?? null,
      operation,
      diff,
      reason: (input.reason ?? ctx.request.reason ?? null)?.slice(0, 500) ?? null,
      actor: actorRef(ctx.principal),
      via: ctx.principal.via,
      proposal_id: proposalId,
      undo_of: inScope?.undoOf ?? null,
      created_at: ctx.clock.now(),
    };
    let row: { id: string; version: number } | undefined;
    for (let attempt = 1; attempt <= VERSION_ATTEMPTS && !row; attempt++) {
      try {
        [row] = await ctx.db
          .insert(change_log)
          .values({
            ...values,
            // Next version for the workspace; two writers racing for it hit the unique index.
            version: sql`(select coalesce(max(${change_log.version}), 0) + 1 from ${change_log} where ${change_log.workspace_id} = ${workspace.id})`,
          })
          .returning({ id: change_log.id, version: change_log.version });
      } catch (error) {
        if (!isUniqueViolation(error) || attempt === VERSION_ATTEMPTS) throw error;
      }
    }
    if (!row) return null;
    inScope?.recorded.push({ changeId: row.id, version: row.version });
    await ctx.events.emit("change.recorded", {
      subject: { type: "change", id: row.id },
      data: {
        change_id: row.id,
        version: row.version,
        area: input.area,
        target_id: values.target_id,
        proposal_id: proposalId,
      },
    });
    return { changeId: row.id, version: row.version };
  } catch (error) {
    ctx.log.error(
      { err: error, area: input.area, target_id: input.targetId ?? null },
      "recording a change in the change log failed",
    );
    return null;
  }
}

/** The latest workspace version (0 before the first change). */
export async function latestVersion(ctx: OpContext, workspaceId: string): Promise<number> {
  const [row] = await ctx.db
    .select({ version: change_log.version })
    .from(change_log)
    .where(eq(change_log.workspace_id, workspaceId))
    .orderBy(desc(change_log.version))
    .limit(1);
  return row?.version ?? 0;
}

/** One change of the workspace, or null. */
export async function findChange(
  ctx: OpContext,
  workspaceId: string,
  changeId: string,
): Promise<ChangeLogEntry | null> {
  const [row] = await ctx.db
    .select()
    .from(change_log)
    .where(and(eq(change_log.workspace_id, workspaceId), eq(change_log.id, changeId)))
    .limit(1);
  return row ?? null;
}

/**
 * Operations whose changes create or remove the whole target (recorded with a null snapshot
 * before or after); they cannot be undone. Approving a suggested offer makes it live, so it counts
 * as a create; archiving an offer is its delete.
 */
const CREATE_OPERATIONS = new Set(["offers.create", "icps.create", "knowledge.approve"]);
const DELETE_OPERATIONS = new Set(["offers.delete", "icps.delete"]);

export type ChangeKind = "create" | "update" | "delete";

/**
 * Whether a change created, updated or removed its target, from the operation that made it.
 * Missing paths never decide it: an update that only adds a key (no `before`) is an update, and
 * undoing it removes the key.
 */
export function changeKind(entry: Pick<ChangeLogEntry, "area" | "operation" | "diff">): ChangeKind {
  if (entry.operation && CREATE_OPERATIONS.has(entry.operation)) return "create";
  if (entry.operation && DELETE_OPERATIONS.has(entry.operation)) return "delete";
  return "update";
}

const SUMMARY_PATHS = 3;

/** One line: "booking.mode: link -> handoff", or the changed paths. */
export function summarizeChange(
  entry: Pick<ChangeLogEntry, "area" | "operation" | "diff">,
): string {
  const kind = changeKind(entry);
  const paths = entry.diff.map((item) => item.path || "(all)");
  const listed =
    paths.length > SUMMARY_PATHS
      ? `${paths.slice(0, SUMMARY_PATHS).join(", ")} and ${paths.length - SUMMARY_PATHS} more`
      : paths.join(", ");
  if (kind === "create") return `Created (${listed})`;
  if (kind === "delete") return `Removed (${listed})`;
  const [only] = entry.diff;
  if (entry.diff.length === 1 && only) {
    return `${only.path || "(all)"}: ${describeValue(only.before)} -> ${describeValue(only.after)}`;
  }
  return `Changed ${listed}`;
}
