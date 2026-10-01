import { sql } from "drizzle-orm";
import type { OpContext } from "../../../core/context.js";
import { PROBLEM_SEVERITIES, type ProblemSeverity } from "../../../core/enums.js";
import type { Workspace } from "../../../db/schema/index.js";
import { listProblems } from "../../problems/service.js";
import { rows, ts } from "../sql.js";
import type { AttentionOutput, Severity } from "./schema.js";

/** Problems listed in the queue; the counts cover all open ones. */
export const PROBLEMS_LISTED = 20;

/** Problem severities on the queue's three-level scale. */
export const DISPLAY_SEVERITY: Record<ProblemSeverity, Severity> = {
  urgent: "critical",
  high: "critical",
  normal: "warning",
  low: "info",
};

/**
 * Open problems (a snoozed one whose time passed counts as open) in the problems service's
 * order: most severe first, then soonest due, then oldest.
 */
export async function openProblems(
  ctx: OpContext,
  workspace: Workspace,
  now: Date,
): Promise<AttentionOutput["problems"]> {
  const [counts, page] = await Promise.all([
    rows<{ severity: ProblemSeverity; n: number }>(
      ctx.db,
      sql`select severity, count(*)::int as n from problems
        where workspace_id = ${workspace.id}
          and (status = 'open' or (status = 'snoozed' and snoozed_until <= ${ts(now)}))
        group by severity`,
    ),
    listProblems({ ...ctx, workspace }, { limit: PROBLEMS_LISTED }),
  ]);
  const bySeverity = Object.fromEntries(PROBLEM_SEVERITIES.map((key) => [key, 0])) as Record<
    ProblemSeverity,
    number
  >;
  for (const row of counts) bySeverity[row.severity] = row.n;
  return {
    total: Object.values(bySeverity).reduce((sum, value) => sum + value, 0),
    by_severity: bySeverity,
    items: page.items.map((row) => ({
      id: row.id,
      kind: row.kind,
      severity: row.severity,
      display_severity: DISPLAY_SEVERITY[row.severity],
      owner: row.owner,
      title: row.title,
      reason: row.reason,
      remedy: row.remedy,
      due_at: row.due_at,
      person_id: row.person_id,
    })),
  };
}
