import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { requireWorkspace } from "../../../core/context.js";
import { OpenOutboundError } from "../../../core/errors.js";
import { idSchema } from "../../../core/ids.js";
import { defineOperation } from "../../../core/operation.js";
import { knowledge_items, offers } from "../../../db/schema/index.js";
import { approveOffer } from "../offers.js";

const skipped = z.object({
  id: z.string(),
  reason: z.enum(["not_found", "already_active", "not_suggested"]),
});

export const approveSuggestions = defineOperation({
  id: "knowledge.approve",
  summary: "Approve suggested knowledge items and offers",
  description:
    "Activates suggested knowledge items and offers (drafted by knowledge.bootstrap or added with status suggested) so writing may use them. Use it after reviewing suggestions with knowledge.list status suggested and offers.list status suggested. To edit a suggestion before approving use knowledge.update or offers.update; to reject one use knowledge.delete or offers.delete. Ids that are not pending suggestions are reported as skipped.",
  effect: "write",
  input: z
    .object({
      item_ids: z.array(idSchema("kn")).max(200).default([]),
      offer_ids: z.array(idSchema("off")).max(20).default([]),
    })
    .refine((value) => value.item_ids.length + value.offer_ids.length > 0, {
      message: "Pass item_ids and/or offer_ids",
    }),
  output: z.object({
    activated_item_ids: z.array(z.string()),
    activated_offer_ids: z.array(z.string()),
    skipped: z.array(skipped),
  }),
  http: { method: "POST", path: "/v1/knowledge/approve" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Approve two items and an offer",
      input: {
        item_ids: ["kn_01k6a3v0q8x3m2n4p5r6s7t8v9", "kn_01k6a3v0q8x3m2n4p5r6s7t8va"],
        offer_ids: ["off_01k6a3v0q8x3m2n4p5r6s7t8v9"],
      },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const result = {
      activated_item_ids: [] as string[],
      activated_offer_ids: [] as string[],
      skipped: [] as Array<z.infer<typeof skipped>>,
    };
    const itemIds = [...new Set(input.item_ids)];
    if (itemIds.length > 0) {
      const rows = await ctx.db
        .select({ id: knowledge_items.id, status: knowledge_items.status })
        .from(knowledge_items)
        .where(
          and(eq(knowledge_items.workspace_id, workspace.id), inArray(knowledge_items.id, itemIds)),
        );
      const byId = new Map(rows.map((row) => [row.id, row.status]));
      const toActivate: string[] = [];
      for (const id of itemIds) {
        const status = byId.get(id);
        if (status === undefined) result.skipped.push({ id, reason: "not_found" });
        else if (status === "active") result.skipped.push({ id, reason: "already_active" });
        else if (status !== "suggested") result.skipped.push({ id, reason: "not_suggested" });
        else toActivate.push(id);
      }
      if (toActivate.length > 0) {
        await ctx.db
          .update(knowledge_items)
          .set({ status: "active" })
          .where(
            and(
              eq(knowledge_items.workspace_id, workspace.id),
              inArray(knowledge_items.id, toActivate),
            ),
          );
        result.activated_item_ids.push(...toActivate);
      }
    }
    for (const id of [...new Set(input.offer_ids)]) {
      const [offer] = await ctx.db
        .select()
        .from(offers)
        .where(and(eq(offers.workspace_id, workspace.id), eq(offers.id, id)));
      if (!offer) result.skipped.push({ id, reason: "not_found" });
      else if (offer.status === "active") result.skipped.push({ id, reason: "already_active" });
      else if (!offer.suggested) result.skipped.push({ id, reason: "not_suggested" });
      else {
        await approveOffer(ctx, offer);
        result.activated_offer_ids.push(id);
      }
    }
    if (
      result.activated_item_ids.length === 0 &&
      result.activated_offer_ids.length === 0 &&
      result.skipped.every((entry) => entry.reason === "not_found")
    ) {
      throw new OpenOutboundError("not_found", "None of the ids are in this workspace.", {
        hint: "List suggestions with manage_knowledge action list (status suggested) and list_offers (status suggested).",
        details: { ids: result.skipped.map((entry) => entry.id) },
      });
    }
    return result;
  },
});
