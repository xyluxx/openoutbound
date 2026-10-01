/**
 * The send gate: the one ordered list of checks made before every email and every LinkedIn
 * action. The senders (email/send-job.ts, linkedin/action-job.ts) call it right before sending
 * and apply the first blocker's disposition with their own functions (cancel, fail, skip, wait,
 * move); the views (checkEligibility, explain_blocker, get_next_actions, get_lead) call the same
 * checks read-only and show every blocker in plain words with its fix. So the view and the
 * sender can never disagree.
 *
 * Mode "send" is the sender acting now: the checks stop at the first blocker, reads are the
 * sender's own (one row at a time) and the sender's hooks run (a send-time re-verification).
 * Mode "view" (the default) collects every blocker, may prefetch a batch and never writes.
 */
import type { OpContext } from "../../core/context.js";
import type { Channel, MessageAction } from "../../core/enums.js";
import type {
  Campaign,
  Company,
  LinkedInAccount,
  LinkedInRelation,
  Mailbox,
  Message,
  Person,
  Workspace,
} from "../../db/schema/index.js";
import { isValidTimeZone } from "../email/timezone.js";
import { type BlockerFacts, personName } from "./blockers.js";
import { EMAIL_CHECKS } from "./checks-email.js";
import { LINKEDIN_CHECKS } from "./checks-linkedin.js";
import { EligibilityLoader } from "./eligibility-loader.js";
import type {
  CheckState,
  EligibilityCheck,
  EligibilityInput,
  GateBlocker,
  GateHooks,
  GateMode,
} from "./eligibility-types.js";

export { campaignActiveKey, companyHoldKey, workspaceActiveKey } from "./checks-common.js";
export { linkedinSlotKey } from "./checks-linkedin.js";
export type {
  GateBlocker,
  GateDisposition,
  GateHooks,
  GateMode,
} from "./eligibility-types.js";

/** What the gate checks: the eligibility input without the channel (each entry point has one). */
export type GateInput = Omit<EligibilityInput, "channel">;

export interface GateOptions {
  /** "send" for the sender acting now; "view" (default) for read-only answers. */
  mode?: GateMode;
  /** Work only the sender does (mode "send"). */
  hooks?: GateHooks;
  /** Rows the caller already read fresh (the send job's workspace and message). */
  known?: { workspace?: Workspace; message?: Message };
  /** A shared loader (views that check several things at once). */
  loader?: EligibilityLoader;
}

/** The email gate's answer, with what the send job needs to act on it. */
export interface EmailGate {
  blockers: GateBlocker[];
  /** The single recipient address, or null when there is none. */
  recipient: string | null;
  /** The message's mailbox row (null when it has none or it was removed). */
  mailbox: Mailbox | null;
  /** A reply, a reply-mode step or an In-Reply-To: it keeps its mailbox and thread. */
  replyMode: boolean;
  person: Person | null;
  company: Company | null;
  campaign: Campaign | null;
  stepMode: "new_thread" | "reply" | null;
}

/** The LinkedIn gate's answer, with what the action job needs to act on it. */
export interface LinkedInGate {
  blockers: GateBlocker[];
  account: LinkedInAccount | null;
  person: Person | null;
  relation: LinkedInRelation | null;
}

function defaultAction(channel: Channel, threadId: string | null | undefined): MessageAction {
  if (channel === "email") return threadId ? "reply" : "email";
  return threadId ? "message" : "invite";
}

/** The person's next open message on the channel (in the campaign or thread when given). */
async function openMessageFor(
  loader: EligibilityLoader,
  input: EligibilityInput,
): Promise<Message | null> {
  const open = await loader.openMessages(input.personId);
  return (
    open.find(
      (message) =>
        message.channel === input.channel &&
        (!input.campaignId || message.campaign_id === input.campaignId) &&
        (!input.threadId || message.thread_id === input.threadId) &&
        (!input.action || message.action === input.action),
    ) ?? null
  );
}

/** Everything one evaluation knows before the checks run. */
async function buildState(
  loader: EligibilityLoader,
  input: EligibilityInput,
  mode: GateMode,
  hooks: GateHooks,
): Promise<CheckState> {
  const now = loader.now;
  const send = mode === "send";
  const message = input.messageId
    ? await loader.message(input.messageId)
    : await openMessageFor(loader, input);
  const channel = message?.channel ?? input.channel;
  const personId = message ? message.person_id : input.personId;
  const person = personId ? await loader.person(personId) : null;
  const company = await loader.company(message?.company_id ?? person?.company_id ?? null);
  const campaignId = message ? message.campaign_id : (input.campaignId ?? null);
  const loaded = await loader.campaign(campaignId);
  // The sender looks at the enrollment of a sequence step only (checks-common.ts).
  const enrollment = message
    ? send && !message.step_id
      ? null
      : await loader.enrollmentById(message.enrollment_id)
    : !send && campaignId && person
      ? await loader.enrollmentIn(campaignId, person.id)
      : null;
  const stepMode = message ? await loader.stepMode(message.step_id) : null;
  const action = message?.action ?? input.action ?? defaultAction(channel, input.threadId);
  const replyMode =
    channel === "email" &&
    (action === "reply" || stepMode === "reply" || Boolean(message?.in_reply_to));

  let thread = await loader.thread(message?.thread_id ?? input.threadId ?? null);
  if (!thread && message?.enrollment_id && stepMode === "reply") {
    thread = await loader.enrollmentThread(message.enrollment_id);
  }
  if (!thread && message?.step_id && channel === "linkedin" && message.action === "message") {
    const accountId = message.linkedin_account_id;
    thread = accountId && person ? await loader.linkedinThread(accountId, person.id) : null;
  }
  const why = (message?.why ?? null) as Record<string, unknown> | null;
  // Automatic: an AI reply sent without review, or a sequence step continuing a thread.
  const automatic = message
    ? Boolean(why?.auto_reply_for) || Boolean(message.step_id && thread)
    : Boolean(thread);
  const answering =
    channel === "email"
      ? action === "reply"
      : message
        ? !message.step_id
        : Boolean(input.threadId) && !campaignId;
  const unplanned = Boolean(
    message &&
      message.status !== "scheduled" &&
      (channel === "email" ? !message.mailbox_id : !message.linkedin_account_id),
  );

  const planned = message?.scheduled_for;
  let at = send ? now : (input.at ?? (planned && planned > now ? planned : now));
  if (at < now) at = now;

  const zone = isValidTimeZone(loader.workspace.timezone) ? loader.workspace.timezone : "UTC";
  const facts: BlockerFacts = {
    now,
    person: person ? personName(person) : null,
    personId: person?.id ?? personId ?? input.personId,
    company: company?.name ?? null,
    companyId: company?.id ?? null,
    campaign: loaded?.campaign.name ?? null,
    campaignId: loaded?.campaign.id ?? campaignId,
    enrollmentId: enrollment?.id ?? null,
    threadId: thread?.id ?? input.threadId ?? null,
    messageId: message?.id ?? null,
    zone,
  };
  return {
    loader,
    input,
    mode,
    hooks,
    now,
    at,
    channel,
    action,
    person,
    company,
    message,
    approval: message && !send ? await loader.pendingApproval(message.id) : null,
    campaign: loaded?.campaign ?? null,
    campaignSettings: loaded?.settings ?? null,
    enrollment,
    thread,
    stepMode,
    replyMode,
    answering,
    automatic,
    unplanned,
    facts,
    codes: new Set(),
  };
}

/**
 * Runs one channel's ordered checks. A check may stop the ones after it; in mode "send" the
 * first blocker stops everything (the sender acts on it).
 */
async function runChecks(
  state: CheckState,
  checks: readonly EligibilityCheck[],
): Promise<GateBlocker[]> {
  const blockers: GateBlocker[] = [];
  for (const check of checks) {
    const result = await check.run(state);
    if (!result) continue;
    for (const item of result.blockers) {
      if (state.codes.has(item.code)) continue;
      state.codes.add(item.code);
      blockers.push(item);
    }
    if (result.stop || (state.mode === "send" && blockers.length > 0)) break;
  }
  return blockers;
}

async function loaderFor(ctx: OpContext, options: GateOptions): Promise<EligibilityLoader> {
  const loader =
    options.loader ??
    (options.known?.workspace
      ? EligibilityLoader.forWorkspace(ctx, options.known.workspace)
      : await EligibilityLoader.create(ctx));
  if (options.known?.message) loader.remember(options.known.message);
  return loader;
}

/** One evaluation: the state (with the sender the checks settled on) and its blockers. */
async function evaluate(
  loader: EligibilityLoader,
  input: EligibilityInput,
  options: GateOptions,
): Promise<{ state: CheckState; blockers: GateBlocker[] }> {
  const state = await buildState(loader, input, options.mode ?? "view", options.hooks ?? {});
  const checks = state.channel === "email" ? EMAIL_CHECKS : LINKEDIN_CHECKS;
  return { state, blockers: await runChecks(state, checks) };
}

/**
 * The email gate: every blocker for an email in the send job's order (see module doc), with
 * the recipient, mailbox and rows the send job goes on with.
 */
export async function evaluateEmailGate(
  ctx: OpContext,
  input: GateInput,
  options: GateOptions = {},
): Promise<EmailGate> {
  const loader = await loaderFor(ctx, options);
  const { state, blockers } = await evaluate(loader, { ...input, channel: "email" }, options);
  const mailbox = state.message
    ? await loader.mailbox(state.message.mailbox_id)
    : (state.mailbox ?? null);
  return {
    blockers,
    recipient: state.recipient ?? null,
    mailbox,
    replyMode: state.replyMode,
    person: state.person,
    company: state.company,
    campaign: state.campaign,
    stepMode: state.stepMode,
  };
}

/**
 * The LinkedIn gate: every blocker for a LinkedIn action in the action job's order (see module
 * doc), with the account, person and relation the action job goes on with.
 */
export async function evaluateLinkedInGate(
  ctx: OpContext,
  input: GateInput,
  options: GateOptions = {},
): Promise<LinkedInGate> {
  const loader = await loaderFor(ctx, options);
  const { state, blockers } = await evaluate(loader, { ...input, channel: "linkedin" }, options);
  return {
    blockers,
    account: state.account ?? null,
    person: state.person,
    relation: state.relation ?? null,
  };
}

/** Several read-only evaluations with shared, prefetched reads (lists such as next actions). */
export async function evaluateGateMany(
  ctx: OpContext,
  inputs: readonly EligibilityInput[],
  options: { loader?: EligibilityLoader } = {},
): Promise<GateBlocker[][]> {
  if (inputs.length === 0) return [];
  const loader = options.loader ?? (await EligibilityLoader.create(ctx));
  await loader.prefetch(
    inputs.map((input) => ({
      personId: input.personId,
      channel: input.channel,
      messageId: input.messageId ?? null,
      campaignId: input.campaignId ?? null,
    })),
  );
  const out: GateBlocker[][] = [];
  for (const input of inputs) out.push((await evaluate(loader, input, {})).blockers);
  return out;
}
