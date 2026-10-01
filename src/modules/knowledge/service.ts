/**
 * Knowledge service: the only source of claims about the user's company. Other modules call
 * these functions (binding signatures from the build plan); never read knowledge tables
 * directly from another module.
 */
import { and, asc, desc, eq } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { type KnowledgeItem, type Offer, offers } from "../../db/schema/index.js";
import { rankKnowledge } from "./search.js";

export type { CrawledPage, CrawlOptions, CrawlResult, PageCategory } from "./crawl.js";
export { crawlSite } from "./crawl.js";
export { openKnowledgeGap } from "./gaps.js";
export type { GroundingFact, GroundingGuidance, GroundingPack } from "./grounding.js";
export { buildGroundingPack, resolveOffer } from "./grounding.js";
// Lessons and the strategy page (strategy module), offer edits for its undo.
export {
  countActiveItems,
  LESSON_DEFAULT_DAYS,
  listActiveLessons,
  listRuleTitles,
} from "./lessons.js";
export { getOffer, type OfferFields, updateOffer } from "./offers.js";

/** Active offers, default first (suggested and archived offers are excluded). */
export async function listActiveOffers(ctx: OpContext): Promise<Offer[]> {
  const workspace = requireWorkspace(ctx);
  return ctx.db
    .select()
    .from(offers)
    .where(and(eq(offers.workspace_id, workspace.id), eq(offers.status, "active")))
    .orderBy(desc(offers.is_default), asc(offers.id));
}

/**
 * Active knowledge items ranked by full-text relevance: items matching every word first, then
 * items matching any word, then a substring match when the query has no searchable words.
 * Suggested and archived items are never returned, and neither are lessons: they are guidance
 * about what works, never an answer to a prospect's question (so they cannot hide a gap).
 */
export async function searchKnowledge(
  ctx: OpContext,
  query: string,
  options?: { limit?: number },
): Promise<KnowledgeItem[]> {
  const workspace = requireWorkspace(ctx);
  const ranked = await rankKnowledge(ctx.db, workspace.id, query, {
    limit: options?.limit ?? 10,
    statuses: ["active"],
    excludeKinds: ["lesson"],
    mode: "best",
  });
  return ranked.map((result) => result.item);
}
