import { and, eq, inArray, sql } from "drizzle-orm";
import { callFailure } from "../../core/call-failure.js";
import type { OpContext } from "../../core/context.js";
import type { Failure } from "../../core/failures.js";
import {
  type Mailbox,
  mailboxes,
  type SenderAutoPause,
  type SenderHealth,
} from "../../db/schema/index.js";
import { notify } from "../../runtime/notify.js";
import { openProblem, resolveProblemsFor } from "../problems/service.js";
import { sendingStatus } from "./capacity.js";
import { mailboxActiveKey } from "./queue.js";
import { openMailboxDown, resolveMailboxDown, senderDownKey } from "./send-problems.js";
import { isValidTimeZone, localDate, startOfNextDay } from "./timezone.js";

/** Auto-pause after this many send failures in a row (playbook: deliverability 8). */
export const MAX_CONSECUTIVE_FAILURES = 5;
/** Gmail's unsolicited-rate blocks (421 4.7.28, 550 5.7.28) pause the whole domain this long. */
export const RATE_BLOCK_PAUSE_MS = 48 * 3_600_000;
/** Paused mail re-checks its mailbox at least this often. */
const PAUSE_RECHECK_MS = 6 * 3_600_000;
/** Mail held on a mailbox in error or disconnected re-checks it at least this often. */
const DOWN_RECHECK_MS = 24 * 3_600_000;

async function safeNotify(ctx: OpContext, input: Parameters<typeof notify>[1]): Promise<void> {
  try {
    await notify(ctx, input);
  } catch (error) {
    ctx.log.warn({ err: String(error) }, "email: notification failed");
  }
}

/**
 * Pauses a mailbox (no new sends; replies keep syncing), emits `mailbox.paused` and notifies
 * (skip the notification for pauses a person asked for).
 */
export async function pauseMailbox(
  ctx: OpContext,
  mailbox: Mailbox,
  reason: string,
  options: { notify?: boolean } = {},
): Promise<boolean> {
  const [updated] = await ctx.db
    .update(mailboxes)
    .set({ status: "paused", status_reason: reason })
    .where(and(eq(mailboxes.id, mailbox.id), sql`${mailboxes.status} <> 'paused'`))
    .returning({ id: mailboxes.id });
  if (!updated) return false;
  await ctx.events.emit("mailbox.paused", {
    workspaceId: mailbox.workspace_id,
    subject: { type: "mailbox", id: mailbox.id },
    data: { mailbox_id: mailbox.id, email: mailbox.email, reason },
  });
  if (options.notify === false) return true;
  await safeNotify(ctx, {
    title: `Mailbox ${mailbox.email} was paused`,
    lines: [reason, "Fix the cause, then resume it with manage_mailboxes action resume."],
    severity: "warning",
    event: "mailbox.paused",
  });
  return true;
}

const PAUSE_RANK: Record<SenderAutoPause["kind"], number> = {
  failures: 0,
  bounce_rate: 1,
  provider_block: 2,
};

/**
 * True when the engine paused the mailbox for its reputation or its list (bounce rate, provider
 * block): its queued mail waits for the resume, because moving it to other mailboxes would route
 * around the pause. Mailboxes paused by a person, failing to connect or in error let mail move.
 */
export function holdsQueuedMail(mailbox: Pick<Mailbox, "status" | "health">): boolean {
  const pause = mailbox.status === "paused" ? mailbox.health?.auto_pause : null;
  return Boolean(pause && PAUSE_RANK[pause.kind] >= PAUSE_RANK.bounce_rate);
}

/** When mail waiting on a paused mailbox should look again: the timed end, at most 6 hours. */
export function pauseRecheckAt(mailbox: Pick<Mailbox, "health">, now: Date): Date {
  const recheck = now.getTime() + PAUSE_RECHECK_MS;
  const until = mailbox.health?.auto_pause?.until;
  const end = until ? new Date(until).getTime() : Number.NaN;
  return new Date(Number.isFinite(end) && end > now.getTime() ? Math.min(end, recheck) : recheck);
}

/**
 * When mail held on a mailbox that cannot send looks again (a resume, a clean test or a
 * reconnect wakes it sooner): `pauseRecheckAt` while it is paused, a day while it is in error
 * or disconnected.
 */
export function heldRecheckAt(mailbox: Pick<Mailbox, "status" | "health">, now: Date): Date {
  if (mailbox.status === "paused") return pauseRecheckAt(mailbox, now);
  return new Date(now.getTime() + DOWN_RECHECK_MS);
}

/**
 * The pause record after a new auto-pause: the strictest kind wins, and a pause without an end
 * (or one a person set: `previous` null on a paused mailbox) never becomes a timed one.
 */
export function mergeAutoPause(
  previous: SenderAutoPause | null | undefined,
  alreadyPaused: boolean,
  next: SenderAutoPause,
): SenderAutoPause {
  if (!alreadyPaused) return next;
  if (!previous) return { ...next, until: null };
  const kind = PAUSE_RANK[next.kind] >= PAUSE_RANK[previous.kind] ? next.kind : previous.kind;
  const until =
    previous.until && next.until
      ? new Date(Math.max(Date.parse(previous.until), Date.parse(next.until))).toISOString()
      : null;
  return {
    kind,
    at: previous.at,
    status: next.status ?? previous.status ?? null,
    domain: next.domain ?? previous.domain ?? null,
    until,
  };
}

/**
 * Pauses a mailbox for a health reason and records why in `health.auto_pause` (see
 * `holdsQueuedMail`). A mailbox that is already paused stays paused; the record is merged
 * (`mergeAutoPause`) and, unless the new pause is milder, its reason replaces the old one.
 * `reason` may depend on the final record (timed or not). Opens (or refreshes) the mailbox's
 * `mailbox_down` problem. True when the status changed.
 */
export async function autoPauseMailbox(
  ctx: OpContext,
  mailbox: Mailbox,
  reason: string | ((pause: SenderAutoPause) => string),
  pause: Omit<SenderAutoPause, "at">,
  options: { notify?: boolean } = {},
): Promise<boolean> {
  const next: SenderAutoPause = {
    status: null,
    domain: null,
    until: null,
    ...pause,
    at: ctx.clock.now().toISOString(),
  };
  const text = (record: SenderAutoPause) => (typeof reason === "string" ? reason : reason(record));
  const changed = await pauseMailbox(ctx, mailbox, text(next), options);
  const [current] = await ctx.db
    .select({ health: mailboxes.health })
    .from(mailboxes)
    .where(eq(mailboxes.id, mailbox.id))
    .limit(1);
  if (!current) return changed;
  const previous = changed ? null : (current.health?.auto_pause ?? null);
  const merged = mergeAutoPause(previous, !changed, next);
  const replaceReason =
    !changed && (!previous || PAUSE_RANK[next.kind] >= PAUSE_RANK[previous.kind]);
  await ctx.db
    .update(mailboxes)
    .set({
      ...(replaceReason ? { status_reason: text(merged) } : {}),
      health: sql`${mailboxes.health} || ${JSON.stringify({ auto_pause: merged })}::jsonb`,
    })
    .where(eq(mailboxes.id, mailbox.id));
  await openMailboxDown(ctx, mailbox.id);
  return changed;
}

/** x.7.28: Gmail's unsolicited-mail rate block (4.7.28 temporary, 5.7.28 permanent). */
export function isRateBlock(status: string | null | undefined): boolean {
  return /^[45]\.7\.28$/.test(status ?? "");
}

function providerBlockReason(
  domain: string,
  status: string,
  until: string | null | undefined,
): string {
  if (!isRateBlock(status)) {
    return `The provider rejected mail from ${domain} for failed sender authentication (${status}). Every mailbox on ${domain} is paused. Run manage_mailboxes action check_dns, fix SPF, DKIM and DMARC, then resume each mailbox.`;
  }
  const timing = until
    ? `is paused for 48 hours, until ${until}`
    : "is paused; this one stays paused until it is resumed";
  return `The provider refused mail from ${domain} as unsolicited (${status}). Every mailbox on ${domain} ${timing}. Cut volume by half and review targeting and copy before sending resumes.`;
}

/**
 * A provider rejected the sending domain: failed sender authentication (5.7.26 and the other
 * SPF, DKIM and DMARC codes) or Gmail's unsolicited-rate block (x.7.28). Both are about the
 * domain, so every mailbox of the workspace on it is paused, not only the one that got the
 * rejection: for 48 hours after x.7.28, until someone fixes DNS and resumes them otherwise.
 * Returns the emails of the mailboxes this call paused.
 */
export async function pauseSendingDomain(
  ctx: OpContext,
  mailbox: Mailbox,
  status: string,
  detail: string | null,
): Promise<string[]> {
  const domain = mailbox.email.slice(mailbox.email.lastIndexOf("@") + 1).toLowerCase();
  const now = ctx.clock.now();
  const until = isRateBlock(status)
    ? new Date(now.getTime() + RATE_BLOCK_PAUSE_MS).toISOString()
    : null;
  const rows = await ctx.db
    .select()
    .from(mailboxes)
    .where(
      and(
        eq(mailboxes.workspace_id, mailbox.workspace_id),
        sql`split_part(${mailboxes.email}, '@', 2) = ${domain}`,
        inArray(mailboxes.status, ["active", "warming", "paused", "error"]),
      ),
    );
  const paused: string[] = [];
  let news = false;
  for (const row of rows) {
    if (row.status !== "paused" || row.health?.auto_pause?.kind !== "provider_block") news = true;
    const changed = await autoPauseMailbox(
      ctx,
      row,
      (record) => providerBlockReason(domain, status, record.until),
      { kind: "provider_block", status, domain, until },
      { notify: false },
    );
    if (changed) paused.push(row.email);
  }
  if (news) {
    const response = detail?.replace(/\s+/g, " ").trim().slice(0, 300);
    await safeNotify(ctx, {
      title: `Sending domain ${domain} was paused`,
      lines: [
        providerBlockReason(domain, status, until),
        `Mailboxes: ${rows.map((row) => row.email).join(", ")}.`,
        ...(response ? [`Provider response: ${response}`] : []),
      ],
      severity: "critical",
      event: "mailbox.paused",
    });
  }
  return paused;
}

/** A person paused the mailbox: a timed auto-pause no longer ends by itself. */
export async function holdUntilResumed(ctx: OpContext, mailbox: Mailbox): Promise<void> {
  await ctx.db
    .update(mailboxes)
    .set({ health: sql`jsonb_set(${mailboxes.health}, '{auto_pause,until}', 'null'::jsonb)` })
    .where(
      and(
        eq(mailboxes.id, mailbox.id),
        eq(mailboxes.status, "paused"),
        sql`${mailboxes.health}->'auto_pause'->>'until' is not null`,
      ),
    );
}

/**
 * Ends timed auto-pauses whose time is up (x.7.28 domain blocks after 48 hours): the mailbox
 * sends again (warming while its ramp runs), mail waiting on it wakes up and its
 * `mailbox_down` problem is resolved.
 */
export async function endTimedPauses(
  ctx: OpContext,
  workspace: { id: string; timezone: string },
): Promise<Mailbox[]> {
  const now = ctx.clock.now();
  const rows = await ctx.db
    .select()
    .from(mailboxes)
    .where(
      and(
        eq(mailboxes.workspace_id, workspace.id),
        eq(mailboxes.status, "paused"),
        sql`${mailboxes.health}->'auto_pause'->>'until' is not null`,
      ),
    );
  const timezone = isValidTimeZone(workspace.timezone) ? workspace.timezone : "UTC";
  const today = localDate(now, timezone);
  const resumed: Mailbox[] = [];
  for (const mailbox of rows) {
    const until = Date.parse(mailbox.health?.auto_pause?.until ?? "");
    if (!Number.isFinite(until) || until > now.getTime()) continue;
    const status = sendingStatus(
      mailbox.daily_limit,
      mailbox.ramp,
      localDate(mailbox.created_at, timezone),
      today,
    );
    const [row] = await ctx.db
      .update(mailboxes)
      .set({
        status,
        status_reason: null,
        health: sql`${mailboxes.health} || ${JSON.stringify({ auto_pause: null, consecutive_failures: 0 })}::jsonb`,
      })
      .where(and(eq(mailboxes.id, mailbox.id), eq(mailboxes.status, "paused")))
      .returning();
    if (!row) continue;
    await ctx.jobs.wake(mailboxActiveKey(mailbox.id));
    await resolveMailboxDown(
      ctx,
      row,
      "Its timed pause after a provider block ended; it sends again.",
    );
    await safeNotify(ctx, {
      title: `Mailbox ${mailbox.email} sends again`,
      lines: [
        `Its 48-hour pause after a provider block (${mailbox.health?.auto_pause?.status ?? "x.7.28"}) ended.`,
        "Keep volume at half until reply and bounce numbers look normal again.",
      ],
      severity: "info",
    });
    resumed.push(row);
  }
  return resumed;
}

/**
 * Marks a mailbox `error` (cannot log in or misconfigured), emits `mailbox.error` once and
 * opens its `mailbox_down` problem.
 */
export async function markMailboxError(
  ctx: OpContext,
  mailbox: Mailbox,
  error: string,
): Promise<boolean> {
  const now = ctx.clock.now().toISOString();
  const [updated] = await ctx.db
    .update(mailboxes)
    .set({
      status: "error",
      status_reason: error.slice(0, 500),
      health: sql`${mailboxes.health} || ${JSON.stringify({ last_error: error.slice(0, 500), last_error_at: now })}::jsonb`,
    })
    .where(and(eq(mailboxes.id, mailbox.id), sql`${mailboxes.status} <> 'error'`))
    .returning({ id: mailboxes.id });
  if (!updated) return false;
  await ctx.events.emit("mailbox.error", {
    workspaceId: mailbox.workspace_id,
    subject: { type: "mailbox", id: mailbox.id },
    data: { mailbox_id: mailbox.id, email: mailbox.email, error: error.slice(0, 500) },
  });
  await safeNotify(ctx, {
    title: `Mailbox ${mailbox.email} cannot send`,
    lines: [error.slice(0, 300), "Check the credentials with manage_mailboxes action test."],
    severity: "critical",
    event: "mailbox.error",
  });
  await openMailboxDown(ctx, mailbox.id);
  return true;
}

/** Dedupe key of the `mailbox_down` problem of a mailbox that cannot read replies. */
export function mailboxReadDownKey(mailboxId: string): string {
  return `${senderDownKey(mailboxId)}:read`;
}

const TIMEOUT_TEXT = /ETIMEDOUT|ESOCKETTIMEDOUT|timed? ?out/i;
const NETWORK_TEXT = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH/;

/**
 * The failure of an IMAP sync or check: a refused login is `auth_invalid` (the account), other
 * problems are classified from the error (a timeout, a connection that failed), else
 * `unavailable`. `cause` may be the error or only its text.
 */
export function syncFailureOf(cause: unknown, loginFailed: boolean): Failure {
  if (loginFailed) {
    return { class: "auth_invalid", retryable: false, scope: "account", provider: "imap" };
  }
  if (typeof cause === "string") {
    if (TIMEOUT_TEXT.test(cause)) {
      return { class: "timeout", retryable: true, scope: "call", provider: "imap" };
    }
    if (NETWORK_TEXT.test(cause)) {
      return { class: "network", retryable: true, scope: "call", provider: "imap" };
    }
    return { class: "unavailable", retryable: true, scope: "call", provider: "imap" };
  }
  return callFailure(cause, "imap");
}

/**
 * Records an IMAP sync problem without touching the sending status (sending and reading replies
 * fail separately), with its failure class in `health.last_sync_failure`. The first failed
 * login of a streak notifies, and a refused login opens a `mailbox_down` problem for reading
 * at once: replies, bounces and unsubscribe replies to the mailbox go unread until it is fixed.
 * `cause` is the error (or its text) to classify.
 */
export async function recordSyncError(
  ctx: OpContext,
  mailbox: Mailbox,
  error: string,
  options: { loginFailed: boolean; cause?: unknown },
): Promise<void> {
  const now = ctx.clock.now().toISOString();
  const failure = syncFailureOf(options.cause ?? error, options.loginFailed);
  const [before] = await ctx.db
    .select({ health: mailboxes.health })
    .from(mailboxes)
    .where(eq(mailboxes.id, mailbox.id))
    .limit(1);
  const since = before?.health?.sync_error_since ?? null;
  await ctx.db
    .update(mailboxes)
    .set({
      health: sql`${mailboxes.health} || ${JSON.stringify({
        last_sync_error: error.slice(0, 500),
        last_sync_failure: failure,
        sync_error_since: since ?? now,
      })}::jsonb`,
    })
    .where(eq(mailboxes.id, mailbox.id));
  if (failure.class === "auth_invalid") await openReadDown(ctx, mailbox, error, failure);
  const knownLoginProblem = /login failed/i.test(before?.health?.last_sync_error ?? "");
  if (options.loginFailed && !knownLoginProblem) {
    await safeNotify(ctx, {
      title: `Mailbox ${mailbox.email} cannot read replies`,
      lines: [
        error.slice(0, 300),
        "Replies, bounces and unsubscribe replies to this mailbox are not being read. Fix the IMAP login (manage_mailboxes action test), sending is not affected.",
      ],
      severity: "critical",
    });
  }
}

/**
 * Clears the reply sync problem after a clean sync or IMAP check and closes the mailbox's
 * `mailbox_down` problem for reading. Not while a message the sync cannot store blocks a
 * folder (`health.stuck_message`): a clean login does not end that, a sync past it does.
 */
export async function recordSyncSuccess(
  ctx: OpContext,
  mailbox: Pick<Mailbox, "id" | "workspace_id">,
): Promise<void> {
  const [row] = await ctx.db
    .select({ health: mailboxes.health })
    .from(mailboxes)
    .where(eq(mailboxes.id, mailbox.id))
    .limit(1);
  if (row?.health?.stuck_message) return;
  await ctx.db
    .update(mailboxes)
    .set({
      health: sql`${mailboxes.health} || ${JSON.stringify({
        last_sync_error: null,
        last_sync_failure: null,
        sync_error_since: null,
      })}::jsonb`,
    })
    .where(eq(mailboxes.id, mailbox.id));
  await resolveReadDown(ctx, mailbox, "Replies are read again.");
}

/** Opens or refreshes the mailbox's `mailbox_down` problem for reading (never throws). */
async function openReadDown(ctx: OpContext, mailbox: Mailbox, error: string, failure: Failure) {
  if (ctx.workspace?.id !== mailbox.workspace_id) return;
  try {
    await openProblem(ctx, {
      kind: "mailbox_down",
      severity: "high",
      owner: "person",
      title: `Mailbox ${mailbox.email} cannot read replies`,
      reason: `The mail server refused the IMAP login (${error.replace(/\s+/g, " ").slice(0, 200)}). Replies, bounces and unsubscribe replies to this mailbox are not being read. Sending is not affected.`,
      remedy: `Fix the IMAP login (password, app password or the OAuth connection), then check it with manage_mailboxes action test (mailbox_id ${mailbox.id}). A clean test or sync closes this problem.`,
      subject: { type: "mailbox", id: mailbox.id },
      data: { mailbox_id: mailbox.id, email: mailbox.email, failure },
      dedupeKey: mailboxReadDownKey(mailbox.id),
    });
  } catch (cause) {
    ctx.log.warn({ err: String(cause), mailbox_id: mailbox.id }, "could not open mailbox_down");
  }
}

/** Resolves the mailbox's `mailbox_down` problem for reading, if one is open (never throws). */
export async function resolveReadDown(
  ctx: OpContext,
  mailbox: Pick<Mailbox, "id" | "workspace_id">,
  resolution: string,
): Promise<void> {
  if (ctx.workspace?.id !== mailbox.workspace_id) return;
  try {
    await resolveProblemsFor(ctx, { dedupeKey: mailboxReadDownKey(mailbox.id) }, resolution);
  } catch (cause) {
    ctx.log.warn({ err: String(cause), mailbox_id: mailbox.id }, "could not resolve mailbox_down");
  }
}

/** Resets the failure streak after a successful send. */
export async function recordSendSuccess(ctx: OpContext, mailboxId: string): Promise<void> {
  await ctx.db
    .update(mailboxes)
    .set({ health: sql`${mailboxes.health} || '{"consecutive_failures":0}'::jsonb` })
    .where(eq(mailboxes.id, mailboxId));
}

/** Counts a failed send; pauses the mailbox at MAX_CONSECUTIVE_FAILURES in a row. */
export async function recordSendFailure(
  ctx: OpContext,
  mailbox: Mailbox,
  error: string,
): Promise<number> {
  const now = ctx.clock.now().toISOString();
  const [row] = await ctx.db
    .update(mailboxes)
    .set({
      health: sql`${mailboxes.health} || jsonb_build_object(
        'consecutive_failures', coalesce((${mailboxes.health}->>'consecutive_failures')::int, 0) + 1,
        'last_error', ${error.slice(0, 500)}::text,
        'last_error_at', ${now}::text)`,
    })
    .where(eq(mailboxes.id, mailbox.id))
    .returning({ health: mailboxes.health });
  const failures = (row?.health as SenderHealth | undefined)?.consecutive_failures ?? 0;
  if (failures >= MAX_CONSECUTIVE_FAILURES) {
    await autoPauseMailbox(
      ctx,
      mailbox,
      `${failures} send failures in a row (last: ${error.slice(0, 200)}). Check credentials and provider status.`,
      { kind: "failures" },
    );
  }
  return failures;
}

/**
 * Stops a provider-throttled mailbox until the start of the next day in the workspace timezone:
 * planning skips it and its queued messages are re-planned when their send jobs run.
 */
export async function throttleMailbox(
  ctx: OpContext,
  mailbox: Mailbox,
  timezone: string,
  reason: string,
): Promise<Date> {
  const now = ctx.clock.now();
  const until = startOfNextDay(localDate(now, timezone), timezone);
  await ctx.db
    .update(mailboxes)
    .set({
      health: sql`${mailboxes.health} || ${JSON.stringify({
        throttled_until: until.toISOString(),
        last_error: reason.slice(0, 500),
        last_error_at: now.toISOString(),
      })}::jsonb`,
    })
    .where(eq(mailboxes.id, mailbox.id));
  ctx.log.warn(
    { mailbox_id: mailbox.id, until: until.toISOString() },
    "email: mailbox throttled by provider",
  );
  return until;
}

/** The time until which a mailbox is throttled, or null. */
export function throttledUntil(mailbox: Mailbox, now: Date): Date | null {
  const value = (mailbox.health as SenderHealth | null)?.throttled_until;
  if (!value) return null;
  const until = new Date(value);
  return Number.isNaN(until.getTime()) || until <= now ? null : until;
}
