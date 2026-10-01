/**
 * Sending replies through the channel services: email replies stay in the thread
 * (In-Reply-To/References set on the message, sent by the email module through
 * `planEmailSend` + `queueEmailSend`), LinkedIn replies go through `planLinkedInAction` +
 * `queueLinkedInAction`. Every send waits a human-like delay; automatic replies also wait for
 * the sending window.
 */
import { and, eq, inArray } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import type { Channel } from "../../core/enums.js";
import { OpenOutboundError } from "../../core/errors.js";
import {
  type CampaignSettings,
  parseCampaignSettings,
  parseWorkspaceSettings,
  type WorkspaceSettings,
} from "../../core/settings.js";
import { type Message, mailboxes, messages } from "../../db/schema/index.js";
import { planEmailSend, queueEmailSend } from "../email/service.js";
import { checkContactable } from "../leads/service.js";
import { planLinkedInAction, queueLinkedInAction } from "../linkedin/service.js";
import { nextSendWindowStart } from "./dates.js";
import { findCampaign, findMessage, findPerson, findThread } from "./reply-context.js";
import { SUPERSEDED_BY_PERSON } from "./stale-replies.js";
import { THREAD_OWNED_BY_PERSON } from "./takeover.js";

export const SEND_REPLY_JOB = "inbox.send_reply";
/** An approved reply that still cannot go out after this long is marked failed. */
export const REPLY_SEND_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export type ScheduleResult =
  | { status: "scheduled"; message_id: string; send_at: Date }
  | { status: "waiting"; message_id: string; retry_at: Date; reason: string }
  | { status: "blocked"; message_id: string; reason: string; hint: string };

const EU_EEA = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
  "IS",
  "LI",
  "NO",
]);

/**
 * Line added to replies sent without human review (EU AI Act Art. 50), per
 * `settings.compliance.ai_disclosure`: `all`, or `eu` for EU/EEA recipients. A missing or
 * unrecognized country counts as EU/EEA, so the line is only left out for recipients known
 * to be elsewhere. Never used for human-approved replies.
 */
export function aiDisclosureLine(
  settings: WorkspaceSettings,
  country: string | null | undefined,
): string | null {
  const { auto_replies, text } = settings.compliance.ai_disclosure;
  if (auto_replies === "off" || !text.trim()) return null;
  if (auto_replies === "all") return text.trim();
  const code = country?.trim().toUpperCase() ?? "";
  const known = /^[A-Z]{2}$/.test(code);
  return !known || EU_EEA.has(code) ? text.trim() : null;
}

/** Reasons from `checkContactable` that forbid even a reply (opt-outs, bounces, bad data). */
export function isBlockingReason(reason: string): boolean {
  return /suppress|unsubscrib|bounc|do_not_contact|not_interested|invalid|no_email|no_linkedin|opted_out|complaint/i.test(
    reason,
  );
}

/** Blocker for a reply whose person no longer exists (GDPR erasure, retention or deletion). */
export const PERSON_ERASED = "person_erased";

/**
 * Why no reply may go to this person: opt-outs, suppressions (email, domain, person, company,
 * LinkedIn), do-not-contact, bounces and bad data (`isBlockingReason`), or `person_erased` when
 * the thread has no person any more. Empty when a reply may go out.
 */
export async function replyBlockers(
  ctx: OpContext,
  personId: string | null | undefined,
  channel: Channel,
): Promise<string[]> {
  if (!personId) return [PERSON_ERASED];
  const contactable = await checkContactable(ctx, { personId, channel });
  if (contactable.ok) return [];
  if (contactable.reasons.includes("person_not_found")) return [PERSON_ERASED];
  return contactable.reasons.filter(isBlockingReason);
}

interface ReplyBlockText {
  /** What is wrong, in plain words. */
  what: string;
  /** What to do about it; `who` is " (person_id pe_...)" or empty. */
  fix: (who: string, personId: string | null) => string;
}

/** Opt-outs, suppressions and do-not-contact marks: final, nothing to fix. */
const DO_NOT_CONTACT: ReplyBlockText = {
  what: "this person opted out or may not be contacted",
  fix: () =>
    "Do not contact them: the engine never messages people who opted out, are suppressed or marked do not contact. See why with manage_suppressions action check; only a human with the person's documented consent may lift it.",
};

/** Contact data a reply cannot go to, which can be fixed. Every other reason is `DO_NOT_CONTACT`. */
const DATA_BLOCKS: Record<string, ReplyBlockText> = {
  invalid_email: {
    what: "their email address is marked invalid",
    fix: (who, personId) =>
      `Check the address and correct it with manage_leads action update${who}, or verify it again with enrich_leads action verify${personId ? ` (person_ids ["${personId}"])` : ""}.`,
  },
  no_email: {
    what: "they have no email address",
    fix: (who, personId) =>
      `Add one with manage_leads action update${who}, or find one with enrich_leads action enrich${personId ? ` (person_ids ["${personId}"])` : ""}.`,
  },
  person_bounced: {
    what: "email to them bounced",
    fix: (who) =>
      `Never retry that address. If they gave you a new one, set it and their status with manage_leads action update${who}.`,
  },
  no_linkedin: {
    what: "no LinkedIn profile is stored for them",
    fix: (who) => `Add their linkedin_url with manage_leads action update${who}.`,
  },
};

/**
 * The `suppressed` error for a reply that `replyBlockers` stops (also shown by dry runs). Each
 * reason gets its own words and fix: bad or missing contact data can be corrected, an opt-out
 * or a suppression is final.
 */
export function replyBlockedError(
  reasons: readonly string[],
  threadId: string,
  personId: string | null = null,
): OpenOutboundError {
  const details = { thread_id: threadId, reasons: [...reasons] };
  if (reasons.includes(PERSON_ERASED)) {
    return new OpenOutboundError("suppressed", "No reply can go out: this person was erased.", {
      hint: "The person asked to be forgotten, so the engine never contacts them again; close the thread with reply_to_thread action update.",
      details,
    });
  }
  return new OpenOutboundError(
    "suppressed",
    `No reply can go out: ${uniqueIds(reasons.map((reason) => blockText(reason).what)).join("; ")} (${reasons.join(", ")}).`,
    { hint: replyBlockHint(reasons, personId), details },
  );
}

function blockText(reason: string): ReplyBlockText {
  return DATA_BLOCKS[reason] ?? DO_NOT_CONTACT;
}

/**
 * What to do about the reasons a reply may not go out: one fix per data problem, or only "do not
 * contact" when they opted out or may not be contacted (fixing their data would not change that).
 */
export function replyBlockHint(reasons: readonly string[], personId: string | null): string {
  const who = personId ? ` (person_id ${personId})` : "";
  if (reasons.some((reason) => !DATA_BLOCKS[reason])) return DO_NOT_CONTACT.fix(who, personId);
  return uniqueIds(reasons.map((reason) => blockText(reason).fix(who, personId))).join(" ");
}

/** Random human-like delay from `settings.sending.reply_delay_minutes` ([min, max] minutes). */
export function randomDelayMs(range: readonly [number, number], random = Math.random): number {
  const low = Math.min(range[0], range[1]);
  const high = Math.max(range[0], range[1]);
  return Math.round((low + random() * (high - low)) * 60_000);
}

/** "Re: <subject>" without stacking prefixes. */
export function replySubject(subject: string | null | undefined): string {
  const base = (subject ?? "").trim();
  if (!base) return "Re: your message";
  return /^(re|aw|antw|sv|vs)(\[\d+\])?\s*:/i.test(base) ? base : `Re: ${base}`;
}

/** References chain for a reply to `inbound`: its references plus its Message-ID. */
export function replyReferences(
  inbound: Pick<Message, "references" | "message_id_header">,
): string[] {
  const chain = [...(inbound.references ?? [])];
  if (inbound.message_id_header) chain.push(inbound.message_id_header);
  return [...new Set(chain)].slice(-20);
}

function uniqueIds(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

/** Sending window for automatic replies: workspace working days and the campaign hours. */
function sendWindow(
  settings: WorkspaceSettings,
  schedule: CampaignSettings["schedule"],
  personTimeZone: string | null,
  workspaceTimeZone: string,
) {
  const workingDays = settings.schedule.working_days;
  const days = schedule.days.filter((day) => workingDays.includes(day));
  return {
    days: days.length > 0 ? days : workingDays,
    startHour: schedule.start_hour,
    endHour: schedule.end_hour,
    timeZone:
      schedule.timezone_mode === "fixed"
        ? schedule.timezone
        : (personTimeZone ?? schedule.timezone ?? workspaceTimeZone),
    holidays: settings.schedule.holidays,
    blackoutRanges: settings.schedule.blackout_ranges,
  };
}

/** Statuses a reply can be scheduled from; anything else was cancelled or sent meanwhile. */
const SCHEDULABLE: Message["status"][] = ["draft", "pending_review", "approved"];

/** The reply was cancelled while it was being planned (for example a newer message arrived). */
function withdrawn(messageId: string): ScheduleResult {
  return {
    status: "blocked",
    message_id: messageId,
    reason: "message_cancelled",
    hint: "The reply was cancelled meanwhile (a newer message arrived or it was withdrawn); draft a new one with reply_to_thread (action draft).",
  };
}

/** Matches the reply only while it may still be scheduled (every write here checks it). */
function stillSchedulable(message: Pick<Message, "id" | "workspace_id">) {
  return and(
    eq(messages.id, message.id),
    eq(messages.workspace_id, message.workspace_id),
    inArray(messages.status, SCHEDULABLE),
  );
}

/**
 * A write found the reply no longer schedulable: another call planned, sent or cancelled it
 * meanwhile. Says what it is now (scheduled, like the idempotent start of `scheduleReplySend`,
 * once it is queued or sent), and never changes it.
 */
async function movedOnMeanwhile(ctx: OpContext, messageId: string): Promise<ScheduleResult> {
  const fresh = await findMessage(ctx, messageId);
  if (fresh && ["scheduled", "sending", "unknown", "sent"].includes(fresh.status)) {
    return {
      status: "scheduled",
      message_id: fresh.id,
      send_at: fresh.scheduled_for ?? fresh.sent_at ?? ctx.clock.now(),
    };
  }
  return changedMeanwhile(messageId, fresh?.status ?? "missing");
}

function changedMeanwhile(
  messageId: string,
  status: string,
): Extract<ScheduleResult, { status: "blocked" }> {
  return {
    status: "blocked",
    message_id: messageId,
    reason: `message_${status}`,
    hint: `The reply changed meanwhile (it is ${status} now); read the thread with list_threads action get, and draft a new reply with reply_to_thread (action draft) if one is still needed.`,
  };
}

/**
 * Cancels a reply whose person may no longer get one (`replyBlockers`) and says why; null when
 * it may go out. Runs when an approval is applied and again at every scheduling. Only a reply
 * that may still be scheduled is cancelled; one that changed meanwhile is left as it is (the
 * send gate checks the person again before anything goes out) and reported as changed.
 */
export async function cancelUncontactableReply(
  ctx: OpContext,
  message: Message,
): Promise<Extract<ScheduleResult, { status: "blocked" }> | null> {
  const person = await findPerson(ctx, message.person_id);
  const blocking = await replyBlockers(ctx, person?.id, message.channel);
  if (blocking.length === 0) return null;
  const cancelled = await ctx.db
    .update(messages)
    .set({ status: "cancelled", error: `not_contactable:${blocking.join(",")}` })
    .where(stillSchedulable(message))
    .returning({ id: messages.id });
  if (cancelled.length === 0) {
    const fresh = await findMessage(ctx, message.id);
    return changedMeanwhile(message.id, fresh?.status ?? "missing");
  }
  return {
    status: "blocked",
    message_id: message.id,
    reason: `not_contactable:${blocking.join(",")}`,
    hint: blocking.includes(PERSON_ERASED)
      ? "The person was erased; the reply was cancelled."
      : `The reply was cancelled. ${replyBlockHint(blocking, person?.id ?? null)}`,
  };
}

async function markBlocked(
  ctx: OpContext,
  message: Message,
  reason: string,
  hint: string,
  cancel: boolean,
): Promise<ScheduleResult> {
  const marked = await ctx.db
    .update(messages)
    .set(cancel ? { status: "cancelled", error: reason } : { error: reason })
    .where(stillSchedulable(message))
    .returning({ id: messages.id });
  if (marked.length === 0) return movedOnMeanwhile(ctx, message.id);
  return { status: "blocked", message_id: message.id, reason, hint };
}

/**
 * Plans and queues an outbound reply message. Idempotent: an already scheduled or sent
 * message returns `scheduled`. `delay` adds the human-like delay, `respectWindow` holds the
 * reply until the next sending window (automatic replies).
 */
export async function scheduleReplySend(
  ctx: OpContext,
  messageId: string,
  options: { delay: boolean; respectWindow: boolean },
): Promise<ScheduleResult> {
  const workspace = requireWorkspace(ctx);
  const message = await findMessage(ctx, messageId);
  if (message?.direction !== "outbound") {
    return {
      status: "blocked",
      message_id: messageId,
      reason: "message_not_found",
      hint: "Draft the reply again with reply_to_thread (action draft).",
    };
  }
  if (["scheduled", "sending", "unknown", "sent"].includes(message.status)) {
    return {
      status: "scheduled",
      message_id: message.id,
      send_at: message.scheduled_for ?? message.sent_at ?? ctx.clock.now(),
    };
  }
  if (!SCHEDULABLE.includes(message.status)) {
    return {
      status: "blocked",
      message_id: message.id,
      reason: `message_${message.status}`,
      hint: "Draft a new reply with reply_to_thread (action draft).",
    };
  }
  const settings = parseWorkspaceSettings(workspace.settings);
  const thread = message.thread_id ? await findThread(ctx, message.thread_id) : null;
  const automatic = Boolean((message.why as { auto_reply_for?: unknown } | null)?.auto_reply_for);
  if (thread?.owner === "person" && automatic) {
    // A person answers this thread now: no automatic answer (explicit replies still go).
    await ctx.db
      .update(messages)
      .set({ status: "cancelled", error: SUPERSEDED_BY_PERSON })
      .where(and(eq(messages.id, message.id), inArray(messages.status, SCHEDULABLE)));
    return {
      status: "blocked",
      message_id: message.id,
      reason: THREAD_OWNED_BY_PERSON,
      hint: "A person took this thread over, so no automatic reply goes out. Answer it yourself with reply_to_thread action send, or hand it back with reply_to_thread action release.",
    };
  }
  const person = await findPerson(ctx, message.person_id);
  const campaign = await findCampaign(ctx, message.campaign_id ?? thread?.campaign_id ?? null);
  const campaignSettings = parseCampaignSettings(campaign?.settings);

  // Checked again at every scheduling (after approval too): people opt out meanwhile.
  const uncontactable = await cancelUncontactableReply(ctx, message);
  if (uncontactable) return uncontactable;

  let earliest = new Date(
    ctx.clock.now().getTime() +
      (options.delay ? randomDelayMs(settings.sending.reply_delay_minutes) : 0),
  );
  if (options.respectWindow) {
    earliest = nextSendWindowStart(
      earliest,
      sendWindow(settings, campaignSettings.schedule, person?.timezone ?? null, workspace.timezone),
    );
  }

  const retry = async (reason: string, retryAt: Date | undefined): Promise<ScheduleResult> => {
    const at =
      retryAt ??
      (reason === "workspace_paused" ? new Date(ctx.clock.now().getTime() + 3_600_000) : null);
    if (!at) {
      const hint =
        message.channel === "email"
          ? "Activate a mailbox with manage_mailboxes (action resume or add), then approve the reply again."
          : "Reconnect or resume the LinkedIn account with manage_linkedin, then approve the reply again.";
      return markBlocked(ctx, message, reason, hint, false);
    }
    const [held] = await ctx.db
      .update(messages)
      .set({ status: "approved", scheduled_for: null, error: null })
      .where(and(eq(messages.id, message.id), inArray(messages.status, SCHEDULABLE)))
      .returning({ id: messages.id });
    if (!held) return withdrawn(message.id);
    await ctx.jobs.enqueue(
      SEND_REPLY_JOB,
      { message_id: message.id },
      { runAt: at, singletonKey: `${SEND_REPLY_JOB}:${message.id}` },
    );
    return { status: "waiting", message_id: message.id, retry_at: at, reason };
  };

  if (message.channel === "email") {
    const mailboxIds = uniqueIds([
      message.mailbox_id,
      thread?.mailbox_id,
      ...campaignSettings.senders.mailbox_ids,
    ]);
    const recipient = message.to_address ?? person?.email ?? null;
    if (mailboxIds.length === 0 || !recipient) {
      return markBlocked(
        ctx,
        message,
        mailboxIds.length === 0 ? "no_mailbox" : "no_recipient",
        mailboxIds.length === 0
          ? "Add a mailbox with manage_mailboxes (action add), then approve the reply again."
          : "The contact has no email address; reply on another channel.",
        false,
      );
    }
    const plan = await planEmailSend(ctx, {
      mailboxIds,
      preferredMailboxId: message.mailbox_id ?? thread?.mailbox_id ?? null,
      recipientEmail: recipient,
      recipientTimezone: person?.timezone ?? null,
      schedule: campaignSettings.schedule,
      notBefore: earliest,
    });
    if (!plan.ok) return retry(plan.reason, plan.retryAt);
    const [mailbox] = await ctx.db
      .select({ email: mailboxes.email })
      .from(mailboxes)
      .where(and(eq(mailboxes.workspace_id, workspace.id), eq(mailboxes.id, plan.mailboxId)))
      .limit(1);
    const [planned] = await ctx.db
      .update(messages)
      .set({
        status: "approved",
        mailbox_id: plan.mailboxId,
        scheduled_for: plan.sendAt,
        to_address: recipient,
        from_address: mailbox?.email ?? message.from_address,
        error: null,
      })
      .where(and(eq(messages.id, message.id), inArray(messages.status, SCHEDULABLE)))
      .returning({ id: messages.id });
    if (!planned) return withdrawn(message.id);
    await queueEmailSend(ctx, message.id);
    return { status: "scheduled", message_id: message.id, send_at: plan.sendAt };
  }

  const accountIds = uniqueIds([
    message.linkedin_account_id,
    thread?.linkedin_account_id,
    ...campaignSettings.senders.linkedin_account_ids,
  ]);
  if (accountIds.length === 0) {
    return markBlocked(
      ctx,
      message,
      "no_linkedin_account",
      "Connect a LinkedIn account with manage_linkedin, then approve the reply again.",
      false,
    );
  }
  const plan = await planLinkedInAction(ctx, {
    accountIds,
    preferredAccountId: message.linkedin_account_id ?? thread?.linkedin_account_id ?? null,
    action: "message",
    notBefore: earliest,
  });
  if (!plan.ok) return retry(plan.reason, plan.retryAt);
  const [planned] = await ctx.db
    .update(messages)
    .set({
      status: "approved",
      linkedin_account_id: plan.accountId,
      scheduled_for: plan.runAt,
      error: null,
    })
    .where(and(eq(messages.id, message.id), inArray(messages.status, SCHEDULABLE)))
    .returning({ id: messages.id });
  if (!planned) return withdrawn(message.id);
  await queueLinkedInAction(ctx, message.id);
  return { status: "scheduled", message_id: message.id, send_at: plan.runAt };
}
