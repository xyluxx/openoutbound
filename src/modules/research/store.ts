/**
 * research_briefs row helpers. A company brief has `person_id` null; a person brief has both
 * ids (company may be null). Rows start `pending` when research is requested; the
 * `research.run` job for the company fills every pending row of that company.
 */
import { and, desc, eq, gte, inArray, isNull, type SQL } from "drizzle-orm";
import type { ResearchBriefStatus } from "../../core/enums.js";
import type { Db } from "../../db/client.js";
import { type ResearchBriefRow, research_briefs } from "../../db/schema/index.js";

/** Briefs younger than this are reused instead of researching again (spec 11.6). */
export const FRESH_DAYS = 30;
/** Pending rows older than this are treated as stuck and queued again. */
export const STALE_PENDING_MS = 60 * 60 * 1000;

export function freshSince(now: Date): Date {
  return new Date(now.getTime() - FRESH_DAYS * 24 * 60 * 60 * 1000);
}

export interface BriefTarget {
  personId?: string | null;
  companyId?: string | null;
}

function targetConditions(workspaceId: string, target: BriefTarget): SQL[] {
  const conditions: SQL[] = [eq(research_briefs.workspace_id, workspaceId)];
  if (target.personId) conditions.push(eq(research_briefs.person_id, target.personId));
  else {
    conditions.push(isNull(research_briefs.person_id));
    if (target.companyId) conditions.push(eq(research_briefs.company_id, target.companyId));
    else conditions.push(isNull(research_briefs.company_id));
  }
  return conditions;
}

/** Latest brief of the target with one of the statuses, optionally updated since `since`. */
export async function latestBrief(
  db: Db,
  workspaceId: string,
  target: BriefTarget,
  statuses: ResearchBriefStatus[],
  since?: Date,
): Promise<ResearchBriefRow | null> {
  const conditions = targetConditions(workspaceId, target);
  conditions.push(inArray(research_briefs.status, statuses));
  if (since) conditions.push(gte(research_briefs.updated_at, since));
  const [row] = await db
    .select()
    .from(research_briefs)
    .where(and(...conditions))
    .orderBy(desc(research_briefs.updated_at), desc(research_briefs.id))
    .limit(1);
  return row ?? null;
}

/** Existing pending row for the target, or a new one. */
export async function ensurePendingRow(
  db: Db,
  workspaceId: string,
  target: { personId: string | null; companyId: string | null },
  now: Date,
): Promise<{ row: ResearchBriefRow; created: boolean }> {
  const existing = await latestBrief(db, workspaceId, target, ["pending"]);
  if (existing) return { row: existing, created: false };
  const [row] = await db
    .insert(research_briefs)
    .values({
      workspace_id: workspaceId,
      company_id: target.companyId,
      person_id: target.personId,
      status: "pending",
      created_at: now,
      updated_at: now,
    })
    .returning();
  if (!row) throw new Error("ensurePendingRow: insert returned no row");
  return { row, created: true };
}

/** Pending rows a job handles: every row of the company, or of one company-less person. */
export async function pendingRowsForScope(
  db: Db,
  workspaceId: string,
  scope: { companyId: string | null; personId: string | null },
): Promise<ResearchBriefRow[]> {
  const conditions: SQL[] = [
    eq(research_briefs.workspace_id, workspaceId),
    eq(research_briefs.status, "pending"),
  ];
  if (scope.companyId) conditions.push(eq(research_briefs.company_id, scope.companyId));
  else if (scope.personId) {
    conditions.push(eq(research_briefs.person_id, scope.personId));
    conditions.push(isNull(research_briefs.company_id));
  } else return [];
  return db
    .select()
    .from(research_briefs)
    .where(and(...conditions))
    .orderBy(research_briefs.id);
}

/** Singleton key for the job that researches a company (or a company-less person). */
export function researchJobKey(
  workspaceId: string,
  scope: { companyId: string | null; personId: string | null },
): string {
  return scope.companyId
    ? `research:${workspaceId}:co:${scope.companyId}`
    : `research:${workspaceId}:pe:${scope.personId}`;
}
