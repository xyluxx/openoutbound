/**
 * Knowledge item storage: create (deduped), update, archive or delete, and replace-in-place
 * writes for ingested sources so re-ingesting a URL or file never duplicates items. Every write
 * that leaves a lesson without an expiry gives it the default lifetime (LESSON_DEFAULT_DAYS).
 */
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { actorRef, type OpContext, requireWorkspace } from "../../core/context.js";
import type { KnowledgeKind, KnowledgeSourceType, KnowledgeStatus } from "../../core/enums.js";
import { notFound, OpenOutboundError } from "../../core/errors.js";
import type { Db } from "../../db/client.js";
import { type KnowledgeItem, knowledge_items, offers } from "../../db/schema/index.js";
import { offerSnapshot, recordChange } from "../strategy/service.js";
import type { ItemDraft } from "./chunk.js";
import { lessonExpiry } from "./lessons.js";
import { cleanTitle } from "./text.js";

export const MAX_BODY_CHARS = 20_000;

export interface NewItemInput {
  kind: KnowledgeKind;
  title: string;
  body: string;
  status?: KnowledgeStatus;
  sourceType?: KnowledgeSourceType;
  sourceRef?: string | null;
  tags?: string[];
  /** Lessons: when the item stops guiding writing (default LESSON_DEFAULT_DAYS from now). */
  expiresAt?: Date | null;
  /** Lessons: how many sends, replies or meetings the lesson is based on. */
  sampleSize?: number | null;
}

export async function getItem(ctx: OpContext, itemId: string): Promise<KnowledgeItem> {
  const workspace = requireWorkspace(ctx);
  const [item] = await ctx.db
    .select()
    .from(knowledge_items)
    .where(and(eq(knowledge_items.workspace_id, workspace.id), eq(knowledge_items.id, itemId)));
  if (!item) throw notFound("Knowledge item", itemId);
  return item;
}

/**
 * Creates an item unless an identical one (same kind, title and body, not archived) exists;
 * then returns that one with `created: false`.
 */
export async function createItem(
  ctx: OpContext,
  input: NewItemInput,
): Promise<{ item: KnowledgeItem; created: boolean }> {
  const workspace = requireWorkspace(ctx);
  const title = cleanTitle(input.title);
  const body = checkBody(input.body);
  const [existing] = await ctx.db
    .select()
    .from(knowledge_items)
    .where(
      and(
        eq(knowledge_items.workspace_id, workspace.id),
        eq(knowledge_items.kind, input.kind),
        eq(knowledge_items.title, title),
        eq(knowledge_items.body, body),
        ne(knowledge_items.status, "archived"),
      ),
    )
    .limit(1);
  if (existing) return { item: existing, created: false };
  const [item] = await ctx.db
    .insert(knowledge_items)
    .values({
      workspace_id: workspace.id,
      kind: input.kind,
      title,
      body,
      status: input.status ?? "active",
      source_type: input.sourceType ?? "manual",
      source_ref: input.sourceRef ?? null,
      tags: dedupeTags(input.tags ?? []),
      expires_at: input.expiresAt ?? defaultExpiry(ctx, input.kind),
      sample_size: input.sampleSize ?? null,
      created_by: actorRef(ctx.principal),
    })
    .returning();
  if (!item) throw new Error("createItem: insert returned no row");
  return { item, created: true };
}

export interface ItemPatch {
  kind?: KnowledgeKind;
  title?: string;
  body?: string;
  status?: KnowledgeStatus;
  tags?: string[];
  source_ref?: string | null;
  expires_at?: Date | null;
  sample_size?: number | null;
}

export async function updateItem(
  ctx: OpContext,
  itemId: string,
  patch: ItemPatch,
): Promise<KnowledgeItem> {
  const existing = await getItem(ctx, itemId);
  const set: Partial<KnowledgeItem> = {};
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (patch.title !== undefined) set.title = cleanTitle(patch.title);
  if (patch.body !== undefined) set.body = checkBody(patch.body);
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.tags !== undefined) set.tags = dedupeTags(patch.tags);
  if (patch.source_ref !== undefined) set.source_ref = patch.source_ref;
  if (patch.expires_at !== undefined) set.expires_at = patch.expires_at;
  if (patch.sample_size !== undefined) set.sample_size = patch.sample_size;
  if (Object.keys(set).length === 0) return existing;
  const expiresAt = set.expires_at !== undefined ? set.expires_at : existing.expires_at;
  if (!expiresAt) {
    const fallback = defaultExpiry(ctx, set.kind ?? existing.kind);
    if (fallback) set.expires_at = fallback;
  }
  const [item] = await ctx.db
    .update(knowledge_items)
    .set(set)
    .where(eq(knowledge_items.id, existing.id))
    .returning();
  if (!item) throw notFound("Knowledge item", itemId);
  return item;
}

/**
 * Archives an item (default) or deletes it for good (`permanent`), removing it from offers'
 * proof lists first so no offer points at a missing item.
 */
export async function removeItem(
  ctx: OpContext,
  itemId: string,
  options: { permanent?: boolean } = {},
): Promise<{ id: string; status: "archived" | "deleted" }> {
  const workspace = requireWorkspace(ctx);
  const item = await getItem(ctx, itemId);
  if (!options.permanent) {
    if (item.status !== "archived") {
      await ctx.db
        .update(knowledge_items)
        .set({ status: "archived" })
        .where(eq(knowledge_items.id, item.id));
    }
    return { id: item.id, status: "archived" };
  }
  const citing = and(
    eq(offers.workspace_id, workspace.id),
    sql`${item.id} = any(${offers.proof_item_ids})`,
  );
  const touched = await ctx.db.transaction(async (tx) => {
    const before = await tx.select().from(offers).where(citing);
    const after = await tx
      .update(offers)
      .set({ proof_item_ids: sql`array_remove(${offers.proof_item_ids}, ${item.id})` })
      .where(citing)
      .returning();
    await tx.delete(knowledge_items).where(eq(knowledge_items.id, item.id));
    return { before, after };
  });
  // Offers that cited the item lose it as proof: an update of their proof ids, recorded as such
  // (the offer itself stays).
  for (const offer of touched.after) {
    const previous = touched.before.find((row) => row.id === offer.id);
    if (!previous) continue;
    await recordChange(ctx, {
      area: "offer",
      targetId: offer.id,
      operation: "offers.update",
      before: offerSnapshot(previous),
      after: offerSnapshot(offer),
    });
  }
  return { id: item.id, status: "deleted" };
}

export interface SourceWriteResult {
  items: KnowledgeItem[];
  created: number;
  updated: number;
  unchanged: number;
  archived: number;
}

/**
 * Writes the drafts of one source (URL, file, named text) replacing its previous items in
 * place: existing items of the same source are updated in order (ids stay stable), extra
 * drafts are inserted and leftover old items archived. Without a source ref, drafts are
 * inserted with identical-item dedupe.
 */
export async function writeSourceItems(
  ctx: OpContext,
  input: {
    drafts: ItemDraft[];
    kind: KnowledgeKind;
    status: KnowledgeStatus;
    sourceType: KnowledgeSourceType;
    sourceRef: string | null;
    tags: string[];
  },
): Promise<SourceWriteResult> {
  const workspace = requireWorkspace(ctx);
  const result: SourceWriteResult = {
    items: [],
    created: 0,
    updated: 0,
    unchanged: 0,
    archived: 0,
  };
  const drafts = input.drafts.filter((draft) => draft.body.trim().length > 0);

  if (!input.sourceRef) {
    for (const draft of drafts) {
      const { item, created } = await createItem(ctx, {
        kind: input.kind,
        title: draft.title,
        body: draft.body,
        status: input.status,
        sourceType: input.sourceType,
        tags: input.tags,
      });
      result.items.push(item);
      if (created) result.created++;
      else result.unchanged++;
    }
    return result;
  }

  const sourceRef = input.sourceRef;
  await ctx.db.transaction(async (tx) => {
    const previous = await sourceItems(tx, workspace.id, input.sourceType, sourceRef);
    for (const [index, draft] of drafts.entries()) {
      const title = cleanTitle(draft.title);
      const body = checkBody(draft.body);
      const old = previous[index];
      if (old) {
        const expiry = old.expires_at ? null : defaultExpiry(ctx, input.kind);
        if (old.title === title && old.body === body && old.kind === input.kind && !expiry) {
          result.items.push(old);
          result.unchanged++;
          continue;
        }
        const [item] = await tx
          .update(knowledge_items)
          .set({
            title,
            body,
            kind: input.kind,
            tags: dedupeTags([...old.tags, ...input.tags]),
            ...(expiry ? { expires_at: expiry } : {}),
          })
          .where(eq(knowledge_items.id, old.id))
          .returning();
        if (item) result.items.push(item);
        result.updated++;
        continue;
      }
      const [item] = await tx
        .insert(knowledge_items)
        .values({
          workspace_id: workspace.id,
          kind: input.kind,
          title,
          body,
          status: input.status,
          source_type: input.sourceType,
          source_ref: sourceRef,
          tags: dedupeTags(input.tags),
          expires_at: defaultExpiry(ctx, input.kind),
          created_by: actorRef(ctx.principal),
        })
        .returning();
      if (item) result.items.push(item);
      result.created++;
    }
    const leftovers = previous.slice(drafts.length).map((item) => item.id);
    if (leftovers.length > 0) {
      await tx
        .update(knowledge_items)
        .set({ status: "archived" })
        .where(inArray(knowledge_items.id, leftovers));
      result.archived = leftovers.length;
    }
  });
  return result;
}

/** The expiry a lesson written now gets when none is given; null for other kinds. */
function defaultExpiry(ctx: OpContext, kind: KnowledgeKind): Date | null {
  return kind === "lesson" ? lessonExpiry(ctx.clock.now()) : null;
}

async function sourceItems(
  db: Db,
  workspaceId: string,
  sourceType: KnowledgeSourceType,
  sourceRef: string,
): Promise<KnowledgeItem[]> {
  return db
    .select()
    .from(knowledge_items)
    .where(
      and(
        eq(knowledge_items.workspace_id, workspaceId),
        eq(knowledge_items.source_type, sourceType),
        eq(knowledge_items.source_ref, sourceRef),
        ne(knowledge_items.status, "archived"),
      ),
    )
    .orderBy(asc(knowledge_items.id));
}

function checkBody(body: string): string {
  const clean = body.replace(/\r\n?/g, "\n").trim();
  if (clean.length > MAX_BODY_CHARS) {
    throw new OpenOutboundError(
      "validation_failed",
      `The body is ${clean.length} characters; items hold at most ${MAX_BODY_CHARS}.`,
      {
        hint: "Split it into several items, or use manage_knowledge action ingest (format markdown or text), which chunks long content.",
      },
    );
  }
  return clean;
}

export function dedupeTags(tags: string[]): string[] {
  const out: string[] = [];
  for (const tag of tags) {
    const clean = tag.trim().toLowerCase();
    if (clean && !out.includes(clean)) out.push(clean);
  }
  return out;
}
