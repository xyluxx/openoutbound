import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { ActorRef } from "../../core/context.js";
import type {
  Channel,
  FactKind,
  FactScope,
  MeetingMatch,
  MeetingSource,
  MeetingStatus,
  MessageAction,
  MessageDirection,
  MessageOrigin,
  MessageStatus,
  OpportunityStage,
  PrivacyKind,
  ReplyCategory,
  TaskStatus,
  TaskType,
  ThreadOwner,
  ThreadStatus,
} from "../../core/enums.js";
import { newId } from "../../core/ids.js";
import type { ContentWhy } from "./campaigns.js";
import { createdAt, idColumn, tstz, updatedAt } from "./columns.js";
import { workspaceId } from "./core.js";

// --- JSON column types -----------------------------------------------------------------------

/** messages.check: deterministic checks + checker model verdict for an outbound draft. */
export interface MessageCheck {
  passed: boolean;
  /** Checker confidence 0-1 (drives the `unsure` review level and auto-send). */
  confidence?: number;
  issues: Array<{ code: string; message: string; severity: "error" | "warning" }>;
  revised?: boolean;
  checker_model?: string | null;
}

/** messages.classification: result of classifying an inbound reply (spec 11.11). */
export interface ReplyClassification {
  category: ReplyCategory;
  /** 0-1 */
  confidence: number;
  sentiment?: "positive" | "neutral" | "negative";
  /** ISO date an out-of-office contact returns. */
  return_date?: string | null;
  referral?: { name?: string | null; email?: string | null; title?: string | null } | null;
  /** The question asked, for `question` replies. */
  question?: string | null;
  summary?: string;
  model?: string | null;
  /** The reply tried to instruct an AI (prompt injection); it is routed to a human. */
  suspicious?: boolean;
  /** Heuristic codes or model notes behind `suspicious` and other human-only reasons. */
  review_reasons?: string[];
  /** The prospect asks whether they are talking to a bot or an AI: always answered by a human. */
  asks_if_bot?: boolean;
  /** BCP 47 language of the reply. */
  language?: string | null;
  /** ISO date the prospect asked to be contacted again (not_now). */
  follow_up_date?: string | null;
  /** An automatic reply says the person left the company. */
  left_company?: boolean;
  /** Who decided: deterministic rules, the model, or a human override. */
  source?: "rules" | "model" | "human";
  /** ISO 8601 time of the classification. */
  classified_at?: string;
  /**
   * A specific meeting time the prospect proposed. `start` is ISO 8601 with offset when the
   * date and time are clear, `timezone` an IANA zone; both null otherwise. Never confirmed by
   * the engine itself.
   */
  proposed_time?: { text: string; start: string | null; timezone: string | null } | null;
  /** What a `privacy_request` asks for; null for every other category. */
  privacy_kind?: PrivacyKind | null;
  /** Short neutral business facts from the reply (at most 5), for the lead file. */
  facts?: Array<{
    kind: Exclude<FactKind, "note">;
    text: string;
    applies_to: FactScope;
    /** YYYY-MM-DD, for timing facts. */
    expires_on: string | null;
  }>;
  /** The reply says the whole company is off-limits until a date (a suggestion, never applied). */
  company_hold?: { until: string; reason: string } | null;
}

/** opportunities.crm_refs: CRM provider -> deal id. */
export type CrmRefs = Record<string, string>;

// --- Tables ----------------------------------------------------------------------------------

export const threads = pgTable(
  "threads",
  {
    id: idColumn("thr"),
    workspace_id: workspaceId(),
    person_id: text("person_id"),
    company_id: text("company_id"),
    campaign_id: text("campaign_id"),
    channel: text("channel").$type<Channel>().notNull(),
    subject: text("subject"),
    mailbox_id: text("mailbox_id"),
    linkedin_account_id: text("linkedin_account_id"),
    /** Provider thread/chat id (LinkedIn chat id, email root Message-ID). */
    external_ref: text("external_ref"),
    status: text("status").$type<ThreadStatus>().notNull().default("open"),
    needs_attention: boolean("needs_attention").notNull().default(false),
    /** Latest reply category. */
    category: text("category").$type<ReplyCategory>(),
    sentiment: text("sentiment"),
    last_message_at: tstz("last_message_at"),
    last_inbound_at: tstz("last_inbound_at"),
    /** person = a human answered in this thread; the engine drafts nothing until it is handed back. */
    owner: text("owner").$type<ThreadOwner>().notNull().default("engine"),
    owner_changed_at: tstz("owner_changed_at"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    index("threads_workspace_attention_last_idx").on(
      t.workspace_id,
      t.needs_attention,
      t.last_message_at.desc(),
    ),
    index("threads_workspace_person_idx").on(t.workspace_id, t.person_id),
    // Hot replies (the attention queue and the stuck check) look back from the latest reply.
    index("threads_workspace_last_inbound_idx").on(t.workspace_id, t.last_inbound_at),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: idColumn("msg"),
    workspace_id: workspaceId(),
    /** Null for drafts whose thread is created at send time. */
    thread_id: text("thread_id"),
    person_id: text("person_id"),
    company_id: text("company_id"),
    campaign_id: text("campaign_id"),
    enrollment_id: text("enrollment_id"),
    step_id: text("step_id"),
    channel: text("channel").$type<Channel>().notNull(),
    action: text("action").$type<MessageAction>().notNull(),
    direction: text("direction").$type<MessageDirection>().notNull(),
    status: text("status").$type<MessageStatus>().notNull(),
    subject: text("subject"),
    body_text: text("body_text"),
    body_html: text("body_html"),
    /** A/B variant key. */
    variant: text("variant"),
    from_address: text("from_address"),
    to_address: text("to_address"),
    mailbox_id: text("mailbox_id"),
    linkedin_account_id: text("linkedin_account_id"),
    why: jsonb("why").$type<ContentWhy>(),
    check: jsonb("check").$type<MessageCheck>(),
    classification: jsonb("classification").$type<ReplyClassification>(),
    scheduled_for: tstz("scheduled_for"),
    sent_at: tstz("sent_at"),
    received_at: tstz("received_at"),
    provider_message_id: text("provider_message_id"),
    /** RFC 5322 Message-ID, with angle brackets. */
    message_id_header: text("message_id_header"),
    in_reply_to: text("in_reply_to"),
    references: text("references").array().notNull().default(sql`'{}'::text[]`),
    headers: jsonb("headers").$type<Record<string, string>>(),
    error: text("error"),
    attempt: integer("attempt").notNull().default(0),
    /** external = found in the mailbox's Sent folder, written outside the engine. */
    origin: text("origin").$type<MessageOrigin>().notNull().default("engine"),
    /** When the message data was handed to the provider (a send in progress). */
    dispatch_started_at: tstz("dispatch_started_at"),
    /** How many times an `unknown` send was looked for in the Sent folder. */
    reconcile_checks: integer("reconcile_checks").notNull().default(0),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    index("messages_workspace_status_scheduled_idx").on(t.workspace_id, t.status, t.scheduled_for),
    index("messages_thread_created_idx").on(t.thread_id, t.created_at),
    uniqueIndex("messages_workspace_message_id_header_uq")
      .on(t.workspace_id, t.message_id_header)
      .where(sql`${t.message_id_header} is not null`),
    index("messages_enrollment_idx").on(t.enrollment_id),
    index("messages_workspace_person_idx").on(t.workspace_id, t.person_id, t.created_at),
    // A company's history (the lead file timeline) reads its messages by company.
    index("messages_workspace_company_idx").on(t.workspace_id, t.company_id),
    // Reports count sends and replies by time window.
    index("messages_workspace_sent_idx").on(t.workspace_id, t.sent_at),
    index("messages_workspace_received_idx").on(t.workspace_id, t.received_at),
  ],
);

export const opportunities = pgTable(
  "opportunities",
  {
    id: idColumn("opp"),
    workspace_id: workspaceId(),
    person_id: text("person_id"),
    company_id: text("company_id"),
    campaign_id: text("campaign_id"),
    thread_id: text("thread_id"),
    stage: text("stage").$type<OpportunityStage>().notNull().default("interested"),
    value: numeric("value", { mode: "number" }),
    /** ISO 4217, e.g. "EUR". */
    currency: text("currency"),
    meeting_at: tstz("meeting_at"),
    lost_reason: text("lost_reason"),
    notes: text("notes"),
    /** Signal keys that led here (attribution). */
    source_signal_keys: text("source_signal_keys").array().notNull().default(sql`'{}'::text[]`),
    crm_refs: jsonb("crm_refs").$type<CrmRefs>().notNull().default({}),
    closed_at: tstz("closed_at"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [index("opportunities_workspace_stage_idx").on(t.workspace_id, t.stage)],
);

export const tasks = pgTable(
  "tasks",
  {
    id: idColumn("tk"),
    workspace_id: workspaceId(),
    person_id: text("person_id"),
    campaign_id: text("campaign_id"),
    enrollment_id: text("enrollment_id"),
    type: text("type").$type<TaskType>().notNull().default("other"),
    title: text("title").notNull(),
    notes: text("notes"),
    due_at: tstz("due_at"),
    status: text("status").$type<TaskStatus>().notNull().default("open"),
    completed_at: tstz("completed_at"),
    /** Thread the task came from (reply actions). */
    thread_id: text("thread_id"),
    /** Set by automatic actions so re-runs never create the same task twice. */
    dedupe_key: text("dedupe_key"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    index("tasks_workspace_status_due_idx").on(t.workspace_id, t.status, t.due_at),
    uniqueIndex("tasks_workspace_dedupe_uq")
      .on(t.workspace_id, t.dedupe_key)
      .where(sql`${t.dedupe_key} is not null`),
  ],
);

export const crm_links = pgTable(
  "crm_links",
  {
    workspace_id: workspaceId(),
    /** crm provider id, e.g. "hubspot". */
    provider: text("provider").notNull(),
    /** "person" | "company" | "opportunity". */
    entity_type: text("entity_type").notNull(),
    entity_id: text("entity_id").notNull(),
    external_id: text("external_id").notNull(),
    synced_at: tstz("synced_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "crm_links_pk",
      columns: [t.workspace_id, t.provider, t.entity_type, t.entity_id],
    }),
  ],
);

/**
 * Inbound meeting-booked webhook (`/hooks/meetings/:token`), one per workspace. Only the
 * SHA-256 hash of the token is stored; the URL is shown once when it is created or rotated.
 */
export const meeting_webhooks = pgTable(
  "meeting_webhooks",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("mwh")),
    workspace_id: workspaceId(),
    /** SHA-256 hex of the full token. */
    token_hash: text("token_hash").notNull(),
    /** Last 4 characters of the token, to tell URLs apart. */
    token_hint: text("token_hint").notNull(),
    created_by: jsonb("created_by").$type<ActorRef>(),
    last_used_at: tstz("last_used_at"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    uniqueIndex("meeting_webhooks_workspace_uq").on(t.workspace_id),
    uniqueIndex("meeting_webhooks_token_hash_uq").on(t.token_hash),
  ],
);

/**
 * Inbound CRM facts webhook (`/hooks/crm/:token`), one per workspace: a CRM, Zapier or n8n
 * reports customers, open deals, owners and do-not-contact people. Only the SHA-256 hash of the
 * token is stored; the URL is shown once when it is created or rotated.
 */
export const crm_webhooks = pgTable(
  "crm_webhooks",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("cwh")),
    workspace_id: workspaceId(),
    /** SHA-256 hex of the full token. */
    token_hash: text("token_hash").notNull(),
    /** Last 4 characters of the token, to tell URLs apart. */
    token_hint: text("token_hint").notNull(),
    created_by: jsonb("created_by").$type<ActorRef>(),
    last_used_at: tstz("last_used_at"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    uniqueIndex("crm_webhooks_workspace_uq").on(t.workspace_id),
    uniqueIndex("crm_webhooks_token_hash_uq").on(t.token_hash),
  ],
);

/**
 * A meeting with a prospect: booked through a booking tool webhook (Calendly, Cal.com, a
 * generic tool) or recorded by a person or agent. Duplicate webhook deliveries match the same
 * row through (source, external_id).
 */
export const meetings = pgTable(
  "meetings",
  {
    id: idColumn("mt"),
    workspace_id: workspaceId(),
    person_id: text("person_id"),
    company_id: text("company_id"),
    opportunity_id: text("opportunity_id"),
    campaign_id: text("campaign_id"),
    thread_id: text("thread_id"),
    source: text("source").$type<MeetingSource>().notNull(),
    /** The booking tool's id for the booking (null for manual records). */
    external_id: text("external_id"),
    /** Booking ids a reschedule replaced, so a late delivery about an old id finds this meeting. */
    previous_external_ids: text("previous_external_ids")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: text("status").$type<MeetingStatus>().notNull().default("scheduled"),
    start_at: tstz("start_at"),
    end_at: tstz("end_at"),
    matched_by: text("matched_by").$type<MeetingMatch>().notNull(),
    /** Whether the meeting met strategy.qualified_meeting; null until someone judges it. */
    qualified: boolean("qualified"),
    notes: text("notes"),
    status_changed_at: tstz("status_changed_at"),
    created_by: jsonb("created_by").$type<ActorRef>(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    uniqueIndex("meetings_workspace_source_external_uq")
      .on(t.workspace_id, t.source, t.external_id)
      .where(sql`${t.external_id} is not null`),
    index("meetings_workspace_status_start_idx").on(t.workspace_id, t.status, t.start_at),
    index("meetings_workspace_person_idx").on(t.workspace_id, t.person_id),
  ],
);

export type Thread = typeof threads.$inferSelect;
export type NewThread = typeof threads.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Opportunity = typeof opportunities.$inferSelect;
export type NewOpportunity = typeof opportunities.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type CrmLink = typeof crm_links.$inferSelect;
export type NewCrmLink = typeof crm_links.$inferInsert;
export type MeetingWebhook = typeof meeting_webhooks.$inferSelect;
export type NewMeetingWebhook = typeof meeting_webhooks.$inferInsert;
export type CrmWebhook = typeof crm_webhooks.$inferSelect;
export type NewCrmWebhook = typeof crm_webhooks.$inferInsert;
export type Meeting = typeof meetings.$inferSelect;
export type NewMeeting = typeof meetings.$inferInsert;
