/**
 * Blockers: why something does not go out now, in plain words, with the fix. One table maps every
 * stable code to its message, its fix and whether waiting clears it, so the send gate, the
 * relationship view, explain_blocker and the docs all use the same words.
 */
import { askToChangeSettingAfter, askToRaiseBudget } from "../../core/setting-hints.js";
import type { Person } from "../../db/schema/index.js";
import { daysBetween, isValidTimeZone, localDate, zonedParts } from "../email/timezone.js";

/** One reason a message or a person cannot be contacted now. */
export interface Blocker {
  /** Stable machine code, e.g. `daily_cap_reached`. */
  code: string;
  /** Plain words, e.g. "Mailbox sam@acme.example hit its daily cap of 40. Next try ...". */
  message: string;
  /** When it clears by itself (ISO 8601), or null. */
  until: string | null;
  /** The exact tool and action that fixes it, or null when nobody can (or needs to). */
  fix: string | null;
  /** True when waiting will not clear it: a person or the agent must act. */
  hard: boolean;
}

/** Facts a template can use. Every field is optional; templates fall back to generic words. */
export interface BlockerFacts {
  now: Date;
  person?: string | null;
  personId?: string | null;
  company?: string | null;
  companyId?: string | null;
  mailbox?: string | null;
  mailboxId?: string | null;
  /** Where the email moves to when its own mailbox cannot send. */
  movedTo?: string | null;
  account?: string | null;
  accountId?: string | null;
  campaign?: string | null;
  campaignId?: string | null;
  /** Another campaign (one active campaign per person). */
  otherCampaign?: string | null;
  enrollmentId?: string | null;
  threadId?: string | null;
  messageId?: string | null;
  /** The campaign step a message belongs to (null: a reply or another message outside steps). */
  stepId?: string | null;
  approvalId?: string | null;
  problemId?: string | null;
  action?: string | null;
  status?: string | null;
  limit?: number | null;
  count?: number | null;
  /** When the blocker clears by itself. */
  until?: Date | null;
  /** Zone `until` is written in (default UTC). */
  zone?: string | null;
  /** When a condition ends (a company hold) even if the blocker itself does not clear then. */
  endsAt?: Date | null;
  /** Extra plain words (a stored reason or error). */
  detail?: string | null;
  since?: Date | null;
}

interface Template {
  /** Waiting never clears it. A known `until` makes a blocker soft regardless. */
  hard: boolean;
  message(facts: BlockerFacts): string;
  fix?(facts: BlockerFacts): string | null;
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const pad = (value: number) => String(value).padStart(2, "0");

/** A person's name for plain words (full name, first and last, email, else the id). */
export function personName(
  person: Pick<Person, "id" | "full_name" | "first_name" | "last_name" | "email">,
): string {
  return (
    person.full_name?.trim() ||
    [person.first_name, person.last_name].filter(Boolean).join(" ").trim() ||
    person.email ||
    person.id
  );
}

/**
 * A time in plain words in a zone, relative to `now`: "today 14:00 Europe/Berlin", "tomorrow
 * 09:00 UTC", "Tuesday 09:00 Europe/Berlin" within the week, else "Tuesday 6 October 09:00
 * Europe/Berlin" (with the year when it differs).
 */
export function whenInWords(at: Date, zone: string | null | undefined, now: Date): string {
  const tz = isValidTimeZone(zone) ? zone : "UTC";
  const parts = zonedParts(at, tz);
  const time = `${pad(parts.hour)}:${pad(parts.minute)}`;
  const diff = daysBetween(localDate(now, tz), localDate(at, tz));
  const weekday = WEEKDAYS[parts.weekday - 1] ?? "";
  let day: string;
  if (diff === 0) day = "today";
  else if (diff === 1) day = "tomorrow";
  else if (diff > 1 && diff < 7) day = weekday;
  else {
    const year = parts.year !== zonedParts(now, tz).year ? ` ${parts.year}` : "";
    day = `${weekday} ${parts.day} ${MONTHS[parts.month - 1] ?? ""}${year}`;
  }
  return `${day} ${time} ${tz}`;
}

const who = (f: BlockerFacts) => f.person ?? "This person";
const whose = (f: BlockerFacts) => (f.person ? `${f.person}'s` : "The");
const mailboxLabel = (f: BlockerFacts) => (f.mailbox ? `Mailbox ${f.mailbox}` : "The mailbox");
const accountLabel = (f: BlockerFacts) =>
  f.account ? `LinkedIn account ${f.account}` : "The LinkedIn account";
const companyLabel = (f: BlockerFacts) => f.company ?? "The company";
const campaignLabel = (f: BlockerFacts) => (f.campaign ? `Campaign ${f.campaign}` : "The campaign");
const id = (field: string, value: string | null | undefined) =>
  value ? ` (${field} ${value})` : "";
const detail = (f: BlockerFacts) => {
  const text = f.detail?.trim().replace(/[.\s]+$/, "");
  return text ? `: ${text}` : "";
};
const next = (f: BlockerFacts, words = "Next try") =>
  f.until ? ` ${words} ${whenInWords(f.until, f.zone, f.now)}.` : "";
const moved = (f: BlockerFacts) =>
  f.movedTo && f.until
    ? ` The email moves to ${f.movedTo} and goes out ${whenInWords(f.until, f.zone, f.now)}.`
    : next(f);
const leadsUpdate = (f: BlockerFacts) => `manage_leads action update${id("person_id", f.personId)}`;
const suppressionFix = () =>
  "Only if the suppression was a mistake: remove it with manage_suppressions action remove.";
const findAddress = (f: BlockerFacts) =>
  `Find another address with enrich_leads action enrich${id("person_id", f.personId)}, then save it with ${leadsUpdate(f)}.`;

/** Every blocker code with its words (reused by the docs and by wave 2's shared gate). */
export const BLOCKER_TEMPLATES: Record<string, Template> = {
  // Workspace, campaign and enrollment.
  workspace_paused: {
    hard: true,
    message: () => "The workspace is paused (kill switch), so nothing is sent.",
    fix: () =>
      "Resume it with manage_workspaces action resume once the reason for the pause is fixed.",
  },
  workspace_archived: {
    hard: true,
    message: () => "The workspace is archived, so nothing is sent.",
    fix: () =>
      "If it should send again, ask the human to restore it (openoutbound workspaces update --no-archived).",
  },
  campaign_paused: {
    hard: true,
    message: (f) => `${campaignLabel(f)} is paused; its queued messages wait until it resumes.`,
    fix: (f) => `Resume it with launch_campaign action resume${id("campaign_id", f.campaignId)}.`,
  },
  campaign_inactive: {
    hard: true,
    message: (f) => `${campaignLabel(f)} is ${f.status ?? "not active"}, so it sends nothing.`,
    fix: (f) =>
      f.status === "draft"
        ? `Launch it with launch_campaign action launch${id("campaign_id", f.campaignId)}.`
        : "Enroll the person in an active campaign with enroll_leads action enroll.",
  },
  enrollment_paused: {
    hard: true,
    message: (f) =>
      `${whose(f)} sequence in ${f.campaign ?? "the campaign"} is paused${detail(f)}.${next(f, "It resumes")}`,
    fix: (f) =>
      f.status === "reply_pending_classification"
        ? `Classify the reply with reply_to_thread action classify${id("thread_id", f.threadId)}.`
        : null,
  },
  enrollment_ended: {
    hard: true,
    message: (f) =>
      `${whose(f)} sequence in ${f.campaign ?? "the campaign"} has ended (${f.status ?? "finished"}).`,
    fix: () => "Enroll them in another campaign with enroll_leads action enroll if it makes sense.",
  },
  enrollment_waiting_review: {
    hard: true,
    message: (f) => `${whose(f)} next step waits for a review.`,
    fix: (f) => `Decide it with review_items action decide${id("approval_id", f.approvalId)}.`,
  },

  // The message itself.
  message_not_found: {
    hard: true,
    message: () => "The message does not exist in this workspace.",
    fix: () => "List messages with manage_messages action list and use an id starting with msg_.",
  },
  approval_pending: {
    hard: true,
    message: (f) =>
      `The message waits for approval${f.since ? ` since ${whenInWords(f.since, f.zone, f.now)}` : ""}.`,
    fix: (f) => `Decide it with review_items action decide${id("approval_id", f.approvalId)}.`,
  },
  message_generating: {
    hard: false,
    message: () => "The message is still being written.",
  },
  message_draft: {
    // A step's draft moves on by itself (the caller passes hard: false for it).
    hard: true,
    message: (f) =>
      f.stepId
        ? "The message is a draft: the campaign reviews or schedules it at its next run."
        : "The message is a draft: nobody has sent it or asked for a review yet.",
    fix: (f) => {
      if (f.stepId) {
        return `Nothing to do. To change the text first, edit it with manage_messages action update${id("message_id", f.messageId)}.`;
      }
      const ids = [
        f.threadId ? `thread_id ${f.threadId}` : null,
        f.messageId ? `message_id ${f.messageId}` : null,
      ].filter(Boolean);
      return `Send it with reply_to_thread action send${ids.length > 0 ? ` (${ids.join(", ")})` : ""}; pass text to change the wording first.`;
    },
  },
  message_sending: {
    hard: false,
    message: () => "The message is being sent right now.",
  },
  send_unknown: {
    hard: true,
    message: () =>
      "An earlier send attempt may have gone out; the engine never sends it again until that is checked.",
    fix: (f) =>
      `Check the Sent folder, then settle it with manage_messages action resolve_unknown${id("message_id", f.messageId)}.`,
  },
  message_sent: {
    hard: true,
    message: (f) =>
      `The message was already sent${f.since ? ` ${whenInWords(f.since, f.zone, f.now)}` : ""}.`,
  },
  message_cancelled: {
    hard: true,
    message: (f) => `The message was cancelled${detail(f)}.`,
  },
  message_failed: {
    hard: true,
    message: (f) => `The message failed${detail(f)}.`,
    fix: (f) =>
      `Fix the cause, then write it again with manage_messages action regenerate${id("message_id", f.messageId)} or start a new one.`,
  },
  message_skipped: {
    hard: true,
    message: (f) => `The message was skipped${detail(f)}.`,
  },
  message_bounced: {
    hard: true,
    message: (f) => `The message bounced${detail(f) || "; the address does not receive mail"}.`,
    fix: (f) => findAddress(f),
  },
  message_no_subject: {
    hard: true,
    message: () => "The email has no subject.",
    fix: (f) => `Add one with manage_messages action update${id("message_id", f.messageId)}.`,
  },
  unresolved_variables: {
    hard: true,
    message: (f) => `The email has template variables with no value${detail(f)}.`,
    fix: (f) =>
      `Edit it with manage_messages action update${id("message_id", f.messageId)}, or add fallbacks like {{first_name|there}}.`,
  },
  invalid_recipient: {
    hard: true,
    message: () => "The email needs exactly one plain recipient address.",
    fix: (f) => `Fix the address with ${leadsUpdate(f)}.`,
  },

  // The person and the company (contactability codes from the leads module).
  person_not_found: {
    hard: true,
    message: () => "The person does not exist in this workspace (deleted or forgotten).",
  },
  no_email: {
    hard: true,
    message: (f) => `${who(f)} has no email address.`,
    fix: (f) =>
      `Find one with enrich_leads action enrich${id("person_id", f.personId)}, or add it with ${leadsUpdate(f)}.`,
  },
  no_linkedin: {
    hard: true,
    message: (f) => `${who(f)} has no LinkedIn profile URL.`,
    fix: (f) => `Add linkedin_url with ${leadsUpdate(f)}.`,
  },
  role_address: {
    hard: true,
    message: (f) =>
      `${whose(f)} address is a role address (like info@ or sales@), which never gets cold email.`,
    fix: (f) => findAddress(f),
  },
  invalid_email: {
    hard: true,
    message: (f) => `${whose(f)} email address is invalid (verification failed).`,
    fix: (f) => findAddress(f),
  },
  unverified_email: {
    hard: true,
    message: (f) =>
      `${whose(f)} email address is not verified, and this workspace only emails verified addresses.`,
    fix: (f) =>
      `Verify it with enrich_leads action verify${id("person_id", f.personId)}. ${askToChangeSettingAfter("To accept unverified addresses", { "sending.require_verified_email": false })}`,
  },
  catch_all_skipped: {
    hard: true,
    message: (f) =>
      `${whose(f)} email domain accepts every address (catch-all), and this workspace skips catch-all addresses.`,
    fix: () =>
      askToChangeSettingAfter("Only if you accept the risk", { "sending.catch_all": "allow" }),
  },
  suppressed_email: {
    hard: true,
    message: (f) => `${whose(f)} email address is on the suppression list.`,
    fix: suppressionFix,
  },
  suppressed_domain: {
    hard: true,
    message: () => "The email domain is on the suppression list.",
    fix: suppressionFix,
  },
  suppressed_linkedin: {
    hard: true,
    message: (f) => `${whose(f)} LinkedIn profile is on the suppression list.`,
    fix: suppressionFix,
  },
  suppressed_person: {
    hard: true,
    message: (f) => `${who(f)} is on the suppression list.`,
    fix: suppressionFix,
  },
  suppressed_company: {
    hard: true,
    message: (f) => `${companyLabel(f)} is on the suppression list.`,
    fix: suppressionFix,
  },
  person_do_not_contact: {
    hard: true,
    message: (f) => `${who(f)} is marked do not contact.`,
  },
  person_unsubscribed: {
    hard: true,
    message: (f) => `${who(f)} unsubscribed.`,
  },
  person_bounced: {
    hard: true,
    message: (f) => `Email to ${f.person ?? "this person"} bounced before.`,
    fix: (f) => findAddress(f),
  },
  person_customer: {
    hard: true,
    message: (f) => `${who(f)} is a customer, so there is no cold outreach.`,
  },
  company_do_not_contact: {
    hard: true,
    message: (f) => `${companyLabel(f)} is marked do not contact.`,
  },
  company_competitor: {
    hard: true,
    message: (f) => `${companyLabel(f)} is marked as a competitor.`,
  },
  company_customer: {
    hard: true,
    message: (f) => `${companyLabel(f)} is a customer, so there is no cold outreach.`,
  },
  company_on_hold: {
    hard: true,
    message: (f) =>
      `${companyLabel(f)} is on hold${f.endsAt ? ` until ${whenInWords(f.endsAt, f.zone, f.now)}` : ""}${detail(f)}; no new outreach to anyone there.`,
    fix: (f) =>
      `Release it early with manage_leads action release_company${id("company_id", f.companyId)} if the hold no longer applies.`,
  },
  company_open_deal: {
    hard: true,
    message: (f) => `${companyLabel(f)} has an open deal in the CRM, so new outreach waits.`,
    fix: () =>
      askToChangeSettingAfter("Close the deal in the CRM, or if reps agree", {
        "crm.allow_outreach_with_open_deal": true,
      }),
  },
  company_owned: {
    hard: true,
    message: (f) => `${companyLabel(f)} is owned by a sales rep in the CRM${detail(f)}.`,
    fix: () => askToChangeSettingAfter("If reps agree", { "crm.skip_owned_accounts": false }),
  },
  excluded_country: {
    hard: true,
    message: (f) => `${who(f)} is in a country this workspace excludes.`,
    fix: () =>
      askToChangeSettingAfter("Only if the exclusion is wrong", {
        "compliance.excluded_countries": ["<the countries to keep excluded>"],
      }),
  },
  consent_required: {
    hard: true,
    message: (f) =>
      `${whose(f)} country requires prior consent for cold email, and none is recorded.`,
    fix: (f) => `Record custom.consent with ${leadsUpdate(f)} only if you really have consent.`,
  },
  publication_evidence_missing: {
    hard: true,
    message: () =>
      "This country needs evidence of where the address was published, and none is recorded.",
    fix: (f) => `Add the page URL as custom.publication_url with ${leadsUpdate(f)}.`,
  },
  uk_possible_sole_trader: {
    hard: true,
    message: (f) =>
      `${companyLabel(f)} may be a UK sole trader (no corporate legal form found), which counts as an individual.`,
    fix: (f) =>
      `If it is a limited company, record custom.legal_form with manage_leads action update_company${id("company_id", f.companyId)}.`,
  },
  privacy_request_open: {
    hard: true,
    message: (f) => `${who(f)} made a privacy request that is still open.`,
    fix: (f) =>
      `Answer the privacy request first (see get_attention_queue). A request to delete their data closes when you forget them with manage_leads action forget; close any other request with resolve_exception action resolve${id("problem_id", f.problemId)}.`,
  },
  thread_owned_by_person: {
    hard: true,
    message: () =>
      "A person took over this conversation, so the engine sends no automatic replies or sequence steps in it.",
    fix: (f) =>
      `Answer yourself, or hand it back with reply_to_thread action release${id("thread_id", f.threadId)}.`,
  },

  // Email senders, capacity and windows.
  no_mailbox: {
    hard: true,
    message: (f) => `No mailbox can send this email${detail(f)}.`,
    fix: () =>
      "Add or resume a mailbox with manage_mailboxes (action add or resume), and list it in the campaign senders with create_campaign action update.",
  },
  mailbox_paused: {
    hard: true,
    message: (f) => `${mailboxLabel(f)} is paused${detail(f)}.${moved(f)}`,
    fix: (f) =>
      `Fix the cause, then resume it with manage_mailboxes action resume${id("mailbox_id", f.mailboxId)}.`,
  },
  mailbox_error: {
    hard: true,
    message: (f) => `${mailboxLabel(f)} has an error${detail(f)}.${moved(f)}`,
    fix: (f) =>
      `Fix the login or server settings with manage_mailboxes action update, then check it with manage_mailboxes action test${id("mailbox_id", f.mailboxId)}.`,
  },
  mailbox_disconnected: {
    hard: true,
    message: (f) => `${mailboxLabel(f)} is disconnected.${moved(f)}`,
    fix: (f) =>
      `Reconnect it with manage_mailboxes action oauth_start or update${id("mailbox_id", f.mailboxId)}.`,
  },
  mailbox_throttled: {
    hard: false,
    message: (f) => `${mailboxLabel(f)} is throttled by its provider${detail(f)}.${moved(f)}`,
  },
  daily_cap_reached: {
    hard: false,
    message: (f) =>
      `${mailboxLabel(f)} hit its daily cap${f.limit !== null && f.limit !== undefined ? ` of ${f.limit}` : ""}.${next(f)}`,
    fix: () =>
      "Nothing to do: it goes out then. To send more a day, add a mailbox with manage_mailboxes action add and list it in the campaign senders.",
  },
  mailbox_warming: {
    hard: false,
    message: (f) =>
      f.limit
        ? `${mailboxLabel(f)} is warming up and may send ${f.limit} cold emails today.${next(f)}`
        : `${mailboxLabel(f)} is in its first warm-up weeks and sends no cold email yet.${next(f, "First send")}`,
  },
  no_capacity: {
    hard: false,
    message: (f) => `Every mailbox that can send this email is full for now.${next(f)}`,
    fix: () =>
      "Nothing to do: it goes out then. To send more a day, add a mailbox with manage_mailboxes action add.",
  },
  outside_window: {
    hard: false,
    message: (f) =>
      `The send window${f.person ? ` for ${f.person}` : ""} is closed now.${next(f, "It opens")}`,
    fix: (f) =>
      `Nothing to do: it goes out then. If the window is wrong, change the schedule with create_campaign action update${id("campaign_id", f.campaignId)}.`,
  },
  window_never_opens: {
    hard: true,
    message: () =>
      "The sending window never opens (no allowed days, start after end, or the campaign ended).",
    fix: (f) =>
      `Fix the schedule with create_campaign action update${id("campaign_id", f.campaignId)}. ${askToChangeSettingAfter("If the workspace working days are wrong", { "schedule.working_days": [1, 2, 3, 4, 5] })}`,
  },
  unsubscribe_link_missing: {
    hard: true,
    message: () =>
      "The email is held: OPENOUTBOUND_BASE_URL is not a public https address, so its unsubscribe link would not work.",
    fix: () =>
      "Ask the human to set OPENOUTBOUND_BASE_URL to the engine's public https address and restart `openoutbound serve`; held emails go out at their next check, within 30 minutes.",
  },

  // LinkedIn.
  no_linkedin_account: {
    hard: true,
    message: (f) => `No LinkedIn account can take this action${detail(f)}.`,
    fix: () =>
      "Connect one with manage_linkedin action connect, and list it in the campaign senders with create_campaign action update.",
  },
  linkedin_account_paused: {
    hard: true,
    message: (f) => `${accountLabel(f)} is paused${detail(f)}.`,
    fix: (f) => `Resume it with manage_linkedin action resume${id("account_id", f.accountId)}.`,
  },
  linkedin_account_restricted: {
    hard: true,
    message: (f) => `${accountLabel(f)} is restricted by LinkedIn${detail(f)}.`,
    fix: (f) =>
      `Check the account on LinkedIn; once it works again, resume it with manage_linkedin action resume${id("account_id", f.accountId)}.`,
  },
  linkedin_account_disconnected: {
    hard: true,
    message: (f) => `${accountLabel(f)} is disconnected${detail(f)}.`,
    fix: () => "Reconnect it with manage_linkedin action connect.",
  },
  linkedin_account_pending: {
    hard: true,
    message: (f) => `${accountLabel(f)} is still connecting.`,
    fix: () =>
      "Finish the connection (manage_linkedin action list shows its status), or connect it again.",
  },
  linkedin_outside_hours: {
    hard: false,
    message: (f) => `${accountLabel(f)} is outside its working hours now.${next(f, "Next slot")}`,
    fix: (f) =>
      `Nothing to do: it goes out then. Working hours are set with manage_linkedin action update${id("account_id", f.accountId)}.`,
  },
  linkedin_cap_reached: {
    hard: false,
    message: (f) =>
      `${accountLabel(f)} reached its ${f.action ?? "action"} cap${f.limit !== null && f.limit !== undefined ? ` of ${f.limit}` : ""} for now.${next(f, "Next slot")}`,
    fix: () => "Nothing to do: it goes out then. Raising LinkedIn caps risks a restriction.",
  },
  linkedin_no_slot: {
    hard: true,
    message: (f) => `${accountLabel(f)} has no free slot in the next three weeks.`,
    fix: (f) =>
      `Check its working hours and caps with manage_linkedin action update${id("account_id", f.accountId)}.`,
  },
  not_due_yet: {
    hard: false,
    message: (f) => `The action is planned for later.${next(f, "It runs")}`,
  },
  not_connected: {
    hard: true,
    message: (f) =>
      f.status === "invited"
        ? `${who(f)} has not accepted the connection invitation yet, so a message cannot be sent.`
        : `${who(f)} is not connected on LinkedIn, so a message cannot be sent.`,
    fix: (f) =>
      f.status === "invited"
        ? null
        : "Send a connection invitation first (a linkedin_invite step before the message).",
  },
  already_connected: {
    hard: true,
    message: (f) => `${who(f)} is already connected, so the invitation is skipped.`,
  },
  already_invited: {
    hard: true,
    message: (f) => `An invitation to ${f.person ?? "this person"} is already pending.`,
  },
  recently_withdrawn: {
    hard: false,
    message: (f) =>
      `An invitation to ${f.person ?? "this person"} was withdrawn less than 30 days ago, and LinkedIn does not allow inviting again yet.${next(f)}`,
  },
  missing_linkedin_url: {
    hard: true,
    message: (f) => `${who(f)} has no LinkedIn profile URL.`,
    fix: (f) => `Add linkedin_url with ${leadsUpdate(f)}.`,
  },
  empty_message: {
    hard: true,
    message: () => "The message has no text.",
    fix: (f) => `Add the text with manage_messages action update${id("message_id", f.messageId)}.`,
  },
  unsupported_action: {
    hard: true,
    message: (f) => `LinkedIn cannot do "${f.action ?? "this action"}".`,
  },
  comment_too_long: {
    hard: true,
    message: (f) => `The comment is too long${detail(f)}.`,
    fix: (f) => `Shorten it with manage_messages action update${id("message_id", f.messageId)}.`,
  },
  note_too_long: {
    hard: true,
    message: (f) => `The invitation note is too long${detail(f)}.`,
    fix: (f) => `Shorten it with manage_messages action update${id("message_id", f.messageId)}.`,
  },

  // New outreach (the enrollment rules).
  already_enrolled: {
    hard: true,
    message: (f) => `${who(f)} is already in ${f.campaign ?? "this campaign"}.`,
  },
  active_in_other_campaign: {
    hard: true,
    message: (f) =>
      `${who(f)} is already active in ${f.otherCampaign ? `campaign ${f.otherCampaign}` : "another campaign"} (one active campaign per person).`,
    fix: () => "Wait for it to finish, or take them out with enroll_leads action unenroll.",
  },
  rest_period: {
    hard: false,
    message: (f) =>
      `${who(f)} finished a campaign recently; the rest period ends ${f.until ? whenInWords(f.until, f.zone, f.now) : "soon"}.`,
    fix: () =>
      askToChangeSettingAfter("To change the rest period", {
        "compliance.rest_days_after_campaign": 30,
      }),
  },
  company_cap_reached: {
    hard: false,
    message: (f) =>
      `${companyLabel(f)} already has ${f.count ?? "the maximum number of"} people in running campaigns (cap ${f.limit ?? "reached"}).`,
    fix: () =>
      askToChangeSettingAfter("Wait for one to finish, or to raise the cap", {
        "compliance.contact_cap_per_company": 3,
      }),
  },
  ai_budget_used_up: {
    hard: false,
    message: (f) =>
      `The monthly AI budget is used up, so no new messages are written.${next(f, "It resets")}`,
    fix: () => `Wait until it resets, or ${askToRaiseBudget("ai.monthly_budget_usd")}.`,
  },
};

/** Every blocker code, for docs and tests. */
export const BLOCKER_CODES: readonly string[] = Object.keys(BLOCKER_TEMPLATES);

/** Overrides for one blocker (a hard flag decided by the situation, a custom fix). */
export interface BlockerOverrides {
  hard?: boolean;
  fix?: string | null;
}

/**
 * Builds a blocker from its code and facts. A blocker with a known `until` is soft (waiting
 * clears it) unless the caller says otherwise. Unknown codes still read as words.
 */
export function blocker(
  code: string,
  facts: BlockerFacts,
  overrides: BlockerOverrides = {},
): Blocker {
  const template = BLOCKER_TEMPLATES[code];
  const until = facts.until && Number.isFinite(facts.until.getTime()) ? facts.until : null;
  const withUntil = { ...facts, until };
  if (!template) {
    return {
      code,
      message: `Blocked: ${code.replace(/[_:]+/g, " ").trim()}${detail(withUntil)}.${next(withUntil)}`,
      until: until?.toISOString() ?? null,
      fix: overrides.fix ?? null,
      hard: overrides.hard ?? !until,
    };
  }
  return {
    code,
    message: template.message(withUntil),
    until: until?.toISOString() ?? null,
    fix: overrides.fix !== undefined ? overrides.fix : (template.fix?.(withUntil) ?? null),
    hard: overrides.hard ?? (until ? false : template.hard),
  };
}

/** Keeps the first blocker of each code, in order. */
export function uniqueBlockers(list: readonly Blocker[]): Blocker[] {
  const seen = new Set<string>();
  const out: Blocker[] = [];
  for (const item of list) {
    if (seen.has(item.code)) continue;
    seen.add(item.code);
    out.push(item);
  }
  return out;
}

/** Blockers that only say when a slot opens: the send window, caps, a throttle, the slot itself. */
const TIMING_CODES: ReadonlySet<string> = new Set([
  "outside_window",
  "daily_cap_reached",
  "mailbox_warming",
  "no_capacity",
  "mailbox_throttled",
  "not_due_yet",
  "linkedin_outside_hours",
  "linkedin_cap_reached",
]);

/**
 * Leaves out timing blockers that clear by `at`, the time an item is planned for: it already
 * waits for them, so at that time they block nothing. Every other blocker stays.
 */
export function withoutTimingWaits(list: readonly Blocker[], at: Date | null): Blocker[] {
  if (!at) return [...list];
  return list.filter(
    (item) =>
      !(TIMING_CODES.has(item.code) && item.until && Date.parse(item.until) <= at.getTime()),
  );
}
