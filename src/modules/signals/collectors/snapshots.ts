/**
 * page_snapshots access for collectors: one row per (workspace, url) holding the current and
 * previous normalized text. Collectors also keep small JSON state here under internal
 * `openoutbound://` URLs (seen job ids, feed items, detected technologies).
 */
import { and, eq } from "drizzle-orm";
import type { OpContext } from "../../../core/context.js";
import { type PageSnapshot, page_snapshots } from "../../../db/schema/index.js";
import { sha256 } from "./pages.js";

export async function readSnapshot(
  ctx: OpContext,
  workspaceId: string,
  url: string,
): Promise<PageSnapshot | null> {
  const [row] = await ctx.db
    .select()
    .from(page_snapshots)
    .where(and(eq(page_snapshots.workspace_id, workspaceId), eq(page_snapshots.url, url)));
  return row ?? null;
}

/**
 * Stores `text` as the current content. When the hash differs from `previous`, the old text
 * moves to prev_text and changed_at is set. Returns true when the content changed.
 */
export async function writeSnapshot(
  ctx: OpContext,
  input: {
    workspaceId: string;
    companyId: string | null;
    url: string;
    text: string;
    previous: PageSnapshot | null;
  },
): Promise<boolean> {
  const now = ctx.clock.now();
  const hash = sha256(input.text);
  const { previous } = input;
  if (!previous) {
    await ctx.db
      .insert(page_snapshots)
      .values({
        workspace_id: input.workspaceId,
        company_id: input.companyId,
        url: input.url,
        content_hash: hash,
        text: input.text,
        fetched_at: now,
      })
      .onConflictDoUpdate({
        target: [page_snapshots.workspace_id, page_snapshots.url],
        set: { content_hash: hash, text: input.text, fetched_at: now },
      });
    return false;
  }
  if (previous.content_hash === hash) {
    await ctx.db
      .update(page_snapshots)
      .set({ fetched_at: now })
      .where(eq(page_snapshots.id, previous.id));
    return false;
  }
  await ctx.db
    .update(page_snapshots)
    .set({
      content_hash: hash,
      text: input.text,
      prev_hash: previous.content_hash,
      prev_text: previous.text,
      fetched_at: now,
      changed_at: now,
      company_id: input.companyId ?? previous.company_id,
    })
    .where(eq(page_snapshots.id, previous.id));
  return true;
}

/** Parses JSON state kept in a snapshot's text; null when absent or malformed. */
export function snapshotState<T>(snapshot: PageSnapshot | null): T | null {
  if (!snapshot) return null;
  try {
    return JSON.parse(snapshot.text) as T;
  } catch {
    return null;
  }
}
