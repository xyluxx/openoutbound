import { index, jsonb, numeric, pgTable, text, unique } from "drizzle-orm/pg-core";
import type { ResearchBriefStatus } from "../../core/enums.js";
import type { Failure } from "../../core/failures.js";
import { createdAt, idColumn, tstz, updatedAt } from "./columns.js";
import { workspaceId } from "./core.js";

// --- JSON column types -----------------------------------------------------------------------

/** A dated, sourced fact (evidence-first: every fact has a URL). */
export interface ResearchFact {
  fact: string;
  source_url: string;
  /** ISO date of the underlying event or publication, when known. */
  date?: string | null;
}

/**
 * research_briefs.brief (spec 11.6). Owned by the research module; campaigns read it when
 * writing. Extend compatibly (new optional fields only).
 */
export interface ResearchBrief {
  /** Who the person is and what they care about in their role. */
  who: { summary: string; role?: string | null };
  /** What the company does, for whom. */
  company: { summary: string };
  /** What is happening now: dated, sourced facts, newest first. */
  now: ResearchFact[];
  pains: Array<{ hypothesis: string; evidence_urls: string[] }>;
  /** Outreach angles tied to our offers. */
  angles: Array<{ angle: string; why: string; offer_id?: string | null; evidence_urls: string[] }>;
  recommended_angle: string | null;
  confidence: "low" | "medium" | "high";
}

export interface ResearchSource {
  url: string;
  title?: string | null;
  published_at?: string | null;
}

/** A source that failed while a brief was built. */
export interface ResearchGap {
  /** search: a web search of the research provider; website: the company site (sandbox). */
  source: "search" | "website";
  /** The search query or the page URL. */
  target: string;
  failure: Failure;
  /** Set on a person brief when the gap is in the company brief it builds on. */
  company_brief_id?: string;
}

/** A web search the brief used, with its results, so a later run does not pay for it again. */
export interface KeptSearch {
  query: string;
  results: Array<{
    url: string;
    title: string;
    snippet: string | null;
    published_at: string | null;
  }>;
}

/**
 * research_briefs.gaps of a partial brief: what failed and what the run already got. A pending
 * brief keeps here the searches its run already paid for (`failed` empty), reused when the job
 * runs again after a wait for the brain or a brain error.
 */
export interface ResearchGaps {
  failed: ResearchGap[];
  kept: KeptSearch[];
}

// --- Tables ----------------------------------------------------------------------------------

export const research_briefs = pgTable(
  "research_briefs",
  {
    id: idColumn("rb"),
    workspace_id: workspaceId(),
    company_id: text("company_id"),
    person_id: text("person_id"),
    status: text("status").$type<ResearchBriefStatus>().notNull().default("pending"),
    brief: jsonb("brief").$type<ResearchBrief>(),
    summary: text("summary"),
    sources: jsonb("sources").$type<ResearchSource[]>().notNull().default([]),
    model: text("model"),
    provider: text("provider"),
    cost_usd: numeric("cost_usd", { precision: 12, scale: 6, mode: "number" }),
    error: text("error"),
    /**
     * Partial briefs: the sources that failed and the searches kept for the next run. Pending
     * briefs: the searches already paid for, until the brief is written.
     */
    gaps: jsonb("gaps").$type<ResearchGaps>(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    index("research_briefs_company_idx").on(t.workspace_id, t.company_id, t.created_at.desc()),
    index("research_briefs_person_idx").on(t.workspace_id, t.person_id, t.created_at.desc()),
  ],
);

export const page_snapshots = pgTable(
  "page_snapshots",
  {
    id: idColumn("snap"),
    workspace_id: workspaceId(),
    company_id: text("company_id"),
    url: text("url").notNull(),
    /** SHA-256 of the normalized text. */
    content_hash: text("content_hash").notNull(),
    text: text("text").notNull(),
    prev_hash: text("prev_hash"),
    prev_text: text("prev_text"),
    fetched_at: tstz("fetched_at").notNull().defaultNow(),
    /** Last time the content hash changed. */
    changed_at: tstz("changed_at"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [unique("page_snapshots_workspace_url_uq").on(t.workspace_id, t.url)],
);

export type ResearchBriefRow = typeof research_briefs.$inferSelect;
export type NewResearchBriefRow = typeof research_briefs.$inferInsert;
export type PageSnapshot = typeof page_snapshots.$inferSelect;
export type NewPageSnapshot = typeof page_snapshots.$inferInsert;
