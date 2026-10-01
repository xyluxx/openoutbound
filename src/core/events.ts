import type { JobContext } from "./context.js";
import type {
  ApprovalKind,
  ApprovalStatus,
  ChangeArea,
  Channel,
  CrmFact,
  EmailStatus,
  EnrichStatus,
  FactKind,
  FactSource,
  MeetingMatch,
  MeetingSource,
  MessageAction,
  MessageStatus,
  OpportunityStage,
  PrivacyKind,
  ProblemKind,
  ProblemSeverity,
  ProposalVerdict,
  ReplyCategory,
} from "./enums.js";

/** The record an event is about (stored as events.subject_type / subject_id). */
export interface EventSubject {
  /** Singular table noun: "person", "company", "message", "thread", "campaign", ... */
  type: string;
  id: string;
}

/**
 * Typed payload per event type (spec 5.5). Payloads are snake_case JSON (they are delivered
 * to webhooks as is), hold ids rather than full records, and never contain message bodies or
 * secrets. Add fields compatibly; never rename.
 */
export interface EventData {
  /** A person or company was created (import, find, API, referral). */
  "lead.created": {
    kind: "person" | "company";
    id: string;
    source: string | null;
    import_id: string | null;
  };
  "lead.updated": {
    kind: "person" | "company";
    id: string;
    /** Changed field names. */
    changes: string[];
  };
  "import.completed": {
    import_id: string;
    source: string;
    /** partial: a paid source failed part way and only what came back was imported. */
    status: "completed" | "partial" | "failed";
    list_id: string | null;
    stats: { created: number; updated: number; skipped: number; failed: number };
  };
  "enrichment.completed": {
    person_id: string;
    email: string | null;
    email_status: EmailStatus;
    /** Provider that found the email, or null when none did. */
    provider: string | null;
    /** provider_failed: a finder or the verifier failed and nothing usable came of the run. */
    status: EnrichStatus;
    credits_used: number;
  };
  "research.completed": {
    brief_id: string;
    company_id: string | null;
    person_id: string | null;
    /** partial: built while a source failed; the brief lists the gaps. */
    status: "ready" | "partial" | "failed";
    /** Brief confidence; null when the brief failed. */
    confidence?: "low" | "medium" | "high" | null;
  };
  "signal.detected": {
    signal_id: string;
    definition_key: string;
    company_id: string | null;
    person_id: string | null;
    title: string;
    evidence_url: string | null;
    strength: number;
    score: number;
  };
  /**
   * A signal automation asks the campaigns module to enroll people. Campaigns applies its usual
   * checks (suppression, one active campaign per person, contactability) before enrolling.
   */
  "automation.enroll_requested": {
    rule_id: string;
    campaign_id: string;
    person_ids: string[];
    signal_id: string;
  };
  "campaign.launched": { campaign_id: string; name: string };
  "campaign.paused": { campaign_id: string; reason: string | null };
  "campaign.completed": { campaign_id: string };
  "enrollment.stopped": {
    enrollment_id: string;
    campaign_id: string;
    person_id: string;
    /** e.g. "replied", "company_replied", "meeting_booked", "unsubscribed", "bounced", "manual". */
    reason: string;
  };
  "message.drafted": {
    message_id: string;
    person_id: string | null;
    campaign_id: string | null;
    channel: Channel;
    action: MessageAction;
    status: MessageStatus;
  };
  "message.approved": { message_id: string; approval_id: string | null };
  "message.sent": {
    message_id: string;
    thread_id: string | null;
    person_id: string | null;
    campaign_id: string | null;
    channel: Channel;
    action: MessageAction;
    /** ISO 8601. */
    sent_at: string;
  };
  "message.failed": { message_id: string; error: string; retryable: boolean };
  "message.bounced": {
    message_id: string | null;
    person_id: string | null;
    email: string;
    bounce_type: "hard" | "soft";
    reason: string | null;
  };
  "reply.received": {
    message_id: string;
    thread_id: string;
    person_id: string | null;
    campaign_id: string | null;
    channel: Channel;
  };
  "reply.classified": {
    message_id: string;
    thread_id: string;
    person_id: string | null;
    category: ReplyCategory;
    confidence: number;
  };
  "thread.needs_attention": {
    thread_id: string;
    reason: string;
    category: ReplyCategory | null;
  };
  "approval.requested": {
    approval_id: string;
    kind: ApprovalKind;
    title: string;
    target_type: string | null;
    target_id: string | null;
  };
  "approval.decided": {
    approval_id: string;
    kind: ApprovalKind;
    decision: "approve" | "reject" | "edit";
    status: ApprovalStatus;
  };
  "opportunity.updated": {
    opportunity_id: string;
    stage: OpportunityStage;
    previous_stage: OpportunityStage | null;
    person_id: string | null;
    company_id: string | null;
  };
  "mailbox.paused": { mailbox_id: string; email: string; reason: string };
  "mailbox.error": { mailbox_id: string; email: string; error: string };
  /** A prospect accepted a connection invite (relation became `connected`). */
  "linkedin.connected": { account_id: string; person_id: string; connected_at: string };
  "linkedin.account_restricted": { account_id: string; reason: string };
  "post.published": { post_id: string; url: string | null; external_id: string | null };
  "knowledge.gap_opened": { gap_id: string; question: string; thread_id: string | null };
  "report.ready": { report_id: string; type: string };
  "unsubscribe.received": {
    person_id: string | null;
    email: string | null;
    /** link = footer link page, one_click = RFC 8058 POST, reply = classified reply, manual. */
    source: "link" | "one_click" | "reply" | "manual";
    message_id: string | null;
  };
  /** A meeting was booked (webhook or recorded by a person or agent); `start_at` is ISO 8601. */
  "meeting.booked": {
    meeting_id: string;
    person_id: string | null;
    opportunity_id: string | null;
    source: MeetingSource;
    start_at: string | null;
    matched_by: MeetingMatch;
  };
  /** A booked meeting moved to another time; it stays `scheduled`. */
  "meeting.rescheduled": {
    meeting_id: string;
    person_id: string | null;
    opportunity_id: string | null;
    start_at: string | null;
    previous_start_at: string | null;
  };
  /** A booked meeting was cancelled; no old sequence restarts. */
  "meeting.cancelled": {
    meeting_id: string;
    person_id: string | null;
    opportunity_id: string | null;
  };
  /** The prospect did not show up to a meeting. */
  "meeting.no_show": {
    meeting_id: string;
    person_id: string | null;
    opportunity_id: string | null;
  };
  /** A meeting took place (marked, or assumed after `booking.assume_held_after_hours`). */
  "meeting.held": {
    meeting_id: string;
    person_id: string | null;
    opportunity_id: string | null;
    qualified: boolean | null;
  };
  /** A person answered in a thread themselves, so the engine stepped back from it. */
  "thread.taken_over": {
    thread_id: string;
    person_id: string | null;
    message_id: string | null;
  };
  /** A thread owned by a person was handed back to the engine. */
  "thread.released": { thread_id: string };
  /** A send may or may not have gone out; it is reconciled before any retry. */
  "message.unknown": { message_id: string; channel: Channel; reason: string };
  /**
   * A message went out twice: an earlier attempt's answer came late and said it went out, and
   * a newer attempt went out too. `attempts` lists both attempt numbers, oldest first.
   */
  "message.duplicate": {
    message_id: string;
    attempts: number[];
    channel: Channel;
    campaign_id: string | null;
    person_id: string | null;
  };
  /** A person was forgotten; only CRM external ids and a SHA-256 of the email, no readable data. */
  "lead.forgotten": {
    person_id: string | null;
    email_sha256: string | null;
    crm_links: Array<{ provider: string; entity_type: string; external_id: string }>;
  };
  /** A fact was added to a lead or company file. */
  "lead.fact_recorded": {
    fact_id: string;
    person_id: string | null;
    company_id: string | null;
    kind: FactKind;
    source: FactSource;
  };
  /** A company hold was set, changed or lifted (`hold_until` null = lifted). */
  "company.hold_changed": { company_id: string; hold_until: string | null; reason: string | null };
  /** A CRM (or an agent reading one) reported a fact about a person or company. */
  "crm.fact_recorded": {
    fact: CrmFact;
    person_id: string | null;
    company_id: string | null;
    crm: string;
  };
  /** A prospect asked to delete their data, see it, or know its source; `due_at` is the deadline. */
  "privacy.requested": {
    person_id: string | null;
    message_id: string | null;
    kind: PrivacyKind;
    due_at: string;
  };
  /** A new problem item needs someone (not fired when an open duplicate is only updated). */
  "problem.opened": {
    problem_id: string;
    kind: ProblemKind;
    severity: ProblemSeverity;
    subject_type: string | null;
    subject_id: string | null;
  };
  /** A problem item was resolved (fired once, on the first resolve). */
  "problem.resolved": { problem_id: string; kind: ProblemKind; resolution: string | null };
  /** A change to settings, an offer, an ICP or a campaign was recorded with a new workspace version. */
  "change.recorded": {
    change_id: string;
    version: number;
    area: ChangeArea;
    target_id: string | null;
    proposal_id: string | null;
  };
  /** An applied proposal got its before and after numbers and a verdict. */
  "proposal.reviewed": { proposal_id: string; verdict: ProposalVerdict };
  /** The daily DNS check found a record that stopped passing (green before), or MX or SPF newly red. */
  "mailbox.dns_failed": { mailbox_id: string; domain: string; failed: string[] };
}

export type EventType = keyof EventData;

/** Every event type, in spec order (for validation, docs and webhook subscriptions). */
export const EVENT_TYPES = [
  "lead.created",
  "lead.updated",
  "import.completed",
  "enrichment.completed",
  "research.completed",
  "signal.detected",
  "automation.enroll_requested",
  "campaign.launched",
  "campaign.paused",
  "campaign.completed",
  "enrollment.stopped",
  "message.drafted",
  "message.approved",
  "message.sent",
  "message.failed",
  "message.bounced",
  "reply.received",
  "reply.classified",
  "thread.needs_attention",
  "approval.requested",
  "approval.decided",
  "opportunity.updated",
  "mailbox.paused",
  "mailbox.error",
  "linkedin.connected",
  "linkedin.account_restricted",
  "post.published",
  "knowledge.gap_opened",
  "report.ready",
  "unsubscribe.received",
  "meeting.booked",
  "meeting.rescheduled",
  "meeting.cancelled",
  "meeting.no_show",
  "meeting.held",
  "thread.taken_over",
  "thread.released",
  "message.unknown",
  "message.duplicate",
  "lead.forgotten",
  "lead.fact_recorded",
  "company.hold_changed",
  "crm.fact_recorded",
  "privacy.requested",
  "problem.opened",
  "problem.resolved",
  "change.recorded",
  "proposal.reviewed",
  "mailbox.dns_failed",
] as const satisfies readonly EventType[];

/** Compile-time check that EVENT_TYPES lists every key of EventData. */
type MissingEventTypes = Exclude<EventType, (typeof EVENT_TYPES)[number]>;
const _allEventTypesListed: MissingEventTypes extends never ? true : never = true;
void _allEventTypesListed;

export function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}

/** An event as delivered to handlers. */
export interface EmittedEvent<T extends EventType = EventType> {
  id: string;
  type: T;
  workspaceId: string;
  subject: EventSubject | null;
  data: EventData[T];
  occurredAt: Date;
}

/**
 * An in-process subscriber. Each emit enqueues one durable job per handler, so handlers run
 * in the worker with a JobContext, are retried on failure and must be idempotent.
 */
export interface EventHandlerDefinition<T extends EventType = EventType> {
  event: T;
  /** Unique, stable handler name, e.g. "campaigns.stop_on_reply". Used as the job name suffix. */
  name: string;
  handler(ctx: JobContext, event: EmittedEvent<T>): Promise<void>;
  /** Default 5. */
  maxAttempts?: number;
}

/** Declares an event handler: `onEvent("reply.received", "inbox.classify", async (ctx, e) => ...)`. */
export function onEvent<T extends EventType>(
  event: T,
  name: string,
  handler: (ctx: JobContext, event: EmittedEvent<T>) => Promise<void>,
  options: { maxAttempts?: number } = {},
): EventHandlerDefinition<T> {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(name)) {
    throw new Error(
      `onEvent: handler name "${name}" must be dotted snake_case, e.g. "inbox.classify_reply"`,
    );
  }
  const definition: EventHandlerDefinition<T> = { event, name, handler };
  if (options.maxAttempts !== undefined) definition.maxAttempts = options.maxAttempts;
  return definition;
}
