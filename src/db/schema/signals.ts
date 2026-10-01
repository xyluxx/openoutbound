import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  unique,
} from "drizzle-orm/pg-core";
import type { ActorRef } from "../../core/context.js";
import type { SignalDefinitionKind, SignalStatus } from "../../core/enums.js";
import { newId } from "../../core/ids.js";
import { createdAt, idColumn, tstz, updatedAt } from "./columns.js";
import { automation_rules, workspaceId } from "./core.js";

// --- JSON column types -----------------------------------------------------------------------

/** signal_definitions.detection: how a signal is found. */
export interface SignalDetection {
  /** Built-in collector names or signal provider ids, e.g. ["job_boards", "predictleads"]. */
  collectors: string[];
  keywords: string[];
  /** Plain-English rule for custom signals, evaluated by the brain over collected evidence. */
  instructions: string;
  /** Extra URLs to watch (pages, feeds). */
  urls: string[];
  /** Brain tier for custom evaluation (default "fast"). */
  tier?: "fast" | "standard";
}

/** monitors.target: which records a monitor watches. */
export interface MonitorTarget {
  kind: "list" | "companies" | "icp" | "all_active";
  list_id?: string;
  company_ids?: string[];
  icp_id?: string;
  /** Only companies with fit_score >= this value (icp and all_active targets). */
  min_fit?: number;
}

export interface MonitorBudget {
  /** Max companies checked per run. */
  max_companies?: number;
  max_credits_per_run?: number;
  max_credits_per_month?: number;
}

/** Outcome of one automation action (automation_firings.results). */
export interface AutomationActionResult {
  type: string;
  status: "ok" | "skipped" | "failed" | "approval_requested";
  detail?: string;
  count?: number;
  approval_id?: string;
}

export type AutomationFiringStatus = "fired" | "skipped" | "failed";

// --- Tables ----------------------------------------------------------------------------------

export const signal_definitions = pgTable(
  "signal_definitions",
  {
    id: idColumn("sd"),
    workspace_id: workspaceId(),
    /** Stable snake_case key, e.g. "funding_round". */
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    kind: text("kind").$type<SignalDefinitionKind>().notNull().default("custom"),
    detection: jsonb("detection")
      .$type<SignalDetection>()
      .notNull()
      .default({ collectors: [], keywords: [], instructions: "", urls: [] }),
    /** Score contribution at full strength (0-100). */
    weight: integer("weight").notNull().default(10),
    half_life_days: integer("half_life_days").notNull().default(30),
    /** Signals weaker than this (0-1) are ignored. */
    min_strength: numeric("min_strength", { mode: "number" }).notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [unique("signal_definitions_workspace_key_uq").on(t.workspace_id, t.key)],
);

export const signals = pgTable(
  "signals",
  {
    id: idColumn("sig"),
    workspace_id: workspaceId(),
    definition_key: text("definition_key").notNull(),
    company_id: text("company_id"),
    person_id: text("person_id"),
    title: text("title").notNull(),
    summary: text("summary"),
    evidence_url: text("evidence_url"),
    evidence_excerpt: text("evidence_excerpt"),
    /** Provider id or collector name. */
    source: text("source").notNull(),
    occurred_at: tstz("occurred_at"),
    detected_at: tstz("detected_at").notNull().defaultNow(),
    /** 0.00-1.00 */
    strength: numeric("strength", { precision: 3, scale: 2, mode: "number" }).notNull().default(1),
    /** Weighted score at detection time (decay is applied when reading). */
    score: integer("score").notNull().default(0),
    status: text("status").$type<SignalStatus>().notNull().default("new"),
    dedupe_key: text("dedupe_key").notNull(),
    raw: jsonb("raw").$type<unknown>(),
    /** Messages that used this signal in outreach (attribution for reports). */
    used_message_ids: text("used_message_ids").array().notNull().default(sql`'{}'::text[]`),
    /** First time the signal was used in outreach. */
    used_at: tstz("used_at"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    unique("signals_workspace_dedupe_uq").on(t.workspace_id, t.dedupe_key),
    index("signals_workspace_company_detected_idx").on(
      t.workspace_id,
      t.company_id,
      t.detected_at.desc(),
    ),
  ],
);

export const monitors = pgTable(
  "monitors",
  {
    id: idColumn("mon"),
    workspace_id: workspaceId(),
    name: text("name").notNull(),
    target: jsonb("target").$type<MonitorTarget>().notNull(),
    collectors: text("collectors").array().notNull().default(sql`'{}'::text[]`),
    signal_keys: text("signal_keys").array().notNull().default(sql`'{}'::text[]`),
    /** Cron expression. */
    schedule: text("schedule").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    budget: jsonb("budget").$type<MonitorBudget>().notNull().default({}),
    last_run_at: tstz("last_run_at"),
    next_run_at: tstz("next_run_at"),
    last_result: jsonb("last_result").$type<Record<string, unknown>>(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [index("monitors_workspace_idx").on(t.workspace_id)],
);

/**
 * One row per (automation rule, signal): the loop guard that makes a rule fire at most once per
 * signal, plus what its actions did.
 */
export const automation_firings = pgTable(
  "automation_firings",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("afr")),
    workspace_id: workspaceId(),
    rule_id: text("rule_id")
      .notNull()
      .references(() => automation_rules.id, { onDelete: "cascade" }),
    signal_id: text("signal_id")
      .notNull()
      .references(() => signals.id, { onDelete: "cascade" }),
    status: text("status").$type<AutomationFiringStatus>().notNull().default("fired"),
    results: jsonb("results").$type<AutomationActionResult[]>().notNull().default([]),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    unique("automation_firings_rule_signal_uq").on(t.rule_id, t.signal_id),
    index("automation_firings_workspace_idx").on(t.workspace_id, t.created_at),
  ],
);

/** Per-workspace tokens for the inbound signals webhook (`/hooks/signals/:token`). */
export const signal_webhook_tokens = pgTable(
  "signal_webhook_tokens",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("swt")),
    workspace_id: workspaceId(),
    name: text("name").notNull(),
    /** First characters of the token, shown in listings. */
    prefix: text("prefix").notNull(),
    /** SHA-256 hex of the full token (the token itself is never stored). */
    token_hash: text("token_hash").notNull().unique(),
    created_by: jsonb("created_by").$type<ActorRef>(),
    last_used_at: tstz("last_used_at"),
    revoked_at: tstz("revoked_at"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [index("signal_webhook_tokens_workspace_idx").on(t.workspace_id)],
);

export type SignalDefinition = typeof signal_definitions.$inferSelect;
export type NewSignalDefinition = typeof signal_definitions.$inferInsert;
export type Signal = typeof signals.$inferSelect;
export type NewSignal = typeof signals.$inferInsert;
export type Monitor = typeof monitors.$inferSelect;
export type NewMonitor = typeof monitors.$inferInsert;
export type AutomationFiring = typeof automation_firings.$inferSelect;
export type NewAutomationFiring = typeof automation_firings.$inferInsert;
export type SignalWebhookToken = typeof signal_webhook_tokens.$inferSelect;
export type NewSignalWebhookToken = typeof signal_webhook_tokens.$inferInsert;
