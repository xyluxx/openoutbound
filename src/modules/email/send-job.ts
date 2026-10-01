import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { type JobContext, type OpContext, requireWorkspace } from "../../core/context.js";
import type { EmailStatus, MessageStatus } from "../../core/enums.js";
import { JobWaitError } from "../../core/errors.js";
import { defineJob } from "../../core/operation.js";
import { parseWorkspaceSettings, type WorkspaceSettings } from "../../core/settings.js";
import type { Db } from "../../db/client.js";
import {
  type Mailbox,
  type Message,
  mailboxes,
  messages,
  type Person,
  people,
  sender_counters,
  type Thread,
  threads,
  type Workspace,
  workspaces,
} from "../../db/schema/index.js";
import { verifyEmailNow } from "../enrichment/service.js";
import { SUPERSEDED_BY_PERSON } from "../inbox/stale-replies.js";
import { type EmailGate, evaluateEmailGate, type GateBlocker } from "../relationships/gate.js";
import { applyBounce } from "./bounce.js";
import { rampLimit } from "./capacity.js";
import {
  buildReferences,
  newMessageIdHeader,
  type OutgoingEmail,
  replySubject,
  sameAddress,
  singleRecipient,
  unsubscribeHeaders,
} from "./compose.js";
import {
  earlierAttemptWentOut,
  type LateSuccessOutcome,
  recordDuplicateSend,
  settleLateSuccess,
} from "./duplicate-sends.js";
import {
  heldRecheckAt,
  holdsQueuedMail,
  MAX_CONSECUTIVE_FAILURES,
  markMailboxError,
  pauseRecheckAt,
  pauseSendingDomain,
  recordSendFailure,
  recordSendSuccess,
  throttleMailbox,
} from "./mailbox-state.js";
import {
  footerFor,
  loadSendContext,
  recipientZone,
  type SendContext,
  type SendContextRows,
  scheduleFor,
  templateVars,
} from "./message-context.js";
import { planEmailSendWith, SENDABLE_STATUSES } from "./plan.js";
import { mailboxActiveKey, SEND_JOB, sendJobKey } from "./queue.js";
import { renderEmail } from "./render.js";
import { classifySendError, isDeliveryUncertain, type SendFailure } from "./send-errors.js";
import { RETRIES_USED_UP_PREFIX, recordSendFailed } from "./send-problems.js";
import { isValidTimeZone, localDate } from "./timezone.js";
import {
  type EmailTransport,
  type SendResult,
  transportFor,
  usesSandboxTransport,
} from "./transport.js";
import {
  failedWhy,
  INTERRUPTED_REASON,
  inWorkspace,
  isQueuedResend,
  markSendUnknown,
  openEmailUnknownProblem,
  QUEUED,
  resolveSendUnknownProblem,
  type SendClaim,
  type SendHold,
  stillHeld,
  stopReconciling,
  withSendTransaction,
} from "./unknown-sends.js";
import {
  openUnsubscribeHoldProblem,
  resolveUnsubscribeHoldProblem,
  UNSUBSCRIBE_LINK_MISSING,
} from "./unsubscribe-hold.js";
import { unsubscribeReadiness, unsubscribeUrl } from "./unsubscribe-token.js";

/**
 * What one run of the send job did (stored as the job result). `duplicate`: this attempt's
 * answer came late, after a newer attempt had sent the email too; it is recorded as a duplicate.
 */
export interface SendOutcome {
  message_id: string;
  status:
    | "sent"
    | "skipped"
    | "failed"
    | "bounced"
    | "cancelled"
    | "noop"
    | "unknown"
    | "duplicate";
  reason?: string;
  mailbox_id?: string | null;
}

const PAUSED_RECHECK_MS = 30 * 60_000;
/** Re-verify an address at send time when its last check is older than this (playbook 5). */
export const REVERIFY_AFTER_MS = 30 * 86_400_000;

export const sendEmailJob = defineJob({
  name: SEND_JOB,
  payload: z.object({ message_id: z.string() }),
  maxAttempts: 6,
  backoff: { type: "exponential", baseMs: 120_000, maxMs: 3_600_000 },
  timeoutMs: 120_000,
  handler: (ctx, payload) => sendEmailMessage(ctx, payload.message_id),
});

/**
 * Sends one scheduled email (the `email.send` job). Re-checks the message status, then runs the
 * send gate (relationships/gate.ts: the kill switch, the person, the recipient, the campaign, a
 * thread a person took over, the mailbox and its throttle, contactability with suppressions and
 * privacy requests, a company hold, the send window and the daily cap), then renders, sends,
 * records and emits `message.sent`. Failures are classified (spec 11.8):
 * login problems mark the mailbox `error` and move the message to another campaign mailbox
 * (or hold it until the mailbox sends again), temporary errors retry with backoff, provider
 * throttling parks the mailbox until tomorrow, unknown recipients become hard bounces and other
 * permanent errors fail the message.
 *
 * Never twice: only a `scheduled` message is claimed (`sending`, `dispatch_started_at`). A
 * message found `sending` belongs to an attempt that stopped mid-send, and a failure after the
 * data may have been handed over (a timeout or a dropped connection) leaves the outcome open:
 * both become `unknown` and are reconciled (reconcile-job.ts) instead of being sent again.
 */
export async function sendEmailMessage(ctx: JobContext, messageId: string): Promise<SendOutcome> {
  const workspaceId = ctx.workspace?.id ?? ctx.job.workspaceId;
  if (!workspaceId) return { message_id: messageId, status: "noop", reason: "no_workspace" };
  const [workspace] = await ctx.db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) return { message_id: messageId, status: "noop", reason: "workspace_missing" };
  const scoped = inWorkspace(ctx, workspace);
  const message = await loadMessage(scoped, workspace.id, messageId);
  if (message?.channel !== "email" || message.direction !== "outbound") {
    return { message_id: messageId, status: "noop", reason: "not_found" };
  }
  if (message.status === "sending") return markEmailInterrupted(scoped, workspace, message);
  if (message.status !== "scheduled") {
    return { message_id: messageId, status: "noop", reason: `status_${message.status}` };
  }
  return sendScheduled(scoped, workspace, message);
}

/**
 * A message found `sending` when a send starts: an earlier attempt claimed it and stopped
 * (crash, timeout, shutdown) before recording the outcome, so it may have gone out. It becomes
 * `unknown` and is reconciled; nothing is sent. Also used by the reconcile job's sweep.
 */
export async function markEmailInterrupted(
  ctx: OpContext,
  workspace: Workspace,
  message: Message,
): Promise<SendOutcome> {
  const mailbox = message.mailbox_id
    ? await loadMailbox(ctx, workspace.id, message.mailbox_id)
    : null;
  if (await markSendUnknown(ctx, message, INTERRUPTED_REASON)) {
    await escalateIfUnsearchable(ctx, workspace, message.id, mailbox, INTERRUPTED_REASON);
    ctx.log.warn(
      { message_id: message.id, mailbox_id: message.mailbox_id },
      "email: a send stopped mid-way; its outcome is unknown and will be reconciled",
    );
  } else {
    const fresh = await loadMessage(ctx, workspace.id, message.id);
    const earlier = fresh?.status === "sending" ? earlierAttemptWentOut(fresh) : null;
    if (fresh && earlier !== null) {
      // An earlier attempt went out (its answer came late): sent, and the stopped attempt may
      // have gone out too.
      const context = await loadSendContext(ctx, workspace, fresh);
      return sentByEarlierAttempt(
        ctx,
        { context, mailbox, composed: null },
        fresh,
        earlier,
        { status: "sending", attempt: fresh.attempt },
        true,
      );
    }
  }
  return {
    message_id: message.id,
    status: "unknown",
    reason: INTERRUPTED_REASON,
    mailbox_id: message.mailbox_id,
  };
}

async function sendScheduled(
  ctx: JobContext,
  workspace: Workspace,
  message: Message,
): Promise<SendOutcome> {
  const now = ctx.clock.now();
  const settings = parseWorkspaceSettings(workspace.settings);
  // The send gate: the checks every view shows, in this order (relationships/gate.ts).
  const gate = await evaluateEmailGate(
    ctx,
    { personId: message.person_id ?? "", messageId: message.id },
    {
      mode: "send",
      known: { workspace, message },
      hooks: {
        reverify: ({ person, recipient }) =>
          reverifyBeforeFirstEmail(ctx, { workspace, settings, message, person }, recipient, now),
      },
    },
  );
  const first = gate.blockers[0];
  if (first) {
    // Held without a working unsubscribe link: one problem says what to do.
    if (first.code === UNSUBSCRIBE_LINK_MISSING) await openUnsubscribeHoldProblem(ctx);
    return applyGate(ctx, workspace, message, gate, first, now);
  }
  const { recipient, mailbox, replyMode } = gate;
  if (!recipient || !mailbox)
    throw new Error("email.send: the gate let a message through without a sender");
  await resolveUnsubscribeHoldProblem(ctx, workspace, mailbox, message);
  const context = await loadSendContext(ctx, workspace, message, gateRows(gate));

  const composed = await composeEmail(ctx, context, mailbox, recipient, replyMode, now);
  if (!composed.ok) return fail(ctx, message, composed.error, false);
  const { email } = composed.value;

  // The claim: only a scheduled message, with the time its data is handed over, and only while
  // its mailbox's daily cap has room.
  const claimed = await claimWithinCap(ctx, workspace, message, mailbox, email, recipient);
  if (claimed === "full") {
    // Sends that ran together used up today's cap: planned again on its mailbox, like the gate.
    return moveOrWait(
      ctx,
      context,
      recipient,
      mailbox,
      true,
      ctx.clock.now(),
      "Daily limit reached.",
    );
  }
  if (!claimed) return { message_id: message.id, status: "noop", reason: "claimed_elsewhere" };
  // From here on every write checks this claim: after a later attempt claimed the message
  // (a resend), a result of this one is logged and never recorded.
  const claim: SendClaim = { status: "sending", attempt: claimed.attempt };

  const attempt: Attempt = { context, recipient, mailbox, replyMode, composed: composed.value };
  let transport: EmailTransport;
  try {
    transport = await transportFor(ctx, workspace, mailbox);
  } catch (error) {
    // No server settings or credentials: nothing was handed over.
    return handleFailure(ctx, attempt, classifySendError(error), claim);
  }
  let result: SendResult;
  try {
    // Stops at the SMTP deadline, or when this job ends first: no send outlives its job.
    result = await transport.send(email, { signal: ctx.job.signal });
  } catch (error) {
    const failure = classifySendError(error);
    if (isDeliveryUncertain(error)) return sendUncertain(ctx, attempt, failure, claim);
    return handleFailure(ctx, attempt, failure, claim);
  }
  // The send resolved, so the server took the message data. Only an explicit refusal of this
  // recipient means it did not go out (servers may report the address in another case, or its
  // domain in punycode: still the same address).
  if (result.rejected.some((address) => sameAddress(address, recipient))) {
    const rejection =
      result.rejectedErrors.find((entry) => sameAddress(entry.recipient, recipient)) ??
      result.rejectedErrors[0];
    const failure = classifySendError({
      responseCode: rejection?.responseCode ?? 550,
      response: rejection?.response ?? "Recipient rejected",
    });
    return handleFailure(ctx, attempt, failure, claim);
  }

  const completed = await completeSend(ctx, {
    workspace,
    message,
    person: context.person,
    mailbox,
    composed: composed.value,
    providerMessageId: result.providerMessageId,
    sentAt: ctx.clock.now(),
    resolution: "The email was sent after all.",
    attempt: claim.attempt,
    // A retry may have marked this very attempt unknown meanwhile: its success still counts.
    from: ["sending", "unknown"],
  });
  if (completed) return { message_id: message.id, status: "sent", mailbox_id: mailbox.id };
  // The message moved on while this attempt sent it: its success is settled, never dropped.
  const settled = await settleLateSuccess(ctx, {
    message,
    attempt: claim.attempt,
    record: (fresh, resolution) =>
      completeSend(ctx, {
        workspace,
        message: fresh,
        person: context.person,
        mailbox,
        composed: composed.value,
        providerMessageId: result.providerMessageId,
        sentAt: ctx.clock.now(),
        resolution,
        attempt: fresh.attempt,
        from: [fresh.status],
      }),
  });
  return lateResult(ctx, message, claim, mailbox.id, settled);
}

/** One send attempt of a claimed message: what the failure and success paths need. */
interface Attempt {
  context: SendContext;
  recipient: string;
  mailbox: Mailbox;
  replyMode: boolean;
  composed: ComposedEmail;
}

/**
 * Claims a scheduled message for this send attempt (`sending`, with the time its data is handed
 * over) under a lock on its mailbox's row, so the claims of one mailbox take turns. "full" (no
 * claim) when the emails the mailbox sent today and those it is still sending reach its daily
 * cap (ramp included): the gate counts only the sent ones, so sends that run together could all
 * pass it. Null when the message is no longer scheduled.
 */
async function claimWithinCap(
  ctx: JobContext,
  workspace: Workspace,
  message: Message,
  mailbox: Mailbox,
  email: OutgoingEmail,
  recipient: string,
): Promise<{ attempt: number } | "full" | null> {
  const timezone = isValidTimeZone(workspace.timezone) ? workspace.timezone : "UTC";
  return ctx.db.transaction(async (tx) => {
    const [locked] = await tx
      .select({
        daily_limit: mailboxes.daily_limit,
        ramp: mailboxes.ramp,
        created_at: mailboxes.created_at,
      })
      .from(mailboxes)
      .where(and(eq(mailboxes.id, mailbox.id), eq(mailboxes.workspace_id, workspace.id)))
      .for("update");
    const current = locked ?? mailbox;
    const today = localDate(ctx.clock.now(), timezone);
    const limit = rampLimit(
      current.daily_limit,
      current.ramp,
      localDate(current.created_at, timezone),
      today,
    );
    // One statement, so both counts are read at the same moment.
    const [usage] = await tx
      .select({
        used: sql<number>`(count(*) + coalesce((select sum(${sender_counters.count}) from ${sender_counters} where ${sender_counters.sender_type} = 'mailbox' and ${sender_counters.sender_id} = ${mailbox.id} and ${sender_counters.action} = 'email' and ${sender_counters.day} = ${today}), 0))::int`,
      })
      .from(messages)
      .where(
        and(
          eq(messages.workspace_id, workspace.id),
          eq(messages.mailbox_id, mailbox.id),
          eq(messages.status, "sending"),
          ne(messages.id, message.id),
        ),
      );
    if ((usage?.used ?? 0) >= limit) return "full" as const;
    const [claimed] = await tx
      .update(messages)
      .set({
        status: "sending",
        attempt: sql`${messages.attempt} + 1`,
        message_id_header: email.messageId,
        from_address: mailbox.email,
        to_address: recipient,
        dispatch_started_at: ctx.clock.now(),
        reconcile_checks: 0,
      })
      .where(stillHeld(message.id, QUEUED))
      .returning({ attempt: messages.attempt });
    return claimed ?? null;
  });
}

/**
 * The result of a send attempt that came after the message moved on (another attempt claimed
 * it, or it was settled). A failure is only logged; a success was settled by
 * `settleLateSuccess` (`settled`): recorded as sent, recorded as a duplicate, or remembered for
 * the newer attempt that holds the message.
 */
function lateResult(
  ctx: OpContext,
  message: Message,
  claim: SendHold,
  mailboxId: string | null,
  settled: LateSuccessOutcome = "ignored",
): SendOutcome {
  const base = { message_id: message.id, mailbox_id: mailboxId };
  switch (settled) {
    case "duplicate":
      return { ...base, status: "duplicate", reason: "it went out twice: recorded as a duplicate" };
    case "recorded":
      return { ...base, status: "sent", reason: "recorded from an answer that came late" };
    case "remembered":
      return { ...base, status: "noop", reason: "newer_attempt_sending" };
    case "ignored":
      break;
  }
  ctx.log.warn(
    {
      message_id: message.id,
      attempt: claim.status === "sending" ? claim.attempt : null,
      mailbox_id: mailboxId,
    },
    "email: a send attempt's result came after the message moved on; it is not recorded",
  );
  return { ...base, status: "noop", reason: "status_changed" };
}

/** An email as the send job hands it over, with what the success path stores. */
interface ComposedEmail {
  email: OutgoingEmail;
  /** The thread it continues; null starts a new thread on success. */
  thread: Thread | null;
  rendered: { subject: string; text: string; html: string | null };
  headers: Record<string, string>;
}

type ComposeResult = { ok: true; value: ComposedEmail } | { ok: false; error: string };

/**
 * Renders a message exactly as it goes out: thread and In-Reply-To/References, subject, body
 * with signature and footer, the Message-ID (kept once set, so a resend reuses it) and the
 * unsubscribe headers. `before` limits the thread chain to older messages (reconciling a past
 * send). Returns an error text for messages that cannot be sent as they are.
 */
async function composeEmail(
  ctx: OpContext,
  context: SendContext,
  mailbox: Mailbox,
  recipient: string,
  replyMode: boolean,
  now: Date,
  options: { before?: Date } = {},
): Promise<ComposeResult> {
  const { message, workspace } = context;
  const thread = await resolveThread(ctx, context, mailbox, replyMode);
  const threadMessages = thread ? await threadChain(ctx, thread.id, options.before) : [];
  const inReplyTo = message.in_reply_to ?? (replyMode ? (threadMessages.at(-1) ?? null) : null);
  const references =
    message.references.length > 0
      ? message.references
      : inReplyTo
        ? buildReferences(threadMessages)
        : [];
  const subjectTemplate =
    replyMode && thread ? replySubject(thread.subject ?? message.subject) : (message.subject ?? "");
  if (!subjectTemplate.trim()) return { ok: false, error: "The message has no subject." };

  // Unsubscribe links (and One-Click) need a public https base URL; sandbox sends keep theirs.
  // Other email without one is held by the gate (unsubscribe-hold.ts), so only a reply to
  // someone who wrote to us gets here without the link: the mailto and a reply line stay.
  // The unsubscribe line and headers are never optional for prospect email.
  const link =
    usesSandboxTransport(workspace, mailbox) || unsubscribeReadiness(ctx.config).one_click;
  const tracking = context.campaignSettings?.tracking;
  const rendered = renderEmail({
    subject: subjectTemplate,
    bodyText: message.body_text ?? "",
    bodyHtml: message.body_html,
    vars: templateVars(context, mailbox),
    signature: mailbox.signature,
    footer: footerFor(ctx, context, recipient, { link }),
    html: Boolean(tracking?.opens || tracking?.clicks),
  });
  if (!rendered.text.trim()) return { ok: false, error: "The message body is empty." };
  if (rendered.missing.length > 0) {
    return {
      ok: false,
      error: `Unresolved template variables: ${rendered.missing.join(", ")}. Edit the message or add fallbacks like {{first_name|there}}.`,
    };
  }

  const messageIdHeader = message.message_id_header ?? newMessageIdHeader(mailbox.email, now);
  const listUnsubscribe = link
    ? unsubscribeUrl(ctx.config, {
        messageId: message.id,
        workspaceId: workspace.id,
        email: recipient,
      })
    : null;
  // Without a link: List-Unsubscribe keeps the mailto (read by IMAP sync), no One-Click POST.
  const headers = unsubscribeHeaders(listUnsubscribe, mailbox.email);
  const email: OutgoingEmail = {
    from: { name: mailbox.from_name, address: mailbox.email },
    to: [recipient],
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    messageId: messageIdHeader,
    date: now,
    inReplyTo,
    references,
    headers,
  };
  return {
    ok: true,
    value: {
      email,
      thread,
      rendered: { subject: rendered.subject, text: rendered.text, html: rendered.html },
      headers,
    },
  };
}

interface Completion {
  workspace: Workspace;
  message: Message;
  person: Person | null;
  mailbox: Mailbox | null;
  /** The rendered email; null keeps the stored subject and text. */
  composed: ComposedEmail | null;
  providerMessageId: string | null;
  sentAt: Date;
  /** Resolution text for a `send_unknown` problem, when the message was unknown. */
  resolution: string;
  /** The send attempt this is about: the job's claim, or the attempt the caller read. */
  attempt: number;
  /**
   * The statuses it is recorded from, tried in this order: `sending` (this attempt's own
   * claim), `unknown` (a late success or a copy found), `scheduled` (a queued resend), or any
   * status a late answer found the message in (duplicate-sends.ts).
   */
  from: readonly MessageStatus[];
  /**
   * False when this attempt did not go out itself and the message is recorded as sent because
   * an earlier attempt did (its late answer said so). Default true.
   */
  wentOut?: boolean;
}

/**
 * Records a send: the message becomes `sent` with the rendered text, the thread (created for a
 * new one), the daily counter, the person's last contact and `message.sent`, all in one
 * transaction (the event too, where the context's events can join it). A `send_unknown`
 * problem is resolved, and when a late answer showed that an earlier attempt went out as well,
 * the duplicate is recorded. Only while the message is still in one of the `from` statuses with
 * the same attempt: false otherwise (nothing changes).
 */
async function completeSend(ctx: OpContext, input: Completion): Promise<boolean> {
  const { workspace, message, person, mailbox, composed, sentAt } = input;
  const content = composed
    ? {
        message_id_header: composed.email.messageId,
        subject: composed.rendered.subject,
        body_text: composed.rendered.text,
        body_html: composed.rendered.html,
        in_reply_to: composed.email.inReplyTo ?? null,
        references: composed.email.references ?? [],
        headers: { "message-id": composed.email.messageId, ...composed.headers },
      }
    : {};
  const values = {
    status: "sent" as const,
    sent_at: sentAt,
    provider_message_id: input.providerMessageId,
    error: null,
    ...content,
  };
  const sentEvent = (threadId: string) =>
    ({
      subject: { type: "message", id: message.id },
      data: {
        message_id: message.id,
        thread_id: threadId,
        person_id: message.person_id,
        campaign_id: message.campaign_id,
        channel: "email",
        action: message.action,
        sent_at: sentAt.toISOString(),
      },
    }) as const;
  const done = await withSendTransaction(ctx, async (txCtx, eventsJoin) => {
    const tx = txCtx.db;
    let recorded: { status: MessageStatus; why: Message["why"] } | null = null;
    for (const status of input.from) {
      const [row] = await tx
        .update(messages)
        .set(values)
        .where(
          and(
            eq(messages.id, message.id),
            eq(messages.workspace_id, workspace.id),
            eq(messages.status, status),
            eq(messages.attempt, input.attempt),
          ),
        )
        .returning({ id: messages.id, why: messages.why });
      if (row) {
        recorded = { status, why: row.why };
        break;
      }
    }
    if (!recorded) return null;
    // Counted with the status change: a claim never finds the email neither sending nor counted.
    if (mailbox) {
      const senderTimezone = isValidTimeZone(workspace.timezone) ? workspace.timezone : "UTC";
      await tx
        .insert(sender_counters)
        .values({
          sender_type: "mailbox",
          sender_id: mailbox.id,
          day: localDate(sentAt, senderTimezone),
          action: "email",
          count: 1,
        })
        .onConflictDoUpdate({
          target: [
            sender_counters.sender_type,
            sender_counters.sender_id,
            sender_counters.day,
            sender_counters.action,
          ],
          set: { count: sql`${sender_counters.count} + 1` },
        });
    }
    const existing =
      composed?.thread ??
      (message.thread_id ? await findThread(tx, workspace.id, message.thread_id) : null);
    const thread =
      existing ??
      (await createThread(tx, {
        workspace,
        message,
        person,
        mailboxId: mailbox?.id ?? null,
        subject: composed?.rendered.subject ?? message.subject,
        rootMessageId: composed?.email.messageId ?? message.message_id_header,
        at: sentAt,
      }));
    await tx.update(messages).set({ thread_id: thread.id }).where(eq(messages.id, message.id));
    const personId = message.person_id ?? person?.id ?? null;
    if (personId) {
      await tx
        .update(people)
        .set({ last_contacted_at: sentAt })
        .where(and(eq(people.id, personId), eq(people.workspace_id, workspace.id)));
    }
    const lastMessageAt =
      thread.last_message_at && thread.last_message_at > sentAt ? thread.last_message_at : sentAt;
    await tx
      .update(threads)
      .set({
        last_message_at: lastMessageAt,
        ...(thread.mailbox_id || !mailbox ? {} : { mailbox_id: mailbox.id }),
      })
      .where(eq(threads.id, thread.id));
    // The event commits with the status change, so a consumer never misses a send.
    if (eventsJoin) await txCtx.events.emit("message.sent", sentEvent(thread.id));
    return { thread, recorded, eventsJoin };
  });
  if (!done) return false;
  const { thread, recorded } = done;
  if (!done.eventsJoin) await ctx.events.emit("message.sent", sentEvent(thread.id));
  if (mailbox) await recordSendSuccess(ctx, mailbox.id);
  if (recorded.status !== "sending") {
    await resolveSendUnknownProblem(ctx, message.id, input.resolution);
  }
  const earlier = earlierAttemptWentOut({ why: recorded.why, attempt: input.attempt });
  if (earlier !== null && recorded.status === "sending" && input.wentOut !== false) {
    // A late answer showed an earlier attempt went out while this one held the message, and
    // this one went out too.
    await recordDuplicateSend(
      ctx,
      { ...message, status: "sent", attempt: input.attempt, why: recorded.why },
      { attempts: [earlier, input.attempt], proven: true },
    );
  }
  return true;
}

/**
 * When an email whose outcome is unknown goes out again (a resend): planned like any send, on
 * its own mailbox (a copy that did arrive shows in its Sent folder), inside the send window, on
 * working days and within the daily cap and gaps. Now when nothing can be planned: the send
 * job's checks decide then (a paused workspace, a mailbox that cannot send).
 */
export async function planEmailResend(
  ctx: OpContext,
  workspace: Workspace,
  message: Message,
): Promise<Date> {
  const now = ctx.clock.now();
  const recipient = singleRecipient(message.to_address ?? "");
  if (!message.mailbox_id || !recipient) return now;
  const scoped = inWorkspace(ctx, workspace);
  const context = await loadSendContext(scoped, workspace, message);
  const plan = await planEmailSendWith(
    scoped,
    {
      mailboxIds: [message.mailbox_id],
      preferredMailboxId: message.mailbox_id,
      recipientEmail: recipient,
      recipientTimezone: recipientZone(context),
      schedule: scheduleFor(context),
    },
    { excludeMessageId: message.id },
  );
  if (plan.ok) return plan.sendAt;
  const later = plan.reason === "outside_window" || plan.reason === "no_capacity";
  return later && plan.retryAt && plan.retryAt > now ? plan.retryAt : now;
}

/**
 * Records an `unknown` email as sent: its copy was found in the Sent folder, or a person
 * confirmed it. Same bookkeeping as a normal send (the text as it went out, thread, daily
 * counter, last contact, `message.sent`); the `send_unknown` problem is resolved, and with
 * `learnedCopy` the mailbox learns that its server keeps sent copies. A resend that still waits
 * in the queue (`isQueuedResend`) is confirmed the same way, which drops the resend; once a
 * send job claimed it, it is left to that job. Returns false (nothing changes) for anything
 * else, or for an email of another workspace.
 */
export async function confirmEmailSent(
  ctx: OpContext,
  messageId: string,
  input: { sentAt?: Date | null; resolution: string; learnedCopy?: boolean },
): Promise<boolean> {
  const workspace = requireWorkspace(ctx);
  const message = await loadMessage(ctx, workspace.id, messageId);
  if (
    message?.channel !== "email" ||
    message.direction !== "outbound" ||
    (message.status !== "unknown" && !isQueuedResend(message))
  ) {
    return false;
  }
  const now = ctx.clock.now();
  const candidate = input.sentAt ?? message.dispatch_started_at ?? message.updated_at;
  const sentAt = candidate.getTime() > now.getTime() ? now : candidate;
  const mailbox = message.mailbox_id
    ? await loadMailbox(ctx, workspace.id, message.mailbox_id)
    : null;
  const context = await loadSendContext(ctx, workspace, message);
  const recipient = singleRecipient(message.to_address ?? context.person?.email ?? "");
  let composed: ComposedEmail | null = null;
  if (mailbox && recipient) {
    const replyMode =
      message.action === "reply" || context.stepMode === "reply" || Boolean(message.in_reply_to);
    const result = await composeEmail(ctx, context, mailbox, recipient, replyMode, sentAt, {
      before: message.dispatch_started_at ?? sentAt,
    });
    if (result.ok) composed = result.value;
  }
  const completed = await completeSend(ctx, {
    workspace,
    message,
    person: context.person,
    mailbox,
    composed,
    providerMessageId: message.provider_message_id,
    sentAt,
    resolution: input.resolution,
    attempt: message.attempt,
    // A queued resend is confirmed only while no send job claimed it.
    from: [message.status === "unknown" ? "unknown" : "scheduled"],
  });
  if (completed && input.learnedCopy && mailbox) await learnSavesSentCopies(ctx, mailbox.id);
  return completed;
}

/**
 * Proof that the mailbox's server keeps a copy of what it sends: a copy of one of the engine's
 * own emails was found in its Sent folder (a reconcile lookup or the Sent folder sync). The
 * first time is stored in `sent_copies_seen_at`.
 */
export async function learnSavesSentCopies(ctx: OpContext, mailboxId: string): Promise<void> {
  await ctx.db
    .update(mailboxes)
    .set({ sent_copies_seen_at: ctx.clock.now() })
    .where(and(eq(mailboxes.id, mailboxId), isNull(mailboxes.sent_copies_seen_at)));
}

/** The engine can look for sent copies: sandbox mailboxes (the outbox) and mailboxes with IMAP. */
export function canSearchSentCopies(workspace: Workspace, mailbox: Mailbox): boolean {
  return usesSandboxTransport(workspace, mailbox) || Boolean(mailbox.imap?.host);
}

/**
 * A new unknown email on a mailbox whose Sent folder the engine cannot read (no IMAP, or the
 * mailbox is gone): nothing can reconcile it, so a person is asked at once.
 */
export async function escalateIfUnsearchable(
  ctx: OpContext,
  workspace: Workspace,
  messageId: string,
  mailbox: Mailbox | null,
  detail: string,
): Promise<boolean> {
  if (mailbox && canSearchSentCopies(workspace, mailbox)) return false;
  const message = await loadMessage(ctx, workspace.id, messageId);
  if (message?.status !== "unknown") return false;
  await openEmailUnknownProblem(
    ctx,
    message,
    mailbox?.email ?? "the sending mailbox",
    `${detail}; the engine cannot read this mailbox's Sent folder (no IMAP access) to check`,
  );
  await stopReconciling(ctx, message.id);
  return true;
}

/**
 * The send failed after the message data may have been handed over (a timeout, reset or
 * dropped connection without a refusal from the server): it may have gone out, so it becomes
 * `unknown` instead of being retried. The failure still counts on the mailbox's failure streak.
 */
async function sendUncertain(
  ctx: JobContext,
  attempt: Attempt,
  failure: SendFailure,
  claim: SendClaim,
): Promise<SendOutcome> {
  const { context, mailbox } = attempt;
  const { message, workspace } = context;
  const reason = `no clear answer from the mail server after the message was handed over (${failure.message})`;
  if (!(await markSendUnknown(ctx, { ...message, attempt: claim.attempt }, reason))) {
    const fresh = await loadMessage(ctx, workspace.id, message.id);
    const held = fresh?.status === "sending" && fresh.attempt === claim.attempt;
    const earlier = held && fresh ? earlierAttemptWentOut(fresh) : null;
    if (fresh && earlier !== null) {
      // An earlier attempt went out (its answer came late): sent, and maybe twice.
      return sentByEarlierAttempt(ctx, attempt, fresh, earlier, claim, true);
    }
    return lateResult(ctx, message, claim, mailbox.id);
  }
  await recordSendFailure(ctx, mailbox, `Outcome unknown: ${failure.message}`);
  await escalateIfUnsearchable(ctx, workspace, message.id, mailbox, reason);
  ctx.log.warn(
    { message_id: message.id, mailbox_id: mailbox.id, error: failure.message },
    "email: send outcome unknown; it will be reconciled, not retried",
  );
  return { message_id: message.id, status: "unknown", reason, mailbox_id: mailbox.id };
}

/**
 * This attempt holds the message without having clearly sent it, while a late answer showed an
 * earlier attempt went out: the message is recorded as sent (by the earlier attempt). When this
 * attempt may have gone out too (`mayHaveGoneOut`: no clear answer, or it stopped mid-send), the
 * person may have it twice, and a `duplicate_send` problem says so.
 */
async function sentByEarlierAttempt(
  ctx: OpContext,
  attempt: { context: SendContext; mailbox: Mailbox | null; composed: ComposedEmail | null },
  fresh: Message,
  earlier: number,
  claim: SendClaim,
  mayHaveGoneOut: boolean,
): Promise<SendOutcome> {
  const { context, mailbox } = attempt;
  const recorded = await completeSend(ctx, {
    workspace: context.workspace,
    message: fresh,
    person: context.person,
    mailbox,
    composed: attempt.composed,
    providerMessageId: fresh.provider_message_id,
    sentAt: ctx.clock.now(),
    resolution: `An earlier try went out (try ${earlier}); its answer came late.`,
    attempt: claim.attempt,
    from: ["sending"],
    wentOut: false,
  });
  if (!recorded) return lateResult(ctx, fresh, claim, mailbox?.id ?? null);
  if (mayHaveGoneOut) {
    await recordDuplicateSend(
      ctx,
      { ...fresh, status: "sent" },
      { attempts: [earlier, claim.attempt], proven: false },
    );
  }
  return {
    message_id: fresh.id,
    status: "sent",
    reason: `an earlier try went out (try ${earlier}); its answer came late`,
    mailbox_id: mailbox?.id ?? null,
  };
}

async function loadMessage(
  ctx: OpContext,
  workspaceId: string,
  messageId: string,
): Promise<Message | null> {
  const [message] = await ctx.db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.workspace_id, workspaceId)))
    .limit(1);
  return message ?? null;
}

async function loadMailbox(
  ctx: OpContext,
  workspaceId: string,
  mailboxId: string,
): Promise<Mailbox | null> {
  const [mailbox] = await ctx.db
    .select()
    .from(mailboxes)
    .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.workspace_id, workspaceId)))
    .limit(1);
  return mailbox ?? null;
}

/**
 * Send-time re-verification (deliverability playbook, list hygiene): before the first email to a
 * person (none sent in the last 30 days), when an email verifier is configured and the last
 * check is missing or over 30 days old, the address is verified now (enrichment
 * `verifyEmailNow`, which stores the result). Returns the reasons the result blocks the send;
 * none when no verifier is configured or the verification could not run.
 */
async function reverifyBeforeFirstEmail(
  ctx: JobContext,
  context: Pick<SendContext, "person" | "message" | "settings" | "workspace">,
  recipient: string,
  now: Date,
): Promise<string[]> {
  const { person, message, settings } = context;
  if (!person || message.action === "reply") return [];
  if ((person.email ?? "").trim().toLowerCase() !== recipient) return [];
  const checkedAt = person.email_checked_at?.getTime() ?? 0;
  if (now.getTime() - checkedAt <= REVERIFY_AFTER_MS) return [];
  const verifierId = settings.data.enrichment.verifier;
  const verifier = await ctx.providers
    .tryGet("email_verifier", verifierId ? { id: verifierId } : undefined)
    .catch(() => null);
  if (!verifier) return [];
  const [recent] = await ctx.db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, context.workspace.id),
        eq(messages.person_id, person.id),
        eq(messages.channel, "email"),
        eq(messages.direction, "outbound"),
        eq(messages.origin, "engine"),
        inArray(messages.status, ["sent", "bounced"]),
        gte(messages.sent_at, new Date(now.getTime() - REVERIFY_AFTER_MS)),
        ne(messages.id, message.id),
      ),
    )
    .limit(1);
  if (recent) return [];
  let status: EmailStatus;
  try {
    status = await verifyEmailNow(ctx, person.id);
  } catch (error) {
    ctx.log.warn(
      { message_id: message.id, err: String(error) },
      "email: send-time verification failed; sending on the stored status",
    );
    return [];
  }
  return verificationBlocks(status, settings);
}

/** Why a verification result blocks a send (same rules as the leads contactability check). */
export function verificationBlocks(status: EmailStatus, settings: WorkspaceSettings): string[] {
  if (status === "valid") return [];
  if (status === "invalid") return ["invalid_email"];
  if (status === "catch_all") {
    return settings.sending.catch_all === "skip" ? ["catch_all_skipped"] : [];
  }
  return settings.sending.require_verified_email ? ["unverified_email"] : [];
}

/** The thread this message belongs to (existing thread, or the enrollment's email thread for reply steps). */
async function resolveThread(
  ctx: OpContext,
  context: SendContext,
  mailbox: Mailbox,
  replyMode: boolean,
): Promise<Thread | null> {
  const { message, workspace } = context;
  if (message.thread_id) {
    const thread = await findThread(ctx.db, workspace.id, message.thread_id);
    if (thread) return thread;
  }
  if (!replyMode) return null;
  const scope = message.enrollment_id
    ? eq(messages.enrollment_id, message.enrollment_id)
    : message.person_id
      ? eq(messages.person_id, message.person_id)
      : null;
  if (!scope) return null;
  const [previous] = await ctx.db
    .select({ thread_id: messages.thread_id })
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, workspace.id),
        scope,
        eq(messages.mailbox_id, mailbox.id),
        eq(messages.direction, "outbound"),
        eq(messages.status, "sent"),
        // Mail a person wrote from the mailbox is not a thread the engine continues.
        eq(messages.origin, "engine"),
        isNotNull(messages.thread_id),
      ),
    )
    .orderBy(desc(messages.sent_at))
    .limit(1);
  if (!previous?.thread_id) return null;
  return findThread(ctx.db, workspace.id, previous.thread_id);
}

async function findThread(db: Db, workspaceId: string, threadId: string): Promise<Thread | null> {
  const [thread] = await db
    .select()
    .from(threads)
    .where(and(eq(threads.id, threadId), eq(threads.workspace_id, workspaceId)))
    .limit(1);
  return thread ?? null;
}

/** Message-IDs of the thread's sent and received messages, oldest first (only older than `before`). */
async function threadChain(ctx: OpContext, threadId: string, before?: Date): Promise<string[]> {
  const at = sql`coalesce(${messages.sent_at}, ${messages.received_at}, ${messages.created_at})`;
  const rows = await ctx.db
    .select({ id: messages.message_id_header })
    .from(messages)
    .where(
      and(
        eq(messages.thread_id, threadId),
        isNotNull(messages.message_id_header),
        inArray(messages.status, ["sent", "received"]),
        ...(before ? [lt(at, sql`${before.toISOString()}::timestamptz`)] : []),
      ),
    )
    .orderBy(asc(at));
  return rows.map((row) => row.id).filter((id): id is string => Boolean(id));
}

async function createThread(
  db: Db,
  input: {
    workspace: Workspace;
    message: Message;
    person: Person | null;
    mailboxId: string | null;
    subject: string | null;
    rootMessageId: string | null;
    at: Date;
  },
): Promise<Thread> {
  const { message, person } = input;
  const [thread] = await db
    .insert(threads)
    .values({
      workspace_id: input.workspace.id,
      person_id: message.person_id ?? person?.id ?? null,
      company_id: message.company_id ?? person?.company_id ?? null,
      campaign_id: message.campaign_id,
      channel: "email",
      subject: input.subject,
      mailbox_id: input.mailboxId,
      external_ref: input.rootMessageId,
      status: "open",
      last_message_at: input.at,
    })
    .returning();
  if (!thread) throw new Error("email.send: thread insert returned no row");
  return thread;
}

/**
 * Cancels a message that must never go out (`cancelled`, `message.failed` not retryable). A
 * message in a thread a person took over keeps the takeover's own error, `superseded_by_person`.
 */
async function cancel(ctx: JobContext, message: Message, why: string): Promise<SendOutcome> {
  const error = why === SUPERSEDED_BY_PERSON ? why : `cancelled: ${why}`;
  const [row] = await ctx.db
    .update(messages)
    .set({ status: "cancelled", error: error.slice(0, 1000) })
    .where(stillHeld(message.id, QUEUED))
    .returning({ id: messages.id });
  if (!row) return movedOn(ctx, message, "it was being cancelled");
  await ctx.events.emit("message.failed", {
    subject: { type: "message", id: message.id },
    data: { message_id: message.id, error: error.slice(0, 500), retryable: false },
  });
  return {
    message_id: message.id,
    status: "cancelled",
    reason: why,
    mailbox_id: message.mailbox_id,
  };
}

/**
 * The person may not be contacted (suppressed, opted out, a privacy request, a company rule):
 * `skipped` with `not_contactable: <codes>` and `message.failed` not retryable, so the sequence
 * moves on.
 */
async function skip(
  ctx: JobContext,
  message: Message,
  reasons: string,
  mailboxId: string | null,
): Promise<SendOutcome> {
  const error = `not_contactable: ${reasons}`;
  const [row] = await ctx.db
    .update(messages)
    .set({ status: "skipped", error })
    .where(stillHeld(message.id, QUEUED))
    .returning({ id: messages.id });
  if (!row) return movedOn(ctx, message, "it was being skipped");
  await ctx.events.emit("message.failed", {
    subject: { type: "message", id: message.id },
    data: { message_id: message.id, error, retryable: false },
  });
  return { message_id: message.id, status: "skipped", reason: reasons, mailbox_id: mailboxId };
}

/**
 * The message changed while the job worked on it (a stop cancelled it, a pause took it back):
 * nothing is written over it.
 */
function movedOn(ctx: OpContext, message: Message, during: string): SendOutcome {
  ctx.log.info(
    { message_id: message.id },
    `email: the message changed while ${during}; it is left as it is`,
  );
  return {
    message_id: message.id,
    status: "noop",
    reason: "status_changed",
    mailbox_id: message.mailbox_id,
  };
}

/** The rows the gate read, so the send context does not read them again. */
function gateRows(gate: EmailGate): SendContextRows {
  return {
    person: gate.person,
    company: gate.company,
    campaign: gate.campaign,
    stepMode: gate.stepMode,
  };
}

/**
 * Acts on the gate's first blocker with the job's own functions: wait (the job parks until its
 * key is woken or the time passes), cancel, fail, skip, or move (to another mailbox or a later
 * time, see moveOrFail and moveOrWait).
 */
async function applyGate(
  ctx: JobContext,
  workspace: Workspace,
  message: Message,
  gate: EmailGate,
  first: GateBlocker,
  now: Date,
): Promise<SendOutcome> {
  const detail = first.detail ?? first.message;
  switch (first.disposition) {
    case "wait":
      throw new JobWaitError(
        first.wait_key ?? sendJobKey(message.id),
        first.retry_at ? new Date(first.retry_at) : new Date(now.getTime() + PAUSED_RECHECK_MS),
      );
    case "cancel":
      return cancel(ctx, message, detail);
    case "fail":
      return fail(ctx, message, detail, false);
    case "skip":
      return skip(ctx, message, detail, gate.mailbox?.id ?? message.mailbox_id);
    case "move": {
      const context = await loadSendContext(ctx, workspace, message, gateRows(gate));
      const recipient = gate.recipient ?? "";
      if (first.retry_at && gate.mailbox) {
        const keep = Boolean(first.keep_sender) || gate.replyMode;
        return moveOrWait(
          ctx,
          context,
          recipient,
          gate.mailbox,
          keep,
          new Date(first.retry_at),
          detail,
        );
      }
      return moveOrFail(ctx, context, recipient, gate.mailbox, gate.replyMode, detail);
    }
  }
}

/**
 * Fails the message while it is still as `hold` says (queued by default, or this attempt's
 * claim); a failure for good also counts in the campaign's `send_failed` problem. An email only
 * fails when it did not go out: nothing was handed over, or the server refused it (a send that
 * may have gone out becomes `unknown` instead), so `why.failed_before_handover` is true.
 */
async function fail(
  ctx: JobContext,
  message: Message,
  error: string,
  retryable: boolean,
  hold: SendHold = QUEUED,
): Promise<SendOutcome> {
  const [row] = await ctx.db
    .update(messages)
    .set({ status: "failed", error: error.slice(0, 1000), why: failedWhy(true) })
    .where(stillHeld(message.id, hold))
    .returning({ id: messages.id });
  if (!row)
    return hold.status === "sending"
      ? lateResult(ctx, message, hold, message.mailbox_id)
      : movedOn(ctx, message, "it was being failed");
  await ctx.events.emit("message.failed", {
    subject: { type: "message", id: message.id },
    data: { message_id: message.id, error: error.slice(0, 500), retryable },
  });
  if (!retryable) await recordSendFailed(ctx, message, error);
  return {
    message_id: message.id,
    status: "failed",
    reason: error,
    mailbox_id: message.mailbox_id,
  };
}

/**
 * Re-plans the message (same mailbox first unless `exclude`) and parks the job until the new
 * time. Fails the message when no mailbox can take it. The move only applies while the message
 * is still `scheduled`: one that was cancelled or paused meanwhile stays as it is (noop).
 */
async function reschedule(
  ctx: JobContext,
  context: SendContext,
  recipient: string,
  mailboxIds: string[],
  preferred: string | null,
  notBefore: Date,
  why: string,
): Promise<SendOutcome> {
  const { message } = context;
  const plan = await planEmailSendWith(
    ctx,
    {
      mailboxIds,
      preferredMailboxId: preferred,
      recipientEmail: recipient,
      recipientTimezone: recipientZone(context),
      schedule: scheduleFor(context),
      notBefore,
    },
    { excludeMessageId: message.id },
  );
  let mailboxId: string | null = null;
  let runAt: Date | null = null;
  if (plan.ok) {
    mailboxId = plan.mailboxId;
    runAt = plan.sendAt;
  } else if (
    plan.retryAt &&
    plan.reason !== "no_active_mailbox" &&
    plan.reason !== "workspace_paused"
  ) {
    mailboxId = preferred && mailboxIds.includes(preferred) ? preferred : (mailboxIds[0] ?? null);
    runAt = plan.retryAt;
  } else if (plan.reason === "workspace_paused") {
    throw new JobWaitError(
      `workspace_active:${context.workspace.id}`,
      new Date(ctx.clock.now().getTime() + PAUSED_RECHECK_MS),
    );
  }
  if (!mailboxId || !runAt) {
    return fail(
      ctx,
      message,
      `${why} No other mailbox can send it (${plan.ok ? "ok" : plan.reason}).`,
      true,
    );
  }
  const [moved] = await ctx.db
    .update(messages)
    .set({ mailbox_id: mailboxId, scheduled_for: runAt, error: why.slice(0, 500) })
    .where(and(eq(messages.id, message.id), eq(messages.status, "scheduled")))
    .returning({ id: messages.id });
  if (!moved) return movedOn(ctx, message, "its move was planned");
  ctx.log.info(
    { message_id: message.id, mailbox_id: mailboxId, run_at: runAt.toISOString(), why },
    "email: rescheduled",
  );
  throw new JobWaitError(sendJobKey(message.id), runAt);
}

function campaignMailboxIds(context: SendContext): string[] {
  return context.campaignSettings?.senders.mailbox_ids ?? [];
}

/**
 * Campaign mailboxes a message may move to: not `currentId`, and able to send (active or
 * warming; so none paused, held by a health pause, in error, disconnected or removed).
 */
async function moveTargets(
  ctx: JobContext,
  context: SendContext,
  currentId: string | undefined,
): Promise<string[]> {
  const ids = campaignMailboxIds(context).filter((id) => id !== currentId);
  if (ids.length === 0) return [];
  const rows = await ctx.db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(
      and(
        eq(mailboxes.workspace_id, context.workspace.id),
        inArray(mailboxes.id, ids),
        inArray(mailboxes.status, [...SENDABLE_STATUSES]),
      ),
    );
  const sendable = new Set(rows.map((row) => row.id));
  return ids.filter((id) => sendable.has(id));
}

/**
 * The mailbox cannot send now: move a new-thread message to another campaign mailbox that can
 * send, else hold it on its mailbox until that sends again. Mail on a mailbox the engine paused
 * for its health (bounce rate, provider block) never moves: that would route around the pause.
 * Held mail waits on `mailbox_active:<id>`, which a resume, a clean test, an OAuth reconnect
 * or a removal wakes, and looks again by itself (`heldRecheckAt`). Only a message whose
 * mailbox was removed fails.
 */
async function moveOrFail(
  ctx: JobContext,
  context: SendContext,
  recipient: string,
  mailbox: Mailbox | null,
  replyMode: boolean,
  why: string,
): Promise<SendOutcome> {
  if (mailbox && holdsQueuedMail(mailbox)) {
    throw new JobWaitError(mailboxActiveKey(mailbox.id), pauseRecheckAt(mailbox, ctx.clock.now()));
  }
  const others = replyMode ? [] : await moveTargets(ctx, context, mailbox?.id);
  if (others.length > 0) {
    return reschedule(ctx, context, recipient, others, null, ctx.clock.now(), why);
  }
  if (mailbox) {
    // Nowhere else to go (or a thread reply that keeps its sender): wait until it sends again.
    throw new JobWaitError(mailboxActiveKey(mailbox.id), heldRecheckAt(mailbox, ctx.clock.now()));
  }
  return fail(ctx, context.message, why, true);
}

/** Wait (same mailbox) or move a new-thread message to another mailbox that can send sooner. */
async function moveOrWait(
  ctx: JobContext,
  context: SendContext,
  recipient: string,
  mailbox: Mailbox,
  replyMode: boolean,
  notBefore: Date,
  why: string,
): Promise<SendOutcome> {
  const ids = replyMode ? [mailbox.id] : [...new Set([mailbox.id, ...campaignMailboxIds(context)])];
  return reschedule(ctx, context, recipient, ids, mailbox.id, notBefore, why);
}

async function handleFailure(
  ctx: JobContext,
  attempt: Attempt,
  failure: SendFailure,
  claim: SendClaim,
): Promise<SendOutcome> {
  const { context, recipient, mailbox, replyMode } = attempt;
  const { message } = context;
  const fresh = await loadMessage(ctx, context.workspace.id, message.id);
  if (fresh?.status !== "sending" || fresh.attempt !== claim.attempt) {
    // Another attempt found this message `sending` and marked it unknown meanwhile (it is
    // reconciled from there, never retried from here), or a later attempt claimed it.
    ctx.log.warn(
      { message_id: message.id, attempt: claim.attempt, status: fresh?.status ?? null },
      "email: a failed send attempt's result came after the message moved on; it is not recorded",
    );
    return {
      message_id: message.id,
      status: "noop",
      reason: `status_${fresh?.status ?? "missing"}`,
      mailbox_id: mailbox.id,
    };
  }
  const earlier = earlierAttemptWentOut(fresh);
  if (earlier !== null) {
    // This attempt did not go out, but a late answer showed an earlier one did: it is sent.
    return sentByEarlierAttempt(ctx, attempt, fresh, earlier, claim, false);
  }
  /** Back to `scheduled` while this attempt still holds its claim; false when it moved on. */
  const restore = async () => {
    const rows = await ctx.db
      .update(messages)
      .set({
        status: "scheduled",
        error: failure.message.slice(0, 1000),
        dispatch_started_at: null,
      })
      .where(stillHeld(message.id, claim))
      .returning({ id: messages.id });
    return rows.length > 0;
  };
  const late = () => lateResult(ctx, message, claim, mailbox.id);

  switch (failure.kind) {
    case "recipient": {
      const bounce = await applyBounce(ctx, {
        message: fresh,
        email: recipient,
        bounceType: "hard",
        reason: failure.message,
        claimedAttempt: claim.attempt,
      });
      if (!bounce.applied) return late();
      return {
        message_id: message.id,
        status: "bounced",
        reason: failure.message,
        mailbox_id: mailbox.id,
      };
    }
    case "auth":
    case "config": {
      if (!(await restore())) return late();
      await markMailboxError(
        ctx,
        mailbox,
        `${failure.kind === "auth" ? "Login failed" : "SMTP settings problem"}: ${failure.message}`,
      );
      return moveOrFail(
        ctx,
        context,
        recipient,
        { ...mailbox, status: "error" },
        replyMode,
        failure.message,
      );
    }
    case "blocked": {
      // A domain-level rejection (x.7.28, 5.7.26 and similar): every mailbox on the sending
      // domain pauses and this message waits for the resume.
      if (!(await restore())) return late();
      await pauseSendingDomain(ctx, mailbox, failure.status ?? "5.7.26", failure.message);
      const paused = (await loadMailbox(ctx, context.workspace.id, mailbox.id)) ?? {
        ...mailbox,
        status: "paused" as const,
      };
      return moveOrFail(ctx, context, recipient, paused, replyMode, failure.message);
    }
    case "throttled": {
      if (!(await restore())) return late();
      const timezone = isValidTimeZone(context.workspace.timezone)
        ? context.workspace.timezone
        : "UTC";
      const until = await throttleMailbox(ctx, mailbox, timezone, failure.message);
      return moveOrWait(
        ctx,
        context,
        recipient,
        mailbox,
        replyMode,
        until,
        `Provider throttling: ${failure.message}`,
      );
    }
    case "permanent": {
      await recordSendFailure(ctx, mailbox, failure.message);
      return fail(ctx, fresh, failure.message, false, claim);
    }
    default: {
      if (!(await restore())) return late();
      const failures = await recordSendFailure(ctx, mailbox, failure.message);
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        return moveOrFail(
          ctx,
          context,
          recipient,
          { ...mailbox, status: "paused" },
          replyMode,
          failure.message,
        );
      }
      if (ctx.job.attempt >= ctx.job.maxAttempts) {
        // Every try failed for a passing reason: this email is not tried again, so it counts
        // in the send_failed problem like any failure for good.
        const error = `${RETRIES_USED_UP_PREFIX} (${ctx.job.attempt} tries): ${failure.message}`;
        return fail(ctx, fresh, error, false);
      }
      throw new Error(`Temporary send failure: ${failure.message}`);
    }
  }
}
