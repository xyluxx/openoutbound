/**
 * Grounding pack: everything a writing prompt may claim about the user's company, trimmed to
 * a character budget. Priority: rules (always, all of them), the offer, its proof items, facts
 * ranked for the query, then up to 3 voice samples. Lessons stay out of the facts: they come
 * as a separate guidance list (`guidanceText`) that only writers get, never checkers.
 */
import { and, asc, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import type { KnowledgeKind } from "../../core/enums.js";
import { OpenOutboundError } from "../../core/errors.js";
import { parseWorkspaceSettings } from "../../core/settings.js";
import { type KnowledgeItem, knowledge_items, type Offer, offers } from "../../db/schema/index.js";
import { rankKnowledge } from "./search.js";

export interface GroundingFact {
  id: string;
  kind: string;
  title: string;
  body: string;
}

/** A lesson: what worked for this client before. Guidance for writers, never a fact to state. */
export interface GroundingGuidance {
  id: string;
  title: string;
  body: string;
}

/** Everything a writing prompt may claim about us, already trimmed to a character budget. */
export interface GroundingPack {
  company: { name: string | null; website: string | null };
  offer: Offer | null;
  /** Hard rules (never say, never promise). Always included. */
  rules: string[];
  facts: GroundingFact[];
  voiceSamples: string[];
  /** Rendered block with section headers, ready to embed in prompts. */
  text: string;
  /** Active lessons (at most 5, newest first). Not part of `text` or `facts`. */
  guidance?: GroundingGuidance[];
  /**
   * The guidance rendered as "Guidance from past results (not facts to state)", or "". Give it
   * to writers only: checkers and evidence checks must keep using `text` alone.
   */
  guidanceText?: string;
}

export const DEFAULT_GROUNDING_MAX_CHARS = 6_000;
const MAX_VOICE_SAMPLES = 3;
const MAX_FACT_CANDIDATES = 24;
/** Budget share kept free for voice samples while facts are added. */
const VOICE_RESERVE_SHARE = 0.2;
/** Facts are cut to fit only when at least this much room is left. */
const MIN_TRUNCATED_FACT_CHARS = 200;

/** Kinds used as facts, in the order they fill the pack when there is no query. */
const FACT_KIND_PRIORITY: KnowledgeKind[] = [
  "about",
  "product",
  "offer_detail",
  "proof",
  "case_study",
  "faq",
  "objection",
  "persona",
  "competitor",
  "other",
];
/** Lessons are guidance about what works, never facts the writer may state. */
const NON_FACT_KINDS: KnowledgeKind[] = ["rule", "voice_sample", "lesson"];
const MAX_GUIDANCE = 5;
const GUIDANCE_BODY_CHARS = 300;
export const GUIDANCE_HEADER = "Guidance from past results (not facts to state)";

/** Picks the offer: explicit id (must be active), else the default, else the only active offer. */
export async function resolveOffer(
  ctx: OpContext,
  offerId: string | null | undefined,
): Promise<Offer | null> {
  const workspace = requireWorkspace(ctx);
  if (offerId) {
    const [offer] = await ctx.db
      .select()
      .from(offers)
      .where(and(eq(offers.workspace_id, workspace.id), eq(offers.id, offerId)));
    if (!offer) {
      throw new OpenOutboundError("not_found", `Offer ${offerId} not found.`, {
        hint: "List offers with manage_knowledge action list_offers and pass an active offer id.",
        details: { what: "Offer", id: offerId },
      });
    }
    if (offer.status !== "active") {
      throw new OpenOutboundError(
        "validation_failed",
        `Offer ${offerId} is not active (${offer.suggested ? "suggested" : offer.status}).`,
        {
          hint: offer.suggested
            ? "Approve it first with manage_knowledge action approve_suggestions (offer_ids)."
            : "Reactivate it with manage_knowledge action update_offer (status active) or pick another offer.",
        },
      );
    }
    return offer;
  }
  const active = await ctx.db
    .select()
    .from(offers)
    .where(and(eq(offers.workspace_id, workspace.id), eq(offers.status, "active")))
    .orderBy(desc(offers.is_default), desc(offers.updated_at), asc(offers.id))
    .limit(2);
  const [first, second] = active;
  if (!first) return null;
  if (first.is_default || !second) return first;
  return null;
}

/**
 * Builds the grounding pack (binding signature, see service.ts). `bookingLink: false` leaves the
 * offer's booking link out of the text (reply drafts when booking.mode is not link); the offer
 * itself keeps it.
 */
export async function buildGroundingPack(
  ctx: OpContext,
  options: { offerId?: string | null; query?: string; maxChars?: number; bookingLink?: boolean },
): Promise<GroundingPack> {
  const workspace = requireWorkspace(ctx);
  const settings = parseWorkspaceSettings(workspace.settings);
  const maxChars = Math.max(500, options.maxChars ?? DEFAULT_GROUNDING_MAX_CHARS);
  const render = { bookingLink: options.bookingLink !== false };
  const company = {
    name: settings.company.name.trim() || null,
    website: settings.company.website.trim() || null,
  };

  const [offer, ruleItems, voiceItems, lessonItems] = await Promise.all([
    resolveOffer(ctx, options.offerId),
    activeItemsOfKind(ctx, workspace.id, "rule"),
    activeItemsOfKind(ctx, workspace.id, "voice_sample", MAX_VOICE_SAMPLES),
    activeLessons(ctx, workspace.id),
  ]);
  const rules = ruleItems.map(ruleText).filter(Boolean);

  const candidates = await factCandidates(ctx, workspace.id, offer, options.query);
  const voiceCandidates = voiceItems.map((item) => item.body.trim() || item.title).filter(Boolean);

  const pack: Omit<GroundingPack, "text"> = { company, offer, rules, facts: [], voiceSamples: [] };
  const voiceCost = voiceCandidates.reduce((sum, sample) => sum + sample.length + 8, 0);
  const reserve =
    voiceCandidates.length === 0
      ? 0
      : Math.min(voiceCost + 60, Math.floor(maxChars * VOICE_RESERVE_SHARE));

  // Rules and the offer are always in; facts fill the budget in priority order (a fact that
  // does not fit is cut when enough room is left, else skipped for a smaller one).
  for (const candidate of candidates) {
    const next = [...pack.facts, candidate];
    const length = renderPack({ ...pack, facts: next }, render).length + reserve;
    if (length <= maxChars) {
      pack.facts = next;
      continue;
    }
    const bodyRoom = candidate.body.length - (length - maxChars) - 3;
    if (bodyRoom >= MIN_TRUNCATED_FACT_CHARS) {
      pack.facts = [
        ...pack.facts,
        { ...candidate, body: `${candidate.body.slice(0, bodyRoom).trimEnd()}...` },
      ];
      break;
    }
  }
  for (const sample of voiceCandidates) {
    const next = [...pack.voiceSamples, sample];
    if (renderPack({ ...pack, voiceSamples: next }, render).length > maxChars) break;
    pack.voiceSamples = next;
  }
  const guidance = lessonItems.map((item) => ({
    id: item.id,
    title: item.title.trim(),
    body: clip(item.body.trim(), GUIDANCE_BODY_CHARS),
  }));
  return {
    ...pack,
    text: renderPack(pack, render),
    guidance,
    guidanceText: renderGuidance(guidance),
  };
}

/** Active lessons that have not expired, newest first. */
async function activeLessons(ctx: OpContext, workspaceId: string): Promise<KnowledgeItem[]> {
  return ctx.db
    .select()
    .from(knowledge_items)
    .where(
      and(
        eq(knowledge_items.workspace_id, workspaceId),
        eq(knowledge_items.kind, "lesson"),
        eq(knowledge_items.status, "active"),
        or(isNull(knowledge_items.expires_at), gt(knowledge_items.expires_at, ctx.clock.now())),
      ),
    )
    .orderBy(desc(knowledge_items.updated_at), desc(knowledge_items.id))
    .limit(MAX_GUIDANCE);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3).trimEnd()}...` : text;
}

/** The guidance block for writers ("" when there are no active lessons). */
export function renderGuidance(guidance: readonly GroundingGuidance[]): string {
  if (guidance.length === 0) return "";
  return [
    `## ${GUIDANCE_HEADER}`,
    "What worked for this client before. Use it to choose the angle, length and tone. Never state it to the prospect, never quote it and never use its numbers as claims.",
    ...guidance.map((item) => `- ${item.body ? `${item.title}: ${item.body}` : item.title}`),
  ].join("\n");
}

async function activeItemsOfKind(
  ctx: OpContext,
  workspaceId: string,
  kind: KnowledgeKind,
  limit?: number,
): Promise<KnowledgeItem[]> {
  const query = ctx.db
    .select()
    .from(knowledge_items)
    .where(
      and(
        eq(knowledge_items.workspace_id, workspaceId),
        eq(knowledge_items.kind, kind),
        eq(knowledge_items.status, "active"),
      ),
    )
    .orderBy(kind === "rule" ? asc(knowledge_items.id) : desc(knowledge_items.updated_at));
  return limit === undefined ? query : query.limit(limit);
}

/** Proof items of the offer first, then items ranked for the query, then kind priority. */
async function factCandidates(
  ctx: OpContext,
  workspaceId: string,
  offer: Offer | null,
  query: string | undefined,
): Promise<GroundingFact[]> {
  const out: GroundingFact[] = [];
  const seen = new Set<string>();
  const add = (item: KnowledgeItem) => {
    if (seen.has(item.id) || NON_FACT_KINDS.includes(item.kind)) return;
    seen.add(item.id);
    out.push({ id: item.id, kind: item.kind, title: item.title, body: item.body.trim() });
  };

  if (offer && offer.proof_item_ids.length > 0) {
    const proof = await ctx.db
      .select()
      .from(knowledge_items)
      .where(
        and(
          eq(knowledge_items.workspace_id, workspaceId),
          eq(knowledge_items.status, "active"),
          inArray(knowledge_items.id, offer.proof_item_ids),
        ),
      );
    const order = new Map(offer.proof_item_ids.map((id, index) => [id, index]));
    proof.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    for (const item of proof) add(item);
  }

  const text = [query ?? "", offer ? `${offer.name} ${offer.summary}` : ""].join(" ").trim();
  if (text) {
    const ranked = await rankKnowledge(ctx.db, workspaceId, text, {
      limit: MAX_FACT_CANDIDATES,
      excludeKinds: NON_FACT_KINDS,
      excludeIds: [...seen],
      mode: "best",
    });
    for (const { item } of ranked) add(item);
  }

  if (out.length < MAX_FACT_CANDIDATES) {
    const rest = await ctx.db
      .select()
      .from(knowledge_items)
      .where(
        and(
          eq(knowledge_items.workspace_id, workspaceId),
          eq(knowledge_items.status, "active"),
          inArray(knowledge_items.kind, FACT_KIND_PRIORITY),
        ),
      )
      .orderBy(desc(knowledge_items.updated_at), asc(knowledge_items.id))
      .limit(MAX_FACT_CANDIDATES * 2);
    rest.sort((a, b) => FACT_KIND_PRIORITY.indexOf(a.kind) - FACT_KIND_PRIORITY.indexOf(b.kind));
    for (const item of rest) {
      if (out.length >= MAX_FACT_CANDIDATES) break;
      add(item);
    }
  }
  return out;
}

function ruleText(item: KnowledgeItem): string {
  const title = item.title.trim();
  const body = item.body.trim();
  if (!body) return title;
  if (!title || body.toLowerCase().startsWith(title.toLowerCase())) return body;
  return `${title}: ${body}`;
}

function renderFact(fact: GroundingFact): string {
  return `### ${fact.title} [${fact.kind}, ${fact.id}]\n${fact.body}`;
}

/**
 * Renders the pack as the prompt block (section headers, rules first). `bookingLink: false`
 * leaves the offer's booking link out.
 */
export function renderPack(
  pack: Omit<GroundingPack, "text">,
  options: { bookingLink?: boolean } = {},
): string {
  const sections: string[] = [];
  const companyLines = [
    pack.company.name ? `Name: ${pack.company.name}` : null,
    pack.company.website ? `Website: ${pack.company.website}` : null,
  ].filter((line): line is string => line !== null);
  if (companyLines.length > 0) sections.push(`## Our company\n${companyLines.join("\n")}`);

  if (pack.rules.length > 0) {
    sections.push(
      `## Rules (always follow, never break)\n${pack.rules.map((rule) => `- ${rule}`).join("\n")}`,
    );
  }

  if (pack.offer) {
    const offer = pack.offer;
    const lines = [`## Offer: ${offer.name}`];
    if (offer.summary.trim()) lines.push(`Summary: ${offer.summary.trim()}`);
    if (offer.details.trim()) lines.push(`Details: ${offer.details.trim()}`);
    if (offer.value_props.length > 0) {
      lines.push(`Value: ${offer.value_props.map((prop) => `\n- ${prop}`).join("")}`);
    }
    if (offer.cta?.trim()) lines.push(`Call to action: ${offer.cta.trim()}`);
    if (options.bookingLink !== false && offer.booking_url?.trim()) {
      lines.push(`Booking link: ${offer.booking_url.trim()}`);
    }
    sections.push(lines.join("\n"));
  }

  if (pack.facts.length > 0) {
    sections.push(
      `## Facts about us (only claim what is written here)\n${pack.facts
        .map(renderFact)
        .join("\n\n")}`,
    );
  }

  if (pack.voiceSamples.length > 0) {
    sections.push(
      `## Voice samples (match the tone, do not copy)\n${pack.voiceSamples
        .map((sample) => `---\n${sample}`)
        .join("\n")}`,
    );
  }
  return sections.join("\n\n");
}
