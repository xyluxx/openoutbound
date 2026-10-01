/**
 * `email.reconcile_sends` (every 10 minutes per workspace): settles sends whose outcome is
 * unknown, never by sending blindly.
 * 1. Sweep: a message still `sending` 15 minutes after its dispatch started, with no job left to
 *    finish it, was interrupted: emails and LinkedIn invites, messages and comments become
 *    `unknown`; LinkedIn visits and likes are queued again (done at least once).
 * 2. Email: each unknown email is looked up by Message-ID in its mailbox's Sent folder (the
 *    outbox for sandbox mailboxes). Found: sent. Not found after three lookups: sent again once
 *    only when the mailbox is proven to keep sent copies (the engine found one of its own
 *    emails there before: `sent_copies_seen_at`), since only then does a missing copy prove the
 *    email never left; else a `send_unknown` problem for a person. Mailboxes without IMAP get
 *    the problem at once. A copy that shows up late still confirms the email for three days,
 *    also while its resend waits in the queue (the resend is dropped then).
 * 3. LinkedIn: see linkedin/unknown-actions.ts.
 * 4. Lost send jobs: a `scheduled` email 15 minutes past its time with no send job left (one
 *    was cancelled, or ended without settling the message) is queued again.
 */
import { and, asc, eq, inArray, lt, notExists, or, sql } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import { type JobContext, requireWorkspace } from "../../core/context.js";
import { defineJob } from "../../core/operation.js";
import {
  jobs,
  type Mailbox,
  type Message,
  mailboxes,
  messages,
  type Workspace,
} from "../../db/schema/index.js";
import { enqueueAction } from "../linkedin/service.js";
import {
  type LinkedInReconcileSummary,
  markLinkedInInterrupted,
  reconcileLinkedInUnknowns,
} from "../linkedin/unknown-actions.js";
import { mailAuth } from "./credentials.js";
import { createImapClient, findSentFolder } from "./imap.js";
import { SEND_JOB, sendJobKey } from "./queue.js";
import { getSandboxOutbox } from "./sandbox-transport.js";
import {
  canSearchSentCopies,
  confirmEmailSent,
  escalateIfUnsearchable,
  markEmailInterrupted,
  planEmailResend,
} from "./send-job.js";
import { usesSandboxTransport } from "./transport.js";
import {
  countReconcileCheck,
  INTERRUPTED_REASON,
  openEmailUnknownProblem,
  RECONCILE_CHECKS,
  rescheduleUnknown,
  savesSentCopies,
  stopReconciling,
  wasResentAfterUnknown,
} from "./unknown-sends.js";

export const RECONCILE_JOB = "email.reconcile_sends";
/** A send still `sending` this long after its dispatch started, with no job left, was interrupted. */
export const STUCK_SENDING_MS = 15 * 60_000;
/** A copy that shows up late still confirms an unknown email this long after its dispatch. */
export const LATE_COPY_MS = 3 * 86_400_000;
/** When the Sent folder cannot be opened, a person is asked once the email is unknown this long. */
export const OPEN_FAILURE_GRACE_MS = 30 * 60_000;
/** A scheduled email this long past its time, with no send job left, lost its job. */
export const LOST_JOB_AFTER_MS = 15 * 60_000;
const MAX_PER_RUN = 100;
/** Job states in which a send job will still settle its message itself. */
const LIVE_JOB_STATES = ["queued", "running", "waiting"] as const;

export const reconcileSendsJob = defineJob({
  name: RECONCILE_JOB,
  maxAttempts: 1,
  timeoutMs: 5 * 60_000,
  handler: (ctx) => reconcileUnknownSends(ctx),
});

/** What the email part of one run did (counts only). */
export interface EmailReconcileSummary {
  checked: number;
  confirmed: number;
  resent: number;
  problems: number;
  pending: number;
  errors: number;
}

/** What one reconcile run did (counts only). */
export interface ReconcileSummary {
  /** Messages found stuck in `sending` and settled as interrupted. */
  swept: number;
  /** Scheduled emails past their time whose send job was gone, queued again. */
  requeued: number;
  email: EmailReconcileSummary;
  linkedin: LinkedInReconcileSummary;
}

type Outcome = Exclude<keyof EmailReconcileSummary, "checked">;
type Tally = (outcome: Outcome) => void;

/** One reconcile run for the context workspace (see module doc). */
export async function reconcileUnknownSends(ctx: JobContext): Promise<ReconcileSummary> {
  const workspace = requireWorkspace(ctx);
  const swept = await sweepStuckSends(ctx, workspace);
  const email = await reconcileEmail(ctx, workspace);
  const linkedin = await reconcileLinkedInUnknowns(ctx);
  const requeued = await requeueLostSends(ctx, workspace);
  if (swept + requeued + email.checked + linkedin.checked > 0) {
    ctx.log.info(
      { swept, requeued, email, linkedin },
      "email: reconciled sends with an unknown outcome",
    );
  }
  return { swept, requeued, email, linkedin };
}

/**
 * Scheduled emails past their time by `LOST_JOB_AFTER_MS` with no live send job (one was
 * cancelled, or ended without settling the message) are queued again with the send job's own
 * key, at most `MAX_PER_RUN` a run. The send job's checks decide what happens to them.
 */
async function requeueLostSends(ctx: JobContext, workspace: Workspace): Promise<number> {
  const now = ctx.clock.now();
  const cutoff = new Date(now.getTime() - LOST_JOB_AFTER_MS);
  const liveJob = ctx.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.workspace_id, workspace.id),
        // The send job's own key (`sendJobKey`) for each message.
        eq(jobs.singleton_key, sql`${sendJobKey("")}::text || ${messages.id}`),
        inArray(jobs.status, [...LIVE_JOB_STATES]),
      ),
    );
  const rows = await ctx.db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, workspace.id),
        eq(messages.channel, "email"),
        eq(messages.direction, "outbound"),
        eq(messages.status, "scheduled"),
        lt(messages.scheduled_for, cutoff),
        notExists(liveJob),
      ),
    )
    .orderBy(asc(messages.scheduled_for))
    .limit(MAX_PER_RUN);
  for (const row of rows) {
    await ctx.jobs.enqueue(
      SEND_JOB,
      { message_id: row.id },
      { workspaceId: workspace.id, runAt: now, singletonKey: sendJobKey(row.id) },
    );
  }
  if (rows.length > 0) {
    ctx.log.warn(
      { count: rows.length },
      "email: scheduled emails had lost their send job; they are queued again",
    );
  }
  return rows.length;
}

/** Messages stuck in `sending` with no live job: the attempt died mid-send. */
async function sweepStuckSends(ctx: JobContext, workspace: Workspace): Promise<number> {
  const cutoff = new Date(ctx.clock.now().getTime() - STUCK_SENDING_MS);
  const rows = await ctx.db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, workspace.id),
        eq(messages.direction, "outbound"),
        eq(messages.status, "sending"),
        sql`coalesce(${messages.dispatch_started_at}, ${messages.updated_at}) < ${cutoff.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(messages.updated_at))
    .limit(MAX_PER_RUN);
  let swept = 0;
  for (const row of rows) {
    const key = row.channel === "email" ? sendJobKey(row.id) : `linkedin.action:${row.id}`;
    const [live] = await ctx.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.singleton_key, key), inArray(jobs.status, [...LIVE_JOB_STATES])))
      .limit(1);
    // A job that is still running (or will run) settles the message itself.
    if (live) continue;
    if (row.channel === "email") await markEmailInterrupted(ctx, workspace, row);
    else if ((await markLinkedInInterrupted(ctx, row, INTERRUPTED_REASON)) === "retried") {
      // A visit or like back in the queue (done at least once): no job is left to run it.
      await enqueueAction(ctx, row.id, ctx.clock.now());
    }
    swept += 1;
  }
  return swept;
}

async function reconcileEmail(
  ctx: JobContext,
  workspace: Workspace,
): Promise<EmailReconcileSummary> {
  const summary: EmailReconcileSummary = {
    checked: 0,
    confirmed: 0,
    resent: 0,
    problems: 0,
    pending: 0,
    errors: 0,
  };
  const tally: Tally = (outcome) => {
    summary.checked += 1;
    summary[outcome] += 1;
  };
  const lateSince = new Date(ctx.clock.now().getTime() - LATE_COPY_MS);
  const rows = await ctx.db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, workspace.id),
        eq(messages.channel, "email"),
        eq(messages.direction, "outbound"),
        or(
          and(
            eq(messages.status, "unknown"),
            or(
              lt(messages.reconcile_checks, RECONCILE_CHECKS),
              sql`coalesce(${messages.dispatch_started_at}, ${messages.updated_at}) >= ${lateSince.toISOString()}::timestamptz`,
            ),
          ),
          // A resend still in the queue: a late copy of the earlier try drops it.
          and(
            eq(messages.status, "scheduled"),
            sql`${messages.why} ->> 'resent_after_unknown' is not null`,
            sql`coalesce(${messages.dispatch_started_at}, ${messages.updated_at}) >= ${lateSince.toISOString()}::timestamptz`,
          ),
        ),
      ),
    )
    // Undecided messages first, then the oldest.
    .orderBy(asc(messages.reconcile_checks), asc(messages.updated_at))
    .limit(MAX_PER_RUN);
  const byMailbox = new Map<string, Message[]>();
  for (const row of rows) {
    const key = row.mailbox_id ?? "";
    byMailbox.set(key, [...(byMailbox.get(key) ?? []), row]);
  }
  for (const [mailboxId, group] of byMailbox) {
    const [mailbox] = mailboxId
      ? await ctx.db
          .select()
          .from(mailboxes)
          .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.workspace_id, workspace.id)))
          .limit(1)
      : [];
    await reconcileMailbox(ctx, workspace, mailbox ?? null, group, tally);
  }
  return summary;
}

async function reconcileMailbox(
  ctx: JobContext,
  workspace: Workspace,
  mailbox: Mailbox | null,
  group: Message[],
  tally: Tally,
): Promise<void> {
  if (!mailbox || !canSearchSentCopies(workspace, mailbox)) {
    // Nothing can be looked up: undecided ones go to a person, decided ones are left alone.
    for (const message of group) {
      if (message.status !== "unknown" || message.reconcile_checks >= RECONCILE_CHECKS) continue;
      const asked = await escalateIfUnsearchable(
        ctx,
        workspace,
        message.id,
        mailbox,
        "the send had no clear answer",
      );
      tally(asked ? "problems" : "pending");
    }
    return;
  }
  if (usesSandboxTransport(workspace, mailbox)) {
    const outbox = getSandboxOutbox({ workspaceId: workspace.id, mailboxId: mailbox.id });
    for (const message of group) {
      const found = outbox.some((entry) => entry.email.messageId === message.message_id_header);
      tally(await settle(ctx, { workspace, mailbox, message, found, keepsCopies: true }));
    }
    return;
  }

  let client: ImapFlow | null = null;
  try {
    const auth = await mailAuth(ctx, mailbox, "imap");
    if (!mailbox.imap?.host) throw new Error("no IMAP server");
    client = createImapClient({
      host: mailbox.imap.host,
      port: mailbox.imap.port,
      secure: mailbox.imap.secure,
      auth,
    });
    await client.connect();
  } catch (error) {
    client?.close();
    await cannotSearch(ctx, mailbox, group, errorText(error), false, tally);
    return;
  }
  let done = 0;
  try {
    const path = findSentFolder(await client.list());
    if (!path) {
      await cannotSearch(ctx, mailbox, group, "it has no Sent folder", true, tally);
      done = group.length;
      return;
    }
    const lock = await client.getMailboxLock(path, { readOnly: true });
    try {
      for (const message of group) {
        if (!message.message_id_header) {
          // Nothing to look for: a person decides.
          await cannotSearch(ctx, mailbox, [message], "the email has no Message-ID", true, tally);
        } else {
          const found = await client.search(
            { header: { "message-id": message.message_id_header } },
            { uid: true },
          );
          const inSent = Array.isArray(found) && found.length > 0;
          const keepsCopies = savesSentCopies(mailbox);
          tally(await settle(ctx, { workspace, mailbox, message, found: inSent, keepsCopies }));
        }
        done += 1;
      }
    } finally {
      lock.release();
    }
  } catch (error) {
    for (let i = done; i < group.length; i++) tally("errors");
    ctx.log.warn(
      { mailbox_id: mailbox.id, err: errorText(error) },
      "email: the Sent folder could not be searched for sends with an unknown outcome",
    );
  } finally {
    await client.logout().catch(() => client?.close());
  }
}

/**
 * The Sent folder cannot be searched: a person is asked at once when that will not change (no
 * Sent folder, no Message-ID), else once the email has been unknown for a grace period.
 */
async function cannotSearch(
  ctx: JobContext,
  mailbox: Mailbox,
  group: Message[],
  why: string,
  atOnce: boolean,
  tally: Tally,
): Promise<void> {
  const now = ctx.clock.now().getTime();
  for (const message of group) {
    if (message.status !== "unknown" || message.reconcile_checks >= RECONCILE_CHECKS) continue;
    const since = (message.dispatch_started_at ?? message.updated_at).getTime();
    if (!atOnce && now - since < OPEN_FAILURE_GRACE_MS) {
      tally("pending");
      continue;
    }
    await openEmailUnknownProblem(
      ctx,
      message,
      mailbox.email,
      `the engine could not check the Sent folder of ${mailbox.email}: ${why.slice(0, 200)}`,
    );
    await stopReconciling(ctx, message.id);
    tally("problems");
  }
}

/** Applies one lookup: found means sent; the third miss decides between one resend and a person. */
async function settle(
  ctx: JobContext,
  input: {
    workspace: Workspace;
    mailbox: Mailbox;
    message: Message;
    found: boolean;
    /** Whether the server is proven to keep a copy of what it sends (null: not proven). */
    keepsCopies: boolean | null;
  },
): Promise<Outcome> {
  const { workspace, mailbox, message } = input;
  if (input.found) {
    const confirmed = await confirmEmailSent(ctx, message.id, {
      resolution: `Found in the Sent folder of ${mailbox.email}.`,
      learnedCopy: !usesSandboxTransport(workspace, mailbox),
    });
    return confirmed ? "confirmed" : "pending";
  }
  // Already decided, or queued again: only a late copy could still change it.
  if (message.status !== "unknown" || message.reconcile_checks >= RECONCILE_CHECKS) {
    return "pending";
  }
  const checks = await countReconcileCheck(ctx, message.id);
  if (checks < RECONCILE_CHECKS) return "pending";
  const resentBefore = wasResentAfterUnknown(message);
  if (!resentBefore && input.keepsCopies === true) {
    const note = `no copy in the Sent folder of ${mailbox.email} after ${RECONCILE_CHECKS} lookups`;
    // It goes out again when its mailbox may send: in the send window, within the daily cap.
    const at = await planEmailResend(ctx, workspace, message);
    if (!(await rescheduleUnknown(ctx, message, note, at))) return "pending";
    await ctx.jobs.enqueue(
      SEND_JOB,
      { message_id: message.id },
      { workspaceId: message.workspace_id, runAt: at, singletonKey: sendJobKey(message.id) },
    );
    ctx.log.info(
      { message_id: message.id, mailbox_id: mailbox.id },
      "email: a send with an unknown outcome never reached the Sent folder; sending it again once",
    );
    return "resent";
  }
  await openEmailUnknownProblem(
    ctx,
    message,
    mailbox.email,
    resentBefore
      ? "it is not in the Sent folder, even after it was sent again once"
      : input.keepsCopies === false
        ? "it is not in the Sent folder, and this server never keeps a copy of what it relays, so a missing copy proves nothing"
        : "it is not in the Sent folder, but this mailbox is not proven to keep a copy of what it sends (no copy of an earlier email was found there yet), so a missing copy proves nothing",
  );
  return "problems";
}

function errorText(error: unknown): string {
  return String((error as Error)?.message ?? error).slice(0, 300);
}
