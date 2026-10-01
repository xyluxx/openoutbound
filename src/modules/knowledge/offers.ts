/**
 * Offers: what we sell, with value props, proof items and a call to action. One active offer
 * per workspace can be the default. Suggested offers (from bootstrap) are stored archived with
 * `suggested = true` until approved, so no consumer uses them early.
 */
import { and, eq, inArray, ne } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { notFound, OpenOutboundError } from "../../core/errors.js";
import type { Db } from "../../db/client.js";
import { knowledge_items, type NewOffer, type Offer, offers } from "../../db/schema/index.js";
import { offerSnapshot, recordChange } from "../strategy/service.js";

/** Offer status as shown to callers: stored status, or "suggested" for pending suggestions. */
export type OfferViewStatus = "active" | "archived" | "suggested";

export function offerViewStatus(offer: Offer): OfferViewStatus {
  return offer.suggested ? "suggested" : offer.status;
}

export async function getOffer(ctx: OpContext, offerId: string): Promise<Offer> {
  const workspace = requireWorkspace(ctx);
  const [offer] = await ctx.db
    .select()
    .from(offers)
    .where(and(eq(offers.workspace_id, workspace.id), eq(offers.id, offerId)));
  if (!offer) throw notFound("Offer", offerId);
  return offer;
}

export interface OfferFields {
  name?: string;
  summary?: string;
  details?: string;
  value_props?: string[];
  proof_item_ids?: string[];
  cta?: string | null;
  booking_url?: string | null;
  is_default?: boolean;
}

/** Proof items must exist in the workspace (any status except archived). */
async function checkProofItems(ctx: OpContext, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const workspace = requireWorkspace(ctx);
  const found = await ctx.db
    .select({ id: knowledge_items.id })
    .from(knowledge_items)
    .where(
      and(
        eq(knowledge_items.workspace_id, workspace.id),
        inArray(knowledge_items.id, unique),
        ne(knowledge_items.status, "archived"),
      ),
    );
  const known = new Set(found.map((row) => row.id));
  const missing = unique.filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw new OpenOutboundError(
      "validation_failed",
      `Unknown or archived proof items: ${missing.join(", ")}.`,
      {
        hint: "Pass ids of active knowledge items (manage_knowledge action list with kinds proof or case_study).",
        details: { missing },
      },
    );
  }
  return unique;
}

async function clearOtherDefaults(db: Db, workspaceId: string, keepId: string): Promise<void> {
  await db
    .update(offers)
    .set({ is_default: false })
    .where(
      and(eq(offers.workspace_id, workspaceId), eq(offers.is_default, true), ne(offers.id, keepId)),
    );
}

async function hasActiveDefault(db: Db, workspaceId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: offers.id })
    .from(offers)
    .where(
      and(
        eq(offers.workspace_id, workspaceId),
        eq(offers.status, "active"),
        eq(offers.is_default, true),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Creates an active offer. The first active offer of a workspace becomes the default. */
export async function createOffer(
  ctx: OpContext,
  input: OfferFields & { name: string },
): Promise<Offer> {
  const workspace = requireWorkspace(ctx);
  const proof = await checkProofItems(ctx, input.proof_item_ids ?? []);
  const created = await ctx.db.transaction(async (tx) => {
    const makeDefault = input.is_default ?? !(await hasActiveDefault(tx, workspace.id));
    const values: NewOffer = {
      workspace_id: workspace.id,
      name: input.name.trim(),
      summary: input.summary?.trim() ?? "",
      details: input.details?.trim() ?? "",
      value_props: (input.value_props ?? []).map((prop) => prop.trim()).filter(Boolean),
      proof_item_ids: proof,
      cta: input.cta ?? null,
      booking_url: input.booking_url ?? null,
      status: "active",
      is_default: makeDefault,
    };
    const [offer] = await tx.insert(offers).values(values).returning();
    if (!offer) throw new Error("createOffer: insert returned no row");
    if (offer.is_default) await clearOtherDefaults(tx, workspace.id, offer.id);
    return offer;
  });
  await recordChange(ctx, {
    area: "offer",
    targetId: created.id,
    operation: "offers.create",
    before: null,
    after: offerSnapshot(created),
  });
  return created;
}

export async function updateOffer(
  ctx: OpContext,
  offerId: string,
  patch: OfferFields & { status?: "active" | "archived" },
): Promise<Offer> {
  const workspace = requireWorkspace(ctx);
  const existing = await getOffer(ctx, offerId);
  const set: Partial<Offer> = {};
  if (patch.name !== undefined) set.name = patch.name.trim();
  if (patch.summary !== undefined) set.summary = patch.summary.trim();
  if (patch.details !== undefined) set.details = patch.details.trim();
  if (patch.value_props !== undefined) {
    set.value_props = patch.value_props.map((prop) => prop.trim()).filter(Boolean);
  }
  if (patch.proof_item_ids !== undefined) {
    set.proof_item_ids = await checkProofItems(ctx, patch.proof_item_ids);
  }
  if (patch.cta !== undefined) set.cta = patch.cta;
  if (patch.booking_url !== undefined) set.booking_url = patch.booking_url;
  if (patch.status !== undefined) {
    set.status = patch.status;
    set.suggested = false;
  }
  const status = set.status ?? existing.status;
  const suggested = set.suggested ?? existing.suggested;
  if (patch.is_default === true && (status !== "active" || suggested)) {
    throw new OpenOutboundError("validation_failed", "Only an active offer can be the default.", {
      hint: "Set status active in the same call, or approve the suggestion first (approve_suggestions).",
    });
  }
  if (patch.is_default !== undefined) set.is_default = patch.is_default;
  if (status !== "active") set.is_default = false;
  if (Object.keys(set).length === 0) return existing;

  const updated = await ctx.db.transaction(async (tx) => {
    const [offer] = await tx.update(offers).set(set).where(eq(offers.id, existing.id)).returning();
    if (!offer) throw notFound("Offer", offerId);
    if (offer.is_default) await clearOtherDefaults(tx, workspace.id, offer.id);
    return offer;
  });
  await recordChange(ctx, {
    area: "offer",
    targetId: updated.id,
    operation: "offers.update",
    before: offerSnapshot(existing),
    after: offerSnapshot(updated),
  });
  return updated;
}

/** Archives the offer (campaigns may still reference it, so it is never hard-deleted). */
export async function archiveOffer(ctx: OpContext, offerId: string): Promise<Offer> {
  const existing = await getOffer(ctx, offerId);
  if (existing.status === "archived" && !existing.suggested && !existing.is_default) {
    return existing;
  }
  const [offer] = await ctx.db
    .update(offers)
    .set({ status: "archived", is_default: false, suggested: false })
    .where(eq(offers.id, existing.id))
    .returning();
  if (!offer) throw notFound("Offer", offerId);
  await recordChange(ctx, {
    area: "offer",
    targetId: offer.id,
    operation: "offers.delete",
    before: offerSnapshot(existing),
    after: offerSnapshot(offer),
  });
  return offer;
}

/** Activates a suggested offer (becomes default when the workspace has none). */
export async function approveOffer(ctx: OpContext, offer: Offer): Promise<Offer> {
  const workspace = requireWorkspace(ctx);
  const approved = await ctx.db.transaction(async (tx) => {
    const makeDefault = !(await hasActiveDefault(tx, workspace.id));
    const [updated] = await tx
      .update(offers)
      .set({ status: "active", suggested: false, is_default: makeDefault })
      .where(eq(offers.id, offer.id))
      .returning();
    if (!updated) throw notFound("Offer", offer.id);
    return updated;
  });
  await recordChange(ctx, {
    area: "offer",
    targetId: approved.id,
    operation: "knowledge.approve",
    before: offerSnapshot(offer),
    after: offerSnapshot(approved),
  });
  return approved;
}
