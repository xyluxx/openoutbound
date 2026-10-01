import type { EventBus, JobQueue } from "../core/context.js";
import { OpenOutboundError } from "../core/errors.js";
import { isEventType } from "../core/events.js";
import { events } from "../db/schema/index.js";
import type { Kernel } from "./kernel.js";
import { queueEventNotifications } from "./notify.js";
import { type EventJobPayload, eventJobName } from "./registry.js";
import { queueWebhookDeliveries } from "./webhooks.js";
import { assertInFence } from "./workspace-fence.js";

/**
 * Event bus (spec 5.5): `emit` writes the `events` row, enqueues one durable job per
 * subscribed handler, one webhook delivery per subscribed endpoint and one notification per
 * channel subscribed to the type. A context fenced to a workspace (see workspace-fence) emits
 * only there.
 */
export function createEventBus(
  kernel: Kernel,
  scope: { workspaceId: string | null; jobs: JobQueue; fence?: string | null },
): EventBus {
  return {
    async emit(type, input) {
      if (!isEventType(type)) {
        throw new OpenOutboundError("internal", `Unknown event type "${String(type)}".`, {
          hint: "Add the type to EventData in src/core/events.ts.",
        });
      }
      const workspaceId = input.workspaceId ?? scope.workspaceId;
      assertInFence(scope.fence ?? null, workspaceId ?? undefined, `emit "${type}" events`);
      if (!workspaceId) {
        throw new OpenOutboundError(
          "internal",
          `Event "${type}" was emitted without a workspace.`,
          {
            hint: "Pass workspaceId to events.emit when the context has no workspace.",
          },
        );
      }
      const now = kernel.clock.now();
      const subject = input.subject ?? null;
      const data = JSON.parse(JSON.stringify(input.data ?? {})) as Record<string, unknown>;
      const [row] = await kernel.db
        .insert(events)
        .values({
          workspace_id: workspaceId,
          type,
          subject_type: subject?.type ?? null,
          subject_id: subject?.id ?? null,
          data,
          occurred_at: now,
        })
        .returning({ id: events.id });
      if (!row) throw new OpenOutboundError("internal", "Failed to store the event.");

      const payload: EventJobPayload = {
        event: {
          id: row.id,
          type,
          workspace_id: workspaceId,
          subject,
          data,
          occurred_at: now.toISOString(),
        },
      };
      for (const handler of kernel.registry.eventHandlers(type)) {
        await scope.jobs.enqueue(eventJobName(handler.name), payload, { workspaceId });
      }
      await queueWebhookDeliveries(kernel, scope.jobs, { id: row.id, workspaceId, type });
      await queueEventNotifications(kernel, scope.jobs, { workspaceId, type, data, subject });
      return { id: row.id };
    },
  };
}
