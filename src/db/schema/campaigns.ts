import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import type { ActorRef } from "../../core/context.js";
import type {
  CampaignGoal,
  CampaignStatus,
  EnrollmentStatus,
  PostStatus,
  StepType,
  TemplateKind,
} from "../../core/enums.js";
import type { CampaignSettingsInput, StepConfigInput } from "../../core/settings.js";
import { createdAt, idColumn, tstz, updatedAt } from "./columns.js";
import { workspaceId, workspaces } from "./core.js";
import { people } from "./leads.js";

// --- JSON column types -----------------------------------------------------------------------

/** Counters for one step and A/B variant (campaigns.stats.by_step). */
export interface CampaignStepStats {
  step_id: string;
  position: number;
  /** A/B variant key, or null when the step has no variants. */
  variant: string | null;
  sent: number;
  replies: number;
  positive_replies: number;
  meetings: number;
  bounces: number;
}

/** campaigns.stats: cached counters, refreshed by the campaigns module. */
export interface CampaignStats {
  enrolled?: number;
  queued?: number;
  active?: number;
  completed?: number;
  stopped?: number;
  failed?: number;
  sent?: number;
  replies?: number;
  positive_replies?: number;
  meetings?: number;
  bounces?: number;
  /** Per step and variant (A/B), in step order. */
  by_step?: CampaignStepStats[];
  refreshed_at?: string;
}

/** enrollment_step_runs.detail: what happened while running one step (skip reasons, waits). */
export interface StepRunDetail {
  /** Why the step was skipped or failed, e.g. "missing_data:email", "no_recent_post". */
  reason?: string;
  /** Codes from contactability checks. */
  codes?: string[];
  /** Branch taken by a condition step. */
  branch?: "then" | "else";
  /** Task created by a task step. */
  task_id?: string;
  /** Webhook delivery attempts and last HTTP status. */
  webhook_attempts?: number;
  webhook_status?: number | null;
  /** When the step started waiting (e.g. for a LinkedIn connection). */
  waiting_since?: string;
  /** How many times message generation was (re)queued. */
  generation_attempts?: number;
  /** Last time a plan was requested and why it could not be scheduled. */
  plan_failure?: string;
  [key: string]: unknown;
}

/** posts.account_ref: which social account publishes the post. */
export interface SocialAccountRef {
  /** social provider id, e.g. "linkedin_official", "unipile", "sandbox". */
  provider: string;
  /** Account id at the provider (member URN, Unipile account id, ...). */
  account_id: string;
  name?: string;
  /** Vault secret holding the account's access token, when the provider needs one. */
  secret_id?: string | null;
}

export interface SocialMedia {
  type: "image" | "video" | "document";
  url: string;
  alt?: string;
}

/** Why a message or post says what it says (shown to reviewers, used in attribution). */
export interface ContentWhy {
  angle?: string;
  signal_ids?: string[];
  signal_keys?: string[];
  brief_id?: string | null;
  knowledge_item_ids?: string[];
  offer_id?: string | null;
  notes?: string;
  /** Why a LinkedIn invite note was not sent, e.g. "monthly_note_limit". */
  note_skipped?: string;
  /**
   * ISO 8601 time the engine sent this message again after its first send had an unknown
   * outcome. A message is resent at most once.
   */
  resent_after_unknown?: string;
  /**
   * Set when a send fails: true when nothing was handed over or the provider refused it (it
   * did not go out), false when it may have gone out (only visits and likes, which are done at
   * least once). The sequencer replaces a failed step message only when this is not false.
   */
  failed_before_handover?: boolean;
  /**
   * An earlier attempt whose late answer said it went out while a newer attempt held the
   * message: when the newer one goes out too, the message went out twice.
   */
  earlier_attempt_went_out?: number;
  /** Attempts known (or, for a post, suspected) to have gone out, when it went out twice. */
  duplicate_attempts?: number[];
  /**
   * Posts: what the engine knows about the latest publish beyond its status, in plain words
   * (accepted without a link, a retry, why the outcome is unknown, who settled it).
   */
  publish_note?: string;
  /**
   * Posts: tries of the current publish request that stopped before anything reached LinkedIn
   * (a rate limit, a connection that never opened). Dropped when the post settles or a new
   * request starts.
   */
  publish_retries?: number;
  /** Posts: ISO 8601 time a person had a post with an unknown outcome published again. */
  republished_after_unknown?: string;
}

// --- Tables ----------------------------------------------------------------------------------

export const campaigns = pgTable(
  "campaigns",
  {
    id: idColumn("cmp"),
    workspace_id: workspaceId(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").$type<CampaignStatus>().notNull().default("draft"),
    goal: text("goal").$type<CampaignGoal>().notNull().default("meeting"),
    offer_id: text("offer_id"),
    icp_id: text("icp_id"),
    /** User overrides only; read through parseCampaignSettings(). */
    settings: jsonb("settings").$type<CampaignSettingsInput>().notNull().default({}),
    stats: jsonb("stats").$type<CampaignStats>().notNull().default({}),
    is_template: boolean("is_template").notNull().default(false),
    template_key: text("template_key"),
    created_by: jsonb("created_by").$type<ActorRef>(),
    launched_at: tstz("launched_at"),
    completed_at: tstz("completed_at"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [index("campaigns_workspace_status_idx").on(t.workspace_id, t.status)],
);

export const campaign_steps = pgTable(
  "campaign_steps",
  {
    id: idColumn("stp"),
    campaign_id: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    workspace_id: workspaceId(),
    /** 0-based order within the campaign. */
    position: integer("position").notNull(),
    type: text("type").$type<StepType>().notNull(),
    /** Wait before this step, counted from the previous step. */
    delay_days: integer("delay_days").notNull().default(0),
    delay_hours: integer("delay_hours").notNull().default(0),
    /** Step config including `type`; read through parseStepConfig(). */
    config: jsonb("config").$type<StepConfigInput>().notNull(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    unique("campaign_steps_campaign_position_uq").on(t.campaign_id, t.position),
    index("campaign_steps_workspace_idx").on(t.workspace_id),
  ],
);

export const enrollments = pgTable(
  "enrollments",
  {
    id: idColumn("enr"),
    workspace_id: workspaceId(),
    campaign_id: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    person_id: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    status: text("status").$type<EnrollmentStatus>().notNull().default("active"),
    /** Position of the next step to run. */
    current_step: integer("current_step").notNull().default(0),
    next_run_at: tstz("next_run_at"),
    mailbox_id: text("mailbox_id"),
    linkedin_account_id: text("linkedin_account_id"),
    /** Deterministic seed for variant assignment and random gaps. */
    variant_seed: integer("variant_seed"),
    stop_reason: text("stop_reason"),
    paused_until: tstz("paused_until"),
    enrolled_by: jsonb("enrolled_by").$type<ActorRef>(),
    enrolled_at: tstz("enrolled_at").notNull().defaultNow(),
    /** When the sequencer moved the enrollment from `queued` to `active` (daily_new_leads). */
    activated_at: tstz("activated_at"),
    /** When the enrollment ended (completed, stopped or failed). */
    completed_at: tstz("completed_at"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    unique("enrollments_campaign_person_uq").on(t.campaign_id, t.person_id),
    index("enrollments_status_next_run_idx").on(t.status, t.next_run_at),
    index("enrollments_workspace_person_idx").on(t.workspace_id, t.person_id),
  ],
);

/**
 * Idempotency ledger of the sequencer: one row per execution attempt of a step for an
 * enrollment. A step runs at most once per attempt: the row is created before any side effect
 * and holds the message, approval or task it produced.
 */
export const enrollment_step_runs = pgTable(
  "enrollment_step_runs",
  {
    workspace_id: workspaceId(),
    enrollment_id: text("enrollment_id")
      .notNull()
      .references(() => enrollments.id, { onDelete: "cascade" }),
    campaign_id: text("campaign_id").notNull(),
    step_id: text("step_id").notNull(),
    /** Step position when the run started (informational). */
    position: integer("position").notNull(),
    /** 1-based; a new attempt starts after a failed send or generation. */
    attempt: integer("attempt").notNull().default(1),
    /** running | waiting | done | skipped | failed */
    status: text("status").notNull().default("running"),
    message_id: text("message_id"),
    approval_id: text("approval_id"),
    detail: jsonb("detail").$type<StepRunDetail>().notNull().default({}),
    finished_at: tstz("finished_at"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    primaryKey({
      name: "enrollment_step_runs_pk",
      columns: [t.enrollment_id, t.step_id, t.attempt],
    }),
    index("enrollment_step_runs_workspace_idx").on(t.workspace_id, t.campaign_id),
  ],
);

export const templates = pgTable(
  "templates",
  {
    id: idColumn("tpl"),
    /** Null = built-in or instance-wide template. */
    workspace_id: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").$type<TemplateKind>().notNull(),
    name: text("name").notNull(),
    description: text("description"),
    content: jsonb("content").$type<Record<string, unknown>>().notNull().default({}),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [index("templates_workspace_idx").on(t.workspace_id)],
);

export const posts = pgTable(
  "posts",
  {
    id: idColumn("pst"),
    workspace_id: workspaceId(),
    account_ref: jsonb("account_ref").$type<SocialAccountRef>(),
    status: text("status").$type<PostStatus>().notNull().default("draft"),
    body: text("body").notNull().default(""),
    media: jsonb("media").$type<SocialMedia[]>().notNull().default([]),
    /** Content pillar from the knowledge base. */
    pillar: text("pillar"),
    scheduled_for: tstz("scheduled_for"),
    published_at: tstz("published_at"),
    external_id: text("external_id"),
    url: text("url"),
    error: text("error"),
    why: jsonb("why").$type<ContentWhy>(),
    /** Number of the latest publish attempt: every claim (status `publishing`) adds one. */
    publish_attempt: integer("publish_attempt").notNull().default(0),
    /** When the latest publish attempt claimed the post (it may have reached LinkedIn since). */
    publish_started_at: tstz("publish_started_at"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    index("posts_workspace_status_scheduled_idx").on(t.workspace_id, t.status, t.scheduled_for),
  ],
);

export type Campaign = typeof campaigns.$inferSelect;
export type NewCampaign = typeof campaigns.$inferInsert;
export type CampaignStep = typeof campaign_steps.$inferSelect;
export type NewCampaignStep = typeof campaign_steps.$inferInsert;
export type Enrollment = typeof enrollments.$inferSelect;
export type NewEnrollment = typeof enrollments.$inferInsert;
export type EnrollmentStepRun = typeof enrollment_step_runs.$inferSelect;
export type NewEnrollmentStepRun = typeof enrollment_step_runs.$inferInsert;
export type Template = typeof templates.$inferSelect;
export type NewTemplate = typeof templates.$inferInsert;
export type Post = typeof posts.$inferSelect;
export type NewPost = typeof posts.$inferInsert;
