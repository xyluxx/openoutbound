/**
 * The locked `privacy` action for `privacy_request` replies (a prospect asks to delete their
 * data, to see what we hold, or where we got their details). Protective, so it runs even for
 * suspicious replies and for privacy wording in mail with auto-reply headers:
 * - everything an unsubscribe does and more, for the person who wrote (the sender's address,
 *   and the person holding it): suppressed on every channel, every enrollment stopped, status
 *   do not contact, every unsent message and pending approval cancelled, open tasks skipped and
 *   the problems that prompt contacting them (meeting to book, promise overdue, stuck) resolved;
 * - when someone else wrote in a lead's thread (a colleague answering all), the lead is
 *   protected the same way, as the request may be about them, but the request stays the
 *   sender's: the problem and its next step name the sender, never the lead;
 * - an urgent problem for a person with the deadline (the earlier of one calendar month and
 *   `compliance.privacy_response_days` after it arrived), where their data came from, a
 *   suggested reply and the next step; `privacy.requested` fires and a human is notified.
 * The engine never answers a privacy request itself: no draft is ever made.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import type { PrivacyKind, ProblemKind } from "../../core/enums.js";
import { events, messages, type Person, people, problems } from "../../db/schema/index.js";
import type { NotifyInput } from "../../runtime/notify.js";
import { stopEnrollmentsForPerson } from "../campaigns/service.js";
import { addSuppression } from "../leads/service.js";
import { type OpenProblemInput, openProblem, resolveProblemsFor } from "../problems/service.js";
import type { ActionOutcome, ClassifiedReply } from "./actions.js";
import { personLabel } from "./notifications.js";
import { advancePersonStatus } from "./person-status.js";
import { bareAddress, hasAutoReplyHeaders, stripQuotedText } from "./prechecks.js";
import { inferPrivacyKind } from "./privacy-phrases.js";
import { OVERDUE_PREFIX } from "./privacy-reminders.js";
import { type DataSource, loadDataSource, plainDate } from "./privacy-source.js";
import { findCompany } from "./reply-context.js";
import { skipOpenTasksForPerson } from "./tasks.js";

const DAY_MS = 86_400_000;

/** The source line when there is no person record to read it from. */
const UNKNOWN_SOURCE: DataSource = {
  line: "we could not find the source; check your records",
  quotable: false,
};

/** Unsent statuses of an outbound message; a privacy request cancels them all. */
const UNSENT_STATUSES = ["draft", "generating", "pending_review", "approved", "scheduled"] as const;

/** Problems that prompt someone to contact the person; a privacy request resolves them. */
const CONTACT_PROBLEM_KINDS: readonly ProblemKind[] = [
  "meeting_to_book",
  "promise_overdue",
  "stuck",
];

/** Why a privacy request stopped, cancelled, skipped or resolved something. */
const PRIVACY_REASON = "privacy_request";

/** What each kind asks, in words: for the title, the reason and the notification. */
export const PRIVACY_ASKS: Record<PrivacyKind, { title: string; reason: string; note: string }> = {
  delete: {
    title: "delete their data",
    reason: "delete their data",
    note: "They ask to delete their data.",
  },
  access: {
    title: "see their data",
    reason: "see the data you hold about them",
    note: "They ask what data you hold about them.",
  },
  source: {
    title: "where we got their details",
    reason: "know where you got their details",
    note: "They ask where you got their details.",
  },
};

/** One privacy problem per request message. */
export function privacyDedupeKey(messageId: string): string {
  return `privacy_request:${messageId}`;
}

/**
 * A short reply the person can send from their own mail app (English, first name when known).
 * Placeholders in angle brackets are for the person to fill in; nothing is sent automatically.
 */
export function suggestedPrivacyReply(
  kind: PrivacyKind,
  firstName: string | null | undefined,
  source: DataSource,
): string {
  const hi = firstName?.trim() ? `Hi ${firstName.trim()}` : "Hi there";
  switch (kind) {
    case "delete":
      return `${hi}, understood. I am deleting your details now and you will not hear from us again.`;
    case "access":
      return `${hi}, here is the information we hold about you: <fill in from the lead record>.`;
    case "source":
      return `${hi}, we found your business email address through ${source.quotable ? source.line : "<fill in where it came from>"}. Let me know if you would like me to delete it.`;
  }
}

export interface PrivacyProblemInput {
  kind: PrivacyKind;
  personId: string | null;
  companyId: string | null;
  /** The person's name (or address) for the reason, e.g. "Dana Reyes". */
  name: string;
  /** The name with the company for the title, e.g. "Dana Reyes (Harbor Dental)". */
  label: string;
  firstName: string | null;
  /** Their address when no person record exists (used in the remedy instead of person_id). */
  address: string | null;
  messageId: string;
  threadId: string | null;
  receivedAt: Date;
  responseDays: number;
  timeZone: string;
  source: DataSource;
  /**
   * The lead of the thread it came in, when someone else sent it (a colleague answering all).
   * They were protected too; the problem asks whether the request is also about them.
   */
  threadLeadId?: string | null;
  /** It arrived with auto-reply headers: a person should check that someone wrote it. */
  automated?: boolean;
}

function remedyFor(input: PrivacyProblemInput): string {
  const who = input.personId
    ? `person_id ${input.personId}`
    : input.address
      ? `email ${input.address}`
      : "their person_id or email";
  switch (input.kind) {
    case "delete":
      return `Reply to them yourself (suggested text below), then run manage_leads action forget with ${who}, first with dry_run true; the forget resolves this problem. The CRM step follows crm.on_forget.`;
    case "access":
      return input.personId
        ? `Look at get_lead action person with person_id ${input.personId} and response_format detailed, and send them what you hold from your own mail app.`
        : `Look up what you hold about them (search_leads with ${input.address ?? "their address"}), and send it to them from your own mail app.`;
    case "source":
      return "Reply with where their details came from (suggested text below).";
  }
}

/** What a person should check: a request from someone else in a lead's thread, or auto-reply headers. */
function checkNotes(input: PrivacyProblemInput): string[] {
  const notes: string[] = [];
  if (input.threadLeadId) {
    notes.push(
      `It came from another address than the lead of the thread (person_id ${input.threadLeadId}), who was suppressed too to be safe: check whether the request is also about them.`,
    );
  }
  if (input.automated) {
    notes.push("It arrived with auto-reply headers: check that a person wrote it.");
  }
  return notes;
}

/**
 * The same day and time one calendar month later, in UTC; the last day of that month when it
 * is shorter (31 Jan becomes 28 or 29 Feb).
 */
export function oneMonthAfter(date: Date): Date {
  const month = date.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      month,
      Math.min(date.getUTCDate(), lastDay),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

/**
 * When a privacy request must be answered: the earlier of one calendar month after it arrived
 * (GDPR) and `responseDays` days after it arrived, in UTC.
 */
export function privacyDeadline(receivedAt: Date, responseDays: number): Date {
  const byDays = receivedAt.getTime() + responseDays * DAY_MS;
  return new Date(Math.min(byDays, oneMonthAfter(receivedAt).getTime()));
}

/**
 * The problem for a privacy request: urgent, for a person, due at `privacyDeadline`, one per
 * request message. Pure, so the sandbox seeds the same wording.
 */
export function buildPrivacyProblem(
  input: PrivacyProblemInput,
): OpenProblemInput & { dueAt: Date } {
  const dueAt = privacyDeadline(input.receivedAt, input.responseDays);
  const ask = PRIVACY_ASKS[input.kind];
  const suggested = suggestedPrivacyReply(input.kind, input.firstName, input.source);
  return {
    kind: "privacy_request",
    severity: "urgent",
    owner: "person",
    title: `Privacy request from ${input.label}: ${ask.title}`,
    reason: [
      `${input.name} asked to ${ask.reason} on ${plainDate(input.receivedAt, input.timeZone)}. Answer by ${plainDate(dueAt, input.timeZone)}. Source of their data: ${input.source.line}.`,
      ...checkNotes(input),
    ].join(" "),
    remedy: `${remedyFor(input)}\n\nSuggested reply: ${suggested}`,
    subject: { type: "message", id: input.messageId },
    personId: input.personId,
    companyId: input.companyId,
    data: {
      kind: input.kind,
      received_at: input.receivedAt.toISOString(),
      due_at: dueAt.toISOString(),
      message_id: input.messageId,
      thread_id: input.threadId,
      source: input.source.line,
      suggested_reply: suggested,
      ...(input.threadLeadId ? { thread_lead_id: input.threadLeadId } : {}),
      ...(input.automated ? { auto_reply_headers: true } : {}),
    },
    dueAt,
    dedupeKey: privacyDedupeKey(input.messageId),
  };
}

/** Suppresses an address, or a person's address, LinkedIn profile and record. */
async function suppressEverywhere(
  ctx: OpContext,
  target: { person: Person } | { address: string },
  note: string,
  effects: string[],
  prefix: string,
): Promise<void> {
  const base = { reason: "do_not_contact" as const, source: "reply", note };
  const person = "person" in target ? target.person : null;
  const email = "person" in target ? target.person.email : target.address;
  if (email) {
    await addSuppression(ctx, { ...base, type: "email", value: email });
    effects.push(`${prefix}suppressed:email`);
  }
  if (person?.linkedin_url) {
    await addSuppression(ctx, { ...base, type: "linkedin", value: person.linkedin_url });
    effects.push(`${prefix}suppressed:linkedin`);
  }
  if (person) {
    await addSuppression(ctx, { ...base, type: "person", value: person.id });
    effects.push(`${prefix}suppressed:person`);
  }
}

/** Cancels the person's unsent engine messages and their pending approvals. */
async function cancelUnsent(
  ctx: OpContext,
  personId: string,
): Promise<{ messages: number; approvals: number }> {
  const workspace = requireWorkspace(ctx);
  const cancelled = await ctx.db
    .update(messages)
    .set({ status: "cancelled", error: PRIVACY_REASON })
    .where(
      and(
        eq(messages.workspace_id, workspace.id),
        eq(messages.person_id, personId),
        eq(messages.direction, "outbound"),
        eq(messages.origin, "engine"),
        inArray(messages.status, [...UNSENT_STATUSES]),
      ),
    )
    .returning({ id: messages.id });
  let approvals = await ctx.approvals.cancel(
    { target: { type: "person", id: personId } },
    PRIVACY_REASON,
  );
  for (const row of cancelled) {
    approvals += await ctx.approvals.cancel(
      { target: { type: "message", id: row.id } },
      PRIVACY_REASON,
    );
  }
  return { messages: cancelled.length, approvals };
}

/**
 * Everything a privacy request stops for one person: suppressions on every channel, every
 * sequence, status do not contact, unsent messages and pending approvals, open tasks, and the
 * problems that prompt contacting them. `prefix` marks the effects (empty for the sender).
 */
async function protectPerson(
  ctx: OpContext,
  person: Person,
  note: string,
  effects: string[],
  prefix: string,
): Promise<void> {
  await suppressEverywhere(ctx, { person }, note, effects, prefix);
  // Not a "replied" reason, so campaign stop settings cannot keep a sequence going.
  await stopEnrollmentsForPerson(ctx, { personId: person.id, reason: PRIVACY_REASON });
  effects.push(`${prefix}enrollments_stopped`);
  if (await advancePersonStatus(ctx, person, "do_not_contact")) {
    effects.push(`${prefix}person_status:do_not_contact`);
  }
  const cancelled = await cancelUnsent(ctx, person.id);
  if (cancelled.messages > 0) effects.push(`${prefix}messages_cancelled:${cancelled.messages}`);
  if (cancelled.approvals > 0) effects.push(`${prefix}approvals_cancelled:${cancelled.approvals}`);
  const skipped = await skipOpenTasksForPerson(ctx, person.id, "privacy request");
  if (skipped > 0) effects.push(`${prefix}tasks_skipped:${skipped}`);
  let resolved = 0;
  for (const kind of CONTACT_PROBLEM_KINDS) {
    resolved += await resolveProblemsFor(ctx, { personId: person.id, kind }, PRIVACY_REASON);
  }
  if (resolved > 0) effects.push(`${prefix}problems_resolved:${resolved}`);
}

/** The person holding an address in the workspace (emails are stored lowercase). */
async function personByEmail(ctx: OpContext, email: string): Promise<Person | null> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select()
    .from(people)
    .where(and(eq(people.workspace_id, workspace.id), eq(people.email, email)))
    .limit(1);
  return row ?? null;
}

interface Requester {
  /** The person who asked, when a record holds their address. */
  person: Person | null;
  /** The address they wrote from (or the person's email). */
  address: string | null;
  company: ClassifiedReply["company"];
  /** The lead of the thread, when someone else wrote in it. */
  threadLead: Person | null;
}

/**
 * Who asked: the thread's lead when the message is from their address (or carries no address,
 * as on LinkedIn), else the sender, with the person holding the sender's address when there
 * is one.
 */
async function requesterOf(ctx: OpContext, reply: ClassifiedReply): Promise<Requester> {
  const { person: lead, company, message } = reply;
  const sender = bareAddress(message.from_address);
  if (lead && (!sender || lead.email?.toLowerCase() === sender)) {
    return { person: lead, address: lead.email ?? null, company, threadLead: null };
  }
  const person = sender ? await personByEmail(ctx, sender) : null;
  let theirCompany: ClassifiedReply["company"] = lead ? null : company;
  if (person) {
    theirCompany =
      person.company_id && person.company_id === company?.id
        ? company
        : await findCompany(ctx, person.company_id);
  }
  return {
    person,
    address: person?.email ?? sender,
    company: theirCompany,
    threadLead: lead && lead.id !== person?.id ? lead : null,
  };
}

/** The unresolved problem for this request, if any (its title may say it is overdue). */
async function unresolvedRequest(
  ctx: OpContext,
  dedupeKey: string,
): Promise<{ title: string } | null> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select({ title: problems.title })
    .from(problems)
    .where(
      and(
        eq(problems.workspace_id, workspace.id),
        eq(problems.dedupe_key, dedupeKey),
        sql`${problems.status} <> 'resolved'`,
      ),
    )
    .limit(1);
  return row ?? null;
}

/** A resolved problem for this request exists (someone already handled it). */
async function resolvedBefore(ctx: OpContext, dedupeKey: string): Promise<boolean> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select({ id: problems.id })
    .from(problems)
    .where(
      and(
        eq(problems.workspace_id, workspace.id),
        eq(problems.dedupe_key, dedupeKey),
        eq(problems.status, "resolved"),
      ),
    )
    .limit(1);
  if (!row) return false;
  return !(await unresolvedRequest(ctx, dedupeKey));
}

/** `privacy.requested` was already emitted for this message (a retried or repeated run). */
async function alreadyAnnounced(ctx: OpContext, messageId: string): Promise<boolean> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.workspace_id, workspace.id),
        eq(events.type, "privacy.requested"),
        sql`${events.data}->>'message_id' = ${messageId}`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Runs the `privacy` action for a classified reply. Idempotent: a retried job refreshes the
 * same problem and never announces the request twice; a request whose problem was already
 * resolved is not opened again.
 */
export async function applyPrivacyRequest(
  ctx: OpContext,
  reply: ClassifiedReply,
  outcome: ActionOutcome,
  notes: NotifyInput[],
): Promise<void> {
  const { message, thread, workspace, settings, classification } = reply;
  const kind =
    classification.privacy_kind ?? inferPrivacyKind(stripQuotedText(message.body_text ?? ""));
  const { person, address, company, threadLead } = await requesterOf(ctx, reply);
  const automated = hasAutoReplyHeaders({
    subject: message.subject,
    headers: message.headers ?? null,
  });

  const note = `Privacy request (reply ${message.id})`;
  if (person) await protectPerson(ctx, person, note, outcome.effects, "");
  else if (address) await suppressEverywhere(ctx, { address }, note, outcome.effects, "");
  // Someone else wrote in the lead's thread: the request may be about the lead too.
  if (threadLead) await protectPerson(ctx, threadLead, note, outcome.effects, "thread_lead:");
  outcome.attention.push("privacy_request");

  const input: PrivacyProblemInput = {
    kind,
    personId: person?.id ?? null,
    companyId: person?.company_id ?? company?.id ?? null,
    name: person?.full_name?.trim() || address || "Unknown contact",
    label: person ? personLabel(person, company) : (address ?? "an unknown contact"),
    firstName: person?.first_name ?? null,
    address: person ? null : address,
    messageId: message.id,
    threadId: thread?.id ?? message.thread_id ?? null,
    receivedAt: message.received_at ?? message.created_at,
    responseDays: settings.compliance.privacy_response_days,
    timeZone: workspace.timezone,
    source: person ? await loadDataSource(ctx, person, workspace.timezone) : UNKNOWN_SOURCE,
    threadLeadId: threadLead?.id ?? null,
    automated,
  };
  const problem = buildPrivacyProblem(input);
  const key = privacyDedupeKey(message.id);
  if (await resolvedBefore(ctx, key)) {
    outcome.effects.push("privacy_request_already_handled");
    return;
  }
  // A repeated run (a reclassify) keeps the overdue mark the daily reminder put on the title.
  const current = await unresolvedRequest(ctx, key);
  if (
    current?.title.startsWith(OVERDUE_PREFIX) &&
    problem.dueAt.getTime() <= ctx.clock.now().getTime()
  ) {
    problem.title = `${OVERDUE_PREFIX}${problem.title}`;
  }
  const opened = await openProblem(ctx, problem);
  outcome.effects.push(`privacy_problem:${opened.id}`);
  if (!opened.created && (await alreadyAnnounced(ctx, message.id))) return;

  await ctx.events.emit("privacy.requested", {
    subject: person ? { type: "person", id: person.id } : { type: "message", id: message.id },
    data: {
      person_id: person?.id ?? null,
      message_id: message.id,
      kind,
      due_at: problem.dueAt.toISOString(),
    },
  });
  notes.push({
    title: problem.title,
    lines: [
      classification.summary ?? "",
      PRIVACY_ASKS[kind].note,
      `Answer by ${plainDate(problem.dueAt, workspace.timezone)} (${Math.round((problem.dueAt.getTime() - input.receivedAt.getTime()) / DAY_MS)} days after it arrived).`,
      "They are suppressed everywhere and every sequence stopped. Nothing is sent automatically: answer the request yourself.",
      ...checkNotes(input),
      `Next step (problem ${opened.id}): ${remedyFor(input)}`,
    ].filter(Boolean),
    severity: "critical",
    event: "privacy.requested",
  });
}
