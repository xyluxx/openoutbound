/**
 * LinkedIn checks in the action job's order (linkedin/action-job.ts runs them through the
 * gate): the slot time, the account, the person, contactability (company-level outreach rules
 * only for campaign steps) with open privacy requests, the relation (already connected or
 * invited, a recent withdrawal, not connected for a message) and the text. Working hours, caps
 * and gaps are decided by the job's claim under a lock on the account; the views read the same
 * planner. Pacing gaps of a few minutes are not blockers.
 */
import type { LinkedInAccount } from "../../db/schema/index.js";
import { OUTREACH_ONLY_REASONS } from "../leads/contactable.js";
import { loadPlannerInput } from "../linkedin/capacity.js";
import {
  dailyCap,
  findSlot,
  hasCapacity,
  LINKEDIN_ACTIONS,
  type LinkedInActionKind,
  NOTE_MAX_FREE,
  NOTE_MAX_PREMIUM,
  REINVITE_COOLDOWN_DAYS,
  rampPercent,
  usedOn,
  weeklyCap,
} from "../linkedin/limits.js";
import { nextWindow } from "../linkedin/time.js";
import { type Blocker, blocker } from "./blockers.js";
import {
  aiBudget,
  campaignActive,
  contactGroup,
  enrollmentState,
  gated,
  messageState,
  one,
  outreachRules,
  threadOwner,
  waiting,
  workspaceActive,
} from "./checks-common.js";
import type { CheckState, EligibilityCheck, GateBlocker } from "./eligibility-types.js";

const DAY_MS = 86_400_000;
/** The action job's comment limit. */
export const COMMENT_MAX = 1250;
/** A job may start this much before its planned slot (clock skew); earlier runs wait. */
export const EARLY_TOLERANCE_MS = 60_000;

const ACTION_WORDS: Record<LinkedInActionKind, string> = {
  invite: "invitation",
  message: "message",
  visit: "profile visit",
  like: "like",
  comment: "comment",
};

export function isLinkedInActionKind(value: string): value is LinkedInActionKind {
  return (LINKEDIN_ACTIONS as readonly string[]).includes(value);
}

/** The key that wakes an action job waiting for its slot. */
export function linkedinSlotKey(messageId: string): string {
  return `linkedin.slot:${messageId}`;
}

function accountFacts(state: CheckState, account: LinkedInAccount | null) {
  return {
    ...state.facts,
    account: account?.name ?? null,
    accountId: account?.id ?? null,
    detail: account?.status_reason ?? null,
  };
}

function accountBlocker(state: CheckState, account: LinkedInAccount): Blocker {
  if (!account.external_account_id) {
    return blocker("no_linkedin_account", {
      ...accountFacts(state, account),
      detail: "its account was removed",
    });
  }
  return blocker(`linkedin_account_${account.status}`, accountFacts(state, account));
}

/** An action job that woke before the slot it was planned into waits for that slot. */
export const linkedinDue: EligibilityCheck = {
  name: "slot_time",
  async run(state) {
    const { message } = state;
    if (state.mode !== "send" || !message?.scheduled_for) return null;
    const slot = message.scheduled_for;
    if (slot.getTime() <= state.now.getTime() + EARLY_TOLERANCE_MS) return null;
    return one(
      gated(blocker("not_due_yet", { ...state.facts, until: slot }), "wait", {
        wait_key: linkedinSlotKey(message.id),
        retry_at: slot.toISOString(),
      }),
    );
  },
};

/** Accounts a new action would be planned on (the sequencer's and the inbox's choice). */
async function candidateAccountIds(state: CheckState): Promise<string[]> {
  const { input, enrollment, thread, campaignSettings, loader } = state;
  if (input.linkedinAccountId) return [input.linkedinAccountId];
  if (enrollment?.linkedin_account_id) return [enrollment.linkedin_account_id];
  if (state.answering && thread?.linkedin_account_id) return [thread.linkedin_account_id];
  if (state.campaign) return campaignSettings?.senders.linkedin_account_ids ?? [];
  return (await loader.allAccounts()).map((row) => row.id);
}

/**
 * The account: a queued action fails without one (or with one that was removed) and goes back
 * to the queue while its account is not active; a new action needs an active account.
 */
export const linkedinAccount: EligibilityCheck = {
  name: "linkedin_account",
  async run(state) {
    const { message, loader, facts } = state;
    if (message && !state.unplanned) {
      if (!isLinkedInActionKind(message.action)) {
        const item = blocker("unsupported_action", { ...facts, action: message.action });
        return one(gated(item, "fail", { detail: `unsupported_action: ${message.action}` }), true);
      }
      if (!message.linkedin_account_id) {
        const item = blocker("no_linkedin_account", {
          ...facts,
          detail: "the message has no account",
        });
        return one(gated(item, "fail", { detail: "missing_account" }), true);
      }
      const account = await loader.account(message.linkedin_account_id);
      if (!account?.external_account_id) {
        const item = blocker("no_linkedin_account", {
          ...facts,
          detail: "its account was removed",
        });
        return one(gated(item, "fail", { detail: "account_removed" }), true);
      }
      state.account = account;
      if (account.status === "active") return null;
      return one(
        gated(accountBlocker(state, account), "move", { detail: `account ${account.status}` }),
      );
    }
    const ids = await candidateAccountIds(state);
    const rows = (await Promise.all(ids.map((id) => loader.account(id)))).filter(
      (row): row is LinkedInAccount => row !== null,
    );
    const usable = rows.find((row) => row.status === "active" && row.external_account_id);
    if (usable) {
      state.account = usable;
      return null;
    }
    const first = rows[0];
    if (!first) {
      return one(
        waiting(
          blocker("no_linkedin_account", {
            ...facts,
            detail: state.campaign
              ? "the campaign lists no LinkedIn account"
              : "the workspace has no LinkedIn account",
          }),
        ),
      );
    }
    return one(waiting(accountBlocker(state, first)));
  },
};

/** A queued action must name its person (the job fails it otherwise); a new one needs a person. */
export const linkedinPerson: EligibilityCheck = {
  name: "person",
  async run(state) {
    const { message, facts } = state;
    if (message) {
      if (message.person_id) return null;
      return one(
        gated(blocker("person_not_found", facts), "fail", { detail: "missing_person" }),
        true,
      );
    }
    return state.person ? null : one(waiting(blocker("person_not_found", facts)), true);
  },
};

/**
 * Contactability on LinkedIn, with an open privacy request. An answer in a conversation (no
 * campaign step) is never held back by company-level outreach rules (a hold, an open CRM deal,
 * an owned account).
 */
export const linkedinContactability: EligibilityCheck = {
  name: "contactability",
  async run(state) {
    const personId = state.message?.person_id ?? state.person?.id;
    if (!personId) return null;
    const result = await state.loader.contactable(personId, "linkedin");
    const stepless = state.message ? !state.message.step_id : state.answering;
    const blocking = stepless
      ? result.reasons.filter((reason) => !OUTREACH_ONLY_REASONS.has(reason))
      : result.reasons;
    const blocked = !result.ok && (blocking.length > 0 || result.reasons.length === 0);
    const codes = blocked ? (blocking.length > 0 ? blocking : ["not_contactable"]) : [];
    return contactGroup(
      state,
      codes,
      (all) =>
        `not_contactable:${all.map((code) => (code === "not_contactable" ? "unknown" : code)).join(",")}`,
    );
  },
};

/** The person's row: a queued action whose person was removed fails. */
export const linkedinPersonRow: EligibilityCheck = {
  name: "person_row",
  async run(state) {
    if (!state.message || state.person) return null;
    return one(
      gated(blocker("person_not_found", state.facts), "fail", { detail: "person_removed" }),
      true,
    );
  },
};

/** The relation between the account and the person decides invites and messages. */
export const linkedinRelation: EligibilityCheck = {
  name: "relation",
  async run(state) {
    const { account, person, message } = state;
    if (!account || !person) return null;
    const relation = await state.loader.relation(account.id, person.id);
    state.relation = relation;
    const base = accountFacts(state, account);
    const skip = (item: Blocker, detail: string): GateBlocker =>
      message ? gated(item, "skip", { detail }) : waiting(item);
    const found: GateBlocker[] = [];
    if (!person.linkedin_url && !relation?.provider_ref && !state.codes.has("no_linkedin")) {
      found.push(skip(blocker("missing_linkedin_url", base), "missing_linkedin_url"));
    }
    if (state.action === "invite") {
      if (relation?.status === "connected") {
        found.push(skip(blocker("already_connected", base), "already_connected"));
      } else if (relation?.status === "invited") {
        found.push(skip(blocker("already_invited", base), "already_invited"));
      } else if (relation?.status === "withdrawn") {
        const withdrawnAt = relation.withdrawn_at ?? relation.updated_at;
        const end = new Date(withdrawnAt.getTime() + REINVITE_COOLDOWN_DAYS * DAY_MS);
        if (end.getTime() > state.at.getTime()) {
          // A queued invitation is skipped for good; a new one could go once the wait ends.
          found.push(
            message
              ? skip(
                  blocker("recently_withdrawn", base, { hard: true }),
                  `recently_withdrawn (no re-invite within ${REINVITE_COOLDOWN_DAYS} days)`,
                )
              : waiting(blocker("recently_withdrawn", { ...base, until: end })),
          );
        }
      }
    }
    if (state.action === "message" && relation?.status !== "connected") {
      const status = relation?.status ?? "none";
      const item = blocker(
        "not_connected",
        { ...base, status },
        { hard: Boolean(message) || status !== "invited" },
      );
      found.push(skip(item, "not_connected"));
    }
    return found.length > 0 ? { blockers: found } : null;
  },
};

/** The text of a queued action (the job fails empty or too long text). */
export const linkedinContent: EligibilityCheck = {
  name: "content",
  async run(state) {
    const { message, account, facts } = state;
    if (!message || !["scheduled", "approved"].includes(message.status)) return null;
    const text = (message.body_text ?? "").trim();
    const fail = (item: Blocker, detail: string) => one(gated(item, "fail", { detail }));
    if (message.action === "invite") {
      const max = account?.premium ? NOTE_MAX_PREMIUM : NOTE_MAX_FREE;
      if (text.length <= max) return null;
      const words = `${text.length} characters, max ${max}`;
      return fail(blocker("note_too_long", { ...facts, detail: words }), `note_too_long: ${words}`);
    }
    if (message.action === "message" && !text) {
      return fail(blocker("empty_message", facts), "empty_message");
    }
    if (message.action === "comment") {
      if (!text) return fail(blocker("empty_message", facts), "empty_comment");
      if (text.length > COMMENT_MAX) {
        return fail(
          blocker("comment_too_long", { ...facts, detail: `max ${COMMENT_MAX} characters` }),
          `comment_too_long: max ${COMMENT_MAX}`,
        );
      }
    }
    return null;
  },
};

/**
 * Working hours and caps of the account, from the same planner the action job claims with
 * (the job decides them itself under a lock on the account, so the sender skips this check).
 */
export const linkedinHours: EligibilityCheck = {
  name: "working_hours",
  async run(state) {
    if (state.mode === "send") return null;
    const { account, message, loader } = state;
    const action = state.action;
    if (account?.status !== "active" || !isLinkedInActionKind(action)) return null;
    if (message && message.status !== "scheduled" && !state.unplanned) return null;
    const planner = await loadPlannerInput(loader.ctx.db, {
      account,
      workspace: loader.workspace,
      action,
      from: state.at,
      ...(message ? { excludeMessageId: message.id } : {}),
    });
    const base = {
      ...accountFacts(state, account),
      detail: null,
      zone: planner.schedule.timezone,
    };
    const later = (item: Blocker): GateBlocker =>
      message && item.until
        ? gated(item, "wait", { wait_key: linkedinSlotKey(message.id), retry_at: item.until })
        : waiting(item);
    const window = nextWindow(planner.schedule, state.at);
    if (!window) return one(later(blocker("linkedin_no_slot", base)));
    if (window.start.getTime() > state.at.getTime()) {
      const slot = findSlot(planner, state.at);
      return one(
        later(
          slot
            ? blocker("linkedin_outside_hours", { ...base, until: slot.at })
            : blocker("linkedin_no_slot", base),
        ),
      );
    }
    if (hasCapacity(planner, window.dayKey)) return null;
    const pct = rampPercent(planner.ramp, window.dayKey);
    const daily = dailyCap(planner.limits, action, pct);
    const weekly =
      usedOn(planner, window.dayKey) >= daily ? null : weeklyCap(planner.limits, action, pct);
    const slot = findSlot(planner, window.end);
    if (!slot) return one(later(blocker("linkedin_no_slot", base)));
    return one(
      later(
        blocker("linkedin_cap_reached", {
          ...base,
          action: `${weekly !== null ? "weekly" : "daily"} ${ACTION_WORDS[action]}`,
          limit: weekly ?? daily,
          until: slot.at,
        }),
      ),
    );
  },
};

/** Every LinkedIn check, in the action job's order. */
export const LINKEDIN_CHECKS: readonly EligibilityCheck[] = [
  messageState,
  workspaceActive,
  campaignActive,
  linkedinDue,
  enrollmentState,
  threadOwner,
  linkedinAccount,
  linkedinPerson,
  linkedinContactability,
  linkedinPersonRow,
  linkedinRelation,
  outreachRules,
  aiBudget,
  linkedinContent,
  linkedinHours,
];
