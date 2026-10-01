import { and, arrayContains, desc, eq, inArray, lt, ne, type SQL } from "drizzle-orm";
import { z } from "zod";
import { requireWorkspace } from "../../../core/context.js";
import { KNOWLEDGE_KINDS, KNOWLEDGE_STATUSES } from "../../../core/enums.js";
import { idSchema } from "../../../core/ids.js";
import { defineOperation, paginated, paginationInput } from "../../../core/operation.js";
import { decodeCursor, toPage } from "../../../core/pagination.js";
import { knowledge_items } from "../../../db/schema/index.js";
import { createItem, getItem, MAX_BODY_CHARS, removeItem, updateItem } from "../items.js";
import {
  assertLessonFields,
  LESSON_DEFAULT_DAYS,
  LESSON_MAX_DAYS,
  lessonExpiry,
} from "../lessons.js";
import { rankKnowledge } from "../search.js";
import { itemView, knowledgeItemOutput } from "../shapes.js";

const kindInput = z.enum(KNOWLEDGE_KINDS);
const tagsInput = z.array(z.string().min(1).max(60)).max(20);
const expiresInDaysInput = z
  .number()
  .int()
  .min(1)
  .max(LESSON_MAX_DAYS)
  .describe(`Lessons only: days until it expires (default ${LESSON_DEFAULT_DAYS})`);
const sampleSizeInput = z
  .number()
  .int()
  .min(1)
  .max(10_000_000)
  .describe("Lessons only: how many sends, replies or meetings the lesson is based on");

export const listKnowledge = defineOperation({
  id: "knowledge.list",
  summary: "List knowledge items",
  description:
    "Lists knowledge items (facts about your own company: about, products, proof, objections, FAQs, rules, voice samples), newest first. Use it to review what the engine may claim, or status suggested to review drafts from bootstrap before approving them. To find items about a topic use knowledge.search instead. Archived items are hidden unless you ask for status archived.",
  effect: "read",
  input: paginationInput.extend({
    status: z
      .enum(KNOWLEDGE_STATUSES)
      .optional()
      .describe("Only this status (default: active and suggested)"),
    kinds: z.array(kindInput).max(12).optional().describe("Only these kinds"),
    tag: z.string().optional().describe("Only items with this tag"),
  }),
  output: paginated(knowledgeItemOutput),
  http: { method: "GET", path: "/v1/knowledge/items" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Review bootstrap suggestions", input: { status: "suggested" } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const conditions: SQL[] = [eq(knowledge_items.workspace_id, workspace.id)];
    conditions.push(
      input.status
        ? eq(knowledge_items.status, input.status)
        : ne(knowledge_items.status, "archived"),
    );
    if (input.kinds && input.kinds.length > 0) {
      conditions.push(inArray(knowledge_items.kind, input.kinds));
    }
    if (input.tag) conditions.push(arrayContains(knowledge_items.tags, [input.tag.toLowerCase()]));
    if (input.cursor) {
      const cursor = decodeCursor<{ id: string }>(input.cursor);
      conditions.push(lt(knowledge_items.id, String(cursor.id)));
    }
    const rows = await ctx.db
      .select()
      .from(knowledge_items)
      .where(and(...conditions))
      .orderBy(desc(knowledge_items.id))
      .limit(input.limit + 1);
    return toPage(
      rows,
      input.limit,
      (row) => ({ id: row.id }),
      (row) => itemView(row, ctx.request.responseFormat),
    );
  },
});

export const getKnowledgeItem = defineOperation({
  id: "knowledge.get",
  summary: "Get one knowledge item with its full text",
  description:
    "Returns one knowledge item with its full body. Use it after list or search when you need the complete text of an item. To find items by topic use knowledge.search instead.",
  effect: "read",
  input: z.object({ item_id: idSchema("kn").describe("Knowledge item id (kn_...)") }),
  output: knowledgeItemOutput,
  http: { method: "GET", path: "/v1/knowledge/items/:item_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Read an item", input: { item_id: "kn_01k6a3v0q8x3m2n4p5r6s7t8v9" } }],
  handler: async (ctx, input) => itemView(await getItem(ctx, input.item_id), "full"),
});

export const createKnowledgeItem = defineOperation({
  id: "knowledge.create",
  summary: "Add a knowledge item",
  description:
    "Adds one fact about your company that writing may use: kind about, product, proof, case_study, objection (title = objection, body = answer), faq, rule (always-followed instruction such as 'Never promise ROI numbers'), voice_sample, persona, competitor or other; kind lesson records what worked for this client (source_ref, sample_size, expires_in_days default 90), which writers get as guidance and never state as a fact. Use it for short, specific facts; for documents, pages or PDFs use knowledge.ingest, and to draft a whole base from a website use knowledge.bootstrap. Adding an identical item (same kind, title and body) returns the existing one.",
  effect: "write",
  input: z.object({
    kind: kindInput,
    title: z.string().min(1).max(200),
    body: z.string().max(MAX_BODY_CHARS).default(""),
    status: z
      .enum(["active", "suggested"])
      .default("active")
      .describe("suggested = keep out of prompts until approved"),
    tags: tagsInput.default([]),
    source_ref: z
      .string()
      .max(500)
      .optional()
      .describe("Where the fact comes from (URL, doc name, report or campaign id)"),
    expires_in_days: expiresInDaysInput.optional(),
    sample_size: sampleSizeInput.optional(),
  }),
  output: knowledgeItemOutput.extend({ created: z.boolean() }),
  http: { method: "POST", path: "/v1/knowledge/items" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Add a hard rule",
      input: {
        kind: "rule",
        title: "No ROI promises",
        body: "Never promise specific savings or ROI numbers.",
      },
    },
    {
      title: "Add a proof point",
      input: {
        kind: "proof",
        title: "Stockouts down 31%",
        body: "Lumen Home cut stockouts by 31% in the first quarter using Forecast Pilot.",
        source_ref: "https://northwind.example.com/customers/lumen-home",
      },
    },
    {
      title: "Record a lesson",
      input: {
        kind: "lesson",
        title: "Short first emails get more replies",
        body: "First emails under 60 words got twice the reply rate of longer ones for practice managers.",
        source_ref: "campaign report, September",
        sample_size: 420,
        expires_in_days: 60,
      },
    },
  ],
  handler: async (ctx, input) => {
    assertLessonFields(input.kind, input);
    const lesson = input.kind === "lesson";
    const { item, created } = await createItem(ctx, {
      kind: input.kind,
      title: input.title,
      body: input.body,
      status: input.status,
      sourceType: "manual",
      sourceRef: input.source_ref ?? null,
      tags: input.tags,
      expiresAt: lesson ? lessonExpiry(ctx.clock.now(), input.expires_in_days) : null,
      sampleSize: lesson ? (input.sample_size ?? null) : null,
    });
    return { ...itemView(item, "full"), created };
  },
});

export const updateKnowledgeItem = defineOperation({
  id: "knowledge.update",
  summary: "Edit or approve a knowledge item",
  description:
    "Changes an item's title, body, kind, tags or status, and for lessons sample_size and expires_in_days (counted from now; pass it again to renew a lesson). Set status active to approve a suggested item (it then reaches prompts), or archived to retire it. To approve many suggestions at once use knowledge.approve; to delete use knowledge.delete.",
  effect: "write",
  input: z.object({
    item_id: idSchema("kn"),
    kind: kindInput.optional(),
    title: z.string().min(1).max(200).optional(),
    body: z.string().max(MAX_BODY_CHARS).optional(),
    status: z.enum(KNOWLEDGE_STATUSES).optional(),
    tags: tagsInput.optional().describe("Replaces the tags"),
    expires_in_days: expiresInDaysInput.optional(),
    sample_size: sampleSizeInput.nullable().optional(),
  }),
  output: knowledgeItemOutput,
  http: { method: "PATCH", path: "/v1/knowledge/items/:item_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Approve a suggestion",
      input: { item_id: "kn_01k6a3v0q8x3m2n4p5r6s7t8v9", status: "active" },
    },
  ],
  handler: async (ctx, input) => {
    const { item_id, expires_in_days, sample_size, ...patch } = input;
    const existing = await getItem(ctx, item_id);
    const kind = patch.kind ?? existing.kind;
    assertLessonFields(kind, { expires_in_days, sample_size });
    const lessonPatch: { expires_at?: Date | null; sample_size?: number | null } = {};
    if (kind === "lesson") {
      // Days count from now; an item that becomes a lesson gets the default lifetime.
      if (expires_in_days !== undefined) {
        lessonPatch.expires_at = lessonExpiry(ctx.clock.now(), expires_in_days);
      } else if (existing.kind !== "lesson") {
        lessonPatch.expires_at = lessonExpiry(ctx.clock.now());
      }
      if (sample_size !== undefined) lessonPatch.sample_size = sample_size;
    } else if (existing.kind === "lesson") {
      lessonPatch.expires_at = null;
      lessonPatch.sample_size = null;
    }
    return itemView(await updateItem(ctx, item_id, { ...patch, ...lessonPatch }), "full");
  },
});

export const deleteKnowledgeItem = defineOperation({
  id: "knowledge.delete",
  summary: "Archive or delete a knowledge item",
  description:
    "Archives a knowledge item so it no longer reaches prompts (default), or deletes it for good with permanent true (it is also removed from offers' proof lists). Use it to reject suggestions or retire outdated facts. To edit an item use knowledge.update instead.",
  effect: "destructive",
  input: z.object({
    item_id: idSchema("kn"),
    permanent: z.boolean().default(false).describe("Delete instead of archive"),
  }),
  output: z.object({ id: z.string(), status: z.enum(["archived", "deleted"]) }),
  http: { method: "DELETE", path: "/v1/knowledge/items/:item_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Reject a suggestion", input: { item_id: "kn_01k6a3v0q8x3m2n4p5r6s7t8v9" } }],
  handler: async (ctx, input) => removeItem(ctx, input.item_id, { permanent: input.permanent }),
});

export const searchKnowledgeItems = defineOperation({
  id: "knowledge.search",
  summary: "Search knowledge by topic",
  description:
    "Full-text search over knowledge items, best matches first (items matching every word, then any word). Use it to check what the engine knows about a topic before writing or answering a prospect's question. To browse everything use knowledge.list instead. Only active items are searched unless you pass status, and lessons (guidance, not facts) only when kinds includes lesson.",
  effect: "read",
  input: z.object({
    query: z.string().min(1).max(500).describe("Words or a phrase, e.g. shopify integration"),
    kinds: z.array(kindInput).max(12).optional(),
    status: z.enum(KNOWLEDGE_STATUSES).default("active"),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  output: z.object({
    items: z.array(
      knowledgeItemOutput.extend({
        rank: z.number().describe("Relevance (higher is better)"),
        match: z.enum(["fulltext", "any_word", "substring"]),
      }),
    ),
  }),
  http: { method: "GET", path: "/v1/knowledge/search" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Pricing facts", input: { query: "pricing plans" } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const ranked = await rankKnowledge(ctx.db, workspace.id, input.query, {
      limit: input.limit,
      statuses: [input.status],
      ...(input.kinds && input.kinds.length > 0
        ? { kinds: input.kinds }
        : { excludeKinds: ["lesson" as const] }),
    });
    return {
      items: ranked.map(({ item, rank, match }) => ({
        ...itemView(item, ctx.request.responseFormat),
        rank: Math.round(rank * 10_000) / 10_000,
        match,
      })),
    };
  },
});
