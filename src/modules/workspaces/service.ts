/**
 * Workspaces service: settings validation and storage for other modules (the strategy undo,
 * a setup import). Every stored settings change is recorded in the change log.
 */
import { eq } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { notFound, OpenOutboundError } from "../../core/errors.js";
import {
  DEFAULT_REPLY_RULES,
  parseWorkspaceSettings,
  type WorkspaceSettingsInput,
} from "../../core/settings.js";
import { type Workspace, workspaces } from "../../db/schema/index.js";
import { recordChange } from "../strategy/service.js";
import { loosenedGateRefusal } from "./safety.js";

/**
 * Throws `validation_failed` when stored settings (or a patch) change a locked reply rule or do
 * not parse with the settings schema.
 */
export function validateWorkspaceSettings(settings: Record<string, unknown>): void {
  const replies = settings.replies;
  if (replies && typeof replies === "object") {
    for (const [category, rule] of Object.entries(replies as Record<string, unknown>)) {
      const locked = DEFAULT_REPLY_RULES[category as keyof typeof DEFAULT_REPLY_RULES];
      if (!locked?.locked || !rule || typeof rule !== "object") continue;
      const action = (rule as { action?: unknown }).action;
      if (action !== undefined && action !== locked.action) {
        throw new OpenOutboundError(
          "validation_failed",
          `The "${category}" reply rule is locked to "${locked.action}".`,
          {
            hint: "Locked rules (unsubscribe, privacy_request, bounce, negative) protect compliance and cannot be changed.",
            details: { field: `settings.replies.${category}.action` },
          },
        );
      }
    }
  }
  parseWorkspaceSettings(settings);
}

/**
 * Updates the context workspace from its row as stored: `change` gets the row read under a row
 * lock and returns the columns to set, so two writers never overwrite each other's settings.
 * New settings are validated before the write, and a settings change is recorded against the
 * locked read (operation default "workspaces.update"). Settings that loosen a gate are refused
 * (`forbidden`) unless the caller is a person holding approve (see safety.ts). Returns the row
 * as stored afterwards.
 */
export async function updateWorkspaceRow(
  ctx: OpContext,
  change: (stored: Workspace) => Partial<Workspace>,
  options: { operation?: string } = {},
): Promise<Workspace> {
  const workspace = requireWorkspace(ctx);
  const { stored, row, settings } = await ctx.db.transaction(async (tx) => {
    // The lock an update of the row takes anyway: it keeps other writers of the row out until
    // this one commits, without blocking inserts elsewhere that reference the workspace.
    const [stored] = await tx
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspace.id))
      .for("no key update");
    if (!stored) throw notFound("Workspace", workspace.id);
    const set = change(stored);
    const settings = set.settings !== undefined;
    if (settings) {
      validateWorkspaceSettings(set.settings as Record<string, unknown>);
      const refusal = loosenedGateRefusal(ctx.principal, stored.settings, set.settings);
      if (refusal) throw refusal;
    }
    if (Object.keys(set).length === 0) return { stored, row: stored, settings };
    const [row] = await tx
      .update(workspaces)
      .set(set)
      .where(eq(workspaces.id, workspace.id))
      .returning();
    if (!row) throw new OpenOutboundError("internal", "Failed to update the workspace.");
    return { stored, row, settings };
  });
  if (settings) {
    await recordChange(ctx, {
      area: "settings",
      targetId: workspace.id,
      operation: options.operation ?? "workspaces.update",
      before: stored.settings ?? {},
      after: row.settings,
    });
  }
  return row;
}

/**
 * Rewrites the context workspace's stored settings: `update` gets the settings as stored (read
 * under a row lock) and returns the new ones, which are validated, written and recorded
 * (operation default "workspaces.update"). Returns the updated workspace row.
 */
export async function saveWorkspaceSettings(
  ctx: OpContext,
  update: (stored: Record<string, unknown>) => Record<string, unknown>,
  options: { operation?: string } = {},
): Promise<Workspace> {
  return updateWorkspaceRow(
    ctx,
    (stored) => ({
      settings: update(
        (stored.settings ?? {}) as Record<string, unknown>,
      ) as WorkspaceSettingsInput,
    }),
    options,
  );
}
