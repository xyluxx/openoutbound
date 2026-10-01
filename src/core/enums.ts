/**
 * Every text "enum" used by the data model, as `const` arrays plus TS unions.
 *
 * Postgres stores these as plain text (no pg enums) so plug-ins can extend them. Use the arrays
 * with `z.enum(...)` in operation inputs and the unions with `$type<>()` in the schema.
 */

// --- Principals and access -------------------------------------------------------------------

export const SCOPES = ["read", "write", "send", "spend", "approve", "admin"] as const;
/** Permission carried by an API key or principal. */
export type Scope = (typeof SCOPES)[number];

export const EFFECTS = ["read", "write", "send", "spend", "destructive", "admin"] as const;
/** What an operation does to the world. Drives default scopes, MCP annotations, audit and dry runs. */
export type Effect = (typeof EFFECTS)[number];

export const VIAS = ["cli", "http", "mcp", "worker", "system"] as const;
/** Door a call came through. */
export type Via = (typeof VIAS)[number];

export const PRINCIPAL_TYPES = ["human", "agent", "service", "system"] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

export const API_KEY_KINDS = ["human", "agent", "service"] as const;
export type ApiKeyKind = (typeof API_KEY_KINDS)[number];

// --- Core ------------------------------------------------------------------------------------

export const WORKSPACE_STATUSES = ["active", "paused", "archived"] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

export const AUDIT_STATUSES = ["ok", "error", "awaiting_approval", "dry_run"] as const;
export type AuditStatus = (typeof AUDIT_STATUSES)[number];

export const APPROVAL_KINDS = [
  "message",
  "reply",
  "campaign_launch",
  "lead_import",
  "enrollment",
  "post",
  "comment",
  "spend",
  /** A reply pointed to another person: add them as a lead (inbox). */
  "referral",
  /** An agent raised a mailbox's daily limit above the safe level or cut a warming ramp (email). */
  "mailbox_limits",
  /** An agent proposed a change that needs an owner's approval (strategy). */
  "change",
  /** Someone who must ask for approval lowered a campaign's review level (campaigns). */
  "review_level",
  /**
   * Someone who must ask for approval let an automation enroll people without asking first
   * (require_approval off on a rule with enroll actions; signals).
   */
  "automation_approval",
  /** Free for custom modules; no built-in module handles it. */
  "custom",
] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "expired",
  "cancelled",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVAL_DECISIONS = ["approve", "reject", "edit"] as const;
/** `edit` = approve with edited payload fields (for messages: subject/body). */
export type ApprovalDecisionKind = (typeof APPROVAL_DECISIONS)[number];

export const JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "waiting",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const WEBHOOK_DELIVERY_STATUSES = ["pending", "delivered", "failed"] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

export const AGENT_TASK_STATUSES = ["open", "claimed", "done", "failed", "expired"] as const;
export type AgentTaskStatus = (typeof AGENT_TASK_STATUSES)[number];

export const NOTIFICATION_CHANNEL_TYPES = ["slack_webhook", "email", "webhook"] as const;
export type NotificationChannelType = (typeof NOTIFICATION_CHANNEL_TYPES)[number];

// --- Knowledge -------------------------------------------------------------------------------

export const KNOWLEDGE_KINDS = [
  "about",
  "product",
  "offer_detail",
  "proof",
  "case_study",
  "objection",
  "faq",
  "voice_sample",
  "rule",
  "persona",
  "competitor",
  /** What works for this client, with its source and sample size; guidance, never a fact to state. */
  "lesson",
  "other",
] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

export const KNOWLEDGE_STATUSES = ["active", "suggested", "archived"] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

export const KNOWLEDGE_SOURCE_TYPES = ["manual", "url", "file", "reply", "ai"] as const;
export type KnowledgeSourceType = (typeof KNOWLEDGE_SOURCE_TYPES)[number];

export const OFFER_STATUSES = ["active", "archived"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export const KNOWLEDGE_GAP_STATUSES = ["open", "answered", "dismissed"] as const;
export type KnowledgeGapStatus = (typeof KNOWLEDGE_GAP_STATUSES)[number];

// --- Leads -----------------------------------------------------------------------------------

export const COMPANY_STATUSES = [
  "active",
  "customer",
  "competitor",
  "do_not_contact",
  "archived",
] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

export const EMAIL_STATUSES = [
  "unknown",
  "valid",
  "invalid",
  "catch_all",
  "risky",
  "unverifiable",
] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

/**
 * Outcome of one person's enrichment run (people.enrichment, enrichment.completed).
 * provider_failed: a finder or the verifier failed and nothing usable came of the run.
 */
export const ENRICH_STATUSES = [
  "found",
  "verified",
  "kept",
  "not_found",
  "skipped",
  "provider_failed",
] as const;
export type EnrichStatus = (typeof ENRICH_STATUSES)[number];

export const PERSON_STATUSES = [
  "new",
  "active",
  "replied",
  "interested",
  "meeting",
  "customer",
  "not_interested",
  "do_not_contact",
  "bounced",
  "unsubscribed",
] as const;
export type PersonStatus = (typeof PERSON_STATUSES)[number];

export const LIST_KINDS = ["static", "smart"] as const;
export type ListKind = (typeof LIST_KINDS)[number];

export const IMPORT_SOURCES = [
  "csv",
  "xlsx",
  "json",
  "rows",
  "apollo",
  "google_maps",
  "api",
] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

/** partial: a paid source failed part way; what came back was imported (see the errors). */
export const IMPORT_STATUSES = [
  "pending",
  "previewed",
  "running",
  "completed",
  "partial",
  "failed",
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const SUPPRESSION_TYPES = ["email", "domain", "linkedin", "person", "company"] as const;
export type SuppressionType = (typeof SUPPRESSION_TYPES)[number];

export const SUPPRESSION_REASONS = [
  "unsubscribed",
  "bounced",
  "complaint",
  "manual",
  "customer",
  "competitor",
  "do_not_contact",
  "gdpr_erasure",
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export const SAVED_SEARCH_SOURCES = ["apollo", "google_maps", "leads"] as const;
export type SavedSearchSource = (typeof SAVED_SEARCH_SOURCES)[number];

export const SAVED_SEARCH_MODES = ["manual", "ask_first", "auto_import"] as const;
export type SavedSearchMode = (typeof SAVED_SEARCH_MODES)[number];

// --- Research and signals --------------------------------------------------------------------

/** partial: built while a source failed; the brief lists the gaps and a later run fills them. */
export const RESEARCH_BRIEF_STATUSES = ["pending", "ready", "partial", "failed"] as const;
export type ResearchBriefStatus = (typeof RESEARCH_BRIEF_STATUSES)[number];

export const SIGNAL_DEFINITION_KINDS = ["builtin", "custom"] as const;
export type SignalDefinitionKind = (typeof SIGNAL_DEFINITION_KINDS)[number];

export const SIGNAL_STATUSES = ["new", "seen", "used", "dismissed"] as const;
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

// --- Channels --------------------------------------------------------------------------------

export const MAILBOX_PROVIDER_LABELS = [
  "google",
  "microsoft",
  "zoho",
  "custom",
  "sandbox",
] as const;
export type MailboxProviderLabel = (typeof MAILBOX_PROVIDER_LABELS)[number];

export const MAILBOX_AUTH_TYPES = [
  "password",
  "oauth_google",
  "oauth_microsoft",
  "sandbox",
] as const;
export type MailboxAuthType = (typeof MAILBOX_AUTH_TYPES)[number];

export const MAILBOX_STATUSES = ["active", "paused", "error", "warming", "disconnected"] as const;
export type MailboxStatus = (typeof MAILBOX_STATUSES)[number];

export const LINKEDIN_ACCOUNT_STATUSES = [
  "active",
  "paused",
  "restricted",
  "disconnected",
  "pending",
] as const;
export type LinkedInAccountStatus = (typeof LINKEDIN_ACCOUNT_STATUSES)[number];

export const LINKEDIN_RELATION_STATUSES = [
  "none",
  "invited",
  "connected",
  "withdrawn",
  "failed",
] as const;
export type LinkedInRelationStatus = (typeof LINKEDIN_RELATION_STATUSES)[number];

export const SENDER_TYPES = ["mailbox", "linkedin"] as const;
export type SenderType = (typeof SENDER_TYPES)[number];

// --- Campaigns and inbox ---------------------------------------------------------------------

export const CAMPAIGN_STATUSES = ["draft", "active", "paused", "completed", "archived"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const CAMPAIGN_GOALS = ["reply", "meeting", "visit", "custom"] as const;
export type CampaignGoal = (typeof CAMPAIGN_GOALS)[number];

export const STEP_TYPES = [
  "email",
  "linkedin_visit",
  "linkedin_like",
  "linkedin_comment",
  "linkedin_invite",
  "linkedin_message",
  "wait",
  "condition",
  "task",
  "webhook",
] as const;
export type StepType = (typeof STEP_TYPES)[number];

export const ENROLLMENT_STATUSES = [
  "queued",
  "active",
  "paused",
  "waiting_review",
  "completed",
  "stopped",
  "failed",
] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

export const CHANNELS = ["email", "linkedin"] as const;
export type Channel = (typeof CHANNELS)[number];

export const THREAD_STATUSES = ["open", "waiting", "closed"] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];

export const MESSAGE_ACTIONS = [
  "email",
  "reply",
  "invite",
  "message",
  "comment",
  "like",
  "visit",
] as const;
export type MessageAction = (typeof MESSAGE_ACTIONS)[number];

export const MESSAGE_DIRECTIONS = ["outbound", "inbound"] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const MESSAGE_STATUSES = [
  "draft",
  "generating",
  "pending_review",
  "approved",
  "scheduled",
  "sending",
  /**
   * Handed to the provider but the outcome is unclear (timeout, lost connection, crash while
   * sending). Reconciled before any retry and never resent blindly; like `sending`, it is not
   * final, not retried and not counted as sent.
   */
  "unknown",
  "sent",
  "failed",
  "skipped",
  "bounced",
  "cancelled",
  "received",
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const MESSAGE_ORIGINS = ["engine", "external"] as const;
/** engine = written and sent by the engine; external = found in the mailbox's Sent folder, written outside the engine. */
export type MessageOrigin = (typeof MESSAGE_ORIGINS)[number];

export const THREAD_OWNERS = ["engine", "person"] as const;
/** person = a human answered in the thread, so the engine steps back until it is handed back. */
export type ThreadOwner = (typeof THREAD_OWNERS)[number];

export const TEMPLATE_KINDS = ["campaign", "step", "message"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export const OPPORTUNITY_STAGES = ["interested", "meeting_booked", "won", "lost"] as const;
export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];

export const TASK_TYPES = [
  "call",
  "manual_email",
  "linkedin",
  "follow_up",
  /** A promise we made in a reply (for example "I will send the case study on Monday"). */
  "promise",
  "other",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_STATUSES = ["open", "done", "skipped"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const POST_STATUSES = [
  "draft",
  "pending_review",
  "approved",
  "scheduled",
  /** Claimed by a publish attempt: the request to the provider is being made. */
  "publishing",
  /**
   * The request reached the provider but no clear answer came back (a timeout, a lost
   * connection, a server error, an attempt that stopped): it may be live. Never published again
   * on its own; a person settles it with `posts.resolve_unknown`.
   */
  "unknown",
  "published",
  /** Not published: nothing was handed over, or the provider refused it. */
  "failed",
] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

/** Reply classification categories (spec 11.11). */
export const REPLY_CATEGORIES = [
  "interested",
  "meeting_request",
  "question",
  "objection",
  "not_now",
  "referral",
  "wrong_person",
  "out_of_office",
  "unsubscribe",
  /** Asks to delete their data, what data we hold, or where we got their details (locked). */
  "privacy_request",
  "bounce",
  "negative",
  "auto_reply_other",
  "other",
] as const;
export type ReplyCategory = (typeof REPLY_CATEGORIES)[number];

// --- Meetings --------------------------------------------------------------------------------

export const MEETING_SOURCES = ["calendly", "cal_com", "generic", "manual"] as const;
/** Where a meeting record came from: a booking tool webhook, or recorded by a person or agent. */
export type MeetingSource = (typeof MEETING_SOURCES)[number];

export const MEETING_STATUSES = ["scheduled", "held", "no_show", "cancelled"] as const;
/** A reschedule updates the time and keeps `scheduled`. */
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const MEETING_MATCHES = ["ref", "email", "manual"] as const;
/** How a booking was matched to a person: the hidden booking reference, the attendee email, or by hand. */
export type MeetingMatch = (typeof MEETING_MATCHES)[number];

export const BOOKING_MODES = ["link", "handoff", "off"] as const;
/** link = replies share the booking link; handoff = a person or agent books; off = never offer meetings. */
export type BookingMode = (typeof BOOKING_MODES)[number];

// --- Lead file -------------------------------------------------------------------------------

export const FACT_KINDS = [
  "fact",
  "timing",
  "preference",
  "objection",
  "relationship",
  "note",
] as const;
/** Kind of a lead-file fact; `note` is written by people and agents, never extracted from replies. */
export type FactKind = (typeof FACT_KINDS)[number];

export const FACT_SCOPES = ["person", "company"] as const;
export type FactScope = (typeof FACT_SCOPES)[number];

export const FACT_SOURCES = ["reply", "manual", "agent", "crm", "research"] as const;
/** Where a fact came from; `source_ref` names the record (message id for replies, CRM name for crm). */
export type FactSource = (typeof FACT_SOURCES)[number];

export const FACT_STATUSES = ["active", "corrected", "expired", "removed"] as const;
/** Only `active` facts reach the writer; the others stay visible in the lead file. */
export type FactStatus = (typeof FACT_STATUSES)[number];

export const PRIVACY_KINDS = ["delete", "access", "source"] as const;
/** What a privacy request asks: delete their data, see the data we hold, or where we got it. */
export type PrivacyKind = (typeof PRIVACY_KINDS)[number];

// --- Problems --------------------------------------------------------------------------------

export const PROBLEM_KINDS = [
  "privacy_request",
  "meeting_to_book",
  "unmatched_booking",
  "send_unknown",
  "send_failed",
  "mailbox_down",
  "brain_down",
  "crm_sync_failed",
  "crm_forget",
  "dns_failed",
  "promise_overdue",
  "company_hold_suggested",
  "stuck",
  "provider_down",
  "duplicate_send",
  "sending_blocked",
  "custom",
] as const;
/** What a problem item (the attention queue) is about. */
export type ProblemKind = (typeof PROBLEM_KINDS)[number];

export const PROBLEM_SEVERITIES = ["urgent", "high", "normal", "low"] as const;
/** Most severe first; lists sort in this order. */
export type ProblemSeverity = (typeof PROBLEM_SEVERITIES)[number];

export const PROBLEM_OWNERS = ["person", "agent", "anyone"] as const;
/** Who should handle a problem: a person, the connected agent, or whoever gets to it first. */
export type ProblemOwner = (typeof PROBLEM_OWNERS)[number];

export const PROBLEM_STATUSES = ["open", "snoozed", "resolved"] as const;
/** A snoozed problem counts as open again once its `snoozed_until` passes. */
export type ProblemStatus = (typeof PROBLEM_STATUSES)[number];

// --- Changes and proposals -------------------------------------------------------------------

export const CHANGE_AREAS = ["settings", "offer", "icp", "campaign"] as const;
/** What a change log entry changed. */
export type ChangeArea = (typeof CHANGE_AREAS)[number];

export const PROPOSAL_STATUSES = [
  "proposed",
  "awaiting_approval",
  "applied",
  "rejected",
  "failed",
  "reverted",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const PROPOSAL_VERDICTS = ["better", "worse", "flat", "unclear"] as const;
/** Whether an applied change helped, from its before and after numbers. */
export type ProposalVerdict = (typeof PROPOSAL_VERDICTS)[number];

// --- CRM -------------------------------------------------------------------------------------

export const CRM_FACTS = [
  "customer",
  "not_customer",
  "open_deal",
  "no_open_deal",
  "closed_lost",
  "owned_by",
  "do_not_contact",
] as const;
/** What a CRM (or an agent reading one) reports about a person or company. */
export type CrmFact = (typeof CRM_FACTS)[number];

export const REVIEW_LEVELS = ["every", "first", "unsure"] as const;
/** every = review all messages; first = first message per campaign step; unsure = only when the checker is unsure. */
export type ReviewLevel = (typeof REVIEW_LEVELS)[number];

export const MODEL_TIERS = ["fast", "standard", "deep"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** MCP toolsets (spec 9.1). `all` is a selector, not a toolset. */
export const TOOLSETS = [
  "core",
  "leads",
  "campaigns",
  "inbox",
  "signals",
  "content",
  "admin",
  "agent_brain",
] as const;
export type Toolset = (typeof TOOLSETS)[number];
