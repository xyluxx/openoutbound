import { sql } from "drizzle-orm";
import type { TaskType } from "../../../core/enums.js";
import type { Db } from "../../../db/client.js";
import { round1 } from "../metric.js";
import { epochMs, rows, ts } from "../sql.js";
import { truncate } from "./hot-replies.js";
import type { AttentionOutput } from "./schema.js";

/** Tasks listed in the queue; the total covers all of them. */
export const TASKS_LISTED = 10;
const TITLE_MAX = 200;

/** Open tasks due now or overdue, the longest overdue first. */
export async function tasksDue(
  db: Db,
  workspaceId: string,
  now: Date,
): Promise<AttentionOutput["tasks_due"]> {
  const list = await rows<{
    id: string;
    type: TaskType;
    title: string;
    person_id: string | null;
    campaign_id: string | null;
    due_ms: number;
    full_name: string | null;
    first_name: string | null;
    last_name: string | null;
    total: number;
  }>(
    db,
    sql`select t.id, t.type, t.title, t.person_id, t.campaign_id,
        ${epochMs(sql`t.due_at`)} as due_ms, p.full_name, p.first_name, p.last_name,
        count(*) over ()::int as total
      from tasks t
      left join people p on p.id = t.person_id
      where t.workspace_id = ${workspaceId} and t.status = 'open' and t.due_at <= ${ts(now)}
      order by t.due_at, t.id
      limit ${TASKS_LISTED}`,
  );
  return {
    total: list[0]?.total ?? 0,
    items: list.map((row) => ({
      id: row.id,
      type: row.type,
      title: truncate(row.title, TITLE_MAX),
      person_id: row.person_id,
      person_name:
        row.full_name?.trim() ||
        [row.first_name, row.last_name].filter(Boolean).join(" ").trim() ||
        null,
      campaign_id: row.campaign_id,
      due_at: new Date(row.due_ms),
      overdue_hours: Math.max(0, round1((now.getTime() - row.due_ms) / 3_600_000)),
    })),
  };
}
