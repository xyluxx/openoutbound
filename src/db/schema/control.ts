import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from "drizzle-orm/pg-core";
import type { ActorRef } from "../../core/context.js";
import type {
  ChangeArea,
  ProblemKind,
  ProblemOwner,
  ProblemSeverity,
  ProblemStatus,
  ProposalStatus,
  ProposalVerdict,
} from "../../core/enums.js";
import { createdAt, idColumn, tstz, updatedAt } from "./columns.js";
import { workspaceId } from "./core.js";

/**
 * The operator layer: problem items (the attention queue), the change log with its workspace
 * versions, change proposals with their results, and named change-feed consumers.
 */

// --- JSON column types -----------------------------------------------------------------------

/** One changed value in a change log entry: a dotted path with the values before and after. */
export interface ChangeDiffEntry {
  /** e.g. "booking.mode", "offers.booking_url". */
  path: string;
  before: unknown;
  after: unknown;
}

/** One piece of evidence behind a proposal, e.g. `{ label: "reply rate", value: 0.021 }`. */
export interface ProposalEvidence {
  label: string;
  value?: string | number | null;
  /** A record the evidence points at (campaign id, report id, ...). */
  ref?: string | null;
}

/** Before and after numbers of an applied proposal over the same length of time. */
export interface ProposalOutcome {
  window_days: number;
  before: Record<string, number | null>;
  after: Record<string, number | null>;
  verdict: ProposalVerdict;
  note?: string;
}

// --- Tables ----------------------------------------------------------------------------------

/**
 * Something that needs a person or the agent: kind, severity, the plain reason and the remedy
 * (the exact tool and action). An open problem with a `dedupe_key` is updated instead of
 * duplicated.
 */
export const problems = pgTable(
  "problems",
  {
    id: idColumn("pb"),
    workspace_id: workspaceId(),
    kind: text("kind").$type<ProblemKind>().notNull(),
    severity: text("severity").$type<ProblemSeverity>().notNull(),
    owner: text("owner").$type<ProblemOwner>().notNull().default("anyone"),
    /** Short, plain words. */
    title: text("title").notNull(),
    /** Why this needs someone. */
    reason: text("reason").notNull(),
    /** What to do, naming the exact tool and action. */
    remedy: text("remedy").notNull(),
    /** The record the problem is about, e.g. "message" + msg id. */
    subject_type: text("subject_type"),
    subject_id: text("subject_id"),
    person_id: text("person_id"),
    company_id: text("company_id"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    due_at: tstz("due_at"),
    status: text("status").$type<ProblemStatus>().notNull().default("open"),
    snoozed_until: tstz("snoozed_until"),
    resolved_at: tstz("resolved_at"),
    resolved_by: jsonb("resolved_by").$type<ActorRef>(),
    resolution: text("resolution"),
    /** At most one unresolved problem per key, e.g. "send_unknown:msg_...". */
    dedupe_key: text("dedupe_key"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    index("problems_workspace_status_severity_idx").on(
      t.workspace_id,
      t.status,
      t.severity,
      t.due_at,
    ),
    index("problems_workspace_person_idx").on(t.workspace_id, t.person_id),
    uniqueIndex("problems_workspace_dedupe_open_uq")
      .on(t.workspace_id, t.dedupe_key)
      .where(sql`${t.dedupe_key} is not null and ${t.status} <> 'resolved'`),
  ],
);

/**
 * Every change to workspace settings, offers, ICPs and campaigns, with a workspace version
 * number that grows by one per change. `undo_of` points at the change an undo reverted.
 */
export const change_log = pgTable(
  "change_log",
  {
    id: idColumn("chg"),
    workspace_id: workspaceId(),
    version: integer("version").notNull(),
    area: text("area").$type<ChangeArea>().notNull(),
    target_id: text("target_id"),
    /** Operation id that made the change, e.g. "workspaces.update". */
    operation: text("operation"),
    diff: jsonb("diff").$type<ChangeDiffEntry[]>().notNull(),
    reason: text("reason"),
    actor: jsonb("actor").$type<ActorRef>(),
    /** Door the change came through (cli, http, mcp, worker, system). */
    via: text("via"),
    proposal_id: text("proposal_id"),
    undone_at: tstz("undone_at"),
    undo_of: text("undo_of"),
    created_at: createdAt(),
  },
  (t) => [
    uniqueIndex("change_log_workspace_version_uq").on(t.workspace_id, t.version),
    index("change_log_workspace_target_idx").on(t.workspace_id, t.area, t.target_id),
  ],
);

/**
 * A change an agent proposed: the operation and input it would run, why, and the evidence.
 * Applied at once when the caller may, otherwise through an approval of kind `change`.
 */
export const change_proposals = pgTable(
  "change_proposals",
  {
    id: idColumn("prop"),
    workspace_id: workspaceId(),
    title: text("title").notNull(),
    reason: text("reason").notNull(),
    evidence: jsonb("evidence").$type<ProposalEvidence[]>().notNull().default([]),
    expected_outcome: text("expected_outcome"),
    /** The operation that applies the change, e.g. "workspaces.update". */
    operation: text("operation").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>().notNull(),
    target_type: text("target_type"),
    target_id: text("target_id"),
    status: text("status").$type<ProposalStatus>().notNull().default("proposed"),
    approval_id: text("approval_id"),
    change_id: text("change_id"),
    error: text("error"),
    applied_at: tstz("applied_at"),
    /** Days of numbers compared before and after the change (1 to 90). */
    review_after_days: integer("review_after_days").notNull().default(14),
    /** When the results job compares the numbers before and after. */
    review_at: tstz("review_at"),
    outcome: jsonb("outcome").$type<ProposalOutcome>(),
    reviewed_at: tstz("reviewed_at"),
    created_by: jsonb("created_by").$type<ActorRef>(),
    decided_by: jsonb("decided_by").$type<ActorRef>(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    index("change_proposals_workspace_status_idx").on(t.workspace_id, t.status),
    index("change_proposals_review_idx").on(t.status, t.review_at),
  ],
);

/** A named reader of the change feed (e.g. "crm") and its acknowledged position. */
export const event_consumers = pgTable(
  "event_consumers",
  {
    workspace_id: workspaceId(),
    name: text("name").notNull(),
    /** Opaque position of the last acknowledged event. */
    cursor: text("cursor"),
    acknowledged_at: tstz("acknowledged_at"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [primaryKey({ name: "event_consumers_pk", columns: [t.workspace_id, t.name] })],
);

export type Problem = typeof problems.$inferSelect;
export type NewProblem = typeof problems.$inferInsert;
export type ChangeLogEntry = typeof change_log.$inferSelect;
export type NewChangeLogEntry = typeof change_log.$inferInsert;
export type ChangeProposal = typeof change_proposals.$inferSelect;
export type NewChangeProposal = typeof change_proposals.$inferInsert;
export type EventConsumer = typeof event_consumers.$inferSelect;
export type NewEventConsumer = typeof event_consumers.$inferInsert;
