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
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { ActorRef, JobProgress } from "../../core/context.js";
import type {
  AgentTaskStatus,
  ApiKeyKind,
  ApprovalKind,
  ApprovalStatus,
  AuditStatus,
  Effect,
  JobStatus,
  NotificationChannelType,
  PrincipalType,
  Scope,
  Via,
  WebhookDeliveryStatus,
  WorkspaceStatus,
} from "../../core/enums.js";
import type { EventType } from "../../core/events.js";
import type { Failure } from "../../core/failures.js";
import type { WorkspaceSettingsInput } from "../../core/settings.js";
import type { Slot } from "../../providers/types.js";
import { createdAt, idColumn, tstz, updatedAt } from "./columns.js";

// --- JSON column types -----------------------------------------------------------------------

/** automation_rules.trigger: an event plus simple equality filters on its data. */
export interface AutomationTrigger {
  event: EventType;
  /** e.g. `{ definition_key: "funding_round", min_score: 60 }`. Semantics owned by signals. */
  filters?: Record<string, unknown>;
}

export const AUTOMATION_ACTION_TYPES = [
  "notify",
  "add_to_list",
  "enroll",
  "research",
  "webhook",
  "tag",
] as const;
export type AutomationActionType = (typeof AUTOMATION_ACTION_TYPES)[number];

/** One automation step. Parameters depend on the type (list_id, campaign_id, url, tag, ...). */
export interface AutomationAction {
  type: AutomationActionType;
  [param: string]: unknown;
}

/**
 * notification_channels.health: failed deliveries in a row (job attempts and tests). After 5 the
 * channel is failing (`failing_since`) and a problem is open; a delivery that works resets it.
 */
export interface NotificationChannelHealth {
  consecutive_failures: number;
  /** What the last failed delivery answered (null after one that worked). */
  last_error: string | null;
  last_failure: Failure | null;
  /** ISO 8601. */
  last_failure_at: string | null;
  /** ISO 8601: when the channel reached 5 failures in a row (null while it is not failing). */
  failing_since: string | null;
}

/** reports.period */
export interface ReportPeriod {
  /** ISO 8601. */
  from: string;
  to: string;
  /** e.g. "this_week", "2026-09". */
  label?: string;
}

/** reports.delivered_to: one entry per delivery. */
export interface ReportDelivery {
  channel_id: string;
  delivered_at: string;
  ok: boolean;
  error?: string;
}

// --- Tables ----------------------------------------------------------------------------------

export const workspaces = pgTable("workspaces", {
  id: idColumn("ws"),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  status: text("status").$type<WorkspaceStatus>().notNull().default("active"),
  is_sandbox: boolean("is_sandbox").notNull().default(false),
  timezone: text("timezone").notNull().default("UTC"),
  /** User overrides only; read through parseWorkspaceSettings(). */
  settings: jsonb("settings").$type<WorkspaceSettingsInput>().notNull().default({}),
  created_at: createdAt(),
  updated_at: updatedAt(),
});

/** Nullable workspace reference for tables that also hold instance-level rows. */
const optionalWorkspaceId = () =>
  text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" });
/** Required workspace reference (workspace-scoped tables). */
export const workspaceId = () =>
  text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });

export const api_keys = pgTable(
  "api_keys",
  {
    id: idColumn("key"),
    workspace_id: optionalWorkspaceId(),
    name: text("name").notNull(),
    kind: text("kind").$type<ApiKeyKind>().notNull(),
    /** First 11 chars of the key (`oo_` + 8), shown in listings. */
    prefix: text("prefix").notNull(),
    /** SHA-256 hex of the full key. */
    hash: text("hash").notNull().unique(),
    scopes: text("scopes").array().$type<Scope[]>().notNull().default(sql`'{}'::text[]`),
    last_used_at: tstz("last_used_at"),
    expires_at: tstz("expires_at"),
    revoked_at: tstz("revoked_at"),
    created_by: jsonb("created_by").$type<ActorRef>(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [index("api_keys_workspace_idx").on(t.workspace_id)],
);

export const secrets = pgTable(
  "secrets",
  {
    id: idColumn("sec"),
    workspace_id: optionalWorkspaceId(),
    name: text("name").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    auth_tag: text("auth_tag").notNull(),
    key_version: integer("key_version").notNull().default(1),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [unique("secrets_workspace_name_uq").on(t.workspace_id, t.name).nullsNotDistinct()],
);

export const provider_settings = pgTable(
  "provider_settings",
  {
    id: idColumn("prv"),
    workspace_id: optionalWorkspaceId(),
    slot: text("slot").$type<Slot>().notNull(),
    provider: text("provider").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** Higher wins when several providers serve a slot. */
    priority: integer("priority").notNull().default(0),
    /** Non-secret config validated by the provider's configSchema. */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    /** Secret key -> secrets.id */
    secret_ids: jsonb("secret_ids").$type<Record<string, string>>().notNull().default({}),
    /**
     * The config was last set by a workspace-bound key (e.g. a client's admin key), not by the
     * instance owner. Such rows never borrow shared keys for custom endpoints, and their
     * requests go through the private-network guard.
     */
    set_by_workspace_key: boolean("set_by_workspace_key").notNull().default(false),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    unique("provider_settings_workspace_slot_provider_uq")
      .on(t.workspace_id, t.slot, t.provider)
      .nullsNotDistinct(),
  ],
);

export const audit_events = pgTable(
  "audit_events",
  {
    id: idColumn("aud"),
    workspace_id: optionalWorkspaceId(),
    occurred_at: tstz("occurred_at").notNull().defaultNow(),
    actor_type: text("actor_type").$type<PrincipalType>().notNull(),
    actor_id: text("actor_id").notNull(),
    actor_name: text("actor_name").notNull(),
    via: text("via").$type<Via>().notNull(),
    operation: text("operation").notNull(),
    effect: text("effect").$type<Effect>().notNull(),
    target_type: text("target_type"),
    target_id: text("target_id"),
    reason: text("reason"),
    summary: text("summary"),
    /** Redacted input summary. */
    input: jsonb("input").$type<Record<string, unknown>>(),
    status: text("status").$type<AuditStatus>().notNull(),
    error_code: text("error_code"),
  },
  (t) => [index("audit_events_workspace_occurred_idx").on(t.workspace_id, t.occurred_at.desc())],
);

export const idempotency_records = pgTable(
  "idempotency_records",
  {
    /** "instance" or a workspace id. */
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    operation: text("operation").notNull(),
    request_hash: text("request_hash").notNull(),
    response: jsonb("response").$type<unknown>(),
    created_at: createdAt(),
    expires_at: tstz("expires_at").notNull(),
  },
  (t) => [
    primaryKey({ name: "idempotency_records_pk", columns: [t.scope, t.key] }),
    index("idempotency_records_expires_idx").on(t.expires_at),
  ],
);

export const approvals = pgTable(
  "approvals",
  {
    id: idColumn("apr"),
    workspace_id: workspaceId(),
    kind: text("kind").$type<ApprovalKind>().notNull(),
    status: text("status").$type<ApprovalStatus>().notNull().default("pending"),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    target_type: text("target_type"),
    target_id: text("target_id"),
    requested_by: jsonb("requested_by").$type<ActorRef>(),
    decided_by: jsonb("decided_by").$type<ActorRef>(),
    decision_note: text("decision_note"),
    edited: boolean("edited").notNull().default(false),
    created_at: createdAt(),
    updated_at: updatedAt(),
    decided_at: tstz("decided_at"),
    expires_at: tstz("expires_at"),
  },
  (t) => [
    index("approvals_workspace_status_created_idx").on(t.workspace_id, t.status, t.created_at),
    index("approvals_target_idx").on(t.workspace_id, t.target_type, t.target_id),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: idColumn("job"),
    workspace_id: optionalWorkspaceId(),
    name: text("name").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull().default({}),
    status: text("status").$type<JobStatus>().notNull().default("queued"),
    /** Higher runs first. */
    priority: integer("priority").notNull().default(0),
    run_at: tstz("run_at").notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    max_attempts: integer("max_attempts").notNull().default(5),
    lease_owner: text("lease_owner"),
    lease_expires_at: tstz("lease_expires_at"),
    last_error: text("last_error"),
    result: jsonb("result").$type<unknown>(),
    singleton_key: text("singleton_key"),
    /** What a `waiting` job waits for (e.g. an agent task key); see JobQueue.wake. */
    wait_for: text("wait_for"),
    progress: jsonb("progress").$type<JobProgress>(),
    created_at: createdAt(),
    updated_at: updatedAt(),
    finished_at: tstz("finished_at"),
  },
  (t) => [
    index("jobs_status_run_at_priority_idx").on(t.status, t.run_at, t.priority),
    uniqueIndex("jobs_singleton_key_active_uq")
      .on(t.singleton_key)
      .where(sql`${t.status} in ('queued', 'running', 'waiting')`),
    index("jobs_wait_for_idx").on(t.wait_for).where(sql`${t.status} = 'waiting'`),
    index("jobs_workspace_idx").on(t.workspace_id),
  ],
);

export const schedules = pgTable(
  "schedules",
  {
    id: idColumn("sch"),
    workspace_id: optionalWorkspaceId(),
    name: text("name").notNull(),
    cron: text("cron").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    job_name: text("job_name").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    next_run_at: tstz("next_run_at"),
    last_run_at: tstz("last_run_at"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [unique("schedules_workspace_name_uq").on(t.workspace_id, t.name).nullsNotDistinct()],
);

export const events = pgTable(
  "events",
  {
    id: idColumn("evt"),
    workspace_id: workspaceId(),
    type: text("type").$type<EventType>().notNull(),
    subject_type: text("subject_type"),
    subject_id: text("subject_id"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    occurred_at: tstz("occurred_at").notNull().defaultNow(),
  },
  (t) => [
    index("events_workspace_type_occurred_idx").on(t.workspace_id, t.type, t.occurred_at),
    index("events_subject_idx").on(t.workspace_id, t.subject_type, t.subject_id),
    // The change feed pages through a workspace's events in this order.
    index("events_workspace_occurred_idx").on(t.workspace_id, t.occurred_at, t.id),
  ],
);

export const webhook_endpoints = pgTable(
  "webhook_endpoints",
  {
    id: idColumn("whk"),
    workspace_id: workspaceId(),
    url: text("url").notNull(),
    description: text("description"),
    /** Event types, or ["*"]. */
    events: text("events").array().notNull().default(sql`'{}'::text[]`),
    /** Signing secret (secrets.id). */
    secret_id: text("secret_id"),
    enabled: boolean("enabled").notNull().default(true),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [index("webhook_endpoints_workspace_idx").on(t.workspace_id)],
);

export const webhook_deliveries = pgTable(
  "webhook_deliveries",
  {
    id: idColumn("whd"),
    endpoint_id: text("endpoint_id")
      .notNull()
      .references(() => webhook_endpoints.id, { onDelete: "cascade" }),
    event_id: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    status: text("status").$type<WebhookDeliveryStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    next_attempt_at: tstz("next_attempt_at"),
    response_status: integer("response_status"),
    last_error: text("last_error"),
    delivered_at: tstz("delivered_at"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    index("webhook_deliveries_status_next_idx").on(t.status, t.next_attempt_at),
    index("webhook_deliveries_endpoint_idx").on(t.endpoint_id, t.created_at),
  ],
);

export const usage_records = pgTable(
  "usage_records",
  {
    id: idColumn("use"),
    workspace_id: optionalWorkspaceId(),
    slot: text("slot").$type<Slot>().notNull(),
    provider: text("provider").notNull(),
    /** Operation id, prompt id or job name. */
    operation: text("operation").notNull(),
    model: text("model"),
    input_tokens: integer("input_tokens").notNull().default(0),
    output_tokens: integer("output_tokens").notNull().default(0),
    cached_tokens: integer("cached_tokens").notNull().default(0),
    credits: numeric("credits", { mode: "number" }).notNull().default(0),
    cost_usd: numeric("cost_usd", { precision: 12, scale: 6, mode: "number" }),
    job_id: text("job_id"),
    created_at: createdAt(),
  },
  (t) => [index("usage_records_workspace_created_idx").on(t.workspace_id, t.created_at)],
);

export const agent_tasks = pgTable(
  "agent_tasks",
  {
    id: idColumn("tsk"),
    workspace_id: workspaceId(),
    /** e.g. "brain" (agent brain prompt), "research", "review". */
    kind: text("kind").notNull(),
    task_key: text("task_key").notNull().unique(),
    status: text("status").$type<AgentTaskStatus>().notNull().default("open"),
    instructions: text("instructions").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>().notNull().default({}),
    /** JSON Schema the output must match. */
    output_schema: jsonb("output_schema").$type<Record<string, unknown>>(),
    output: jsonb("output").$type<unknown>(),
    claimed_by: jsonb("claimed_by").$type<ActorRef>(),
    claimed_at: tstz("claimed_at"),
    completed_at: tstz("completed_at"),
    expires_at: tstz("expires_at"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [index("agent_tasks_workspace_status_idx").on(t.workspace_id, t.status, t.created_at)],
);

export const automation_rules = pgTable(
  "automation_rules",
  {
    id: idColumn("rul"),
    workspace_id: workspaceId(),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    trigger: jsonb("trigger").$type<AutomationTrigger>().notNull(),
    actions: jsonb("actions").$type<AutomationAction[]>().notNull().default([]),
    require_approval: boolean("require_approval").notNull().default(false),
    last_fired_at: tstz("last_fired_at"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [index("automation_rules_workspace_idx").on(t.workspace_id)],
);

export const notification_channels = pgTable(
  "notification_channels",
  {
    id: idColumn("ntf"),
    workspace_id: workspaceId(),
    type: text("type").$type<NotificationChannelType>().notNull(),
    name: text("name").notNull(),
    /** Non-secret config, e.g. `{ mailbox_id, to }` for email. */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    /** Secret part (Slack webhook URL, signing secret) in the vault. */
    secret_id: text("secret_id"),
    events: text("events").array().notNull().default(sql`'{}'::text[]`),
    enabled: boolean("enabled").notNull().default(true),
    /** Delivery failures in a row; null until the first failure. */
    health: jsonb("health").$type<NotificationChannelHealth>(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [index("notification_channels_workspace_idx").on(t.workspace_id)],
);

export const reports = pgTable(
  "reports",
  {
    id: idColumn("rpt"),
    workspace_id: optionalWorkspaceId(),
    /** e.g. "overview", "campaign_funnel", "signals_attribution", "agency". */
    type: text("type").notNull(),
    period: jsonb("period").$type<ReportPeriod>(),
    content: jsonb("content").$type<Record<string, unknown>>().notNull().default({}),
    markdown: text("markdown"),
    delivered_to: jsonb("delivered_to").$type<ReportDelivery[]>().notNull().default([]),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [index("reports_workspace_created_idx").on(t.workspace_id, t.created_at)],
);

// --- Row types -------------------------------------------------------------------------------

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type ApiKey = typeof api_keys.$inferSelect;
export type NewApiKey = typeof api_keys.$inferInsert;
export type Secret = typeof secrets.$inferSelect;
export type NewSecret = typeof secrets.$inferInsert;
export type ProviderSetting = typeof provider_settings.$inferSelect;
export type NewProviderSetting = typeof provider_settings.$inferInsert;
export type AuditEvent = typeof audit_events.$inferSelect;
export type NewAuditEvent = typeof audit_events.$inferInsert;
export type IdempotencyRecord = typeof idempotency_records.$inferSelect;
export type NewIdempotencyRecord = typeof idempotency_records.$inferInsert;
export type Approval = typeof approvals.$inferSelect;
export type NewApproval = typeof approvals.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type Schedule = typeof schedules.$inferSelect;
export type NewSchedule = typeof schedules.$inferInsert;
export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
export type WebhookEndpoint = typeof webhook_endpoints.$inferSelect;
export type NewWebhookEndpoint = typeof webhook_endpoints.$inferInsert;
export type WebhookDelivery = typeof webhook_deliveries.$inferSelect;
export type NewWebhookDelivery = typeof webhook_deliveries.$inferInsert;
export type UsageRecord = typeof usage_records.$inferSelect;
export type NewUsageRecord = typeof usage_records.$inferInsert;
export type AgentTask = typeof agent_tasks.$inferSelect;
export type NewAgentTask = typeof agent_tasks.$inferInsert;
export type AutomationRule = typeof automation_rules.$inferSelect;
export type NewAutomationRule = typeof automation_rules.$inferInsert;
export type NotificationChannel = typeof notification_channels.$inferSelect;
export type NewNotificationChannel = typeof notification_channels.$inferInsert;
export type Report = typeof reports.$inferSelect;
export type NewReport = typeof reports.$inferInsert;
