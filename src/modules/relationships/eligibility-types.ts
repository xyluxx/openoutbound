import type { Channel, MessageAction } from "../../core/enums.js";
import type { CampaignSettings } from "../../core/settings.js";
import type {
  Campaign,
  Company,
  Enrollment,
  LinkedInAccount,
  LinkedInRelation,
  Mailbox,
  Message,
  Person,
  Thread,
} from "../../db/schema/index.js";
import type { PlanEmailSendResult } from "../email/plan.js";
import type { Blocker, BlockerFacts } from "./blockers.js";
import type { EligibilityLoader, PendingApproval } from "./eligibility-loader.js";

/** What to check (binding signature from the upgrade plan, plus the optional `messageId`). */
export interface EligibilityInput {
  personId: string;
  channel: Channel;
  /** Default: email `reply` with a thread, else `email`; LinkedIn `message` with a thread, else `invite`. */
  action?: MessageAction;
  campaignId?: string | null;
  mailboxId?: string | null;
  linkedinAccountId?: string | null;
  threadId?: string | null;
  /** When the send would happen (default now, or the message's planned time when later). */
  at?: Date;
  /**
   * The message in question. When absent, the person's next open outbound message on the
   * channel (in the campaign or thread when given) is used; without one, the check answers
   * "could a new message go out now".
   */
  messageId?: string | null;
}

export interface EligibilityResult {
  ok: boolean;
  blockers: Blocker[];
}

/**
 * What the sender does about a blocker when the message is due:
 * - `cancel`: the message is cancelled and never goes out (the person is gone, or a person took
 *   the conversation over).
 * - `skip`: the message is skipped: the person may not be contacted (opted out, suppressed, a
 *   privacy request, a relation that rules it out).
 * - `fail`: the message fails: it cannot be sent as it is (bad recipient, no subject, too long).
 * - `wait`: nothing changes; the sender looks again when `wait_key` is woken or at `retry_at`
 *   (the workspace or campaign is paused, a company hold, an early slot). Blockers about a
 *   message that is not due (a draft, a review) or about a new message also carry `wait`.
 * - `move`: the sender plans it again: email moves to another mailbox or a later time
 *   (`retry_at` set: from that time; `keep_sender`: on the same mailbox only), a LinkedIn action
 *   goes back to the queue until its account or workspace works again.
 */
export type GateDisposition = "cancel" | "skip" | "fail" | "wait" | "move";

/** A blocker with what the sender does about it (see `GateDisposition`). */
export interface GateBlocker extends Blocker {
  disposition: GateDisposition;
  /** `wait`: the key that wakes the parked send job. */
  wait_key?: string;
  /** The exact reason the sender records (the error of a failed message, the skip reason). */
  detail?: string;
  /** `wait`: when to look again at the latest; `move` (email): the earliest time to plan from. */
  retry_at?: string;
  /** `move` (email): plan on the same mailbox only, never on another one. */
  keep_sender?: boolean;
}

/** "send": the sender acting now (stops at the first blocker); "view": read-only, every blocker. */
export type GateMode = "send" | "view";

/** Work only the sender does, handed in by the send job (the view never calls it). */
export interface GateHooks {
  /**
   * Email: re-verifies a stale address right before the first email to the person (it may use
   * verifier credits and stores the result). Returns the codes the result blocks the send with.
   */
  reverify?: (input: { person: Person; recipient: string }) => Promise<string[]>;
}

/** Everything one evaluation knows; channel checks fill in the sender they settled on. */
export interface CheckState {
  loader: EligibilityLoader;
  input: EligibilityInput;
  mode: GateMode;
  hooks: GateHooks;
  now: Date;
  at: Date;
  channel: Channel;
  action: MessageAction;
  person: Person | null;
  company: Company | null;
  message: Message | null;
  approval: PendingApproval | null;
  campaign: Campaign | null;
  campaignSettings: CampaignSettings | null;
  enrollment: Enrollment | null;
  thread: Thread | null;
  /** `reply` for email steps configured to continue the thread. */
  stepMode: "new_thread" | "reply" | null;
  /** The send job's reply mode (email): a reply, a reply-mode step, or an In-Reply-To. */
  replyMode: boolean;
  /**
   * Answers someone who wrote to us: company-level outreach rules never hold it back (email
   * action `reply`; LinkedIn messages outside campaign steps).
   */
  answering: boolean;
  /** Written and sent by the engine alone: an automatic reply or a sequence step in a thread. */
  automatic: boolean;
  /**
   * A message that waits to be planned (approved, in review, a draft) without a sender yet: the
   * planner picks its mailbox or account when it is scheduled, so it is checked like a new one.
   */
  unplanned: boolean;
  /** Base facts for blocker words (names and ids). */
  facts: BlockerFacts;
  /** Codes found so far (later checks skip what an earlier one already said). */
  codes: Set<string>;
  // Filled by the channel checks.
  recipient?: string | null;
  mailbox?: Mailbox | null;
  plan?: PlanEmailSendResult | null;
  planZone?: string;
  /** An earlier check already decided when it can go (a move or a wait): skip the timing checks. */
  timingSettled?: boolean;
  account?: LinkedInAccount | null;
  relation?: LinkedInRelation | null;
}

export interface CheckResult {
  blockers: GateBlocker[];
  /** Later checks cannot run (for example the person is gone). */
  stop?: boolean;
}

/** One check of the sender's ordered list. Returns null when it has nothing to say. */
export interface EligibilityCheck {
  name: string;
  run(state: CheckState): Promise<CheckResult | null>;
}
