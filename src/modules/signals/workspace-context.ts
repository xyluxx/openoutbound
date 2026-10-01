import type { OpContext } from "../../core/context.js";
import { contextForWorkspace } from "../../runtime/context.js";

/**
 * The context bound to `workspaceId` (job and event handlers may run with a context whose
 * workspace is not set), rebuilt with every service bound to it (`contextForWorkspace`, never a
 * shallow copy). Null when the workspace does not exist. A context that belongs to another
 * workspace is refused with `forbidden`.
 */
export async function inWorkspace<C extends OpContext>(
  ctx: C,
  workspaceId: string | null | undefined,
): Promise<C | null> {
  if (!workspaceId) return ctx.workspace ? ctx : null;
  return contextForWorkspace(ctx, workspaceId);
}
