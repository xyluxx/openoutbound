/**
 * Knowledge gaps: questions prospects asked that the knowledge base cannot answer. Open gaps
 * are deduped by normalized question; answering one creates an active `faq` item.
 */
import { and, desc, eq } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { invalid, notFound } from "../../core/errors.js";
import {
  type KnowledgeGap,
  type KnowledgeItem,
  knowledge_gaps,
  knowledge_items,
} from "../../db/schema/index.js";
import { cleanTitle, normalizeKey } from "./text.js";

/** How many recent open gaps are compared when deduping. */
const DEDUPE_WINDOW = 1_000;
const MAX_QUESTION_CHARS = 2_000;

/** Opens (or returns the existing open) gap for a question the knowledge base cannot answer. */
export async function openKnowledgeGap(
  ctx: OpContext,
  input: { question: string; context?: string; threadId?: string },
): Promise<{ id: string }> {
  const workspace = requireWorkspace(ctx);
  const question = input.question.replace(/\s+/g, " ").trim().slice(0, MAX_QUESTION_CHARS);
  const key = normalizeKey(question);
  if (!key) throw invalid("The question is empty.");

  const open = await ctx.db
    .select({
      id: knowledge_gaps.id,
      question: knowledge_gaps.question,
      context: knowledge_gaps.context,
      thread_id: knowledge_gaps.thread_id,
    })
    .from(knowledge_gaps)
    .where(and(eq(knowledge_gaps.workspace_id, workspace.id), eq(knowledge_gaps.status, "open")))
    .orderBy(desc(knowledge_gaps.id))
    .limit(DEDUPE_WINDOW);
  const existing = open.find((gap) => normalizeKey(gap.question) === key);
  if (existing) {
    const patch: Partial<Pick<KnowledgeGap, "context" | "thread_id">> = {};
    if (!existing.context && input.context) patch.context = input.context;
    if (!existing.thread_id && input.threadId) patch.thread_id = input.threadId;
    if (Object.keys(patch).length > 0) {
      await ctx.db.update(knowledge_gaps).set(patch).where(eq(knowledge_gaps.id, existing.id));
    }
    return { id: existing.id };
  }

  const [gap] = await ctx.db
    .insert(knowledge_gaps)
    .values({
      workspace_id: workspace.id,
      question,
      context: input.context ?? null,
      thread_id: input.threadId ?? null,
      status: "open",
    })
    .returning();
  if (!gap) throw new Error("openKnowledgeGap: insert returned no row");
  await ctx.events.emit("knowledge.gap_opened", {
    subject: { type: "knowledge_gap", id: gap.id },
    data: { gap_id: gap.id, question: gap.question, thread_id: gap.thread_id },
  });
  return { id: gap.id };
}

export async function getGap(ctx: OpContext, gapId: string): Promise<KnowledgeGap> {
  const workspace = requireWorkspace(ctx);
  const [gap] = await ctx.db
    .select()
    .from(knowledge_gaps)
    .where(and(eq(knowledge_gaps.workspace_id, workspace.id), eq(knowledge_gaps.id, gapId)));
  if (!gap) throw notFound("Knowledge gap", gapId);
  return gap;
}

/**
 * Answers a gap: creates (or, for an already answered gap, updates) an active `faq` item with
 * the question as title and marks the gap answered. Idempotent for the same answer.
 */
export async function answerGap(
  ctx: OpContext,
  input: { gapId: string; answer: string; title?: string },
): Promise<{ gap: KnowledgeGap; item: KnowledgeItem; created: boolean }> {
  const workspace = requireWorkspace(ctx);
  const gap = await getGap(ctx, input.gapId);
  const answer = input.answer.trim();
  if (!answer) throw invalid("The answer is empty.");
  const title = cleanTitle(input.title ?? gap.question);
  const now = ctx.clock.now();

  return ctx.db.transaction(async (tx) => {
    let item: KnowledgeItem | undefined;
    let created = false;
    if (gap.answer_item_id) {
      [item] = await tx
        .update(knowledge_items)
        .set({ title, body: answer, status: "active" })
        .where(
          and(
            eq(knowledge_items.workspace_id, workspace.id),
            eq(knowledge_items.id, gap.answer_item_id),
          ),
        )
        .returning();
    }
    if (!item) {
      [item] = await tx
        .insert(knowledge_items)
        .values({
          workspace_id: workspace.id,
          kind: "faq",
          title,
          body: answer,
          status: "active",
          source_type: "reply",
          source_ref: gap.id,
        })
        .returning();
      created = true;
    }
    if (!item) throw new Error("answerGap: item write returned no row");
    const [updated] = await tx
      .update(knowledge_gaps)
      .set({ status: "answered", answer_item_id: item.id, answered_at: gap.answered_at ?? now })
      .where(eq(knowledge_gaps.id, gap.id))
      .returning();
    if (!updated) throw notFound("Knowledge gap", gap.id);
    return { gap: updated, item, created };
  });
}

export async function dismissGap(ctx: OpContext, gapId: string): Promise<KnowledgeGap> {
  const gap = await getGap(ctx, gapId);
  if (gap.status === "dismissed") return gap;
  if (gap.status === "answered") {
    throw invalid(`Gap ${gapId} is already answered.`, { status: gap.status });
  }
  const [updated] = await ctx.db
    .update(knowledge_gaps)
    .set({ status: "dismissed" })
    .where(eq(knowledge_gaps.id, gap.id))
    .returning();
  if (!updated) throw notFound("Knowledge gap", gapId);
  return updated;
}
