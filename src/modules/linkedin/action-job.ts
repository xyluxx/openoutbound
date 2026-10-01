/**
 * `linkedin.action`: executes one scheduled LinkedIn message (visit, like, comment, invite,
 * message). Re-checks everything at run time through the send gate (relationships/gate.ts:
 * workspace, campaign, slot time, a thread a person took over, account status, contactability
 * and privacy requests, a company hold, relation state, text), then working hours, caps and
 * gaps under a per-account lock. Delivery (docs/concepts/delivery-guarantees.md):
 * - the claim (`scheduled` to `sending`, attempt + 1) starts one attempt, and every later write
 *   checks it, so two workers never both hand an action over;
 * - invites, messages and comments are never repeated blindly: one found `sending`, or one whose
 *   call may have reached LinkedIn without a clear answer, becomes `unknown` (unknown-actions.ts);
 * - a failure before anything reached LinkedIn is retried on the same message;
 * - visits and likes are done at least once: a stopped or unclear attempt is simply tried again;
 * - an answer that comes after the message moved on is settled (email/duplicate-sends.ts), and
 *   a resend of an unknown invitation that finds it pending or the person connected records it
 *   as sent: the earlier try went out.
 * Provider calls get the job's abort signal, so no call outlives its job. Whether a failed
 * call may have reached LinkedIn is decided in delivery-uncertain.ts.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { JobContext } from "../../core/context.js";
import { isOpenOutboundError, JobWaitError } from "../../core/errors.js";
import { isRetryable } from "../../core/failures.js";
import { defineJob } from "../../core/operation.js";
import {
  type LinkedInAccount,
  linkedin_accounts,
  type Message,
  messages,
  threads,
} from "../../db/schema/index.js";
import type { LinkedInProvider, LinkedInTarget } from "../../providers/types.js";
import {
  earlierAttemptWentOut,
  type LateSuccessOutcome,
  recordDuplicateSend,
  settleLateSuccess,
} from "../email/duplicate-sends.js";
import { recordSendFailed } from "../email/send-problems.js";
import {
  failedWhy,
  INTERRUPTED_REASON,
  inWorkspace,
  QUEUED,
  type SendClaim,
  type SendHold,
  stillHeld,
  wasResentAfterUnknown,
} from "../email/unknown-sends.js";
import { evaluateLinkedInGate, type GateBlocker, linkedinSlotKey } from "../relationships/gate.js";
import { errorText, handleAccountFailure, loadWorkspace, providerFor } from "./accounts.js";
import { accountSchedule, executedByDay, loadPlannerInput } from "./capacity.js";
import { deliveryUncertain } from "./delivery-uncertain.js";
import {
  findSlot,
  gapAfter,
  hasCapacity,
  LIKE_MAX_POST_AGE_DAYS,
  type LinkedInActionKind,
  MIN_GAP_MS,
  noteLimit,
} from "./limits.js";
import { type LinkedInSent, recordLinkedInSent } from "./record-sent.js";
import { upsertRelation } from "./relations.js";
import { isLinkedInAction, pickRecentPost } from "./service.js";
import { dayKey, nextWindow } from "./time.js";
import {
  markLinkedInInterrupted,
  markLinkedInUnknown,
  recordStoredLinkedInSend,
  UNKNOWN_ACTIONS,
} from "./unknown-actions.js";

const PAUSED_RETRY_MS = 60 * 60_000;

export type ActionJobResult =
  | { status: "sent"; message_id: string; note_dropped?: boolean; reason?: string }
  | {
      status: "skipped" | "failed" | "paused" | "unknown" | "cancelled" | "duplicate";
      message_id: string;
      reason: string;
    };

export const linkedinActionJob = defineJob({
  name: "linkedin.action",
  payload: z.object({ message_id: z.string() }),
  maxAttempts: 5,
  timeoutMs: 2 * 60_000,
  handler: (ctx, payload) => runLinkedInAction(ctx, payload.message_id),
});

/**
 * Updates the message while it is still as `hold` says: queued, or claimed by this job's
 * attempt (unknown-sends.ts). False when it moved on meanwhile (nothing changes).
 */
async function setMessage(
  ctx: JobContext,
  message: Message,
  hold: SendHold,
  values: Partial<Message>,
): Promise<boolean> {
  const rows = await ctx.db
    .update(messages)
    .set(values)
    .where(stillHeld(message.id, hold))
    .returning({ id: messages.id });
  return rows.length > 0;
}

/**
 * The message moved on while the job worked on it (cancelled, or claimed by a later attempt):
 * the job's own result is logged and never recorded.
 */
function movedOn(ctx: JobContext, message: Message, hold: SendHold): ActionJobResult {
  ctx.log.warn(
    { message_id: message.id, attempt: hold.status === "sending" ? hold.attempt : null },
    "linkedin: the message moved on while its action ran; the result is not recorded",
  );
  return { status: "skipped", message_id: message.id, reason: "status_changed" };
}

/**
 * Skip: status `skipped` + `message.failed` with `skipped:<reason>` so sequences move on. A claim
 * that a late answer took (an earlier attempt went out meanwhile) records that send instead.
 */
async function skip(
  ctx: JobContext,
  message: Message,
  reason: string,
  hold: SendHold = QUEUED,
): Promise<ActionJobResult> {
  if (!(await setMessage(ctx, message, hold, { status: "skipped", error: `skipped: ${reason}` }))) {
    if (hold.status === "sending") {
      const settled = await sentByEarlierAttempt(ctx, message, hold, false);
      if (settled) return settled;
    }
    return movedOn(ctx, message, hold);
  }
  await ctx.events.emit("message.failed", {
    workspaceId: message.workspace_id,
    subject: { type: "message", id: message.id },
    data: { message_id: message.id, error: `skipped:${reason}`, retryable: false },
  });
  return { status: "skipped", message_id: message.id, reason };
}

/**
 * Fails the action; a failure for good also counts in the campaign's `send_failed` problem.
 * `beforeHandover` (stored as `why.failed_before_handover`) is false only for a visit or like
 * that may have happened: anything else that may have reached LinkedIn becomes `unknown`.
 */
async function fail(
  ctx: JobContext,
  message: Message,
  reason: string,
  retryable = false,
  hold: SendHold = QUEUED,
  beforeHandover = true,
): Promise<ActionJobResult> {
  const failed = await ctx.db
    .update(messages)
    .set({ status: "failed", error: reason.slice(0, 500), why: failedWhy(beforeHandover) })
    .where(stillHeld(message.id, hold))
    .returning({ id: messages.id });
  if (failed.length === 0) {
    return movedOn(ctx, message, hold);
  }
  await ctx.events.emit("message.failed", {
    workspaceId: message.workspace_id,
    subject: { type: "message", id: message.id },
    data: { message_id: message.id, error: reason.slice(0, 500), retryable },
  });
  if (!retryable) await recordSendFailed(ctx, message, reason);
  return { status: "failed", message_id: message.id, reason };
}

/** Back to `approved` (capacity released); the account resume re-queues it. */
async function park(
  ctx: JobContext,
  message: Message,
  reason: string,
  hold: SendHold = QUEUED,
): Promise<ActionJobResult> {
  if (!(await setMessage(ctx, message, hold, { status: "approved", error: `paused: ${reason}` }))) {
    return movedOn(ctx, message, hold);
  }
  return { status: "paused", message_id: message.id, reason };
}

/**
 * A person took the conversation over: `cancelled` with the takeover's own error
 * (`superseded_by_person`) and `message.failed` not retryable, so the sequence moves on.
 */
async function cancel(ctx: JobContext, message: Message, reason: string): Promise<ActionJobResult> {
  if (
    !(await setMessage(ctx, message, QUEUED, { status: "cancelled", error: reason.slice(0, 500) }))
  ) {
    return movedOn(ctx, message, QUEUED);
  }
  await ctx.events.emit("message.failed", {
    workspaceId: message.workspace_id,
    subject: { type: "message", id: message.id },
    data: { message_id: message.id, error: reason.slice(0, 500), retryable: false },
  });
  return { status: "cancelled", message_id: message.id, reason };
}

/**
 * Acts on the gate's first blocker with the job's own functions: wait (parked until its key is
 * woken or the time passes), cancel, fail, skip, or move (back to the queue until the account
 * or the workspace works again).
 */
async function applyGate(
  ctx: JobContext,
  message: Message,
  first: GateBlocker,
): Promise<ActionJobResult> {
  const detail = first.detail ?? first.message;
  switch (first.disposition) {
    case "wait":
      throw new JobWaitError(
        first.wait_key ?? linkedinSlotKey(message.id),
        first.retry_at
          ? new Date(first.retry_at)
          : new Date(ctx.clock.now().getTime() + PAUSED_RETRY_MS),
      );
    case "cancel":
      return cancel(ctx, message, detail);
    case "fail":
      return fail(ctx, message, detail);
    case "skip":
      return skip(ctx, message, detail);
    case "move":
      return park(ctx, message, detail);
  }
}

type Claim =
  | { kind: "claimed"; claim: SendClaim }
  | { kind: "wait"; retryAt: Date }
  | { kind: "none" };

/**
 * Under a lock on the account row: checks working hours, caps (executed + other reservations)
 * and the minimum gap to actions that really started; then marks the message `sending`.
 */
async function claim(
  ctx: JobContext,
  message: Message,
  account: LinkedInAccount,
  action: LinkedInActionKind,
): Promise<Claim> {
  const workspace = await loadWorkspace(ctx, message.workspace_id);
  return ctx.db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(linkedin_accounts)
      .where(eq(linkedin_accounts.id, account.id))
      .for("update");
    if (locked?.status !== "active") return { kind: "none" } as Claim;
    const now = ctx.clock.now();
    const planner = await loadPlannerInput(tx, {
      account: locked,
      workspace,
      action,
      from: now,
      excludeMessageId: message.id,
    });
    const window = nextWindow(planner.schedule, now);
    const lastStarted = planner.busy
      .filter((slot) => slot.started && slot.at.getTime() <= now.getTime() + MIN_GAP_MS)
      .at(-1);
    const tooClose =
      lastStarted !== undefined && Math.abs(now.getTime() - lastStarted.at.getTime()) < MIN_GAP_MS;
    const inHours = window !== null && window.start.getTime() <= now.getTime();
    if (!inHours || !hasCapacity(planner, window.dayKey) || tooClose) {
      let from = now;
      if (tooClose && lastStarted) {
        from = new Date(lastStarted.at.getTime() + gapAfter(account.id, lastStarted.at));
      } else if (inHours && !hasCapacity(planner, window.dayKey)) {
        from = window.end;
      }
      const slot = findSlot(planner, from);
      if (!slot) return { kind: "wait", retryAt: new Date(now.getTime() + 24 * 60 * 60_000) };
      await tx
        .update(messages)
        .set({ scheduled_for: slot.at })
        .where(and(eq(messages.id, message.id), eq(messages.status, "scheduled")));
      return { kind: "wait", retryAt: slot.at } as Claim;
    }
    const [claimed] = await tx
      .update(messages)
      .set({
        status: "sending",
        scheduled_for: now,
        attempt: sql`${messages.attempt} + 1`,
        dispatch_started_at: now,
        reconcile_checks: 0,
      })
      .where(stillHeld(message.id, QUEUED))
      .returning({ attempt: messages.attempt });
    if (!claimed) return { kind: "none" } as Claim;
    return { kind: "claimed", claim: { status: "sending", attempt: claimed.attempt } } as Claim;
  });
}

async function notesUsedThisMonth(ctx: JobContext, accountId: string, today: string) {
  const monthStart = `${today.slice(0, 8)}01`;
  const counts = await executedByDay(ctx.db, accountId, "invite_note", monthStart, today);
  let total = 0;
  for (const value of counts.values()) total += value;
  return total;
}

/** Set once the call that may act on LinkedIn is made (reads before it never act). */
interface Handover {
  started: boolean;
}

/**
 * The action as it went out, for a late answer recorded after the job's claim was lost:
 * everything `recordLinkedInSent` needs except the message, its attempt and the statuses.
 */
type SentDetails = Omit<LinkedInSent, "message" | "attempt" | "from" | "wentOut" | "resolution">;

interface Performed {
  providerMessageId?: string | null;
  chatId?: string | null;
  postId?: string | null;
  memberId?: string | null;
  noteSent?: boolean;
  noteDropped?: boolean;
  skipReason?: string;
  connected?: boolean;
  invitationPending?: boolean;
}

async function perform(
  ctx: JobContext,
  input: {
    provider: LinkedInProvider;
    account: LinkedInAccount;
    message: Message;
    action: LinkedInActionKind;
    target: LinkedInTarget;
    note: string;
    chatId: string | null;
    /** Account-local day key (counters). */
    today: string;
    handover: Handover;
  },
): Promise<Performed> {
  const { provider, message, action, target } = input;
  const external = input.account.external_account_id ?? "";
  const now = ctx.clock.now();
  // The job's signal: a call still running when the job is cancelled or times out is stopped.
  const call = { signal: ctx.job.signal };
  switch (action) {
    case "visit": {
      input.handover.started = true;
      await provider.visitProfile(external, target, call);
      return {};
    }
    case "invite": {
      const profile = await provider.getProfile(external, target, call);
      const memberId = profile.provider_id || null;
      if (profile.connection_degree === 1) {
        return { skipReason: "already_connected", connected: true, memberId };
      }
      if (profile.invitation_pending) {
        return { skipReason: "already_invited", invitationPending: true, memberId };
      }
      let note = input.note;
      let noteDropped = false;
      const monthlyNotes = noteLimit(input.account);
      if (note && monthlyNotes !== null) {
        const used = await notesUsedThisMonth(ctx, input.account.id, input.today);
        if (used >= monthlyNotes) {
          note = "";
          noteDropped = true;
        }
      }
      input.handover.started = true;
      const result = await provider.sendInvite(
        external,
        { ...target, provider_id: memberId ?? target.provider_id ?? null },
        note || undefined,
        call,
      );
      return {
        memberId: result.providerRef ?? memberId,
        noteSent: Boolean(note),
        noteDropped,
      };
    }
    case "message": {
      const text = (message.body_text ?? "").trim();
      input.handover.started = true;
      const sent = await provider.sendMessage(
        external,
        target,
        text,
        input.chatId ? { chatId: input.chatId, ...call } : call,
      );
      return { providerMessageId: sent.messageId ?? null, chatId: sent.chatId ?? input.chatId };
    }
    case "like":
    case "comment": {
      let postId = message.in_reply_to;
      if (!postId) {
        const posts = await provider.listRecentPosts(external, target, { limit: 5, ...call });
        const maxAge = action === "like" ? LIKE_MAX_POST_AGE_DAYS : 30;
        postId = pickRecentPost(posts, now, maxAge)?.id ?? null;
      }
      if (!postId) return { skipReason: "no_recent_post" };
      input.handover.started = true;
      if (action === "like") {
        await provider.reactToPost(external, postId, "like", call);
        return { postId };
      }
      const comment = await provider.commentOnPost(
        external,
        postId,
        (message.body_text ?? "").trim(),
        call,
      );
      return { postId, providerMessageId: comment.commentId ?? null };
    }
  }
}

/** Runs one LinkedIn action (see module doc). Returns a compact result for jobs.get. */
export async function runLinkedInAction(
  ctx: JobContext,
  messageId: string,
): Promise<ActionJobResult> {
  const workspaceId = ctx.workspace?.id ?? ctx.job.workspaceId;
  if (!workspaceId) return { status: "skipped", message_id: messageId, reason: "no_workspace" };
  let message = await loadMessage(ctx, workspaceId, messageId);
  if (!message) return { status: "skipped", message_id: messageId, reason: "not_found" };
  if (message.status === "sending") {
    // The previous attempt stopped mid-action: it may have reached LinkedIn.
    const scoped = inWorkspace(ctx, await loadWorkspace(ctx, workspaceId));
    const outcome = await markLinkedInInterrupted(scoped, message, INTERRUPTED_REASON);
    switch (outcome) {
      case "unknown":
      case "failed":
        return { status: outcome, message_id: message.id, reason: INTERRUPTED_REASON };
      case "sent":
        return { status: "sent", message_id: message.id, reason: "an earlier try went out" };
      case "moved_on":
        return { status: "skipped", message_id: message.id, reason: "status_changed" };
      case "retried": {
        // A visit or like (done at least once): this job tries it again right away.
        message = await loadMessage(ctx, workspaceId, messageId);
        if (!message) return { status: "skipped", message_id: messageId, reason: "not_found" };
        break;
      }
    }
  }
  if (message.status !== "scheduled") {
    return { status: "skipped", message_id: message.id, reason: `status_${message.status}` };
  }

  const workspace = await loadWorkspace(ctx, workspaceId);
  const scoped = inWorkspace(ctx, workspace);
  // The send gate: the checks every view shows, in this order (relationships/gate.ts).
  const gate = await evaluateLinkedInGate(
    scoped,
    { personId: message.person_id ?? "", messageId: message.id },
    { mode: "send", known: { workspace, message } },
  );
  const first = gate.blockers[0];
  if (first) return applyGate(scoped, message, first);
  const { account, person, relation } = gate;
  if (!account || !person || !isLinkedInAction(message.action)) {
    throw new Error("linkedin.action: the gate let an action through without an account");
  }
  const action = message.action;
  const note = action === "invite" ? (message.body_text ?? "").trim() : "";

  let chatId: string | null = null;
  let threadId: string | null = message.thread_id;
  if (action === "message") {
    const [thread] = await ctx.db
      .select({ id: threads.id, external_ref: threads.external_ref })
      .from(threads)
      .where(
        and(
          eq(threads.workspace_id, workspaceId),
          eq(threads.channel, "linkedin"),
          eq(threads.linkedin_account_id, account.id),
          eq(threads.person_id, person.id),
        ),
      )
      .orderBy(threads.created_at)
      .limit(1);
    chatId = thread?.external_ref ?? null;
    threadId = threadId ?? thread?.id ?? null;
  }

  // No LinkedIn provider any more (removed after the account was connected; readiness names
  // it `linkedin_provider`): nothing can go out, so the action waits for one instead of failing.
  let provider: LinkedInProvider;
  try {
    provider = await providerFor(ctx, account);
  } catch (error) {
    if (!isOpenOutboundError(error) || error.code !== "provider_not_configured") throw error;
    throw new JobWaitError(
      linkedinSlotKey(message.id),
      new Date(ctx.clock.now().getTime() + PAUSED_RETRY_MS),
    );
  }

  const claimed = await claim(ctx, message, account, action);
  if (claimed.kind === "none") {
    return { status: "skipped", message_id: message.id, reason: "not_claimable" };
  }
  if (claimed.kind === "wait") {
    throw new JobWaitError(`linkedin.slot:${message.id}`, claimed.retryAt);
  }
  // From here on every write checks this claim: after a later attempt claimed the message (a
  // resend), a result of this one is never recorded as that attempt's result.
  const sendClaim = claimed.claim;

  const schedule = accountSchedule(account, workspace);
  const target: LinkedInTarget = {
    profile_url: person.linkedin_url,
    provider_id: relation?.provider_ref ?? null,
  };
  const handover: Handover = { started: false };
  let performed: Performed;
  try {
    performed = await perform(ctx, {
      provider,
      account,
      message,
      action,
      target,
      note,
      chatId,
      today: dayKey(ctx.clock.now(), schedule.timezone),
      handover,
    });
  } catch (error) {
    return handleFailure(scoped, message, account, error, sendClaim, handover.started);
  }

  if (performed.skipReason) {
    // A late answer showed an earlier attempt went out: that send is the result, not a skip.
    const settled = await sentByEarlierAttempt(scoped, message, sendClaim, false);
    if (settled) return settled;
    if (performed.connected) {
      await upsertRelation(ctx.db, {
        workspaceId,
        accountId: account.id,
        personId: person.id,
        status: "connected",
        providerRef: performed.memberId ?? null,
      });
    } else if (performed.invitationPending) {
      await upsertRelation(ctx.db, {
        workspaceId,
        accountId: account.id,
        personId: person.id,
        status: "invited",
        providerRef: performed.memberId ?? null,
      });
    }
    const found = await earlierInviteFound(scoped, message, sendClaim, performed);
    if (found) return found;
    return skip(scoped, message, performed.skipReason, sendClaim);
  }

  const sent: SentDetails = {
    workspaceId,
    account,
    personId: person.id,
    action,
    sentAt: ctx.clock.now(),
    timezone: schedule.timezone,
    threadId,
    chatId: performed.chatId ?? null,
    providerMessageId: performed.providerMessageId ?? null,
    postId: performed.postId ?? null,
    memberId: performed.memberId ?? null,
    noteSent: performed.noteSent === true,
    noteDropped: performed.noteDropped === true,
  };
  const recorded = await recordLinkedInSent(scoped, {
    ...sent,
    message,
    attempt: sendClaim.attempt,
    // A retry may have marked this very attempt unknown meanwhile: its success still counts.
    from: ["sending", "unknown"],
  });
  if (recorded) {
    return performed.noteDropped
      ? { status: "sent", message_id: message.id, note_dropped: true }
      : { status: "sent", message_id: message.id };
  }
  // The message moved on while this attempt acted: its success is settled, never dropped.
  const settled = await settleLateSuccess(scoped, {
    message,
    attempt: sendClaim.attempt,
    repeatable: !UNKNOWN_ACTIONS.has(action),
    record: async (fresh, resolution) =>
      (await recordLinkedInSent(scoped, {
        ...sent,
        threadId: fresh.thread_id ?? sent.threadId,
        message: fresh,
        attempt: fresh.attempt,
        from: [fresh.status],
        resolution,
      })) !== null,
  });
  return lateResult(ctx, message, sendClaim, settled);
}

async function loadMessage(
  ctx: JobContext,
  workspaceId: string,
  messageId: string,
): Promise<Message | null> {
  const [row] = await ctx.db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.workspace_id, workspaceId)))
    .limit(1);
  return row ?? null;
}

/** The job's result for an action whose answer came after the message moved on. */
function lateResult(
  ctx: JobContext,
  message: Message,
  claim: SendClaim,
  settled: LateSuccessOutcome,
): ActionJobResult {
  switch (settled) {
    case "duplicate":
      return {
        status: "duplicate",
        message_id: message.id,
        reason: "it went out twice: recorded as a duplicate",
      };
    case "recorded":
      return {
        status: "sent",
        message_id: message.id,
        reason: "recorded from an answer that came late",
      };
    case "remembered":
      return { status: "skipped", message_id: message.id, reason: "newer_attempt_sending" };
    case "ignored":
      return movedOn(ctx, message, claim);
  }
}

/**
 * This attempt holds the message without having clearly acted, while a late answer showed that
 * an earlier attempt went out (`why.earlier_attempt_went_out`): the message is recorded as sent
 * by the earlier attempt. When this attempt may have acted too (`mayHaveActed`), the person may
 * have it twice, and a `duplicate_send` problem says so. Null when there is no such answer.
 */
async function sentByEarlierAttempt(
  ctx: JobContext,
  message: Message,
  claim: SendClaim,
  mayHaveActed: boolean,
): Promise<ActionJobResult | null> {
  const fresh = await loadMessage(ctx, message.workspace_id, message.id);
  if (fresh?.status !== "sending" || fresh.attempt !== claim.attempt) return null;
  const earlier = earlierAttemptWentOut(fresh);
  if (earlier === null) return null;
  const recorded = await recordStoredLinkedInSend(ctx, fresh, {
    from: ["sending"],
    wentOut: false,
    resolution: `An earlier try went out (try ${earlier}); its answer came late.`,
  });
  if (!recorded) return movedOn(ctx, message, claim);
  if (mayHaveActed && UNKNOWN_ACTIONS.has(fresh.action)) {
    await recordDuplicateSend(
      ctx,
      { ...fresh, status: "sent" },
      { attempts: [earlier, claim.attempt], proven: false },
    );
  }
  return {
    status: "sent",
    message_id: message.id,
    reason: `an earlier try went out (try ${earlier}); its answer came late`,
  };
}

/**
 * A resend after an unknown try (`why.resent_after_unknown`) that finds the invitation pending or
 * the person connected: the earlier try went out (the profile check of B3 in
 * docs/concepts/delivery-guarantees.md), so the invitation is recorded as sent at that try's time,
 * not skipped. Null for anything else, or when the message moved on meanwhile.
 */
async function earlierInviteFound(
  ctx: JobContext,
  message: Message,
  claim: SendClaim,
  performed: Performed,
): Promise<ActionJobResult | null> {
  if (message.action !== "invite" || !wasResentAfterUnknown(message)) return null;
  if (!performed.invitationPending && !performed.connected) return null;
  const fresh = await loadMessage(ctx, message.workspace_id, message.id);
  if (fresh?.status !== "sending" || fresh.attempt !== claim.attempt) return null;
  const recorded = await recordStoredLinkedInSend(ctx, fresh, {
    from: ["sending"],
    wentOut: false,
    resolution: "LinkedIn shows the invitation of an earlier try.",
    sentAt: message.dispatch_started_at,
    memberId: performed.memberId ?? null,
    connected: performed.connected === true,
  });
  if (!recorded) return null;
  return {
    status: "sent",
    message_id: message.id,
    reason: "LinkedIn shows the invitation of an earlier try",
  };
}

/**
 * A failed provider call (see module doc): an account problem parks the action, a rate limit
 * plans it later, an invite, message or comment that may have reached LinkedIn becomes
 * `unknown`; anything else is tried again on the same message while the error is retryable
 * (`isRetryable`) and the job has attempts left, else it fails.
 */
async function handleFailure(
  ctx: JobContext,
  message: Message,
  account: LinkedInAccount,
  error: unknown,
  claim: SendClaim,
  /** The call that may act on LinkedIn was made (a failure before it never reached it). */
  handedOver: boolean,
): Promise<ActionJobResult> {
  const text = errorText(error);
  const outcome = await handleAccountFailure(ctx, account, error);
  const mayHaveActed = handedOver && deliveryUncertain(error);
  const settled = await sentByEarlierAttempt(ctx, message, claim, mayHaveActed);
  if (settled) return settled;
  if (
    outcome === "restricted" ||
    outcome === "disconnected" ||
    outcome === "restricted_after_rate_limits"
  ) {
    return park(
      ctx,
      message,
      `account ${outcome === "disconnected" ? "disconnected" : "restricted"}: ${text}`,
      claim,
    );
  }
  // A rate limit, or the provider paused for the workspace (its key or quota, with a
  // provider_down problem): nothing reached LinkedIn, so the action waits for a later slot.
  if (outcome === "rate_limited" || outcome === "provider_paused") {
    const now = ctx.clock.now();
    const retryAfterMs =
      isOpenOutboundError(error) && error.retryAfterSeconds !== undefined
        ? error.retryAfterSeconds * 1000
        : PAUSED_RETRY_MS;
    const from = new Date(now.getTime() + Math.max(retryAfterMs, 15 * 60_000));
    const workspace = await loadWorkspace(ctx, message.workspace_id);
    const planner = await loadPlannerInput(ctx.db, {
      account,
      workspace,
      action: message.action as LinkedInActionKind,
      from,
      excludeMessageId: message.id,
    });
    const retryAt = findSlot(planner, from)?.at ?? new Date(from.getTime() + 24 * 60 * 60_000);
    const moved = await setMessage(ctx, message, claim, {
      status: "scheduled",
      scheduled_for: retryAt,
      error: `${outcome}: ${text}`,
    });
    if (!moved) return movedOn(ctx, message, claim);
    throw new JobWaitError(`linkedin.slot:${message.id}`, retryAt);
  }
  if (mayHaveActed && UNKNOWN_ACTIONS.has(message.action)) {
    // It may have reached LinkedIn: reconciled (invites, messages) or checked by a person,
    // never retried blindly.
    const reason = `no clear answer from LinkedIn (${text})`;
    if (!(await markLinkedInUnknown(ctx, { ...message, attempt: claim.attempt }, reason))) {
      return (
        (await sentByEarlierAttempt(ctx, message, claim, true)) ?? movedOn(ctx, message, claim)
      );
    }
    return { status: "unknown", message_id: message.id, reason };
  }
  // Nothing reached LinkedIn, or a visit or like (done at least once): retried, or failed.
  if (!isRetryable(error)) {
    return fail(ctx, message, `provider_error: ${text}`, false, claim, !mayHaveActed);
  }
  if (ctx.job.attempt >= ctx.job.maxAttempts) {
    const reason = `provider_error after ${ctx.job.attempt} attempts: ${text}`;
    return fail(ctx, message, reason, false, claim, !mayHaveActed);
  }
  const requeued = await setMessage(ctx, message, claim, {
    status: "scheduled",
    error: `retrying: ${text}`,
  });
  if (!requeued) return movedOn(ctx, message, claim);
  throw error;
}

/** Re-enqueues overdue scheduled actions of an account (safety net after worker downtime). */
export async function requeueOverdue(ctx: JobContext, account: LinkedInAccount): Promise<number> {
  const cutoff = new Date(ctx.clock.now().getTime() - 10 * 60_000);
  const rows = await ctx.db
    .select({ id: messages.id, scheduled_for: messages.scheduled_for })
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, account.workspace_id),
        eq(messages.linkedin_account_id, account.id),
        eq(messages.channel, "linkedin"),
        inArray(messages.status, ["scheduled"]),
      ),
    );
  let count = 0;
  for (const row of rows) {
    if (row.scheduled_for && row.scheduled_for.getTime() < cutoff.getTime()) {
      await ctx.jobs.enqueue(
        "linkedin.action",
        { message_id: row.id },
        { singletonKey: `linkedin.action:${row.id}` },
      );
      count++;
    }
  }
  return count;
}
