/**
 * Writes to ideal customer profiles. Every create, update and delete is recorded in the change
 * log (strategy), whatever calls it: manage_icp, a proposal or an undo.
 */
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../../core/context.js";
import { notFound, OpenOutboundError } from "../../../core/errors.js";
import { type Icp, icps } from "../../../db/schema/index.js";
import { icpSnapshot, recordChange } from "../../strategy/service.js";
import { describeCriteria, parseIcp } from "./criteria.js";

export interface IcpFields {
  name?: string;
  description?: string | null;
  criteria?: Record<string, unknown>;
  scoring?: Record<string, unknown>;
  signal_keys?: string[];
  is_default?: boolean;
}

/** The ICP in the context workspace, or `not_found`. */
export async function requireIcp(ctx: OpContext, icpId: string): Promise<Icp> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select()
    .from(icps)
    .where(and(eq(icps.id, icpId), eq(icps.workspace_id, workspace.id)));
  if (!row) throw notFound("ICP", icpId);
  return row;
}

async function clearOtherDefaults(ctx: OpContext, keepId: string): Promise<void> {
  const workspace = requireWorkspace(ctx);
  await ctx.db
    .update(icps)
    .set({ is_default: false })
    .where(
      and(eq(icps.workspace_id, workspace.id), ne(icps.id, keepId), eq(icps.is_default, true)),
    );
}

/** Creates an ICP; the first one of a workspace becomes the default. */
export async function createIcpRecord(
  ctx: OpContext,
  input: IcpFields & { name: string },
): Promise<Icp> {
  const workspace = requireWorkspace(ctx);
  const [existing] = await ctx.db
    .select({ id: icps.id })
    .from(icps)
    .where(eq(icps.workspace_id, workspace.id))
    .limit(1);
  const isDefault = input.is_default ?? !existing;
  const [row] = await ctx.db
    .insert(icps)
    .values({
      workspace_id: workspace.id,
      name: input.name.trim(),
      description: input.description ?? null,
      criteria: input.criteria ?? {},
      scoring: input.scoring ?? {},
      signal_keys: input.signal_keys ?? [],
      is_default: isDefault,
    })
    .returning();
  if (!row) throw new Error("insert returned no row");
  if (isDefault) await clearOtherDefaults(ctx, row.id);
  await recordChange(ctx, {
    area: "icp",
    targetId: row.id,
    operation: "icps.create",
    before: null,
    after: icpSnapshot(row),
  });
  return row;
}

/**
 * Updates an ICP: criteria and scoring are replaced as a whole when given, is_default true makes
 * it the default (the default cannot be unset directly).
 */
export async function updateIcpRecord(
  ctx: OpContext,
  icpId: string,
  input: IcpFields,
): Promise<Icp> {
  const workspace = requireWorkspace(ctx);
  const row = await requireIcp(ctx, icpId);
  if (input.is_default === false && row.is_default) {
    throw new OpenOutboundError("validation_failed", "The default ICP cannot be unset directly.", {
      hint: "Make another ICP the default (is_default true on that one) instead.",
    });
  }
  const patch: Partial<Icp> = {};
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.description !== undefined) patch.description = input.description;
  if (input.criteria !== undefined) patch.criteria = input.criteria;
  if (input.scoring !== undefined) patch.scoring = input.scoring;
  if (input.signal_keys !== undefined) patch.signal_keys = input.signal_keys;
  if (input.is_default) patch.is_default = true;
  const [updated] = await ctx.db
    .update(icps)
    .set({ ...patch, updated_at: ctx.clock.now() })
    .where(and(eq(icps.id, row.id), eq(icps.workspace_id, workspace.id)))
    .returning();
  if (input.is_default) await clearOtherDefaults(ctx, row.id);
  const result = updated ?? row;
  await recordChange(ctx, {
    area: "icp",
    targetId: row.id,
    operation: "icps.update",
    before: icpSnapshot(row),
    after: icpSnapshot(result),
  });
  return result;
}

/**
 * Deletes an ICP. When it was the default, the most recently updated remaining ICP becomes the
 * default; its id is returned.
 */
export async function deleteIcpRecord(
  ctx: OpContext,
  icpId: string,
): Promise<{ newDefaultId: string | null }> {
  const workspace = requireWorkspace(ctx);
  const row = await requireIcp(ctx, icpId);
  await ctx.db.delete(icps).where(and(eq(icps.id, row.id), eq(icps.workspace_id, workspace.id)));
  let newDefault: string | null = null;
  if (row.is_default) {
    const [next] = await ctx.db
      .select()
      .from(icps)
      .where(eq(icps.workspace_id, workspace.id))
      .orderBy(sql`${icps.updated_at} desc`)
      .limit(1);
    if (next) {
      await ctx.db.update(icps).set({ is_default: true }).where(eq(icps.id, next.id));
      newDefault = next.id;
    }
  }
  await recordChange(ctx, {
    area: "icp",
    targetId: row.id,
    operation: "icps.delete",
    before: icpSnapshot(row),
    after: null,
  });
  return { newDefaultId: newDefault };
}

const SUMMARY_MAX = 200;

/** Every ICP of the workspace with a one-line criteria summary, default first. */
export async function listIcpSummaries(
  ctx: OpContext,
): Promise<Array<{ id: string; name: string; is_default: boolean; summary: string }>> {
  const workspace = requireWorkspace(ctx);
  const rows = await ctx.db
    .select()
    .from(icps)
    .where(eq(icps.workspace_id, workspace.id))
    .orderBy(asc(icps.id));
  return rows
    .map((row) => {
      const summary = describeCriteria(parseIcp(row).criteria).replaceAll("\n", "; ");
      return {
        id: row.id,
        name: row.name,
        is_default: row.is_default,
        summary: !summary
          ? "No criteria yet"
          : summary.length > SUMMARY_MAX
            ? `${summary.slice(0, SUMMARY_MAX - 3)}...`
            : summary,
      };
    })
    .sort((a, b) => Number(b.is_default) - Number(a.is_default));
}
