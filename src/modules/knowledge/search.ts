/**
 * Full-text search over knowledge items: the generated `search` tsvector ('simple' config,
 * title weighted A, body B) queried with `websearch_to_tsquery` and ranked with `ts_rank`.
 * Queries without lexemes (only punctuation or operators) fall back to ILIKE.
 */
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  ilike,
  inArray,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { KnowledgeKind, KnowledgeStatus } from "../../core/enums.js";
import { type Db, queryRows } from "../../db/client.js";
import { type KnowledgeItem, knowledge_items } from "../../db/schema/index.js";

export interface KnowledgeSearchOptions {
  limit?: number;
  kinds?: KnowledgeKind[];
  excludeKinds?: KnowledgeKind[];
  /** Default ["active"]: suggested and archived items never reach prompts. */
  statuses?: KnowledgeStatus[];
  excludeIds?: string[];
  /**
   * `all` = every word must match (websearch syntax: quotes, OR, -word); `any` = rank items
   * matching any word; `best` (default) = `all` first, topped up with `any` matches.
   */
  mode?: "all" | "any" | "best";
}

export interface RankedKnowledgeItem {
  item: KnowledgeItem;
  /** ts_rank score (higher is better); ILIKE fallback matches get 0.01 to 0.02. */
  rank: number;
  match: "fulltext" | "any_word" | "substring";
}

const { search: _searchColumn, ...itemColumns } = getTableColumns(knowledge_items);

/** Knowledge items of one workspace ranked by relevance to `query`. */
export async function rankKnowledge(
  db: Db,
  workspaceId: string,
  query: string,
  options: KnowledgeSearchOptions = {},
): Promise<RankedKnowledgeItem[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 10, 200));
  const text = query.trim().slice(0, 500);
  if (!text) return [];
  const mode = options.mode ?? "best";

  const hasLexemes = await queryHasLexemes(db, text);
  if (!hasLexemes) return substringSearch(db, workspaceId, text, options, limit);

  const results: RankedKnowledgeItem[] = [];
  if (mode === "all" || mode === "best") {
    results.push(...(await fullTextSearch(db, workspaceId, text, options, limit, "all")));
  }
  if (mode === "any" || (mode === "best" && results.length < limit)) {
    const seen = new Set([...(options.excludeIds ?? []), ...results.map((r) => r.item.id)]);
    const more = await fullTextSearch(
      db,
      workspaceId,
      text,
      { ...options, excludeIds: [...seen] },
      limit - results.length,
      "any",
    );
    results.push(...more);
  }
  if (results.length === 0) return substringSearch(db, workspaceId, text, options, limit);
  return results;
}

async function queryHasLexemes(db: Db, text: string): Promise<boolean> {
  const [row] = await queryRows<{ n: number | string }>(
    db,
    sql`select numnode(websearch_to_tsquery('simple', ${text})) as n`,
  );
  return Number(row?.n ?? 0) > 0;
}

function baseConditions(workspaceId: string, options: KnowledgeSearchOptions): SQL[] {
  const conditions: SQL[] = [
    eq(knowledge_items.workspace_id, workspaceId),
    inArray(knowledge_items.status, options.statuses ?? ["active"]),
  ];
  if (options.kinds && options.kinds.length > 0) {
    conditions.push(inArray(knowledge_items.kind, options.kinds));
  }
  if (options.excludeKinds && options.excludeKinds.length > 0) {
    conditions.push(notInArray(knowledge_items.kind, options.excludeKinds));
  }
  if (options.excludeIds && options.excludeIds.length > 0) {
    conditions.push(notInArray(knowledge_items.id, options.excludeIds));
  }
  return conditions;
}

async function fullTextSearch(
  db: Db,
  workspaceId: string,
  text: string,
  options: KnowledgeSearchOptions,
  limit: number,
  mode: "all" | "any",
): Promise<RankedKnowledgeItem[]> {
  if (limit <= 0) return [];
  const tsquery =
    mode === "all"
      ? sql`websearch_to_tsquery('simple', ${text})`
      : sql`replace(websearch_to_tsquery('simple', ${text})::text, ' & ', ' | ')::tsquery`;
  const rank = sql<number>`ts_rank(${knowledge_items.search}, ${tsquery})`;
  const rows = await db
    .select({ ...itemColumns, rank })
    .from(knowledge_items)
    .where(
      and(...baseConditions(workspaceId, options), sql`${knowledge_items.search} @@ ${tsquery}`),
    )
    .orderBy(desc(rank), asc(knowledge_items.id))
    .limit(limit);
  return rows.map(({ rank: score, ...item }) => ({
    item: { ...item, search: null },
    rank: Number(score),
    match: mode === "all" ? "fulltext" : "any_word",
  }));
}

/** ILIKE fallback: every whitespace-separated term must appear in the title or body. */
async function substringSearch(
  db: Db,
  workspaceId: string,
  text: string,
  options: KnowledgeSearchOptions,
  limit: number,
): Promise<RankedKnowledgeItem[]> {
  const terms = text.split(/\s+/).filter(Boolean).slice(0, 8);
  const termConditions = terms.map((term) => {
    const pattern = `%${escapeLike(term)}%`;
    return or(ilike(knowledge_items.title, pattern), ilike(knowledge_items.body, pattern)) as SQL;
  });
  const titleHit = sql<number>`case when ${knowledge_items.title} ilike ${`%${escapeLike(text)}%`} then 0.02 else 0.01 end`;
  const rows = await db
    .select({ ...itemColumns, rank: titleHit })
    .from(knowledge_items)
    .where(and(...baseConditions(workspaceId, options), ...termConditions))
    .orderBy(desc(titleHit), desc(knowledge_items.updated_at), asc(knowledge_items.id))
    .limit(limit);
  return rows.map(({ rank: score, ...item }) => ({
    item: { ...item, search: null },
    rank: Number(score),
    match: "substring",
  }));
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
