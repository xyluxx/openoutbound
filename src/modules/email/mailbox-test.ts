import { eq, sql } from "drizzle-orm";
import type { OpContext } from "../../core/context.js";
import { isOpenOutboundError } from "../../core/errors.js";
import {
  type Mailbox,
  mailboxes,
  type SenderLoginTest,
  type Workspace,
} from "../../db/schema/index.js";
import { sendingStatus } from "./capacity.js";
import { isAuthFailure, mailAuth } from "./credentials.js";
import { isImapAuthError, verifyImap } from "./imap.js";
import { recordSyncError, recordSyncSuccess } from "./mailbox-state.js";
import { mailboxActiveKey } from "./queue.js";
import { openMailboxDown, resolveMailboxDown } from "./send-problems.js";
import { isValidTimeZone, localDate } from "./timezone.js";
import { transportFor, usesSandboxTransport } from "./transport.js";

export type CheckOutcome = "ok" | "failed" | "skipped";

export interface MailboxTestResult {
  smtp: CheckOutcome;
  imap: CheckOutcome;
  /** First problem found (never contains credentials). */
  error: string | null;
  /** The server refused the login (wrong password, revoked OAuth, basic auth disabled). */
  auth_failed: boolean;
}

function describe(error: unknown): string {
  if (isOpenOutboundError(error)) return error.message;
  const e = error as { response?: unknown; responseText?: unknown; message?: unknown };
  const text = [e?.response, e?.responseText, e?.message].find(
    (value) => typeof value === "string" && value.trim() !== "",
  );
  return String(text ?? error)
    .replace(/\s+/g, " ")
    .slice(0, 300);
}

function smtpAuthError(error: unknown): boolean {
  const e = error as { code?: unknown; responseCode?: unknown };
  return isAuthFailure(error) || e?.code === "EAUTH" || e?.responseCode === 535;
}

interface LoginChecks {
  result: MailboxTestResult;
  /** SMTP refused the login: the mailbox cannot send. */
  smtpAuthFailed: boolean;
  /** IMAP problem (recorded apart from the sending status). */
  imapError: string | null;
  imapAuthFailed: boolean;
}

async function checkLogins(
  ctx: OpContext,
  workspace: Workspace,
  mailbox: Mailbox,
): Promise<LoginChecks> {
  const result: MailboxTestResult = {
    smtp: "ok",
    imap: "skipped",
    error: null,
    auth_failed: false,
  };
  const checks: LoginChecks = {
    result,
    smtpAuthFailed: false,
    imapError: null,
    imapAuthFailed: false,
  };
  if (usesSandboxTransport(workspace, mailbox)) return checks;
  try {
    await (await transportFor(ctx, workspace, mailbox)).verify();
  } catch (error) {
    result.smtp = "failed";
    result.error = `SMTP: ${describe(error)}`;
    checks.smtpAuthFailed = smtpAuthError(error);
    result.auth_failed = checks.smtpAuthFailed;
  }
  if (mailbox.imap?.host) {
    try {
      await verifyImap({
        host: mailbox.imap.host,
        port: mailbox.imap.port,
        secure: mailbox.imap.secure,
        auth: await mailAuth(ctx, mailbox, "imap"),
      });
      result.imap = "ok";
    } catch (error) {
      result.imap = "failed";
      checks.imapError = describe(error);
      checks.imapAuthFailed = isImapAuthError(error) || isAuthFailure(error);
      result.error ??= `IMAP: ${checks.imapError}`;
      result.auth_failed ||= checks.imapAuthFailed;
    }
  }
  return checks;
}

/** Logs in to SMTP (and IMAP when configured) without sending anything. */
export async function testMailboxLogin(
  ctx: OpContext,
  workspace: Workspace,
  mailbox: Mailbox,
): Promise<MailboxTestResult> {
  return (await checkLogins(ctx, workspace, mailbox)).result;
}

/**
 * Tests a mailbox and records the outcome. Sending and reading are separate: a refused SMTP
 * login sets status `error` (with a `mailbox_down` problem), a clean SMTP login brings an
 * `error` or `disconnected` mailbox back, resolves it and wakes the emails held on it (paused
 * mailboxes stay paused); IMAP problems go to `health.last_sync_error` and never change the
 * status, like problems of the sync job.
 */
export async function testAndRecord(
  ctx: OpContext,
  workspace: Workspace,
  mailbox: Mailbox,
): Promise<{ result: MailboxTestResult; mailbox: Mailbox }> {
  const checks = await checkLogins(ctx, workspace, mailbox);
  const { result } = checks;
  if (checks.imapError) {
    await recordSyncError(
      ctx,
      mailbox,
      `IMAP ${checks.imapAuthFailed ? "login failed" : "check failed"}: ${checks.imapError}`,
      { loginFailed: checks.imapAuthFailed, cause: checks.imapError },
    );
  } else if (result.imap === "ok") {
    await recordSyncSuccess(ctx, mailbox);
  }
  // Kept so workspace readiness can tell a mailbox that passed its login test.
  const lastTest: SenderLoginTest = {
    at: ctx.clock.now().toISOString(),
    smtp: result.smtp,
    imap: result.imap,
  };
  await ctx.db
    .update(mailboxes)
    .set({
      health: sql`${mailboxes.health} || ${JSON.stringify({ last_test: lastTest })}::jsonb`,
    })
    .where(eq(mailboxes.id, mailbox.id));
  let patch: Partial<Pick<Mailbox, "status" | "status_reason">> | null = null;
  if (checks.smtpAuthFailed) {
    patch = { status: "error", status_reason: result.error };
  } else if (
    result.smtp === "ok" &&
    (mailbox.status === "error" || mailbox.status === "disconnected")
  ) {
    const timezone = isValidTimeZone(workspace.timezone) ? workspace.timezone : "UTC";
    const status = sendingStatus(
      mailbox.daily_limit,
      mailbox.ramp,
      localDate(mailbox.created_at, timezone),
      localDate(ctx.clock.now(), timezone),
    );
    patch = { status, status_reason: null };
  }
  const [row] = patch
    ? await ctx.db.update(mailboxes).set(patch).where(eq(mailboxes.id, mailbox.id)).returning()
    : await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, mailbox.id)).limit(1);
  if (patch?.status === "error") await openMailboxDown(ctx, mailbox.id);
  else if (patch) {
    await resolveMailboxDown(ctx, mailbox, "A clean login test; it sends again.");
    await ctx.jobs.wake(mailboxActiveKey(mailbox.id));
  }
  return { result, mailbox: row ?? mailbox };
}
