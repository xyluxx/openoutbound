import { and, desc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import type { OpContext } from "../../../core/context.js";
import { requireWorkspace } from "../../../core/context.js";
import type { MessageStatus } from "../../../core/enums.js";
import {
  type Approval,
  approvals,
  enrollment_step_runs,
  enrollments,
  type Message,
  mailboxes,
  messages,
  type NewMessage,
} from "../../../db/schema/index.js";
import type { LinkedInPost } from "../../../providers/types.js";
import { planEmailSend, queueEmailSend } from "../../email/service.js";
import { checkContactable } from "../../leads/service.js";
import {
  getRecentPostForPerson,
  getRelation,
  planLinkedInAction,
  queueLinkedInAction,
} from "../../linkedin/service.js";
import { stopEnrollments } from "../control.js";
import { missingDataFor } from "../enrollment.js";
import { displayName } from "../people.js";
import { findMessage } from "../repo.js";
import { anyStepConfig, stepAction, stepChannel, stepUsesAi } from "../steps.js";
import { recipientTimeZone } from "../timezones.js";
import type { DraftCheck, DraftWhy } from "../writing/pipeline.js";
import { enqueueGeneration, generateMessage, POST_HEADERS } from "./generate.js";
import { loadStepStateForMessage } from "./load.js";
import {
  advance,
  applyMissingData,
  failEnrollment,
  MAX_STEP_ATTEMPTS,
  MOVABLE,
  reschedule,
  type StepState,
  updateRun,
} from "./state.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** How long a LinkedIn message step waits for the invite to be accepted. */
export const CONNECTION_WAIT_MS = 14 * DAY;
/** Likes and comments only act on posts younger than this. */
export const RECENT_POST_DAYS = 14;
const GENERATION_RETRY_MS = 5 * MINUTE;
const REVIEW_WATCHDOG_MS = 6 * HOUR;
const SEND_WATCHDOG_MS = HOUR;
/** Actions that are harmless to repeat (at least once by design): a failed one is replaced. */
const REPEATABLE: ReadonlySet<string> = new Set(["visit", "like"]);
/** An unsure checker (confidence under this) sends the draft to review at level `unsure`. */
export const UNSURE_CONFIDENCE = 0.7;
const MAX_GENERATION_RETRIES = 3;

type Prepared =
  | { kind: "ready"; replyTo: Message | null; post: LinkedInPost | null; accountId: string | null }
  | { kind: "missing"; reason: string; codes?: string[] }
  | { kind: "block"; reason: string; codes: string[] }
  | { kind: "skip"; reason: string }
  | { kind: "wait"; reason: string; retryAt: Date; since?: string };

/** A company hold pauses outreach until a date: the step waits for it instead of stopping. */
const COMPANY_ON_HOLD = "company_on_hold";

/**
 * Contactability codes that block the person on every channel (the rest only block this
 * channel, which is treated like missing data). A company hold is not one of them: the step
 * waits for it to end (see `holdWait`).
 */
export function isGlobalBlock(codes: readonly string[]): boolean {
  return codes.some(
    (code) =>
      code !== COMPANY_ON_HOLD &&
      /person|company|unsubscribed|do_not_contact|excluded_country|bounced|customer|competitor/.test(
        code,
      ),
  );
}

/**
 * The wait for a company hold: the step runs again when the hold ends, checked at least daily so
 * an early release or a changed date is picked up. Null when there is no hold or another reason
 * blocks the person on every channel (then the enrollment stops as before).
 */
function holdWait(state: StepState, codes: readonly string[]): Prepared | null {
  if (!codes.includes(COMPANY_ON_HOLD) || isGlobalBlock(codes)) return null;
  const now = state.now.getTime();
  const until = state.company?.hold_until?.getTime() ?? 0;
  const recheck = now + DAY;
  return {
    kind: "wait",
    reason: COMPANY_ON_HOLD,
    retryAt: new Date(until > now ? Math.min(until, recheck) : recheck),
  };
}

async function latestSentEmail(ctx: OpContext, enrollmentId: string): Promise<Message | null> {
  const [row] = await ctx.db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.enrollment_id, enrollmentId),
        eq(messages.channel, "email"),
        eq(messages.direction, "outbound"),
        eq(messages.status, "sent"),
      ),
    )
    .orderBy(desc(messages.sent_at), desc(messages.id))
    .limit(1);
  return row ?? null;
}

function linkedinAccountFor(state: StepState): string | null {
  return (
    state.enrollment.linkedin_account_id ??
    state.loaded.settings.senders.linkedin_account_ids[0] ??
    null
  );
}

async function prepare(ctx: OpContext, state: StepState): Promise<Prepared> {
  const { step, person, now } = state;
  const channel = stepChannel(step.type);
  if (!channel) throw new Error(`Not a channel step: ${step.type}`);
  const missing = missingDataFor(step, person);
  if (missing) return { kind: "missing", reason: `missing_data:${missing}` };
  const contact = await checkContactable(ctx, { personId: person.id, channel });
  if (!contact.ok) {
    const hold = holdWait(state, contact.reasons);
    if (hold) return hold;
    return isGlobalBlock(contact.reasons)
      ? { kind: "block", reason: "not_contactable", codes: contact.reasons }
      : { kind: "missing", reason: "not_contactable", codes: contact.reasons };
  }
  if (channel === "email") {
    const config = anyStepConfig(step);
    const replyTo =
      config.type === "email" && config.mode === "reply"
        ? await latestSentEmail(ctx, state.enrollment.id)
        : null;
    return { kind: "ready", replyTo, post: null, accountId: null };
  }

  const accountId = linkedinAccountFor(state);
  if (!accountId) {
    return {
      kind: "wait",
      reason: "no_linkedin_account",
      retryAt: new Date(now.getTime() + 6 * HOUR),
    };
  }
  switch (step.type) {
    case "linkedin_invite": {
      const relation = await getRelation(ctx, { accountId, personId: person.id });
      if (relation === "connected") return { kind: "skip", reason: "already_connected" };
      if (relation === "invited") return { kind: "skip", reason: "already_invited" };
      return { kind: "ready", replyTo: null, post: null, accountId };
    }
    case "linkedin_message": {
      const relation = await getRelation(ctx, { accountId, personId: person.id });
      if (relation === "connected") return { kind: "ready", replyTo: null, post: null, accountId };
      const since = state.run.detail.waiting_since ?? now.toISOString();
      if (now.getTime() - new Date(since).getTime() >= CONNECTION_WAIT_MS) {
        return { kind: "missing", reason: "not_connected" };
      }
      return {
        kind: "wait",
        reason: "waiting_for_connection",
        retryAt: new Date(now.getTime() + 12 * HOUR),
        since,
      };
    }
    case "linkedin_like":
    case "linkedin_comment": {
      const post = await getRecentPostForPerson(ctx, {
        accountId,
        personId: person.id,
        maxAgeDays: RECENT_POST_DAYS,
      });
      if (!post) return { kind: "skip", reason: "no_recent_post" };
      return { kind: "ready", replyTo: null, post, accountId };
    }
    default:
      return { kind: "ready", replyTo: null, post: null, accountId };
  }
}

async function handleNotReady(
  ctx: OpContext,
  state: StepState,
  prepared: Exclude<Prepared, { kind: "ready" }>,
): Promise<void> {
  switch (prepared.kind) {
    case "missing":
      await applyMissingData(ctx, state, prepared.reason, prepared.codes);
      return;
    case "block":
      await updateRun(ctx.db, state.run, {
        detail: { reason: prepared.reason, codes: prepared.codes },
      });
      await stopEnrollments(ctx, [state.enrollment], prepared.reason);
      return;
    case "skip":
      await advance(ctx, state, {
        anchor: ctx.clock.now(),
        outcome: "skipped",
        detail: { reason: prepared.reason },
      });
      return;
    case "wait":
      await updateRun(ctx.db, state.run, {
        status: "waiting",
        detail: {
          reason: prepared.reason,
          ...(prepared.since ? { waiting_since: prepared.since } : {}),
        },
      });
      await reschedule(ctx, state, prepared.retryAt);
      return;
  }
}

/**
 * Content of the previous attempt, reused when a send failed after review (so a retry is not
 * regenerated or reviewed again). Nothing is reused when generation itself failed.
 */
async function previousAttemptContent(
  ctx: OpContext,
  state: StepState,
): Promise<Partial<NewMessage> | null> {
  if (state.run.attempt <= 1) return null;
  const [previous] = await ctx.db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.enrollment_id, state.enrollment.id),
        eq(messages.step_id, state.step.id),
        eq(messages.status, "failed"),
        lt(messages.attempt, state.run.attempt),
      ),
    )
    .orderBy(desc(messages.created_at))
    .limit(1);
  if (!previous || previous.error?.startsWith("generation_failed")) return null;
  return {
    subject: previous.subject,
    body_text: previous.body_text,
    variant: previous.variant,
    why: previous.why,
    check: previous.check,
    thread_id: previous.thread_id,
    in_reply_to: previous.in_reply_to,
    references: previous.references,
    headers: previous.headers,
  };
}

async function createStepMessage(
  ctx: OpContext,
  state: StepState,
  prepared: Extract<Prepared, { kind: "ready" }>,
): Promise<Message> {
  const { step, person, enrollment } = state;
  const channel = stepChannel(step.type) ?? "email";
  const config = anyStepConfig(step);
  const needsText = !(
    step.type === "linkedin_visit" ||
    step.type === "linkedin_like" ||
    (config.type === "linkedin_invite" && config.note === "none")
  );
  const copied = await previousAttemptContent(ctx, state);
  const values: NewMessage = {
    workspace_id: enrollment.workspace_id,
    person_id: person.id,
    company_id: person.company_id,
    campaign_id: enrollment.campaign_id,
    enrollment_id: enrollment.id,
    step_id: step.id,
    channel,
    action: stepAction(step.type),
    direction: "outbound",
    status: needsText && !copied ? "generating" : "approved",
    to_address: channel === "email" ? person.email : person.linkedin_url,
    attempt: state.run.attempt,
    why: emptyWhy(state),
  };
  if (prepared.replyTo) {
    const parent = prepared.replyTo;
    values.thread_id = parent.thread_id;
    values.in_reply_to = parent.message_id_header;
    values.references = [
      ...(parent.references ?? []),
      ...(parent.message_id_header ? [parent.message_id_header] : []),
    ];
    values.subject = parent.subject;
  }
  if (prepared.post) {
    values.in_reply_to = prepared.post.id;
    values.headers = {
      [POST_HEADERS.id]: prepared.post.id,
      [POST_HEADERS.url]: prepared.post.url ?? "",
      [POST_HEADERS.text]: prepared.post.text.slice(0, 2000),
    };
  }
  if (copied) Object.assign(values, copied);

  const created = await ctx.db
    .transaction(async (tx) => {
      const [row] = await tx.insert(messages).values(values).returning();
      if (!row) throw new Error("message insert returned no row");
      const claimed = await tx
        .update(enrollment_step_runs)
        .set({ message_id: row.id })
        .where(
          and(
            eq(enrollment_step_runs.enrollment_id, state.run.enrollment_id),
            eq(enrollment_step_runs.step_id, state.run.step_id),
            eq(enrollment_step_runs.attempt, state.run.attempt),
            isNull(enrollment_step_runs.message_id),
          ),
        )
        .returning({ message_id: enrollment_step_runs.message_id });
      // Another worker already created this step's message: roll back ours.
      if (claimed.length === 0) throw new StaleRunError();
      return row;
    })
    .catch((error: unknown) => {
      if (error instanceof StaleRunError) return null;
      throw error;
    });
  if (created) return created;
  const [run] = await ctx.db
    .select({ message_id: enrollment_step_runs.message_id })
    .from(enrollment_step_runs)
    .where(
      and(
        eq(enrollment_step_runs.enrollment_id, state.run.enrollment_id),
        eq(enrollment_step_runs.step_id, state.run.step_id),
        eq(enrollment_step_runs.attempt, state.run.attempt),
      ),
    );
  const existing = run?.message_id ? await findMessage(ctx, run.message_id) : null;
  if (existing) return existing;
  throw new Error("step run already has a message that cannot be loaded");
}

class StaleRunError extends Error {}

/** Attribution fields reports read; generation replaces them for messages with text. */
function emptyWhy(state: StepState): DraftWhy {
  return {
    angle: "",
    signal_ids: [],
    signal_keys: [],
    facts: [],
    offer_id: state.loaded.campaign.offer_id,
    brief_id: null,
  };
}

function isFirstMessageReview(history: Array<Pick<Message, "body_text">>): boolean {
  return !history.some((message) => Boolean(message.body_text?.trim()));
}

/** Whether a drafted message needs a human (review level, failed checks, comment policy). */
async function needsReview(ctx: OpContext, state: StepState, message: Message): Promise<boolean> {
  const hasText = Boolean(message.body_text?.trim());
  if (!hasText) return false;
  const check = message.check as DraftCheck | null;
  if (check && !check.passed) return true;
  const config = anyStepConfig(state.step);
  if (config.type === "linkedin_comment" && config.review === "always") return true;
  switch (state.loaded.settings.review_level) {
    case "every":
      return true;
    case "unsure": {
      const verdict = check?.verdict ?? (check?.passed ? "pass" : "revise");
      return verdict !== "pass" || (check?.confidence ?? 0) < UNSURE_CONFIDENCE;
    }
    case "first": {
      const earlier = await ctx.db
        .select({ body_text: messages.body_text })
        .from(messages)
        .where(
          and(
            eq(messages.enrollment_id, state.enrollment.id),
            eq(messages.direction, "outbound"),
            ne(messages.id, message.id),
            inArray(messages.status, ["approved", "scheduled", "sending", "unknown", "sent"]),
          ),
        );
      return isFirstMessageReview(earlier);
    }
  }
}

/**
 * The approval a message in review waits for: a pending one when there is one (an edit asked
 * again after an earlier decision), else the newest.
 */
async function pendingApprovalFor(ctx: OpContext, messageId: string): Promise<Approval | null> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.workspace_id, workspace.id),
        eq(approvals.target_type, "message"),
        eq(approvals.target_id, messageId),
      ),
    )
    .orderBy(desc(sql`${approvals.status} = 'pending'`), desc(approvals.created_at))
    .limit(1);
  return row ?? null;
}

/** The review the step's run asked for last (`requestReview` records it), for this message. */
async function runApproval(
  ctx: OpContext,
  state: StepState,
  messageId: string,
): Promise<Approval | null> {
  if (!state.run.approval_id) return null;
  const [row] = await ctx.db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.id, state.run.approval_id),
        eq(approvals.target_type, "message"),
        eq(approvals.target_id, messageId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Payload of a `message` approval: what reviewers see and may edit (subject, body). */
export function messageApprovalPayload(
  state: StepState,
  message: Message,
): Record<string, unknown> {
  return {
    message_id: message.id,
    enrollment_id: state.enrollment.id,
    campaign_id: state.loaded.campaign.id,
    campaign_name: state.loaded.campaign.name,
    step_id: state.step.id,
    step_position: state.step.position,
    person_id: state.person.id,
    person_name: displayName(state.person),
    company_name: state.company?.name ?? null,
    channel: message.channel,
    action: message.action,
    to: message.to_address,
    variant: message.variant,
    subject: message.subject,
    body: message.body_text,
    why: message.why,
    check: message.check,
  };
}

/**
 * Asks a person to review the step's message (or keeps waiting for the review already asked
 * for), holds the message in `pending_review` and the enrollment in `waiting_review`. `note`
 * opens the summary (who changed the text). Returns the approval id.
 */
async function requestReview(
  ctx: OpContext,
  state: StepState,
  message: Message,
  note?: string,
): Promise<string> {
  const existing = await pendingApprovalFor(ctx, message.id);
  let approvalId = existing && existing.status === "pending" ? existing.id : null;
  if (!approvalId) {
    const check = message.check as DraftCheck | null;
    const who = `${displayName(state.person)}${state.company?.name ? ` (${state.company.name})` : ""}`;
    const what = message.channel === "email" ? "Email" : `LinkedIn ${message.action}`;
    const { id } = await ctx.approvals.request({
      kind: "message",
      title: `${what} to ${who}`,
      summary: [
        note ?? "",
        `Step ${state.step.position + 1} of "${state.loaded.campaign.name}".`,
        message.subject ? `Subject: ${message.subject}.` : "",
        check
          ? `Check: ${check.verdict ?? (check.passed ? "pass" : "revise")} (confidence ${Math.round((check.confidence ?? 0) * 100)}%)${check.issues.length ? `, ${check.issues.length} issue(s)` : ""}.`
          : "",
        "Approve to schedule it, edit the subject or body, or reject to skip this step.",
      ]
        .filter(Boolean)
        .join(" "),
      payload: messageApprovalPayload(state, message),
      target: { type: "message", id: message.id },
    });
    approvalId = id;
  }
  await ctx.db
    .update(messages)
    .set({ status: "pending_review" })
    .where(and(eq(messages.id, message.id), eq(messages.status, "draft")));
  await updateRun(ctx.db, state.run, { approval_id: approvalId });
  await reschedule(
    ctx,
    state,
    new Date(ctx.clock.now().getTime() + REVIEW_WATCHDOG_MS),
    "waiting_review",
  );
  return approvalId;
}

/**
 * Asks a person to review a step's message again after a text change no person reviewed (an
 * edit by someone who must ask, or one whose checks failed: `messages.update`). The message
 * already holds the new text in `pending_review`. A pending review of the earlier text is
 * cancelled, since an approval covers the text it shows, and the new request goes where the
 * sequencer looks for it: the step's run while the enrollment is on this step (paused or not),
 * else the message alone. Returns the approval id.
 */
export async function requestReviewAgain(
  ctx: OpContext,
  message: Message,
  note: string,
): Promise<string> {
  await ctx.approvals.cancel(
    { kind: "message", target: { type: "message", id: message.id } },
    "The text changed: replaced by a review of the new text.",
  );
  const state = await loadStepStateForMessage(ctx, message, { paused: true });
  if (state) return requestReview(ctx, state, message, note);
  const what = message.channel === "email" ? "Email" : `LinkedIn ${message.action}`;
  const { id } = await ctx.approvals.request({
    kind: "message",
    title: `${what}${message.to_address ? ` to ${message.to_address}` : ""}`,
    summary: [
      note,
      message.subject ? `Subject: ${message.subject}.` : "",
      "Approve to schedule it when its sequence runs this step, edit the subject or body, or reject to cancel it.",
    ]
      .filter(Boolean)
      .join(" "),
    payload: {
      message_id: message.id,
      enrollment_id: message.enrollment_id,
      campaign_id: message.campaign_id,
      step_id: message.step_id,
      person_id: message.person_id,
      channel: message.channel,
      action: message.action,
      to: message.to_address,
      variant: message.variant,
      subject: message.subject,
      body: message.body_text,
      why: message.why,
      check: message.check,
    },
    target: { type: "message", id: message.id },
  });
  return id;
}

/** `why` with the pre-edit draft kept (once) so teach can learn from the edit. */
export function withOriginal(message: Message, note: string): DraftWhy {
  const why = (message.why as DraftWhy | null) ?? {};
  return {
    ...why,
    notes: note,
    original: why.original ?? { subject: message.subject, body: message.body_text },
  };
}

/** Reviewer edits that actually change the message (as subject / body_text columns). */
export function changedFields(
  message: Pick<Message, "subject" | "body_text">,
  edits: { subject?: string; body?: string } | undefined,
): { subject?: string; body_text?: string } {
  const out: { subject?: string; body_text?: string } = {};
  if (typeof edits?.subject === "string" && edits.subject !== message.subject) {
    out.subject = edits.subject;
  }
  if (typeof edits?.body === "string" && edits.body !== message.body_text) {
    out.body_text = edits.body;
  }
  return out;
}

/**
 * Marks a message approved (applying reviewer edits) and plans + queues it. Shared by the
 * no-review path, the approval resolver and the sequencer's recovery path. `from` limits the
 * statuses it approves: the no-review path takes only a `draft`, so a message an edit sent to
 * review meanwhile stays there.
 */
export async function approveAndSchedule(
  ctx: OpContext,
  state: StepState,
  message: Message,
  options: {
    approvalId?: string | null;
    edits?: { subject?: string; body?: string };
    from?: MessageStatus[];
  } = {},
): Promise<string> {
  const changes = changedFields(message, options.edits);
  const set: Partial<NewMessage> = { status: "approved", ...changes };
  if (Object.keys(changes).length > 0) set.why = withOriginal(message, "edited by reviewer");
  const from = options.from ?? ["draft", "pending_review"];
  const updated = await ctx.db
    .update(messages)
    .set(set)
    .where(and(eq(messages.id, message.id), inArray(messages.status, from)))
    .returning();
  const current = updated[0] ?? (await findMessage(ctx, message.id));
  if (!current) return "missing";
  if (updated.length > 0) {
    await ctx.events.emit("message.approved", {
      subject: { type: "message", id: message.id },
      data: { message_id: message.id, approval_id: options.approvalId ?? null },
    });
  }
  if (current.status !== "approved") return current.status;
  const campaignStatus = state.loaded.campaign.status;
  if (campaignStatus !== "active") {
    // Approved while the campaign is paused: the sequencer plans it once the campaign runs.
    await reschedule(ctx, state, ctx.clock.now());
    return `waiting:campaign_${campaignStatus}`;
  }
  return planAndQueue(ctx, state, current);
}

function defaultRetry(now: Date, reason: string): Date {
  return new Date(now.getTime() + (reason === "workspace_paused" ? 15 * MINUTE : HOUR));
}

async function planFailed(
  ctx: OpContext,
  state: StepState,
  reason: string,
  retryAt: Date | undefined,
): Promise<string> {
  const now = ctx.clock.now();
  const at = retryAt && retryAt.getTime() > now.getTime() ? retryAt : defaultRetry(now, reason);
  await updateRun(ctx.db, state.run, { detail: { plan_failure: reason } });
  await reschedule(ctx, state, at);
  return `waiting:${reason}`;
}

/**
 * Picks a sender and a send time, then queues the approved message with the channel module.
 * Only one caller can claim the message (the claim sets scheduled_for). Plan failures move the
 * enrollment to the retry time (capacity, send window, paused workspace).
 */
async function planAndQueue(ctx: OpContext, state: StepState, message: Message): Promise<string> {
  const now = ctx.clock.now();
  if (message.scheduled_for) {
    // Claimed earlier but the queue call did not finish: retry it once the claim is stale.
    if (message.updated_at.getTime() < now.getTime() - 2 * MINUTE) {
      if (message.channel === "email") await queueEmailSend(ctx, message.id);
      else await queueLinkedInAction(ctx, message.id);
    }
    await reschedule(
      ctx,
      state,
      new Date(Math.max(now.getTime(), message.scheduled_for.getTime()) + SEND_WATCHDOG_MS),
    );
    return "scheduled";
  }
  const { settings } = state.loaded;
  if (message.channel === "email") {
    if (!state.person.email) return planFailed(ctx, state, "missing_email", undefined);
    const isReply = Boolean(message.thread_id || message.in_reply_to);
    const sticky = isReply ? state.enrollment.mailbox_id : null;
    const all = settings.senders.mailbox_ids;
    if (all.length === 0 && !sticky) return planFailed(ctx, state, "no_senders", undefined);
    const plan = (mailboxIds: string[]) =>
      planEmailSend(ctx, {
        mailboxIds,
        preferredMailboxId: state.enrollment.mailbox_id,
        recipientEmail: state.person.email ?? "",
        recipientTimezone: recipientTimeZone(settings.schedule, state.person, state.company),
        schedule: settings.schedule,
        notBefore: now,
      });
    let result = await plan(sticky ? [sticky] : all);
    if (!result.ok && result.reason === "no_active_mailbox" && sticky && all.length > 0) {
      // The thread's mailbox is gone: continue as a new thread from another mailbox.
      await ctx.db
        .update(messages)
        .set({
          thread_id: null,
          in_reply_to: null,
          references: [],
          subject: (message.subject ?? "").replace(/^\s*re\s*:\s*/i, ""),
        })
        .where(eq(messages.id, message.id));
      result = await plan(all);
    }
    if (!result.ok) return planFailed(ctx, state, result.reason, result.retryAt);
    const [mailbox] = await ctx.db
      .select({ email: mailboxes.email })
      .from(mailboxes)
      .where(eq(mailboxes.id, result.mailboxId));
    const claimed = await ctx.db
      .update(messages)
      .set({
        mailbox_id: result.mailboxId,
        scheduled_for: result.sendAt,
        from_address: mailbox?.email ?? null,
      })
      .where(
        and(
          eq(messages.id, message.id),
          eq(messages.status, "approved"),
          isNull(messages.scheduled_for),
        ),
      )
      .returning({ id: messages.id });
    if (claimed.length === 0) return "claimed_elsewhere";
    await queueEmailSend(ctx, message.id);
    await ctx.db
      .update(enrollments)
      .set({
        mailbox_id: state.enrollment.mailbox_id ?? result.mailboxId,
        next_run_at: new Date(result.sendAt.getTime() + SEND_WATCHDOG_MS),
        status: "active",
      })
      .where(
        and(
          eq(enrollments.id, state.enrollment.id),
          eq(enrollments.current_step, state.enrollment.current_step),
          inArray(enrollments.status, MOVABLE),
        ),
      );
    return "scheduled";
  }

  const accountIds = state.enrollment.linkedin_account_id
    ? [state.enrollment.linkedin_account_id]
    : settings.senders.linkedin_account_ids;
  if (accountIds.length === 0) return planFailed(ctx, state, "no_senders", undefined);
  const action = stepAction(state.step.type);
  if (action === "email" || action === "reply") throw new Error("unexpected email action");
  const result = await planLinkedInAction(ctx, {
    accountIds,
    preferredAccountId: state.enrollment.linkedin_account_id,
    action,
    notBefore: now,
  });
  if (!result.ok) return planFailed(ctx, state, result.reason, result.retryAt);
  const claimed = await ctx.db
    .update(messages)
    .set({ linkedin_account_id: result.accountId, scheduled_for: result.runAt })
    .where(
      and(
        eq(messages.id, message.id),
        eq(messages.status, "approved"),
        isNull(messages.scheduled_for),
      ),
    )
    .returning({ id: messages.id });
  if (claimed.length === 0) return "claimed_elsewhere";
  await queueLinkedInAction(ctx, message.id);
  await ctx.db
    .update(enrollments)
    .set({
      linkedin_account_id: state.enrollment.linkedin_account_id ?? result.accountId,
      next_run_at: new Date(result.runAt.getTime() + SEND_WATCHDOG_MS),
      status: "active",
    })
    .where(
      and(
        eq(enrollments.id, state.enrollment.id),
        eq(enrollments.current_step, state.enrollment.current_step),
        inArray(enrollments.status, MOVABLE),
      ),
    );
  return "scheduled";
}

async function continuePendingReview(
  ctx: OpContext,
  state: StepState,
  message: Message,
): Promise<void> {
  const now = ctx.clock.now();
  const approval =
    (await runApproval(ctx, state, message.id)) ?? (await pendingApprovalFor(ctx, message.id));
  if (!approval) {
    await ctx.db
      .update(messages)
      .set({ status: "draft" })
      .where(and(eq(messages.id, message.id), eq(messages.status, "pending_review")));
    await requestReview(ctx, state, { ...message, status: "draft" });
    return;
  }
  switch (approval.status) {
    case "pending": {
      if (approval.expires_at && approval.expires_at.getTime() < now.getTime() - HOUR) {
        await ctx.approvals.cancel({ id: approval.id }, "expired");
        await skipForReview(ctx, state, message, "approval_expired");
        return;
      }
      await reschedule(ctx, state, new Date(now.getTime() + REVIEW_WATCHDOG_MS), "waiting_review");
      return;
    }
    case "approved": {
      const edits = {
        ...(typeof approval.payload.subject === "string"
          ? { subject: approval.payload.subject }
          : {}),
        ...(typeof approval.payload.body === "string" ? { body: approval.payload.body } : {}),
      };
      await approveAndSchedule(ctx, state, message, { approvalId: approval.id, edits });
      return;
    }
    default:
      await skipForReview(ctx, state, message, `approval_${approval.status}`);
  }
}

/** A rejected or expired review: cancel the message, skip the step, continue the sequence. */
export async function skipForReview(
  ctx: OpContext,
  state: StepState,
  message: Pick<Message, "id">,
  reason: string,
): Promise<void> {
  await ctx.db
    .update(messages)
    .set({ status: "cancelled", error: reason })
    .where(
      and(
        eq(messages.id, message.id),
        inArray(messages.status, ["draft", "pending_review", "approved"]),
      ),
    );
  await advance(ctx, state, { anchor: ctx.clock.now(), outcome: "skipped", detail: { reason } });
}

async function continueMessage(ctx: OpContext, state: StepState, message: Message): Promise<void> {
  const now = ctx.clock.now();
  switch (message.status) {
    case "generating": {
      const { deduplicated } = await enqueueGeneration(ctx, message.id);
      const attempts = (state.run.detail.generation_attempts ?? 0) + (deduplicated ? 0 : 1);
      if (attempts > MAX_GENERATION_RETRIES) {
        await ctx.db
          .update(messages)
          .set({ status: "failed", error: "generation_failed" })
          .where(and(eq(messages.id, message.id), eq(messages.status, "generating")));
        await failOrRetry(ctx, state, "generation_failed");
        return;
      }
      await updateRun(ctx.db, state.run, { detail: { generation_attempts: attempts } });
      await reschedule(ctx, state, new Date(now.getTime() + GENERATION_RETRY_MS));
      return;
    }
    case "draft":
      if (await needsReview(ctx, state, message)) await requestReview(ctx, state, message);
      else await approveAndSchedule(ctx, state, message, { from: ["draft"] });
      return;
    case "pending_review":
      await continuePendingReview(ctx, state, message);
      return;
    case "approved":
      await planAndQueue(ctx, state, message);
      return;
    case "scheduled":
    case "sending":
    // Not known whether it went out: wait until the email module reconciles it.
    case "unknown": {
      const at = Math.max(now.getTime(), message.scheduled_for?.getTime() ?? now.getTime());
      await reschedule(ctx, state, new Date(at + SEND_WATCHDOG_MS));
      return;
    }
    case "sent":
      await advance(ctx, state, { anchor: message.sent_at ?? now, outcome: "done" });
      return;
    case "failed":
      // A new message for the step only when the failed one did not go out: one that may have
      // (`why.failed_before_handover` false) is never replaced, except a visit or like, which
      // is harmless to repeat. Rows without the flag failed before it existed: before handover.
      if (message.why?.failed_before_handover === false && !REPEATABLE.has(message.action)) {
        await failEnrollment(ctx, state, message.error ?? "send_failed");
        return;
      }
      await failOrRetry(ctx, state, message.error ?? "send_failed");
      return;
    case "skipped":
      await applyMissingData(ctx, state, message.error ?? "missing_data");
      return;
    case "cancelled":
      await advance(ctx, state, {
        anchor: now,
        outcome: "skipped",
        detail: { reason: message.error ?? "message_cancelled" },
      });
      return;
    case "bounced":
      await stopEnrollments(ctx, [state.enrollment], "bounced");
      return;
    default:
      await reschedule(ctx, state, new Date(now.getTime() + HOUR));
  }
}

/** Retries the step with a new attempt, or fails the enrollment after MAX_STEP_ATTEMPTS. */
async function failOrRetry(ctx: OpContext, state: StepState, reason: string): Promise<void> {
  if (state.run.attempt >= MAX_STEP_ATTEMPTS) {
    await failEnrollment(ctx, state, reason);
    return;
  }
  await updateRun(ctx.db, state.run, {
    status: "failed",
    detail: { reason },
    finishedAt: ctx.clock.now(),
  });
  await reschedule(ctx, state, new Date(ctx.clock.now().getTime() + HOUR));
}

/**
 * Runs one email or LinkedIn step for an enrollment. The message row of the step run is the
 * state: missing -> checks + create; generating -> (re)queue generation; draft -> review level;
 * pending_review -> watch the approval; approved -> plan and queue; sent -> advance.
 */
export async function executeChannelStep(ctx: OpContext, state: StepState): Promise<void> {
  let message = state.run.message_id ? await findMessage(ctx, state.run.message_id) : null;
  if (!message) {
    const prepared = await prepare(ctx, state);
    if (prepared.kind !== "ready") {
      await handleNotReady(ctx, state, prepared);
      return;
    }
    message = await createStepMessage(ctx, state, prepared);
    state.run = { ...state.run, message_id: message.id };
    if (message.status === "generating") {
      if (stepUsesAi(state.step)) {
        await enqueueGeneration(ctx, message.id);
        await reschedule(ctx, state, new Date(ctx.clock.now().getTime() + GENERATION_RETRY_MS));
        return;
      }
      await generateMessage(ctx, message.id);
      message = (await findMessage(ctx, message.id)) ?? message;
    }
  }
  await continueMessage(ctx, state, message);
}
