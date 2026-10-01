/**
 * Daily housekeeping: expire approvals, purge idempotency records, prune old events (90 days),
 * delivered webhook deliveries (30 days) and finished jobs (30 days; failed ones 90 days).
 */
import { and, eq, inArray, lt, lte } from "drizzle-orm";
import { type BuiltinSchedule, defineJob } from "../core/operation.js";
import type { Db } from "../db/client.js";
import { events, idempotency_records, jobs, webhook_deliveries } from "../db/schema/index.js";
import { expireApprovals } from "./approvals.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const EVENT_RETENTION_DAYS = 90;
export const DELIVERY_RETENTION_DAYS = 30;
export const JOB_RETENTION_DAYS = 30;
export const FAILED_JOB_RETENTION_DAYS = 90;

export interface MaintenanceResult {
  approvals_expired: number;
  idempotency_purged: number;
  events_pruned: number;
  deliveries_pruned: number;
  jobs_pruned: number;
}

const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS);

export async function runMaintenance(db: Db, now: Date): Promise<MaintenanceResult> {
  const approvalsExpired = await expireApprovals(db, now);
  const idempotency = await db
    .delete(idempotency_records)
    .where(lte(idempotency_records.expires_at, now))
    .returning({ key: idempotency_records.key });
  const deliveries = await db
    .delete(webhook_deliveries)
    .where(
      and(
        eq(webhook_deliveries.status, "delivered"),
        lt(webhook_deliveries.delivered_at, daysAgo(now, DELIVERY_RETENTION_DAYS)),
      ),
    )
    .returning({ id: webhook_deliveries.id });
  const oldEvents = await db
    .delete(events)
    .where(lt(events.occurred_at, daysAgo(now, EVENT_RETENTION_DAYS)))
    .returning({ id: events.id });
  const finished = await db
    .delete(jobs)
    .where(
      and(
        inArray(jobs.status, ["succeeded", "cancelled"]),
        lt(jobs.finished_at, daysAgo(now, JOB_RETENTION_DAYS)),
      ),
    )
    .returning({ id: jobs.id });
  const failed = await db
    .delete(jobs)
    .where(
      and(eq(jobs.status, "failed"), lt(jobs.finished_at, daysAgo(now, FAILED_JOB_RETENTION_DAYS))),
    )
    .returning({ id: jobs.id });
  return {
    approvals_expired: approvalsExpired,
    idempotency_purged: idempotency.length,
    events_pruned: oldEvents.length,
    deliveries_pruned: deliveries.length,
    jobs_pruned: finished.length + failed.length,
  };
}

export const maintenanceJob = defineJob({
  name: "system.maintenance",
  maxAttempts: 3,
  handler: (ctx) => runMaintenance(ctx.db, ctx.clock.now()),
});

export const maintenanceSchedule: BuiltinSchedule = {
  name: "system.maintenance",
  cron: "17 3 * * *",
  job: "system.maintenance",
  perWorkspace: false,
};
