/**
 * Undo: sets the paths of one change back to their values before it, through the same
 * functions that apply changes, so the undo is itself a recorded change (`undo_of` points at
 * the change it reverts). Creates and deletes cannot be undone, and a change cannot be undone
 * while a later change that touched the same paths is still in effect (undo that one first).
 * A change is in effect until it is undone; undoing an undo makes the change it reverted live
 * again.
 */
import { and, asc, desc, eq, gt, isNull } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { forbidden, notFound, OpenOutboundError } from "../../core/errors.js";
import { type ChangeLogEntry, change_log, change_proposals } from "../../db/schema/index.js";
import { applyCampaignUpdate, type CampaignUpdate, loadCampaign } from "../campaigns/service.js";
import { getOffer, type OfferFields, updateOffer } from "../knowledge/service.js";
import { type IcpFields, requireIcp, updateIcpRecord } from "../leads/service.js";
import { saveWorkspaceSettings } from "../workspaces/service.js";
import { changeKind, findChange } from "./change-log.js";
import { runInChangeScope } from "./change-scope.js";
import { pathsOverlap, revertDiff } from "./diff.js";
import {
  type CampaignSnapshot,
  campaignSnapshot,
  type IcpSnapshot,
  icpSnapshot,
  type OfferSnapshot,
  offerSnapshot,
} from "./snapshots.js";

export interface UndoResult {
  /** The change that was undone (or would be, on a dry run). */
  change: ChangeLogEntry;
  /** The new change that restored the values; null on a dry run or when nothing differed. */
  undo: { changeId: string; version: number } | null;
  /** Each path and the value it gets back (`removed` = it did not exist before). */
  restores: Array<{ path: string; value: unknown; removed: boolean }>;
  warnings: string[];
}

const UNDO_OPERATION = "changes.undo";

function unsupportedKind(change: ChangeLogEntry, kind: "create" | "delete"): OpenOutboundError {
  const hints: Record<string, string> = {
    "create:offer":
      "Archive the offer instead with manage_knowledge action remove_offer (offer_id from target_id).",
    "create:icp": "Delete the ICP instead with manage_icp action delete (icp_id from target_id).",
    "delete:offer":
      "Reactivate or recreate it instead: manage_knowledge action update_offer (status active) or add_offer, using the before values of this change.",
    "delete:icp":
      "Recreate it instead with manage_icp action create, using the before values of this change.",
  };
  return new OpenOutboundError(
    "unsupported",
    `Change ${change.id} (version ${change.version}) ${kind === "create" ? "created" : "removed"} its ${change.area}; creates and deletes cannot be undone.`,
    {
      hint:
        hints[`${kind}:${change.area}`] ??
        (kind === "create" ? "Remove it instead." : "Recreate it instead."),
      details: { change_id: change.id, version: change.version, kind },
    },
  );
}

/**
 * The latest later change on the same target that touched one of the change's paths and is
 * still in effect. An undone change is not in effect, and an undo in effect that reverted a
 * later change (now undone) cancels out with it.
 */
async function laterConflict(
  ctx: OpContext,
  change: ChangeLogEntry,
): Promise<{ row: ChangeLogEntry; path: string } | null> {
  const rows = await ctx.db
    .select()
    .from(change_log)
    .where(
      and(
        eq(change_log.workspace_id, change.workspace_id),
        eq(change_log.area, change.area),
        change.target_id === null
          ? isNull(change_log.target_id)
          : eq(change_log.target_id, change.target_id),
        gt(change_log.version, change.version),
      ),
    )
    .orderBy(asc(change_log.version));
  const later = new Map(rows.map((row) => [row.id, row]));
  let found: { row: ChangeLogEntry; path: string } | null = null;
  for (const row of rows) {
    if (row.undone_at) continue;
    const reverted = row.undo_of ? later.get(row.undo_of) : undefined;
    if (reverted?.undone_at) continue;
    for (const entry of row.diff) {
      const own = change.diff.find((item) => pathsOverlap(item.path, entry.path));
      if (own) found = { row, path: own.path };
    }
  }
  return found;
}

/**
 * The undo that undid a change: the latest one still in effect (a change undone, made live by
 * undoing its undo, then undone again has several), else the latest.
 */
export async function findUndoOf(
  ctx: OpContext,
  workspaceId: string,
  changeId: string,
): Promise<{ id: string; version: number } | null> {
  const rows = await ctx.db
    .select({ id: change_log.id, version: change_log.version, undone_at: change_log.undone_at })
    .from(change_log)
    .where(and(eq(change_log.workspace_id, workspaceId), eq(change_log.undo_of, changeId)))
    .orderBy(desc(change_log.version));
  const undo = rows.find((row) => row.undone_at === null) ?? rows[0];
  return undo ? { id: undo.id, version: undo.version } : null;
}

/** Marks the proposal behind a change reverted (its change was undone) or applied (live again). */
async function followProposal(
  ctx: OpContext,
  workspaceId: string,
  proposalId: string,
  reverted: boolean,
): Promise<void> {
  await ctx.db
    .update(change_proposals)
    .set({ status: reverted ? "reverted" : "applied" })
    .where(
      and(
        eq(change_proposals.workspace_id, workspaceId),
        eq(change_proposals.id, proposalId),
        eq(change_proposals.status, reverted ? "applied" : "reverted"),
      ),
    );
}

/** How far undos of undos are followed. */
const MAX_UNDO_CHAIN = 50;

/**
 * After undoing an undo: the change it reverted is live again; when that one was an undo too,
 * the change it reverted is undone again, and so on up the chain.
 */
async function flipRevertedChain(
  ctx: OpContext,
  workspaceId: string,
  undo: ChangeLogEntry,
  now: Date,
): Promise<void> {
  let live = true;
  let id = undo.undo_of;
  for (let depth = 0; id && depth < MAX_UNDO_CHAIN; depth++) {
    const [row] = await ctx.db
      .update(change_log)
      .set({ undone_at: live ? null : now })
      .where(and(eq(change_log.workspace_id, workspaceId), eq(change_log.id, id)))
      .returning();
    if (!row) return;
    if (row.proposal_id) await followProposal(ctx, workspaceId, row.proposal_id, !live);
    id = row.undo_of;
    live = !live;
  }
}

function differs(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
}

/** Top-level fields whose restored value differs from the current one. */
function changedFields<T extends object>(current: T, restored: T): Array<keyof T> {
  return (Object.keys(restored) as Array<keyof T>).filter((key) =>
    differs(current[key], restored[key]),
  );
}

/**
 * Undoes one change (see the file comment). Settings changes need the admin scope, like
 * workspaces.update. With `dryRun` nothing is written and `restores` shows what would change.
 */
export async function undoChange(
  ctx: OpContext,
  changeId: string,
  options: { dryRun?: boolean } = {},
): Promise<UndoResult> {
  const workspace = requireWorkspace(ctx);
  const change = await findChange(ctx, workspace.id, changeId);
  if (!change) throw notFound("Change", changeId);
  if (change.undone_at) {
    const undo = await findUndoOf(ctx, workspace.id, change.id);
    throw new OpenOutboundError(
      "conflict",
      `Change ${change.id} (version ${change.version}) was already undone${undo ? ` by version ${undo.version} (${undo.id})` : ""}.`,
      {
        hint: "Read the current values with manage_strategy action get and change them directly if needed.",
        details: { change_id: change.id, undo_change_id: undo?.id ?? null },
      },
    );
  }
  const kind = changeKind(change);
  if (kind !== "update") throw unsupportedKind(change, kind);
  const conflict = await laterConflict(ctx, change);
  if (conflict) {
    throw new OpenOutboundError(
      "conflict",
      `Version ${conflict.row.version} (${conflict.row.id}) changed ${conflict.path || "the same values"} after version ${change.version}, so undoing ${change.id} would overwrite it.`,
      {
        hint: `Undo version ${conflict.row.version} first with manage_strategy action undo (change_id ${conflict.row.id}), or set the value directly.`,
        details: { later_change_id: conflict.row.id, later_version: conflict.row.version },
      },
    );
  }
  if (change.area === "settings" && !ctx.principal.scopes.includes("admin")) {
    throw forbidden("admin");
  }

  const restores = change.diff.map((entry) => ({
    path: entry.path,
    value: entry.before ?? null,
    removed: entry.before === undefined,
  }));
  const warnings: string[] = [];
  const apply = await prepareRestore(ctx, change, warnings);
  if (options.dryRun) return { change, undo: null, restores, warnings };

  // Claim the change first so two undos cannot both run.
  const now = ctx.clock.now();
  const [claimed] = await ctx.db
    .update(change_log)
    .set({ undone_at: now })
    .where(and(eq(change_log.id, change.id), isNull(change_log.undone_at)))
    .returning();
  if (!claimed) {
    throw new OpenOutboundError("conflict", `Change ${change.id} is being undone already.`, {
      hint: "Read it again with manage_strategy action change.",
    });
  }
  const scope = {
    workspaceId: workspace.id,
    undoOf: change.id,
    operation: UNDO_OPERATION,
    recorded: [] as Array<{ changeId: string; version: number }>,
  };
  try {
    await runInChangeScope(scope, apply);
  } catch (error) {
    await ctx.db.update(change_log).set({ undone_at: null }).where(eq(change_log.id, change.id));
    throw error;
  }
  if (change.proposal_id) await followProposal(ctx, workspace.id, change.proposal_id, true);
  if (change.undo_of) await flipRevertedChain(ctx, workspace.id, change, now);
  return { change: claimed, undo: scope.recorded.at(-1) ?? null, restores, warnings };
}

/** Reads the target, computes what to restore and returns the write to run. */
async function prepareRestore(
  ctx: OpContext,
  change: ChangeLogEntry,
  warnings: string[],
): Promise<() => Promise<void>> {
  const targetId = change.target_id ?? "";
  switch (change.area) {
    case "settings": {
      // Reverted on the settings as stored when the write runs (under a row lock), so an undo
      // running at the same time as another settings write keeps that write.
      const restore = (stored: Record<string, unknown>) =>
        (revertDiff(stored, change.diff) as Record<string, unknown> | undefined) ?? {};
      return async () => {
        await saveWorkspaceSettings(ctx, restore, { operation: UNDO_OPERATION });
      };
    }
    case "offer": {
      const offer = await getOffer(ctx, targetId);
      const current = offerSnapshot(offer);
      const restored = revertDiff(current, change.diff) as OfferSnapshot;
      const patch: OfferFields & { status?: "active" | "archived" } = {};
      for (const field of changedFields(current, restored)) {
        if (field === "status") {
          if (restored.status === "suggested") {
            throw new OpenOutboundError(
              "unsupported",
              "An offer cannot go back to being a suggestion.",
              { hint: "Archive it with manage_knowledge action remove_offer instead." },
            );
          }
          patch.status = restored.status;
        } else {
          Object.assign(patch, { [field]: restored[field] });
        }
      }
      if (patch.is_default === false) {
        warnings.push(
          `Offer ${offer.name} is no longer the default. Make another offer the default with manage_knowledge action update_offer (is_default true) if campaigns without an offer should still pitch one.`,
        );
      }
      return async () => {
        await updateOffer(ctx, offer.id, patch);
      };
    }
    case "icp": {
      const icp = await requireIcp(ctx, targetId);
      const current = icpSnapshot(icp);
      const restored = revertDiff(current, change.diff) as IcpSnapshot;
      const patch: IcpFields = {};
      for (const field of changedFields(current, restored)) {
        if (field === "is_default" && restored.is_default === false) {
          warnings.push(
            `ICP ${icp.name} stays the default: make another ICP the default with manage_icp action update (is_default true) to move it.`,
          );
          continue;
        }
        Object.assign(patch, { [field]: restored[field] });
      }
      return async () => {
        await updateIcpRecord(ctx, icp.id, patch);
      };
    }
    case "campaign": {
      const loaded = await loadCampaign(ctx, targetId);
      const current = campaignSnapshot(loaded.campaign, loaded.steps);
      const restored = revertDiff(current, change.diff) as CampaignSnapshot;
      const update: CampaignUpdate = {};
      const existing = new Set(loaded.steps.map((step) => step.id));
      for (const field of changedFields(current, restored)) {
        if (field === "settings") update.replace_settings = restored.settings ?? {};
        else if (field === "steps") {
          // Steps that still exist keep their id (and people their place); removed ones return new.
          update.steps = restored.steps.map((step) => ({
            ...(existing.has(step.id) ? { id: step.id } : {}),
            type: step.type,
            delay_days: step.delay_days,
            delay_hours: step.delay_hours,
            config: step.config,
          }));
        } else Object.assign(update, { [field]: restored[field] });
      }
      return async () => {
        const { held, heldSteps } = await applyCampaignUpdate(ctx, loaded.campaign.id, update, {
          operation: UNDO_OPERATION,
        });
        if (held) {
          warnings.push(
            `The review level stays ${held.from}: lowering it to ${held.to} waits for a person with the approve scope (approval ${held.approval_id} in review_items).`,
          );
        }
        for (const step of heldSteps) {
          warnings.push(
            `Every comment of step ${step.position + 1} stays reviewed: following the review level waits for a person with the approve scope (approval ${step.approval_id} in review_items).`,
          );
        }
      };
    }
  }
}
