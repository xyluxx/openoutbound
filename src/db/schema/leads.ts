import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { ActorRef } from "../../core/context.js";
import type {
  CompanyStatus,
  EmailStatus,
  EnrichStatus,
  FactKind,
  FactScope,
  FactSource,
  FactStatus,
  ImportSource,
  ImportStatus,
  ListKind,
  PersonStatus,
  SavedSearchMode,
  SavedSearchSource,
  SuppressionReason,
  SuppressionType,
} from "../../core/enums.js";
import type { Failure } from "../../core/failures.js";
import { createdAt, idColumn, tstz, updatedAt } from "./columns.js";
import { workspaceId } from "./core.js";

// --- JSON column types -----------------------------------------------------------------------

/** Source/provider id -> external id, e.g. `{ apollo: "5f2...", google_maps: "ChIJ..." }`. */
export type SourceRefs = Record<string, string>;

/** One scoring rule outcome (fit_reasons). */
export interface FitReason {
  /** Rule or criterion key, e.g. "industry", "employee_range", "title". */
  rule: string;
  points: number;
  matched: boolean;
  detail?: string;
}

/** Custom fields: string keys, JSON values. */
export type CustomFields = Record<string, unknown>;

export interface ImportStats {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  suppressed?: number;
  /** Existing records whose empty fields were filled (merge policy fill_empty). */
  merged?: number;
  /** Skipped rows by reason: duplicate, suppressed, invalid, consent_country, excluded_country, no_website, no_match. */
  skipped_by_reason?: Record<string, number>;
  companies_created?: number;
  companies_updated?: number;
  /** Rows processed so far (progress checkpoint of import jobs). */
  processed?: number;
}

/** A provider call of an enrichment run that failed: the step, the provider and why. */
export interface EnrichmentFailedStep {
  step: "finder" | "verifier";
  provider: string;
  failure: Failure;
}

/**
 * people.enrichment: what the last enrichment run did for the person (owned by the enrichment
 * module), so the next run asks only what failed.
 */
export interface PersonEnrichment {
  /** ISO time of the run. */
  at: string;
  status: EnrichStatus;
  /**
   * Paid finder id -> ISO time it last answered "no match" (or only an unusable address). Not
   * asked again for 30 days unless forced.
   */
  no_match?: Record<string, string>;
  /**
   * The paid finder whose address is on file, that address and when it found it. A run that
   * asks failed finders again skips it while the address is on file and was checked in the
   * last 30 days, so the address is not paid for twice.
   */
  found_by?: { provider: string; email: string; at: string };
  /** Provider calls of that run that failed. */
  failed?: EnrichmentFailedStep[];
  /** When the engine tries the failed steps again by itself; null when it does not. */
  retry_at?: string | null;
}

export interface ImportRowError {
  row: number;
  message: string;
  field?: string;
  /** Stable reason code, e.g. duplicate, suppressed, invalid, consent_country. */
  code?: string;
}

// --- Tables ----------------------------------------------------------------------------------

export const companies = pgTable(
  "companies",
  {
    id: idColumn("co"),
    workspace_id: workspaceId(),
    name: text("name").notNull(),
    /** Lowercase, no www., no scheme or path (normalizeDomain). */
    domain: text("domain"),
    website: text("website"),
    linkedin_url: text("linkedin_url"),
    industry: text("industry"),
    description: text("description"),
    employee_count: integer("employee_count"),
    employee_range: text("employee_range"),
    revenue_range: text("revenue_range"),
    founded_year: integer("founded_year"),
    /** ISO 3166-1 alpha-2. */
    country: text("country"),
    region: text("region"),
    city: text("city"),
    address: text("address"),
    postal_code: text("postal_code"),
    phone: text("phone"),
    /** IANA timezone. */
    timezone: text("timezone"),
    technologies: text("technologies").array().notNull().default(sql`'{}'::text[]`),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    custom: jsonb("custom").$type<CustomFields>().notNull().default({}),
    /** Where the record first came from: csv, apollo, google_maps, api, ... */
    source: text("source"),
    source_refs: jsonb("source_refs").$type<SourceRefs>().notNull().default({}),
    fit_score: integer("fit_score"),
    fit_reasons: jsonb("fit_reasons").$type<FitReason[]>(),
    intent_score: integer("intent_score"),
    status: text("status").$type<CompanyStatus>().notNull().default("active"),
    last_researched_at: tstz("last_researched_at"),
    /** No outreach to anyone at the company before this time (a company hold). */
    hold_until: tstz("hold_until"),
    hold_reason: text("hold_reason"),
    /** The CRM reports an open deal; blocks outreach unless crm.allow_outreach_with_open_deal. */
    crm_open_deal: boolean("crm_open_deal").notNull().default(false),
    /** Sales rep who owns the account in the CRM; blocks outreach when crm.skip_owned_accounts. */
    crm_owner: text("crm_owner"),
    /** When a CRM last reported on this company. */
    crm_updated_at: tstz("crm_updated_at"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    uniqueIndex("companies_workspace_domain_uq")
      .on(t.workspace_id, t.domain)
      .where(sql`${t.domain} is not null`),
    index("companies_workspace_idx").on(t.workspace_id, t.created_at),
  ],
);

export const people = pgTable(
  "people",
  {
    id: idColumn("pe"),
    workspace_id: workspaceId(),
    company_id: text("company_id").references(() => companies.id, { onDelete: "set null" }),
    first_name: text("first_name"),
    last_name: text("last_name"),
    full_name: text("full_name"),
    title: text("title"),
    seniority: text("seniority"),
    department: text("department"),
    /** Lowercase. */
    email: text("email"),
    email_status: text("email_status").$type<EmailStatus>().notNull().default("unknown"),
    email_checked_at: tstz("email_checked_at"),
    /** Provider or method that produced the email (import, apollo, icypeas, website, ...). */
    email_source: text("email_source"),
    /**
     * When the paid email finders last looked for this person and found no usable address.
     * Enrichment does not pay them again for 30 days unless forced; cleared once one is found.
     */
    email_not_found_at: tstz("email_not_found_at"),
    /** The last enrichment run: its outcome, the finders that answered and what failed. */
    enrichment: jsonb("enrichment").$type<PersonEnrichment>(),
    /** Normalized https://www.linkedin.com/in/<slug> (normalizeLinkedinUrl). */
    linkedin_url: text("linkedin_url"),
    phone: text("phone"),
    country: text("country"),
    region: text("region"),
    city: text("city"),
    timezone: text("timezone"),
    /** BCP 47 language tag for writing, e.g. "en", "de". */
    language: text("language"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    custom: jsonb("custom").$type<CustomFields>().notNull().default({}),
    source: text("source"),
    source_refs: jsonb("source_refs").$type<SourceRefs>().notNull().default({}),
    status: text("status").$type<PersonStatus>().notNull().default("new"),
    fit_score: integer("fit_score"),
    fit_reasons: jsonb("fit_reasons").$type<FitReason[]>(),
    last_contacted_at: tstz("last_contacted_at"),
    /**
     * Random booking reference tagged onto booking links sent to this person, so a booking
     * made from another address still matches. Created on first use, unique per workspace.
     */
    booking_ref: text("booking_ref"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    uniqueIndex("people_workspace_email_uq")
      .on(t.workspace_id, t.email)
      .where(sql`${t.email} is not null`),
    uniqueIndex("people_workspace_linkedin_uq")
      .on(t.workspace_id, t.linkedin_url)
      .where(sql`${t.linkedin_url} is not null`),
    index("people_workspace_company_idx").on(t.workspace_id, t.company_id),
    index("people_workspace_status_idx").on(t.workspace_id, t.status),
    // Reports count new leads by time window.
    index("people_workspace_created_idx").on(t.workspace_id, t.created_at),
    uniqueIndex("people_workspace_booking_ref_uq")
      .on(t.workspace_id, t.booking_ref)
      .where(sql`${t.booking_ref} is not null`),
  ],
);

export const lists = pgTable(
  "lists",
  {
    id: idColumn("ls"),
    workspace_id: workspaceId(),
    name: text("name").notNull(),
    description: text("description"),
    kind: text("kind").$type<ListKind>().notNull().default("static"),
    /** Smart lists: saved people filter (owned by the leads module). */
    filter: jsonb("filter").$type<Record<string, unknown>>(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [unique("lists_workspace_name_uq").on(t.workspace_id, t.name)],
);

export const list_members = pgTable(
  "list_members",
  {
    list_id: text("list_id")
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    person_id: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    added_at: tstz("added_at").notNull().defaultNow(),
    added_by: jsonb("added_by").$type<ActorRef>(),
  },
  (t) => [
    primaryKey({ name: "list_members_pk", columns: [t.list_id, t.person_id] }),
    index("list_members_person_idx").on(t.person_id),
  ],
);

export const icps = pgTable(
  "icps",
  {
    id: idColumn("icp"),
    workspace_id: workspaceId(),
    name: text("name").notNull(),
    description: text("description"),
    /** Who fits (industries, sizes, countries, titles, ...). Schema owned by the leads module. */
    criteria: jsonb("criteria").$type<Record<string, unknown>>().notNull().default({}),
    /** Points per criterion and thresholds. Schema owned by the leads module. */
    scoring: jsonb("scoring").$type<Record<string, unknown>>().notNull().default({}),
    signal_keys: text("signal_keys").array().notNull().default(sql`'{}'::text[]`),
    is_default: boolean("is_default").notNull().default(false),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [index("icps_workspace_idx").on(t.workspace_id)],
);

export const imports = pgTable(
  "imports",
  {
    id: idColumn("imp"),
    workspace_id: workspaceId(),
    source: text("source").$type<ImportSource>().notNull(),
    status: text("status").$type<ImportStatus>().notNull().default("pending"),
    file_name: text("file_name"),
    /** Source column -> field (e.g. "E-Mail" -> "email", "Firma" -> "company.name"). */
    mapping: jsonb("mapping").$type<Record<string, string>>(),
    options: jsonb("options").$type<Record<string, unknown>>().notNull().default({}),
    stats: jsonb("stats").$type<ImportStats>(),
    errors: jsonb("errors").$type<ImportRowError[]>(),
    list_id: text("list_id"),
    created_by: jsonb("created_by").$type<ActorRef>(),
    finished_at: tstz("finished_at"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [index("imports_workspace_created_idx").on(t.workspace_id, t.created_at)],
);

export const suppressions = pgTable(
  "suppressions",
  {
    id: idColumn("sup"),
    workspace_id: workspaceId(),
    type: text("type").$type<SuppressionType>().notNull(),
    /** Normalized: lowercase email, bare domain, normalized LinkedIn URL, or record id. */
    value: text("value").notNull(),
    reason: text("reason").$type<SuppressionReason>().notNull(),
    note: text("note"),
    /** What created it: "unsubscribe_link", "reply", "bounce", "import", "api", ... */
    source: text("source"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [unique("suppressions_workspace_type_value_uq").on(t.workspace_id, t.type, t.value)],
);

export const saved_searches = pgTable(
  "saved_searches",
  {
    id: idColumn("ss"),
    workspace_id: workspaceId(),
    name: text("name").notNull(),
    source: text("source").$type<SavedSearchSource>().notNull(),
    /** PeopleQuery / CompanyQuery / leads filter, depending on source. */
    query: jsonb("query").$type<Record<string, unknown>>().notNull().default({}),
    icp_id: text("icp_id"),
    /** Cron expression; null = manual only. */
    schedule: text("schedule"),
    mode: text("mode").$type<SavedSearchMode>().notNull().default("manual"),
    min_fit_score: integer("min_fit_score"),
    max_results: integer("max_results"),
    spend_cap_credits: integer("spend_cap_credits"),
    list_id: text("list_id"),
    campaign_id: text("campaign_id"),
    enabled: boolean("enabled").notNull().default(true),
    last_run_at: tstz("last_run_at"),
    next_run_at: tstz("next_run_at"),
    last_result: jsonb("last_result").$type<Record<string, unknown>>(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [index("saved_searches_workspace_idx").on(t.workspace_id)],
);

/**
 * The lead file and the company file: short, neutral business facts with their source and
 * date. `scope` says whom a fact is about; person-scope facts carry `person_id`, company-scope
 * facts carry `company_id` (and the person they came from, when known).
 */
export const lead_facts = pgTable(
  "lead_facts",
  {
    id: idColumn("lf"),
    workspace_id: workspaceId(),
    person_id: text("person_id"),
    company_id: text("company_id"),
    scope: text("scope").$type<FactScope>().notNull(),
    kind: text("kind").$type<FactKind>().notNull(),
    /** At most 280 characters, whitespace collapsed. */
    text: text("text").notNull(),
    source: text("source").$type<FactSource>().notNull(),
    /** The record behind the fact: message id for replies, CRM name for crm. */
    source_ref: text("source_ref"),
    observed_at: tstz("observed_at").notNull(),
    expires_at: tstz("expires_at"),
    status: text("status").$type<FactStatus>().notNull().default("active"),
    /** The fact that corrected this one. */
    replaced_by: text("replaced_by"),
    created_by: jsonb("created_by").$type<ActorRef>(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    index("lead_facts_workspace_person_idx").on(t.workspace_id, t.person_id, t.status),
    index("lead_facts_workspace_company_idx").on(t.workspace_id, t.company_id, t.status),
    // Erasure and retention delete the facts taken from a person's replies by message id.
    index("lead_facts_workspace_source_idx").on(t.workspace_id, t.source, t.source_ref),
  ],
);

export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
export type Person = typeof people.$inferSelect;
export type NewPerson = typeof people.$inferInsert;
export type List = typeof lists.$inferSelect;
export type NewList = typeof lists.$inferInsert;
export type ListMember = typeof list_members.$inferSelect;
export type NewListMember = typeof list_members.$inferInsert;
export type Icp = typeof icps.$inferSelect;
export type NewIcp = typeof icps.$inferInsert;
export type Import = typeof imports.$inferSelect;
export type NewImport = typeof imports.$inferInsert;
export type Suppression = typeof suppressions.$inferSelect;
export type NewSuppression = typeof suppressions.$inferInsert;
export type SavedSearch = typeof saved_searches.$inferSelect;
export type NewSavedSearch = typeof saved_searches.$inferInsert;
export type LeadFact = typeof lead_facts.$inferSelect;
export type NewLeadFact = typeof lead_facts.$inferInsert;
