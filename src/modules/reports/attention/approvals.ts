import { sql } from "drizzle-orm";
import type { ApprovalKind } from "../../../core/enums.js";
import type { Db } from "../../../db/client.js";
import { round1 } from "../metric.js";
import { epochMs, rows, ts } from "../sql.js";

export interface PendingApprovals {
  total: number;
  by_kind: Array<{
    kind: ApprovalKind;
    count: number;
    oldest: Array<{
      id: string;
      title: string;
      created_at: Date;
      age_hours: number;
      target_type: string | null;
      target_id: string | null;
    }>;
  }>;
}

/** Pending, unexpired approvals by kind with the oldest items of each kind (one query). */
export async function pendingApprovals(
  db: Db,
  workspaceId: string,
  now: Date,
  maxItems: number,
): Promise<PendingApprovals> {
  const list = await rows<{
    id: string;
    kind: ApprovalKind;
    title: string;
    target_type: string | null;
    target_id: string | null;
    created_ms: number;
    kind_count: number;
  }>(
    db,
    sql`select id, kind, title, target_type, target_id, created_ms, kind_count from (
        select a.id, a.kind, a.title, a.target_type, a.target_id,
          ${epochMs(sql`a.created_at`)} as created_ms,
          count(*) over (partition by a.kind)::int as kind_count,
          row_number() over (partition by a.kind order by a.created_at, a.id) as position
        from approvals a
        where a.workspace_id = ${workspaceId} and a.status = 'pending'
          and (a.expires_at is null or a.expires_at > ${ts(now)})
      ) ranked
      where position <= ${maxItems}
      order by kind_count desc, kind, created_ms`,
  );
  const byKind = new Map<ApprovalKind, PendingApprovals["by_kind"][number]>();
  for (const row of list) {
    const entry = byKind.get(row.kind) ?? { kind: row.kind, count: row.kind_count, oldest: [] };
    entry.oldest.push({
      id: row.id,
      title: row.title,
      created_at: new Date(row.created_ms),
      age_hours: round1((now.getTime() - row.created_ms) / 3_600_000),
      target_type: row.target_type,
      target_id: row.target_id,
    });
    byKind.set(row.kind, entry);
  }
  const groups = [...byKind.values()];
  return { total: groups.reduce((sum, group) => sum + group.count, 0), by_kind: groups };
}
