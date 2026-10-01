import { and, desc, eq, type SQL } from "drizzle-orm";
import { z } from "zod";
import { requireWorkspace } from "../../../core/context.js";
import { idSchema } from "../../../core/ids.js";
import { defineOperation, paginated, paginationInput } from "../../../core/operation.js";
import { decodeCursor, toPage } from "../../../core/pagination.js";
import { offers } from "../../../db/schema/index.js";
import { archiveOffer, createOffer, getOffer, updateOffer } from "../offers.js";
import { offerOutput, offerView } from "../shapes.js";

const offerFields = {
  summary: z.string().max(1_000).describe("One sentence: what the buyer gets"),
  details: z.string().max(5_000).describe("How it works, scope, price notes"),
  value_props: z.array(z.string().min(1).max(300)).max(10),
  proof_item_ids: z
    .array(idSchema("kn"))
    .max(20)
    .describe("Knowledge items (proof, case studies) that back the offer"),
  cta: z.string().max(300).nullable().describe("Low-friction next step, e.g. a 20 minute call"),
  booking_url: z.string().url().max(500).nullable(),
  is_default: z.boolean().describe("Used when a campaign names no offer"),
};

export const listOffers = defineOperation({
  id: "offers.list",
  summary: "List offers",
  description:
    "Lists offers (what you sell in outreach: summary, value props, proof, call to action), default first. Use status suggested to review offers drafted by knowledge.bootstrap before approving them with knowledge.approve. Archived offers are hidden unless you ask for them.",
  effect: "read",
  input: paginationInput.extend({
    status: z
      .enum(["active", "archived", "suggested"])
      .optional()
      .describe("Only this status (default: active and suggested)"),
  }),
  output: paginated(offerOutput),
  http: { method: "GET", path: "/v1/offers" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Active offers", input: { status: "active" } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const conditions: SQL[] = [eq(offers.workspace_id, workspace.id)];
    if (input.status === "suggested") conditions.push(eq(offers.suggested, true));
    else if (input.status === "archived") {
      conditions.push(eq(offers.status, "archived"), eq(offers.suggested, false));
    } else if (input.status === "active") conditions.push(eq(offers.status, "active"));
    const rows = await ctx.db
      .select()
      .from(offers)
      .where(and(...conditions))
      .orderBy(desc(offers.id));
    const visible = input.status
      ? rows
      : rows.filter((row) => row.status === "active" || row.suggested);
    visible.sort((a, b) => Number(b.is_default) - Number(a.is_default));
    const offset = input.cursor
      ? Math.max(0, Number(decodeCursor<{ offset: number }>(input.cursor).offset) || 0)
      : 0;
    return toPage(
      visible.slice(offset, offset + input.limit + 1),
      input.limit,
      () => ({ offset: offset + input.limit }),
      offerView,
    );
  },
});

export const createOfferOp = defineOperation({
  id: "offers.create",
  summary: "Add an offer",
  description:
    "Creates an active offer that campaigns and replies can pitch. The first active offer becomes the default automatically. Link proof with proof_item_ids (knowledge items of kind proof or case_study) so writing can cite it. To change an existing offer use offers.update.",
  effect: "write",
  input: z.object({
    name: z.string().min(1).max(200),
    summary: offerFields.summary.default(""),
    details: offerFields.details.default(""),
    value_props: offerFields.value_props.default([]),
    proof_item_ids: offerFields.proof_item_ids.default([]),
    cta: offerFields.cta.optional(),
    booking_url: offerFields.booking_url.optional(),
    is_default: offerFields.is_default.optional(),
  }),
  output: offerOutput,
  http: { method: "POST", path: "/v1/offers" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Pilot offer",
      input: {
        name: "Forecast Pilot",
        summary: "A 30 day forecasting pilot on your own sales data.",
        value_props: ["Fewer stockouts", "Less cash tied up in slow stock"],
        cta: "Open to a 20 minute walkthrough?",
      },
    },
  ],
  handler: async (ctx, input) => offerView(await createOffer(ctx, input)),
});

export const updateOfferOp = defineOperation({
  id: "offers.update",
  summary: "Edit an offer",
  description:
    "Changes an offer's fields, makes it the default, or archives or reactivates it with status. Only active offers can be the default. Approve suggested offers with knowledge.approve (or status active here).",
  effect: "write",
  input: z.object({
    offer_id: idSchema("off"),
    name: z.string().min(1).max(200).optional(),
    summary: offerFields.summary.optional(),
    details: offerFields.details.optional(),
    value_props: offerFields.value_props.optional(),
    proof_item_ids: offerFields.proof_item_ids.optional(),
    cta: offerFields.cta.optional(),
    booking_url: offerFields.booking_url.optional(),
    is_default: offerFields.is_default.optional(),
    status: z.enum(["active", "archived"]).optional(),
  }),
  output: offerOutput,
  http: { method: "PATCH", path: "/v1/offers/:offer_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Make default",
      input: { offer_id: "off_01k6a3v0q8x3m2n4p5r6s7t8v9", is_default: true },
    },
  ],
  handler: async (ctx, input) => {
    const { offer_id, ...patch } = input;
    return offerView(await updateOffer(ctx, offer_id, patch));
  },
});

export const deleteOfferOp = defineOperation({
  id: "offers.delete",
  summary: "Archive an offer",
  description:
    "Archives an offer so no new message pitches it (existing campaigns keep their reference). Use it to retire an offer or reject a suggested one. Reactivate later with offers.update status active.",
  effect: "destructive",
  input: z.object({ offer_id: idSchema("off") }),
  output: offerOutput,
  http: { method: "DELETE", path: "/v1/offers/:offer_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Archive", input: { offer_id: "off_01k6a3v0q8x3m2n4p5r6s7t8v9" } }],
  handler: async (ctx, input) => {
    await getOffer(ctx, input.offer_id);
    return offerView(await archiveOffer(ctx, input.offer_id));
  },
});
