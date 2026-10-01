import { type SQL, sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import type { ActorRef } from "../../core/context.js";
import type {
  KnowledgeGapStatus,
  KnowledgeKind,
  KnowledgeSourceType,
  KnowledgeStatus,
  OfferStatus,
} from "../../core/enums.js";
import { createdAt, idColumn, tstz, tsvector, updatedAt } from "./columns.js";
import { workspaceId } from "./core.js";

export const knowledge_items = pgTable(
  "knowledge_items",
  {
    id: idColumn("kn"),
    workspace_id: workspaceId(),
    kind: text("kind").$type<KnowledgeKind>().notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    status: text("status").$type<KnowledgeStatus>().notNull().default("active"),
    source_type: text("source_type").$type<KnowledgeSourceType>().notNull().default("manual"),
    /** URL, file name, thread id, ... depending on source_type. */
    source_ref: text("source_ref"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    /** After this time the item no longer guides writing (lessons expire). */
    expires_at: tstz("expires_at"),
    /** Lessons: how many sends, replies or meetings the lesson is based on. */
    sample_size: integer("sample_size"),
    /** Who added the item (null for items from before this was recorded). */
    created_by: jsonb("created_by").$type<ActorRef>(),
    /**
     * Generated full-text vector ('simple' config): title weighted A, body B. Query with
     * `search @@ websearch_to_tsquery('simple', $q)` and rank with `ts_rank(search, query)`.
     */
    search: tsvector("search").generatedAlwaysAs(
      (): SQL =>
        sql`setweight(to_tsvector('simple', coalesce(${knowledge_items.title}, '')), 'A') || setweight(to_tsvector('simple', coalesce(${knowledge_items.body}, '')), 'B')`,
    ),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    index("knowledge_items_workspace_kind_status_idx").on(t.workspace_id, t.kind, t.status),
    index("knowledge_items_search_idx").using("gin", t.search),
  ],
);

export const offers = pgTable(
  "offers",
  {
    id: idColumn("off"),
    workspace_id: workspaceId(),
    name: text("name").notNull(),
    summary: text("summary").notNull().default(""),
    details: text("details").notNull().default(""),
    value_props: text("value_props").array().notNull().default(sql`'{}'::text[]`),
    /** knowledge_items ids (proof, case studies) backing the offer. */
    proof_item_ids: text("proof_item_ids").array().notNull().default(sql`'{}'::text[]`),
    cta: text("cta"),
    booking_url: text("booking_url"),
    status: text("status").$type<OfferStatus>().notNull().default("active"),
    is_default: boolean("is_default").notNull().default(false),
    /**
     * Drafted by `knowledge.bootstrap` and waiting for review. Suggested offers are stored with
     * status "archived" so no consumer uses them before a human or agent approves them
     * (approval sets status "active" and clears this flag).
     */
    suggested: boolean("suggested").notNull().default(false),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [index("offers_workspace_idx").on(t.workspace_id)],
);

export const knowledge_gaps = pgTable(
  "knowledge_gaps",
  {
    id: idColumn("gap"),
    workspace_id: workspaceId(),
    question: text("question").notNull(),
    context: text("context"),
    thread_id: text("thread_id"),
    status: text("status").$type<KnowledgeGapStatus>().notNull().default("open"),
    answer_item_id: text("answer_item_id"),
    answered_at: tstz("answered_at"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [index("knowledge_gaps_workspace_status_idx").on(t.workspace_id, t.status)],
);

export type KnowledgeItem = typeof knowledge_items.$inferSelect;
export type NewKnowledgeItem = typeof knowledge_items.$inferInsert;
export type Offer = typeof offers.$inferSelect;
export type NewOffer = typeof offers.$inferInsert;
export type KnowledgeGap = typeof knowledge_gaps.$inferSelect;
export type NewKnowledgeGap = typeof knowledge_gaps.$inferInsert;
