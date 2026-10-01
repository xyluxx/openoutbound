/**
 * The workspace fence of a context (spec 2, rule 9 and the context services): events, jobs and
 * approvals created through a context land in the context's workspace. Only an instance-level
 * context (no workspace, and a principal bound to none) may name another workspace; work that
 * needs another workspace's context gets one from `contextForWorkspace`.
 */
import type { Principal } from "../core/context.js";
import { OpenOutboundError } from "../core/errors.js";

/**
 * The workspace a context may write to: its own, else the one its principal is bound to. Null
 * for instance-level contexts, which may name any workspace.
 */
export function contextFence(
  workspaceId: string | null,
  principal: Pick<Principal, "workspaceId">,
): string | null {
  return workspaceId ?? principal.workspaceId ?? null;
}

/**
 * Throws `forbidden` when a fenced context names another workspace (or none) for something it
 * creates. `what` completes "cannot ... in workspace X", e.g. "emit events".
 */
export function assertInFence(
  fence: string | null,
  target: string | null | undefined,
  what: string,
): void {
  if (fence === null || target === undefined || target === fence) return;
  throw new OpenOutboundError(
    "forbidden",
    `A context of workspace ${fence} cannot ${what} ${target === null ? "outside any workspace" : `in workspace ${target}`}.`,
    {
      hint: "This is a bug in the calling code: work in another workspace only from an instance-level job, with a context from contextForWorkspace.",
      details: { reason: "workspace_scope", workspace_id: fence, target_workspace_id: target },
    },
  );
}
