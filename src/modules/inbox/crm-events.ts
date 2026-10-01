/**
 * The built-in CRM sync, one event at a time, following the `crm.*` preferences:
 * - `sync_from`: `interested` (people reach the CRM with their deal), `replied` (also on their
 *   first human reply: not bounces, automatic replies, unsubscribes or privacy requests),
 *   `contacted` (also on the first engine send: an email, reply, invite or LinkedIn message).
 * - `log`: `deals` (no notes), `key_moments` (a note per human reply with its category and
 *   one-line summary, never the text, and per meeting change), `everything` (also every engine
 *   email sent and every inbound reply with its subject and body, cut to 2000 characters).
 * - `timing`: `live` runs these handlers as events happen; `daily` turns them off and the daily
 *   replay (`crm-daily.ts`) feeds the day's events through the same `processCrmEvent`.
 *
 * A note is only written on a contact the CRM has (or may create now under `sync_from`), and
 * only once per event and provider: an `activity` link remembers it, so job retries and a
 * switch from live to daily never log it twice. A note whose answer was lost
 * (`outcome_unknown`: it may or may not be in the CRM) is remembered the same way, with
 * external id "unknown", and never written again. Nothing is written about privacy requests.
 */
import type { JobContext, OpContext } from "../../core/context.js";
import type { ReplyCategory } from "../../core/enums.js";
import { isOpenOutboundError, OpenOutboundError } from "../../core/errors.js";
import type { EventData, EventType } from "../../core/events.js";
import { failureOf, isRetryable } from "../../core/failures.js";
import { onEvent } from "../../core/operation.js";
import type { Company, Message, Person } from "../../db/schema/index.js";
import { ACTIVITY_BODY_MAX, activityText, truncateText } from "../../providers/crm/activity.js";
import type { CrmActivity, CrmProvider } from "../../providers/types.js";
import {
  type CrmPreferences,
  crmPreferences,
  enqueueCrmSync,
  ensureCrmContact,
  errorMessage,
  isLastAttempt,
  openCrmSyncProblem,
  readLinks,
  resolveCrmSyncProblem,
  writeLink,
} from "./crm-sync.js";
import { findOpenOpportunity } from "./opportunities.js";
import { stripQuotedText } from "./prechecks.js";
import { findCompany, findMessage, findPerson } from "./reply-context.js";

/** Events the built-in sync reacts to (live handlers, or the daily replay). */
export const CRM_SYNC_EVENT_TYPES = [
  "opportunity.updated",
  "reply.classified",
  "message.sent",
  "meeting.booked",
  "meeting.rescheduled",
  "meeting.cancelled",
  "meeting.no_show",
  "meeting.held",
] as const satisfies readonly EventType[];
export type CrmSyncEventType = (typeof CRM_SYNC_EVENT_TYPES)[number];

/** One event as the sync sees it (an emitted event or a stored `events` row). */
export type CrmEvent = {
  [T in CrmSyncEventType]: { id: string; type: T; data: EventData[T]; occurredAt: Date };
}[CrmSyncEventType];

export interface CrmEventProviderResult {
  provider: string;
  /** linked = the CRM already had the contact; created = created now; missing = not in the CRM. */
  contact: "linked" | "created" | "missing";
  /** `unknown`: the CRM did not confirm the note; it is not written again. */
  note: "logged" | "already_logged" | "unknown" | "no_contact" | "unsupported" | "not_needed";
  error: string | null;
}

export interface CrmEventResult {
  event_id: string;
  type: CrmSyncEventType;
  /** Why nothing was sent to any CRM, or null. */
  skipped: string | null;
  /** opportunity.updated: a deal sync was queued. */
  queued_sync: boolean;
  providers: CrmEventProviderResult[];
}

/** Replies no person wrote: they never create a contact or a note. */
const MACHINE_REPLIES: ReadonlySet<ReplyCategory> = new Set([
  "bounce",
  "out_of_office",
  "auto_reply_other",
]);
/** Hot replies create the opportunity, and so the contact, whatever `sync_from` says. */
const HOT_REPLIES: ReadonlySet<ReplyCategory> = new Set(["interested", "meeting_request"]);
/** Sends that reach a person (profile visits and likes do not count as contact). */
const CONTACT_ACTIONS: ReadonlySet<string> = new Set(["email", "reply", "invite", "message"]);

type NoteDraft = Pick<CrmActivity, "kind" | "subject" | "body" | "occurredAt">;

/** What one event asks of every CRM. */
interface Plan {
  personId: string;
  /** Create the contact (and company) when the CRM does not have it yet. */
  createContact: boolean;
  note: NoteDraft | null;
  /** The deal the note belongs to, when the event names one. */
  opportunityId: string | null;
}

function categoryLabel(category: string): string {
  const words = category.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "2026-10-08 13:00 UTC", or null for a missing or invalid time. */
function utcLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function cut(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  return trimmed ? truncateText(trimmed, ACTIVITY_BODY_MAX) : null;
}

/** The reply's own words (quoted history removed), else the whole text. */
function ownWords(message: Message): string | null {
  const text = message.body_text ?? "";
  return cut(stripQuotedText(text) || text);
}

function replyNote(message: Message, category: ReplyCategory, log: CrmPreferences["log"]) {
  const summary = message.classification?.summary?.replace(/\s+/g, " ").trim() || null;
  const occurredAt = message.received_at ?? message.created_at;
  if (log !== "everything") {
    // key_moments: the category and the one-line summary, never the text itself.
    return { kind: "reply", subject: categoryLabel(category), body: summary, occurredAt } as const;
  }
  const sorted = `Sorted as: ${categoryLabel(category)}${summary ? `. ${summary}` : ""}`;
  const words = ownWords(message);
  return {
    kind: message.channel === "email" ? "email_received" : "reply",
    subject: message.channel === "email" ? message.subject : categoryLabel(category),
    body: cut(words ? `${sorted}\n\n${words}` : sorted),
    occurredAt,
  } as const;
}

function meetingNote(event: CrmEvent): NoteDraft | null {
  const at = event.occurredAt;
  switch (event.type) {
    case "meeting.booked": {
      const when = utcLabel(event.data.start_at);
      return { kind: "meeting", subject: when ? `booked for ${when}` : "booked", occurredAt: at };
    }
    case "meeting.rescheduled": {
      const when = utcLabel(event.data.start_at);
      return {
        kind: "meeting",
        subject: when ? `moved to ${when}` : "rescheduled",
        occurredAt: at,
      };
    }
    case "meeting.cancelled":
      return { kind: "meeting", subject: "cancelled", occurredAt: at };
    case "meeting.no_show":
      return { kind: "meeting", subject: "no-show", occurredAt: at };
    case "meeting.held": {
      const qualified = event.data.qualified;
      const judged = qualified === null ? "" : qualified ? ", qualified" : ", not qualified";
      return { kind: "meeting", subject: `held${judged}`, occurredAt: at };
    }
    default:
      return null;
  }
}

/** What the event asks for, or the reason it asks for nothing. */
async function planEvent(
  ctx: OpContext,
  event: CrmEvent,
  preferences: CrmPreferences,
): Promise<Plan | string> {
  const wantsNotes = preferences.log !== "deals";
  switch (event.type) {
    case "opportunity.updated":
      return "handled_by_deal_sync";
    case "reply.classified": {
      if (typeof event.data?.message_id !== "string") return "malformed_event";
      const message = await findMessage(ctx, event.data.message_id);
      if (message?.direction !== "inbound") return "message_not_found";
      const personId = message.person_id ?? event.data.person_id;
      if (!personId) return "no_person";
      const category = message.classification?.category ?? event.data.category;
      // Nothing about a privacy request goes to a CRM: not a contact, not a note.
      if (category === "privacy_request") return "privacy_request";
      if (MACHINE_REPLIES.has(category)) return "automatic_reply";
      const optOut = category === "unsubscribe";
      const createContact =
        !optOut &&
        (preferences.sync_from !== "interested" || (HOT_REPLIES.has(category) && wantsNotes));
      if (!createContact && !wantsNotes) return "nothing_to_sync";
      return {
        personId,
        createContact,
        note: wantsNotes ? replyNote(message, category, preferences.log) : null,
        opportunityId: null,
      };
    }
    case "message.sent": {
      if (typeof event.data?.message_id !== "string") return "malformed_event";
      const message = await findMessage(ctx, event.data.message_id);
      if (message?.direction !== "outbound") return "message_not_found";
      if (message.origin !== "engine") return "not_sent_by_engine";
      const personId = message.person_id ?? event.data.person_id;
      if (!personId) return "no_person";
      const createContact =
        preferences.sync_from === "contacted" && CONTACT_ACTIONS.has(message.action);
      const wantsNote = preferences.log === "everything" && message.channel === "email";
      if (!createContact && !wantsNote) return "nothing_to_sync";
      return {
        personId,
        createContact,
        note: wantsNote
          ? {
              kind: "email_sent",
              subject: message.subject,
              body: cut(message.body_text),
              occurredAt: message.sent_at ?? event.occurredAt,
            }
          : null,
        opportunityId: null,
      };
    }
    default: {
      // meeting.*: a note under key_moments and everything; the deal sync does the rest.
      if (!wantsNotes) return "nothing_to_sync";
      const personId = event.data?.person_id;
      if (typeof personId !== "string" || !personId) return "no_person";
      return {
        personId,
        // A meeting is past every sync_from point, so the note may create the contact.
        createContact: true,
        note: meetingNote(event),
        opportunityId: event.data.opportunity_id ?? null,
      };
    }
  }
}

/** Writes the note once per event and provider; `activity` links remember what was written. */
async function logNoteOnce(
  ctx: OpContext,
  crm: CrmProvider,
  eventId: string,
  entry: CrmActivity,
): Promise<"logged" | "already_logged" | "unknown" | "unsupported"> {
  if (!crm.logActivity && !crm.logNote) return "unsupported";
  const done = await readLinks(ctx, crm.id, [{ type: "activity", id: eventId }]);
  if (done.size > 0) return "already_logged";
  let activityId: string | null = null;
  try {
    if (crm.logActivity) {
      activityId = (await crm.logActivity(entry)).activityId;
    } else {
      await crm.logNote?.({
        contactId: entry.contactId,
        ...(entry.dealId ? { dealId: entry.dealId } : {}),
        text: activityText(entry),
        occurredAt: entry.occurredAt,
      });
    }
  } catch (error) {
    // The note may already be in the CRM: writing it again could double it, so stop here.
    if (failureOf(error)?.class !== "outcome_unknown") throw error;
    ctx.log.warn({ err: error, provider: crm.id, event: eventId }, "inbox: CRM note unconfirmed");
    await writeLink(ctx, crm.id, "activity", eventId, "unknown");
    return "unknown";
  }
  await writeLink(ctx, crm.id, "activity", eventId, activityId ?? "logged");
  return "logged";
}

async function applyToProvider(
  ctx: OpContext,
  crm: CrmProvider,
  eventId: string,
  plan: Plan,
  person: Person,
  company: Company | null,
  opportunityId: string | null,
): Promise<CrmEventProviderResult> {
  const entities: Array<{ type: "person" | "company" | "opportunity"; id: string }> = [
    { type: "person", id: person.id },
  ];
  if (company) entities.push({ type: "company", id: company.id });
  if (opportunityId) entities.push({ type: "opportunity", id: opportunityId });
  const links = await readLinks(ctx, crm.id, entities);
  let contactId = links.get(`person:${person.id}`);
  let companyId = company ? links.get(`company:${company.id}`) : undefined;
  let contact: CrmEventProviderResult["contact"] = contactId ? "linked" : "missing";
  if (!contactId && plan.createContact) {
    // Under the person's lock: a deal sync may be creating the same contact right now.
    const ensured = await ensureCrmContact(ctx, crm, person, company, { update: false });
    contactId = ensured.contactId;
    companyId = ensured.companyId ?? companyId;
    contact = ensured.created ? "created" : "linked";
  }
  let note: CrmEventProviderResult["note"] = "not_needed";
  if (plan.note) {
    note = contactId
      ? await logNoteOnce(ctx, crm, eventId, {
          ...plan.note,
          contactId,
          dealId: opportunityId ? (links.get(`opportunity:${opportunityId}`) ?? null) : null,
          companyId: companyId ?? null,
        })
      : "no_contact";
  }
  if (contact === "created" || note === "logged") await resolveCrmSyncProblem(ctx, crm.id);
  return { provider: crm.id, contact, note, error: null };
}

/**
 * Applies one event to every configured CRM while `crm.mode` is built_in (the caller decides
 * the timing). `opportunity.updated` queues the deal sync; replies, sends and meetings may
 * create contacts and write notes. A provider that rejects the write for good gets a
 * `crm_sync_failed` problem; temporary failures throw so the job retries (and open the problem
 * on the last attempt).
 */
export async function processCrmEvent(ctx: OpContext, event: CrmEvent): Promise<CrmEventResult> {
  const result: CrmEventResult = {
    event_id: event.id,
    type: event.type,
    skipped: null,
    queued_sync: false,
    providers: [],
  };
  const preferences = crmPreferences(ctx);
  if (preferences.mode !== "built_in") return { ...result, skipped: `mode_${preferences.mode}` };
  if (event.type === "opportunity.updated") {
    if (typeof event.data?.opportunity_id !== "string") {
      return { ...result, skipped: "malformed_event" };
    }
    if ((await ctx.providers.list("crm")).length === 0) {
      return { ...result, skipped: "no_crm_provider" };
    }
    await enqueueCrmSync(ctx, event.data.opportunity_id);
    return { ...result, queued_sync: true };
  }
  const plan = await planEvent(ctx, event, preferences);
  if (typeof plan === "string") return { ...result, skipped: plan };
  const crms = await ctx.providers.list("crm");
  if (crms.length === 0) return { ...result, skipped: "no_crm_provider" };
  const person = await findPerson(ctx, plan.personId);
  if (!person) return { ...result, skipped: "person_not_found" };
  const company = await findCompany(ctx, person.company_id);
  const opportunityId =
    plan.opportunityId ??
    (plan.note ? ((await findOpenOpportunity(ctx, person.id))?.id ?? null) : null);

  const retryable: Array<{ provider: string; error: unknown }> = [];
  for (const crm of crms) {
    try {
      result.providers.push(
        await applyToProvider(ctx, crm, event.id, plan, person, company, opportunityId),
      );
    } catch (error) {
      ctx.log.warn(
        { err: error, provider: crm.id, event: event.id, type: event.type },
        "inbox: CRM event sync failed",
      );
      if (isRetryable(error)) retryable.push({ provider: crm.id, error });
      else await openCrmSyncProblem(ctx, crm.id, error);
      result.providers.push({
        provider: crm.id,
        contact: "missing",
        note: "not_needed",
        error: errorMessage(error),
      });
    }
  }
  const first = retryable[0];
  if (first) {
    if (isLastAttempt(ctx)) {
      for (const failure of retryable)
        await openCrmSyncProblem(ctx, failure.provider, failure.error);
    }
    throw isOpenOutboundError(first.error)
      ? first.error
      : new OpenOutboundError("provider_error", "The CRM sync failed; it will retry.", {
          cause: first.error,
        });
  }
  return result;
}

/** Live timing: handle the event now. Daily timing: leave it to the daily replay. */
async function onLiveEvent(ctx: JobContext, event: CrmEvent): Promise<void> {
  const { mode, timing } = crmPreferences(ctx);
  if (mode !== "built_in" || timing !== "live") return;
  await processCrmEvent(ctx, event);
}

/** Every pipeline change goes to the CRM (when one is configured). */
export const syncCrmOnOpportunityUpdate = onEvent(
  "opportunity.updated",
  "inbox.sync_crm",
  (ctx, event) => onLiveEvent(ctx, event),
);
export const crmOnReplyClassified = onEvent("reply.classified", "inbox.crm_reply", (ctx, event) =>
  onLiveEvent(ctx, event),
);
export const crmOnMessageSent = onEvent("message.sent", "inbox.crm_message_sent", (ctx, event) =>
  onLiveEvent(ctx, event),
);
export const crmOnMeetingBooked = onEvent(
  "meeting.booked",
  "inbox.crm_meeting_booked",
  (ctx, event) => onLiveEvent(ctx, event),
);
export const crmOnMeetingRescheduled = onEvent(
  "meeting.rescheduled",
  "inbox.crm_meeting_rescheduled",
  (ctx, event) => onLiveEvent(ctx, event),
);
export const crmOnMeetingCancelled = onEvent(
  "meeting.cancelled",
  "inbox.crm_meeting_cancelled",
  (ctx, event) => onLiveEvent(ctx, event),
);
export const crmOnMeetingNoShow = onEvent(
  "meeting.no_show",
  "inbox.crm_meeting_no_show",
  (ctx, event) => onLiveEvent(ctx, event),
);
export const crmOnMeetingHeld = onEvent("meeting.held", "inbox.crm_meeting_held", (ctx, event) =>
  onLiveEvent(ctx, event),
);

/** The live CRM handlers, for the module registration. */
export const crmEventHandlers = [
  syncCrmOnOpportunityUpdate,
  crmOnReplyClassified,
  crmOnMessageSent,
  crmOnMeetingBooked,
  crmOnMeetingRescheduled,
  crmOnMeetingCancelled,
  crmOnMeetingNoShow,
  crmOnMeetingHeld,
];
