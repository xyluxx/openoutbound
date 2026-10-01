import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import type {
  LinkedInAccountStatus,
  LinkedInRelationStatus,
  MailboxAuthType,
  MailboxProviderLabel,
  MailboxStatus,
  SenderType,
} from "../../core/enums.js";
import type { Failure } from "../../core/failures.js";
import { newId } from "../../core/ids.js";
import { createdAt, idColumn, tstz, updatedAt } from "./columns.js";
import { workspaceId } from "./core.js";
import { people } from "./leads.js";

// --- JSON column types -----------------------------------------------------------------------

/** SMTP or IMAP server settings (the password lives in the vault: mailboxes.secret_id). */
export interface MailServerConfig {
  host: string;
  port: number;
  /** true = implicit TLS (465/993); false = STARTTLS. */
  secure: boolean;
  user: string;
}

/** OAuth state for Google/Microsoft mailboxes (tokens live in the vault). */
export interface MailboxOAuth {
  provider: "google" | "microsoft";
  scope?: string;
  /** secrets.id holding the refresh token. */
  refresh_token_secret_id?: string;
  access_token_expires_at?: string;
  tenant?: string;
}

/** Gradual volume increase for new senders. */
export interface RampConfig {
  enabled: boolean;
  /** Daily volume on the first sending day. */
  start: number;
  /** Added every `every_days`. */
  increment: number;
  every_days: number;
  /**
   * Days with no cold email before the first sending day (new domains: DNS, profile and real
   * mail only). Absent = 0.
   */
  delay_days?: number;
  /** ISO date the ramp started. */
  started_at?: string;
}

export interface MailboxDnsCheck {
  checked_at: string;
  mx: boolean;
  spf: boolean;
  dkim: boolean;
  dmarc: boolean;
  /** Human-readable problems with fix hints. */
  issues: string[];
  /** Worst check result: green, yellow or red. */
  overall?: "green" | "yellow" | "red";
  /** The domain checked. */
  domain?: string;
  /** Status of each check (rows stored before the daily DNS check have only the booleans). */
  statuses?: Partial<Record<"mx" | "spf" | "dkim" | "dmarc", "green" | "yellow" | "red">>;
}

export interface SenderHealth {
  sent_7d?: number;
  bounced_7d?: number;
  bounce_rate_7d?: number;
  consecutive_failures?: number;
  last_error?: string | null;
  last_error_at?: string | null;
  /** ISO time until which the provider throttled the sender (no sends before it). */
  throttled_until?: string | null;
  /** Set when the 7-day bounce rate crossed the warning threshold (2%). */
  bounce_warning_at?: string | null;
  /** Last IMAP sync problem (null after a clean sync). */
  last_sync_error?: string | null;
  /** Its failure class: auth_invalid for a refused login (null after a clean sync). */
  last_sync_failure?: Failure | null;
  /** First failed sync of the current streak (null after a clean sync). */
  sync_error_since?: string | null;
  /**
   * A message the reply sync could not store: its folder waits at it (an unsubscribe must not
   * be skipped). Kept until a sync gets past it; at 3 syncs in a row the read problem opens.
   */
  stuck_message?: StuckMessage | null;
  /** Set when the engine paused the sender for a health reason; cleared on resume. */
  auto_pause?: SenderAutoPause | null;
  /**
   * ISO time a person last resumed the sender (mailboxes.resume). The bounce-rate check only
   * counts sends from then on, so bounces from before the resume cannot pause it again.
   */
  resumed_at?: string | null;
  /** Mailboxes: the last login test (manage_mailboxes action test, or add with test). */
  last_test?: SenderLoginTest | null;
}

/** A message the reply sync stopped at because it could not store it. */
export interface StuckMessage {
  folder: string;
  uid: number;
  /** Why storing it failed (shortened). */
  error: string;
  /** ISO time of the first sync that stopped at it. */
  since: string;
  /** Syncs in a row that stopped at it. */
  syncs: number;
}

/** Outcome of a mailbox login test, kept so readiness can tell a tested mailbox. */
export interface SenderLoginTest {
  /** ISO time of the test. */
  at: string;
  smtp: "ok" | "failed" | "skipped";
  imap: "ok" | "failed" | "skipped";
}

/** Why the engine paused a sender by itself. */
export interface SenderAutoPause {
  /**
   * bounce_rate and provider_block hold the sender's queued mail until it resumes (moving it to
   * other senders would route around the pause); failures (a broken connection) lets it move.
   */
  kind: "bounce_rate" | "failures" | "provider_block";
  /** ISO time of the pause. */
  at: string;
  /** Provider status code behind a provider_block, e.g. 5.7.26 or 4.7.28. */
  status?: string | null;
  /** Sending domain paused as a whole (provider blocks). */
  domain?: string | null;
  /** ISO time the pause ends by itself (x.7.28 blocks: 48 hours); null = until resumed. */
  until?: string | null;
}

/** IMAP sync position (UID tracking per folder). */
export interface MailboxSyncState {
  folders?: Record<string, { uidvalidity: number; last_uid: number }>;
  /** Sent folder cursor (read when `inbox.read_sent_folder` is on); its own, apart from `folders`. */
  sent?: { path: string; uidvalidity: number; last_uid: number } | null;
}

/** Per-account LinkedIn limits (defaults in spec 11.9: invites 15/day and 80/week, ...). */
export interface LinkedInLimits {
  invites_per_day?: number;
  invites_per_week?: number;
  messages_per_day?: number;
  visits_per_day?: number;
  likes_per_day?: number;
  comments_per_day?: number;
  /**
   * Invitation notes per calendar month. Default: 3 for free accounts, unlimited for premium.
   * When used up, invites go out without a note.
   */
  invite_notes_per_month?: number | null;
}

export interface WorkingHours {
  /** ISO weekdays, 1 = Monday. */
  days: number[];
  start_hour: number;
  end_hour: number;
}

export interface LinkedInSyncState {
  /** Where an unfinished message listing continues (the provider stopped before the end). */
  messages_cursor?: string | null;
  /** Where an unfinished relations listing continues. */
  relations_cursor?: string | null;
  /** ISO time the unfinished message listing started: synced_at once it ends. */
  messages_cursor_started_at?: string | null;
  /** ISO time the unfinished relations listing started. */
  relations_cursor_started_at?: string | null;
  last_webhook_at?: string | null;
  /** ISO time of the last completed message sync. */
  messages_synced_at?: string | null;
  /** ISO time of the last completed relations sync. */
  relations_synced_at?: string | null;
  /** Sync runs in a row that failed; 0 after a clean run. At 5 a problem opens. */
  failed_syncs?: number;
  /** The first failure of the last sync run; null after a clean run. */
  last_error?: {
    at: string;
    step: "relations" | "messages" | "actions";
    message: string;
    failure: Failure;
  } | null;
  /** Hosted-auth connection waiting for the provider callback or a poll. */
  pending_auth?: {
    requested_at: string;
    expires_at?: string | null;
    /** Provider account ids that existed when the link was created (null = unknown). */
    known_account_ids?: string[] | null;
  } | null;
}

// --- Tables ----------------------------------------------------------------------------------

export const mailboxes = pgTable(
  "mailboxes",
  {
    id: idColumn("mbx"),
    workspace_id: workspaceId(),
    /** Lowercase. */
    email: text("email").notNull(),
    from_name: text("from_name"),
    provider_label: text("provider_label")
      .$type<MailboxProviderLabel>()
      .notNull()
      .default("custom"),
    auth_type: text("auth_type").$type<MailboxAuthType>().notNull().default("password"),
    smtp: jsonb("smtp").$type<MailServerConfig>(),
    imap: jsonb("imap").$type<MailServerConfig>(),
    /** Password or app password (secrets.id). */
    secret_id: text("secret_id"),
    oauth: jsonb("oauth").$type<MailboxOAuth>(),
    daily_limit: integer("daily_limit").notNull().default(30),
    ramp: jsonb("ramp").$type<RampConfig>(),
    min_gap_seconds: integer("min_gap_seconds").notNull().default(240),
    max_gap_seconds: integer("max_gap_seconds").notNull().default(720),
    signature: text("signature"),
    /** Extra warmup-mail markers (subject/body tags or header names) the inbound filter ignores. */
    warmup_patterns: text("warmup_patterns").array().notNull().default(sql`'{}'::text[]`),
    status: text("status").$type<MailboxStatus>().notNull().default("active"),
    status_reason: text("status_reason"),
    dns: jsonb("dns").$type<MailboxDnsCheck>(),
    health: jsonb("health").$type<SenderHealth>().notNull().default({}),
    sync_state: jsonb("sync_state").$type<MailboxSyncState>().notNull().default({}),
    last_synced_at: tstz("last_synced_at"),
    /**
     * Legacy: set for Google and Microsoft mailboxes when they were added, without proof.
     * No longer read; the proof is `sent_copies_seen_at`.
     */
    saves_sent_copies: boolean("saves_sent_copies"),
    /**
     * When the engine first found one of its own emails in this mailbox's Sent folder: proof that
     * the server keeps a copy of what it sends, so a copy that is still missing after a few
     * lookups means the email never left. Cleared when the SMTP or IMAP server or login changes.
     */
    sent_copies_seen_at: tstz("sent_copies_seen_at"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [unique("mailboxes_workspace_email_uq").on(t.workspace_id, t.email)],
);

export const linkedin_accounts = pgTable(
  "linkedin_accounts",
  {
    id: idColumn("lia"),
    workspace_id: workspaceId(),
    /** Provider id: "unipile", "sandbox", or a plug-in. */
    provider: text("provider").notNull(),
    /** Account id at the provider; null while a hosted-auth link is pending. */
    external_account_id: text("external_account_id"),
    name: text("name"),
    profile_url: text("profile_url"),
    status: text("status").$type<LinkedInAccountStatus>().notNull().default("pending"),
    status_reason: text("status_reason"),
    limits: jsonb("limits").$type<LinkedInLimits>().notNull().default({}),
    working_hours: jsonb("working_hours").$type<WorkingHours>(),
    timezone: text("timezone"),
    ramp: jsonb("ramp").$type<RampConfig>(),
    health: jsonb("health").$type<SenderHealth>().notNull().default({}),
    sync_state: jsonb("sync_state").$type<LinkedInSyncState>().notNull().default({}),
    connected_at: tstz("connected_at"),
    /** Premium (or Sales Navigator) account: 300-char invite notes, no monthly note cap. */
    premium: boolean("premium").notNull().default(false),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    unique("linkedin_accounts_workspace_provider_external_uq").on(
      t.workspace_id,
      t.provider,
      t.external_account_id,
    ),
  ],
);

export const linkedin_relations = pgTable(
  "linkedin_relations",
  {
    workspace_id: workspaceId(),
    account_id: text("account_id")
      .notNull()
      .references(() => linkedin_accounts.id, { onDelete: "cascade" }),
    person_id: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    status: text("status").$type<LinkedInRelationStatus>().notNull().default("none"),
    invited_at: tstz("invited_at"),
    connected_at: tstz("connected_at"),
    /** When the invitation was withdrawn (no re-invite for 30 days after). */
    withdrawn_at: tstz("withdrawn_at"),
    /** Provider reference (invitation id, member URN). */
    provider_ref: text("provider_ref"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "linkedin_relations_pk", columns: [t.account_id, t.person_id] }),
    index("linkedin_relations_person_idx").on(t.person_id),
    index("linkedin_relations_workspace_status_idx").on(t.workspace_id, t.status),
  ],
);

/** Daily action counters per sender (capacity and limits). */
export const sender_counters = pgTable(
  "sender_counters",
  {
    sender_type: text("sender_type").$type<SenderType>().notNull(),
    sender_id: text("sender_id").notNull(),
    /** YYYY-MM-DD in the sender's timezone. */
    day: date("day", { mode: "string" }).notNull(),
    /** e.g. "email", "invite", "message", "visit", "like", "comment". */
    action: text("action").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    primaryKey({
      name: "sender_counters_pk",
      columns: [t.sender_type, t.sender_id, t.day, t.action],
    }),
  ],
);

export const SOCIAL_ACCOUNT_STATUSES = ["active", "expired", "disconnected"] as const;
export type SocialAccountStatus = (typeof SOCIAL_ACCOUNT_STATUSES)[number];

/**
 * Accounts that publish posts through a social provider with their own credentials
 * (linkedin_official OAuth). Tokens live in the vault (`secret_id`). Unipile outreach accounts
 * publish through linkedin_accounts instead.
 */
export const social_accounts = pgTable(
  "social_accounts",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("sac")),
    workspace_id: workspaceId(),
    /** social provider id, e.g. "linkedin_official". */
    provider: text("provider").notNull(),
    /** Account id at the provider (member URN for LinkedIn). */
    external_id: text("external_id").notNull(),
    name: text("name"),
    /** Vault secret holding the JSON credentials (access token). */
    secret_id: text("secret_id"),
    status: text("status").$type<SocialAccountStatus>().notNull().default("active"),
    status_reason: text("status_reason"),
    /** When the access token expires (re-connect before). */
    expires_at: tstz("expires_at"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    unique("social_accounts_workspace_provider_external_uq").on(
      t.workspace_id,
      t.provider,
      t.external_id,
    ),
  ],
);

export type Mailbox = typeof mailboxes.$inferSelect;
export type NewMailbox = typeof mailboxes.$inferInsert;
export type LinkedInAccount = typeof linkedin_accounts.$inferSelect;
export type NewLinkedInAccount = typeof linkedin_accounts.$inferInsert;
export type LinkedInRelation = typeof linkedin_relations.$inferSelect;
export type NewLinkedInRelation = typeof linkedin_relations.$inferInsert;
export type SenderCounter = typeof sender_counters.$inferSelect;
export type NewSenderCounter = typeof sender_counters.$inferInsert;
export type SocialAccountRow = typeof social_accounts.$inferSelect;
export type NewSocialAccountRow = typeof social_accounts.$inferInsert;
