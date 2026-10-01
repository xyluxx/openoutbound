import { sql } from "drizzle-orm";
import type { Db } from "../../../db/client.js";
import { epochMs, rows } from "../sql.js";
import { truncate } from "./hot-replies.js";

const QUESTION_MAX = 300;

/** Open knowledge gaps (questions prospects asked that the knowledge base cannot answer), oldest first. */
export async function openKnowledgeGaps(
  db: Db,
  workspaceId: string,
  maxItems: number,
): Promise<{
  total: number;
  items: Array<{
    id: string;
    question: string;
    thread_id: string | null;
    created_at: Date;
    untrusted: true;
  }>;
}> {
  const list = await rows<{
    id: string;
    question: string;
    thread_id: string | null;
    created_ms: number;
    total: number;
  }>(
    db,
    sql`select g.id, g.question, g.thread_id, ${epochMs(sql`g.created_at`)} as created_ms,
        count(*) over ()::int as total
      from knowledge_gaps g
      where g.workspace_id = ${workspaceId} and g.status = 'open'
      order by g.created_at, g.id
      limit ${maxItems}`,
  );
  return {
    total: list[0]?.total ?? 0,
    items: list.map((row) => ({
      id: row.id,
      question: truncate(row.question, QUESTION_MAX),
      thread_id: row.thread_id,
      created_at: new Date(row.created_ms),
      untrusted: true as const,
    })),
  };
}
