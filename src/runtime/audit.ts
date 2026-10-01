import { type AuditLog, actorRef, type Principal } from "../core/context.js";
import { audit_events } from "../db/schema/index.js";
import type { Kernel } from "./kernel.js";
import { auditInputSummary } from "./redact.js";

/**
 * Audit log bound to a context: fills workspace, actor and via from it and redacts the input
 * (secrets removed, long text truncated to 500 chars). Never throws: a failed audit write is
 * logged, not surfaced to the caller.
 */
export function createAuditLog(
  kernel: Pick<Kernel, "db" | "clock" | "log">,
  scope: { workspaceId: string | null; principal: Principal },
): AuditLog {
  return {
    async record(entry) {
      const actor = entry.actor ?? actorRef(scope.principal);
      try {
        await kernel.db.insert(audit_events).values({
          workspace_id: entry.workspaceId !== undefined ? entry.workspaceId : scope.workspaceId,
          occurred_at: entry.occurredAt ?? kernel.clock.now(),
          actor_type: actor.type,
          actor_id: actor.id,
          actor_name: actor.name,
          via: entry.via ?? actor.via ?? scope.principal.via,
          operation: entry.operation,
          effect: entry.effect,
          target_type: entry.target?.type ?? null,
          target_id: entry.target?.id ?? null,
          reason: entry.reason ?? null,
          summary: entry.summary ?? null,
          input: auditInputSummary(entry.input),
          status: entry.status,
          error_code: entry.errorCode ?? null,
        });
      } catch (error) {
        kernel.log.error({ err: error, operation: entry.operation }, "audit write failed");
      }
    },
  };
}
