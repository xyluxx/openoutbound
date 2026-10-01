import { OpenOutboundError } from "./errors.js";

/**
 * Opaque cursor helpers for list operations. A cursor is base64url JSON of whatever the query
 * needs to resume (usually the last row's sort key and id).
 *
 * Typical handler: fetch `limit + 1` rows ordered by (sort key, id), then `toPage(rows, limit,
 * (row) => ({ id: row.id }))`.
 */
export function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** Decodes a cursor; throws `validation_failed` when it was not produced by `encodeCursor`. */
export function decodeCursor<T extends Record<string, unknown>>(cursor: string): T {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as T;
  } catch {
    // fall through
  }
  throw new OpenOutboundError("validation_failed", "Invalid cursor.", {
    hint: "Pass next_cursor exactly as returned by the previous page, or omit it to start over.",
  });
}

/** Builds `{ items, next_cursor, has_more }` from `limit + 1` fetched rows. */
export function toPage<T, R = T>(
  rows: T[],
  limit: number,
  cursorOf: (row: T) => Record<string, unknown>,
  map?: (row: T) => R,
): { items: R[]; next_cursor: string | null; has_more: boolean } {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  return {
    items: map ? pageRows.map(map) : (pageRows as unknown as R[]),
    next_cursor: hasMore && last !== undefined ? encodeCursor(cursorOf(last)) : null,
    has_more: hasMore,
  };
}
