/**
 * Email checks in the send job's order (email/send-job.ts runs them through the gate): the
 * recipient, the mailbox state and provider throttle (moved or waited out by the job's
 * move-or-wait planning), suppressions and contactability with a send-time re-verification and
 * open privacy requests, a late message outside its window, the daily cap, the subject, then
 * the unsubscribe link (held without a public base URL). In the views the same checks also say
 * where and when a move lands; they reserve nothing.
 */
import type { CampaignSettings } from "../../core/settings.js";
import type { Mailbox } from "../../db/schema/index.js";
import { recipientTimeZone } from "../campaigns/timezones.js";
import { rampLimit } from "../email/capacity.js";
import { singleRecipient } from "../email/compose.js";
import { holdsQueuedMail, throttledUntil } from "../email/mailbox-state.js";
import { anytimeSchedule } from "../email/message-context.js";
import { type PlanEmailSendResult, planEmailSendWith, SENDABLE_STATUSES } from "../email/plan.js";
import { buildWindowSpec, isInWindow } from "../email/send-window.js";
import { holdsForUnsubscribeLink } from "../email/sending-checks.js";
import { localDate } from "../email/timezone.js";
import {
  UNSUBSCRIBE_LINK_MISSING,
  UNSUBSCRIBE_RECHECK_MS,
  unsubscribeLinkKey,
} from "../email/unsubscribe-hold.js";
import { isBlockingReason } from "../inbox/send.js";
import { type BlockerFacts, blocker } from "./blockers.js";
import {
  aiBudget,
  campaignActive,
  contactGroup,
  enrollmentState,
  gated,
  messageState,
  one,
  outreachRules,
  personExists,
  threadOwner,
  waiting,
  workspaceActive,
  workspaceZone,
} from "./checks-common.js";
import type { CheckState, EligibilityCheck } from "./eligibility-types.js";

/** The send job re-checks the window only for campaign messages later than this. */
const LATE_AFTER_MS = 15 * 60_000;

/** The error the send job stores for a mailbox that cannot send. */
function mailboxDownDetail(mailbox: Mailbox | null, mailboxId: string | null): string {
  return `Mailbox ${mailbox?.email ?? mailboxId ?? "(none)"} is ${mailbox?.status ?? "missing"}.`;
}

/** The schedule the send job plans with (campaign schedule, else always open). */
function scheduleOf(state: CheckState): CampaignSettings["schedule"] {
  if (state.campaignSettings && !(state.answering && !state.message)) {
    return state.campaignSettings.schedule;
  }
  return anytimeSchedule(state.loader.workspace.timezone || "UTC");
}

function zoneOf(state: CheckState, schedule: CampaignSettings["schedule"]): string {
  return recipientTimeZone(
    schedule,
    state.person ?? { timezone: null, country: null },
    state.company,
  );
}

function campaignMailboxIds(state: CheckState): string[] {
  return state.campaignSettings?.senders.mailbox_ids ?? [];
}

/** planEmailSendWith exactly as the send job's reschedule calls it. */
function plan(
  state: CheckState,
  mailboxIds: string[],
  preferred: string | null,
  notBefore: Date,
): Promise<PlanEmailSendResult> {
  const schedule = scheduleOf(state);
  return planEmailSendWith(
    state.loader.planCtx,
    {
      mailboxIds,
      preferredMailboxId: preferred,
      recipientEmail: state.recipient ?? "",
      recipientTimezone: zoneOf(state, schedule),
      schedule,
      notBefore,
    },
    state.message ? { excludeMessageId: state.message.id } : {},
  );
}

/** Where the send job's reschedule lands (time and mailbox), or null when it fails the message. */
function landing(
  result: PlanEmailSendResult,
  ids: string[],
  preferred: string | null,
): { at: Date; mailboxId: string | null } | null {
  if (result.ok) return { at: result.sendAt, mailboxId: result.mailboxId };
  if (
    result.retryAt &&
    result.reason !== "no_active_mailbox" &&
    result.reason !== "workspace_paused"
  ) {
    return {
      at: result.retryAt,
      mailboxId: preferred && ids.includes(preferred) ? preferred : (ids[0] ?? null),
    };
  }
  return null;
}

/** Campaign mailboxes a message may move to (the send job's moveTargets). */
async function moveTargets(state: CheckState, currentId: string | undefined): Promise<string[]> {
  const ids = campaignMailboxIds(state).filter((id) => id !== currentId);
  if (ids.length === 0) return [];
  const rows = await state.loader.mailboxes(ids);
  const held = new Set(rows.filter((row) => holdsQueuedMail(row)).map((row) => row.id));
  return ids.filter((id) => !held.has(id));
}

function statusCode(mailbox: Mailbox | null): string {
  switch (mailbox?.status) {
    case "paused":
      return "mailbox_paused";
    case "error":
      return "mailbox_error";
    case "disconnected":
      return "mailbox_disconnected";
    default:
      return "no_mailbox";
  }
}

function mailboxFacts(state: CheckState, mailbox: Mailbox | null, fallbackId?: string | null) {
  return {
    ...state.facts,
    mailbox: mailbox?.email ?? null,
    mailboxId: mailbox?.id ?? fallbackId ?? null,
    detail: mailbox ? mailbox.status_reason : "its mailbox no longer exists",
    zone: workspaceZone(state),
  } satisfies BlockerFacts;
}

/** A mailbox the engine paused for its health: when the pause ends by itself, if ever. */
function healthPauseEnd(mailbox: Mailbox, at: Date): Date | null {
  const until = mailbox.health?.auto_pause?.until;
  const end = until ? new Date(until) : null;
  return end && end.getTime() > at.getTime() ? end : null;
}

/** The recipient: exactly one plain address (the send job fails the message otherwise). */
export const recipient: EligibilityCheck = {
  name: "recipient",
  async run(state) {
    const address = (state.message?.to_address ?? state.person?.email ?? "").trim();
    state.recipient = singleRecipient(address);
    if (state.recipient) return null;
    const detail = address
      ? `The recipient must be exactly one plain address, not "${address.slice(0, 200)}".`
      : "No recipient address.";
    const item =
      !address && state.person
        ? blocker("no_email", state.facts)
        : blocker("invalid_recipient", {
            ...state.facts,
            detail: address ? `"${address.slice(0, 120)}"` : null,
          });
    return one(state.message ? gated(item, "fail", { detail }) : waiting(item));
  },
};

/**
 * The message's mailbox, as the send job's moveOrFail and throttle handling see it. The sender
 * moves the email (or waits for a mailbox paused for its health); the views say where it lands.
 */
async function messageMailbox(state: CheckState) {
  const message = state.message;
  if (!message) return null;
  const { loader } = state;
  const mailbox = await loader.mailbox(message.mailbox_id);
  const sendable = mailbox && (SENDABLE_STATUSES as readonly string[]).includes(mailbox.status);
  if (!sendable) {
    const code = statusCode(mailbox);
    const facts = mailboxFacts(state, mailbox, message.mailbox_id);
    const move = { detail: mailboxDownDetail(mailbox, message.mailbox_id) };
    state.timingSettled = true;
    if (state.mode === "send") return one(gated(blocker(code, facts), "move", move));
    if (mailbox && holdsQueuedMail(mailbox)) {
      const until = healthPauseEnd(mailbox, state.at);
      return one(gated(blocker("mailbox_paused", { ...facts, until }), "move", move));
    }
    const others = state.replyMode ? [] : await moveTargets(state, mailbox?.id);
    if (others.length > 0 && state.recipient) {
      const land = landing(await plan(state, others, null, state.now), others, null);
      if (land) {
        const target = await loader.mailbox(land.mailboxId);
        const item = blocker(code, { ...facts, movedTo: target?.email ?? null, until: land.at });
        return one(gated(item, "move", move));
      }
      const item = blocker(code, {
        ...facts,
        detail: `${facts.detail ?? mailbox?.status ?? "missing"}; no other campaign mailbox can send it`,
      });
      return one(gated(item, "move", move));
    }
    return one(gated(blocker(code, facts), "move", move));
  }
  state.mailbox = mailbox;
  const throttled = throttledUntil(mailbox, state.at);
  if (!throttled) return null;
  state.timingSettled = true;
  const move = {
    detail: "Mailbox throttled by the provider.",
    retry_at: throttled.toISOString(),
  };
  if (state.mode === "send") {
    return one(
      gated(
        blocker("mailbox_throttled", { ...mailboxFacts(state, mailbox), detail: null }),
        "move",
        move,
      ),
    );
  }
  const ids = state.replyMode
    ? [mailbox.id]
    : [...new Set([mailbox.id, ...campaignMailboxIds(state)])];
  const land = state.recipient
    ? landing(await plan(state, ids, mailbox.id, throttled), ids, mailbox.id)
    : null;
  const target =
    land?.mailboxId && land.mailboxId !== mailbox.id ? await loader.mailbox(land.mailboxId) : null;
  const item = blocker("mailbox_throttled", {
    ...mailboxFacts(state, mailbox),
    detail: null,
    movedTo: target?.email ?? null,
    until: land?.at ?? throttled,
  });
  return one(gated(item, "move", move));
}

/** Mailboxes a new email would be planned on (the sequencer's and the inbox's choice). */
async function candidateMailboxIds(state: CheckState): Promise<string[]> {
  if (state.input.mailboxId) return [state.input.mailboxId];
  const ids: string[] = [];
  if (state.answering && state.thread?.mailbox_id) ids.push(state.thread.mailbox_id);
  if (state.enrollment?.mailbox_id && state.replyMode) ids.push(state.enrollment.mailbox_id);
  if (state.campaign) {
    ids.push(...campaignMailboxIds(state));
    if (!state.answering) return [...new Set(ids)];
  }
  if (ids.length === 0 || state.answering) {
    ids.push(...(await state.loader.allMailboxes()).map((row) => row.id));
  }
  return [...new Set(ids)];
}

/**
 * A new email, or one that waits to be planned (approved, in review): could any sender take it
 * (the planner decides, as it will when the message is scheduled).
 */
async function plannedMailbox(state: CheckState) {
  if (!state.recipient) return null;
  const ids = await candidateMailboxIds(state);
  if (ids.length === 0) {
    state.plan = null;
    return one(
      waiting(
        blocker("no_mailbox", {
          ...state.facts,
          detail: state.campaign ? "the campaign lists no mailbox" : "the workspace has no mailbox",
        }),
      ),
    );
  }
  const schedule = scheduleOf(state);
  state.plan = await plan(state, ids, ids[0] ?? null, state.at);
  state.planZone = buildWindowSpec(
    schedule,
    state.loader.settings.schedule,
    zoneOf(state, schedule),
  ).timezone;
  const rows = await state.loader.mailboxes(ids);
  if (rows.some((row) => (SENDABLE_STATUSES as readonly string[]).includes(row.status))) {
    return null;
  }
  // Nothing can send: say why, mailbox by mailbox when there is only one.
  state.plan = null;
  if (rows.length <= 1) {
    const mailbox = rows[0] ?? null;
    const facts = mailboxFacts(state, mailbox, ids[0]);
    const until = mailbox && holdsQueuedMail(mailbox) ? healthPauseEnd(mailbox, state.at) : null;
    return one(waiting(blocker(statusCode(mailbox), { ...facts, until })));
  }
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  const summary = [...counts].map(([status, count]) => `${count} ${status}`).join(", ");
  return one(
    waiting(blocker("no_mailbox", { ...state.facts, detail: `every mailbox is off (${summary})` })),
  );
}

export const mailboxState: EligibilityCheck = {
  name: "mailbox",
  async run(state) {
    return state.message && !state.unplanned ? messageMailbox(state) : plannedMailbox(state);
  },
};

/**
 * Suppressions of the recipient address and domain, then the leads contactability check (after
 * the sender's re-verification of a stale address), then an open privacy request. Replies stop
 * only for opt-outs, bounces and bad data (`isBlockingReason`) and for a privacy request.
 */
export const emailContactability: EligibilityCheck = {
  name: "contactability",
  async run(state) {
    const { loader, person, message } = state;
    const reasons: string[] = [];
    const reverify = state.mode === "send" ? state.hooks.reverify : undefined;
    if (reverify && person && state.recipient) {
      reasons.push(...(await reverify({ person, recipient: state.recipient })));
    }
    if (state.recipient) reasons.push(...(await loader.recipientSuppressions(state.recipient)));
    if (person) {
      const result = await loader.contactable(person.id, "email");
      if (!result.ok) {
        const found = result.reasons.length > 0 ? result.reasons : ["not_contactable"];
        const replying = (message?.action ?? state.action) === "reply";
        reasons.push(...(replying ? found.filter(isBlockingReason) : found));
      }
    }
    return contactGroup(state, reasons, (codes) => codes.join(", "));
  },
};

/** A campaign message later than 15 minutes must still be inside its send window. */
export const sendWindow: EligibilityCheck = {
  name: "send_window",
  async run(state) {
    if (state.timingSettled) return null;
    const { message, campaignSettings, mailbox } = state;
    if (!message || state.unplanned) return plannedTiming(state, "window");
    if (message.status !== "scheduled" || !campaignSettings || !mailbox) return null;
    const scheduledFor = message.scheduled_for ?? state.at;
    if (state.at.getTime() - scheduledFor.getTime() <= LATE_AFTER_MS) return null;
    const spec = buildWindowSpec(
      campaignSettings.schedule,
      state.loader.settings.schedule,
      zoneOf(state, campaignSettings.schedule),
    );
    if (isInWindow(state.at, spec)) return null;
    state.timingSettled = true;
    const move = {
      detail: "Outside the send window.",
      retry_at: state.now.toISOString(),
      keep_sender: true,
    };
    if (state.mode === "send") {
      return one(
        gated(blocker("outside_window", { ...state.facts, zone: spec.timezone }), "move", move),
      );
    }
    const land = state.recipient
      ? landing(await plan(state, [mailbox.id], mailbox.id, state.at), [mailbox.id], mailbox.id)
      : null;
    if (!land) return one(gated(blocker("window_never_opens", state.facts), "move", move));
    const item = blocker("outside_window", { ...state.facts, until: land.at, zone: spec.timezone });
    return one(gated(item, "move", move));
  },
};

/** The mailbox's daily cap today (ramp included), counted like the send job does. */
export const dailyCap: EligibilityCheck = {
  name: "daily_cap",
  async run(state) {
    if (state.timingSettled) return null;
    const { message, mailbox, loader } = state;
    if (!message || state.unplanned) return plannedTiming(state, "capacity");
    if (message.status !== "scheduled" || !mailbox) return null;
    const zone = workspaceZone(state);
    const today = localDate(state.at, zone);
    const count = await loader.sentOnDay(mailbox.id, today);
    const limit = rampLimit(
      mailbox.daily_limit,
      mailbox.ramp,
      localDate(mailbox.created_at, zone),
      today,
    );
    if (count < limit) return null;
    state.timingSettled = true;
    const code = limit < mailbox.daily_limit ? "mailbox_warming" : "daily_cap_reached";
    const facts = { ...mailboxFacts(state, mailbox), detail: null, limit, count };
    const move = {
      detail: "Daily limit reached.",
      retry_at: state.now.toISOString(),
      keep_sender: true,
    };
    if (state.mode === "send") return one(gated(blocker(code, facts), "move", move));
    const land = state.recipient
      ? landing(await plan(state, [mailbox.id], mailbox.id, state.at), [mailbox.id], mailbox.id)
      : null;
    return one(gated(blocker(code, { ...facts, until: land?.at ?? null }), "move", move));
  },
};

/** Without a message: the planner's answer for the window or the caps, when it said no. */
async function plannedTiming(state: CheckState, part: "window" | "capacity") {
  const result = state.plan;
  if (!result || result.ok) return null;
  if (part === "window" && result.reason === "outside_window") {
    if (!result.retryAt) return one(waiting(blocker("window_never_opens", state.facts)));
    return one(
      waiting(
        blocker("outside_window", {
          ...state.facts,
          until: result.retryAt,
          zone: state.planZone ?? workspaceZone(state),
        }),
      ),
    );
  }
  if (part !== "capacity" || result.reason !== "no_capacity") return null;
  const ids = await candidateMailboxIds(state);
  const rows = await state.loader.mailboxes(ids);
  const sendable = rows.filter((row) =>
    (SENDABLE_STATUSES as readonly string[]).includes(row.status),
  );
  const zone = workspaceZone(state);
  if (sendable.length === 1 && sendable[0]) {
    const mailbox = sendable[0];
    const today = localDate(state.at, zone);
    const limit = rampLimit(
      mailbox.daily_limit,
      mailbox.ramp,
      localDate(mailbox.created_at, zone),
      today,
    );
    const code = limit < mailbox.daily_limit ? "mailbox_warming" : "daily_cap_reached";
    return one(
      waiting(
        blocker(code, {
          ...mailboxFacts(state, mailbox),
          detail: null,
          limit,
          until: result.retryAt ?? null,
        }),
      ),
    );
  }
  return one(
    waiting(blocker("no_capacity", { ...state.facts, until: result.retryAt ?? null, zone })),
  );
}

/** A new-thread email needs a subject (the send job fails it otherwise). */
export const emailSubject: EligibilityCheck = {
  name: "subject",
  async run(state) {
    const { message } = state;
    if (message?.status !== "scheduled" || state.replyMode) return null;
    if ((message.subject ?? "").trim()) return null;
    return one(
      gated(blocker("message_no_subject", state.facts), "fail", {
        detail: "The message has no subject.",
      }),
    );
  },
};

/**
 * Real email needs a working unsubscribe link: without a public https base URL it waits, and the
 * send job opens a `sending_blocked` problem (email/unsubscribe-hold.ts). Replies to people who
 * wrote to us and sandbox email go out. Last, so only an email that would go out now is held.
 */
export const unsubscribeLink: EligibilityCheck = {
  name: "unsubscribe_link",
  async run(state) {
    const { loader } = state;
    const action = state.message?.action ?? state.action;
    // The sender: the one settled on, the planner's pick, else every candidate (a new email).
    const planned = state.plan?.ok ? await loader.mailbox(state.plan.mailboxId) : null;
    const senders = state.mailbox
      ? [state.mailbox]
      : planned
        ? [planned]
        : await loader.mailboxes(await candidateMailboxIds(state));
    const held = senders.some((mailbox) =>
      holdsForUnsubscribeLink(loader.ctx.config, loader.workspace, mailbox, action),
    );
    if (!held) return null;
    return one(
      gated(blocker(UNSUBSCRIBE_LINK_MISSING, state.facts), "wait", {
        wait_key: unsubscribeLinkKey(loader.workspace.id),
        retry_at: new Date(state.now.getTime() + UNSUBSCRIBE_RECHECK_MS).toISOString(),
      }),
    );
  },
};

/** Every email check, in the send job's order. */
export const EMAIL_CHECKS: readonly EligibilityCheck[] = [
  messageState,
  workspaceActive,
  personExists,
  recipient,
  campaignActive,
  enrollmentState,
  threadOwner,
  mailboxState,
  emailContactability,
  outreachRules,
  aiBudget,
  sendWindow,
  dailyCap,
  emailSubject,
  unsubscribeLink,
];
