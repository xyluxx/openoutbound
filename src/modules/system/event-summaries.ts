/**
 * One plain line per event for the change feed, built only from the stored payload (ids, enums,
 * counts, dates and short engine texts), so a summary never adds personal data the payload does
 * not already hold. Payloads are read defensively: older rows may miss fields.
 */
import type { EventType } from "../../core/events.js";

type Payload = Record<string, unknown>;

/** Longest outside text (signal titles, bounce reasons, questions) quoted in a summary. */
const QUOTE_MAX = 100;

/**
 * Event types whose payload carries text from outside parties or imported rows (web pages,
 * replies, bounce messages, provider errors, lead names): feed items of these types are marked
 * `untrusted` so agents read them as data.
 */
export const UNTRUSTED_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  "signal.detected",
  "knowledge.gap_opened",
  "message.bounced",
  "message.failed",
  "mailbox.error",
  "linkedin.account_restricted",
  "approval.requested",
  "company.hold_changed",
]);

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** An id from the payload, or a placeholder when it is missing. */
function ref(value: unknown, missing = "unknown"): string {
  return text(value) ?? missing;
}

/** Outside text: one line, cut, in quotes. */
function quote(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const line = raw.replace(/\s+/g, " ");
  return `"${line.length > QUOTE_MAX ? `${line.slice(0, QUOTE_MAX - 3)}...` : line}"`;
}

/** " (label value)" when the value is present. */
function part(label: string, value: unknown): string {
  const raw = text(value);
  return raw ? ` (${label}${raw})` : "";
}

function person(value: unknown): string {
  return text(value) ?? "an unknown person";
}

/** ISO 8601 shortened to minutes in UTC, e.g. 2026-10-08T13:00Z. */
function when(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return `${date.toISOString().slice(0, 16)}Z`;
}

function list(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

const SUMMARIES: { [K in EventType]: (data: Payload) => string } = {
  "lead.created": (d) =>
    `${d.kind === "company" ? "Company" : "Person"} ${ref(d.id)} created${part("source ", d.source)}`,
  "lead.updated": (d) => {
    const changes = list(d.changes);
    return `${d.kind === "company" ? "Company" : "Person"} ${ref(d.id)} updated${changes.length > 0 ? `: ${changes.slice(0, 8).join(", ")}` : ""}`;
  },
  "import.completed": (d) => {
    const stats = (d.stats ?? {}) as Payload;
    const counts = ["created", "updated", "skipped", "failed"]
      .map((key) => `${num(stats[key]) ?? 0} ${key}`)
      .join(", ");
    const done =
      d.status === "failed" ? "failed" : d.status === "partial" ? "partly done" : "completed";
    return `Import ${ref(d.import_id)} ${done}: ${counts}`;
  },
  "enrichment.completed": (d) =>
    `Enrichment for ${person(d.person_id)}: email ${ref(d.email_status)}${part("by ", d.provider)}`,
  "research.completed": (d) =>
    `Research brief ${ref(d.brief_id)} ${d.status === "failed" ? "failed" : d.status === "partial" ? "partial (a source failed)" : "ready"}${part("confidence ", d.confidence)} for ${ref(d.company_id ?? d.person_id)}`,
  "signal.detected": (d) =>
    `Signal ${ref(d.definition_key)} (score ${num(d.score) ?? 0}) for ${ref(d.company_id ?? d.person_id)}${quote(d.title) ? `: ${quote(d.title)}` : ""}`,
  "automation.enroll_requested": (d) =>
    `Automation ${ref(d.rule_id)} asked to enroll ${list(d.person_ids).length} people in ${ref(d.campaign_id)}`,
  "campaign.launched": (d) => `Campaign ${ref(d.campaign_id)} launched${part("", d.name)}`,
  "campaign.paused": (d) =>
    `Campaign ${ref(d.campaign_id)} paused${text(d.reason) ? `: ${quote(d.reason)}` : ""}`,
  "campaign.completed": (d) => `Campaign ${ref(d.campaign_id)} completed`,
  "enrollment.stopped": (d) =>
    `Enrollment ${ref(d.enrollment_id)} of ${person(d.person_id)} in ${ref(d.campaign_id)} stopped: ${ref(d.reason, "no reason")}`,
  "message.drafted": (d) =>
    `${actionLabel(d.action)} drafted for ${person(d.person_id)} (${ref(d.status)})${part("campaign ", d.campaign_id)}`,
  "message.approved": (d) => `Message ${ref(d.message_id)} approved`,
  "message.sent": (d) =>
    `${actionLabel(d.action)} ${ref(d.message_id)} sent to ${person(d.person_id)}${part("campaign ", d.campaign_id)}`,
  "message.failed": (d) =>
    `Message ${ref(d.message_id)} failed${d.retryable === true ? " (will retry)" : ""}${text(d.error) ? `: ${quote(d.error)}` : ""}`,
  "message.bounced": (d) =>
    `${d.bounce_type === "soft" ? "Soft" : "Hard"} bounce for ${person(d.person_id)}${text(d.reason) ? `: ${quote(d.reason)}` : ""}`,
  "reply.received": (d) =>
    `Reply ${ref(d.message_id)} from ${person(d.person_id)} on ${ref(d.channel, "email")}`,
  "reply.classified": (d) => {
    const confidence = num(d.confidence);
    return `Reply ${ref(d.message_id)} from ${person(d.person_id)} classified ${ref(d.category)}${confidence === null ? "" : ` (${confidence.toFixed(2)})`}`;
  },
  "thread.needs_attention": (d) =>
    `Thread ${ref(d.thread_id)} needs attention${part("", d.category)}: ${ref(d.reason, "no reason")}`,
  "approval.requested": (d) =>
    `Approval ${ref(d.approval_id)} requested (${ref(d.kind)})${quote(d.title) ? `: ${quote(d.title)}` : ""}`,
  "approval.decided": (d) =>
    `Approval ${ref(d.approval_id)} (${ref(d.kind)}) ${decisionLabel(d.decision)}`,
  "opportunity.updated": (d) =>
    `Opportunity ${ref(d.opportunity_id)} of ${person(d.person_id)} moved to ${ref(d.stage)}${part("from ", d.previous_stage)}`,
  "mailbox.paused": (d) => `Mailbox ${ref(d.mailbox_id)} paused: ${ref(d.reason, "no reason")}`,
  "mailbox.error": (d) =>
    `Mailbox ${ref(d.mailbox_id)} error${text(d.error) ? `: ${quote(d.error)}` : ""}`,
  "linkedin.connected": (d) =>
    `${person(d.person_id)} accepted the LinkedIn invite${part("account ", d.account_id)}`,
  "linkedin.account_restricted": (d) =>
    `LinkedIn account ${ref(d.account_id)} restricted${text(d.reason) ? `: ${quote(d.reason)}` : ""}`,
  "post.published": (d) => `Post ${ref(d.post_id)} published`,
  "knowledge.gap_opened": (d) =>
    `Knowledge gap ${ref(d.gap_id)} opened${quote(d.question) ? `: ${quote(d.question)}` : ""}`,
  "report.ready": (d) => `Report ${ref(d.report_id)} ready (${ref(d.type)})`,
  "unsubscribe.received": (d) =>
    `Unsubscribe from ${person(d.person_id)} (${ref(d.source, "unknown source")})`,
  "meeting.booked": (d) => {
    const start = when(d.start_at);
    return `Meeting ${start ? `booked for ${start}` : "booked, time not known yet"} (${person(d.person_id)}, ${ref(d.source)})`;
  },
  "meeting.rescheduled": (d) => {
    const start = when(d.start_at);
    return `Meeting ${ref(d.meeting_id)} of ${person(d.person_id)} moved to ${start ?? "an unknown time"}`;
  },
  "meeting.cancelled": (d) => `Meeting ${ref(d.meeting_id)} of ${person(d.person_id)} cancelled`,
  "meeting.no_show": (d) => `No-show for meeting ${ref(d.meeting_id)} of ${person(d.person_id)}`,
  "meeting.held": (d) =>
    `Meeting ${ref(d.meeting_id)} of ${person(d.person_id)} held${d.qualified === true ? " (qualified)" : d.qualified === false ? " (not qualified)" : ""}`,
  "thread.taken_over": (d) => `A person took over thread ${ref(d.thread_id)}`,
  "thread.released": (d) => `Thread ${ref(d.thread_id)} handed back to the engine`,
  "message.unknown": (d) =>
    `Message ${ref(d.message_id)} outcome unknown: ${ref(d.reason, "no reason")}`,
  "message.duplicate": (d) =>
    `Message ${ref(d.message_id)} went out twice to ${person(d.person_id)}${part("campaign ", d.campaign_id)}`,
  "lead.forgotten": (d) => {
    const links = Array.isArray(d.crm_links) ? d.crm_links.length : 0;
    return `A person was forgotten${links > 0 ? ` (${links} CRM link${links === 1 ? "" : "s"} to clean up)` : ""}`;
  },
  "lead.fact_recorded": (d) =>
    `Fact ${ref(d.fact_id)} (${ref(d.kind)}) recorded for ${ref(d.person_id ?? d.company_id)} from ${ref(d.source)}`,
  "company.hold_changed": (d) => {
    const until = text(d.hold_until);
    return until
      ? `Company ${ref(d.company_id)} on hold until ${until.slice(0, 10)}${text(d.reason) ? `: ${quote(d.reason)}` : ""}`
      : `Hold lifted for company ${ref(d.company_id)}`;
  },
  "crm.fact_recorded": (d) =>
    `CRM ${ref(d.crm)} reported ${ref(d.fact)} for ${ref(d.company_id ?? d.person_id)}`,
  "privacy.requested": (d) =>
    `Privacy request (${ref(d.kind)}) from ${person(d.person_id)}, due ${ref(when(d.due_at))}`,
  "problem.opened": (d) =>
    `Problem ${ref(d.problem_id)} opened: ${ref(d.kind)} (${ref(d.severity)})`,
  "problem.resolved": (d) => `Problem ${ref(d.problem_id)} (${ref(d.kind)}) resolved`,
  "change.recorded": (d) =>
    `Change v${num(d.version) ?? "?"} recorded: ${ref(d.area)}${part("", d.target_id)}`,
  "proposal.reviewed": (d) => `Proposal ${ref(d.proposal_id)} reviewed: ${ref(d.verdict)}`,
  "mailbox.dns_failed": (d) => {
    const failed = list(d.failed);
    return `DNS check failed for ${ref(d.domain)}${failed.length > 0 ? `: ${failed.join(", ").toUpperCase()}` : ""}`;
  },
};

function actionLabel(action: unknown): string {
  switch (action) {
    case "email":
      return "Email";
    case "reply":
      return "Reply";
    case "invite":
      return "LinkedIn invite";
    case "message":
      return "LinkedIn message";
    case "comment":
      return "LinkedIn comment";
    case "visit":
      return "Profile visit";
    case "like":
      return "LinkedIn like";
    default:
      return "Message";
  }
}

function decisionLabel(decision: unknown): string {
  if (decision === "approve") return "approved";
  if (decision === "reject") return "rejected";
  if (decision === "edit") return "approved with edits";
  return "decided";
}

/** One plain line for an event (unknown types get a generic line). */
export function summarizeEvent(type: string, data: unknown): string {
  const payload = data && typeof data === "object" ? (data as Payload) : {};
  const summarize = (SUMMARIES as Record<string, ((data: Payload) => string) | undefined>)[type];
  return summarize ? summarize(payload) : `Event ${type}`;
}
