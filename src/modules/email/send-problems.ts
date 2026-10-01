/**
 * Outage and failure problems of the senders (attention queue items), shared by email and
 * LinkedIn (linkedin/send-problems.ts has the account side):
 * - `mailbox_down` (high, for a person): a mailbox or a LinkedIn account stopped sending
 *   because of an error: a refused login, a lost connection, a provider block, a pause for its
 *   bounce rate or a failure streak, a LinkedIn restriction. Never for a pause a person made.
 *   One per sender (`mailbox_down:<mailbox_id or linkedin_account_id>`), resolved by the
 *   operation or job that makes it send again (resume, a clean test, a reconnect, the end of a
 *   timed pause) or when it is removed.
 * - `send_failed` (normal, for anyone): engine messages that failed for good, grouped by
 *   campaign (or thread) and cause (`send_failed:<campaign_id or thread_id>:<class>`) with the
 *   count and the latest message: a bad recipient address, no subject or text, template
 *   variables with no value, a refusal by the mail server or LinkedIn, temporary errors until
 *   the retries ran out, text too long. Bounces, skips (the person may not be contacted) and
 *   cancels never open one.
 * Opening or resolving a problem never breaks the caller: errors are logged.
 */
import { and, eq, ne } from "drizzle-orm";
import type { OpContext } from "../../core/context.js";
import type { Channel } from "../../core/enums.js";
import {
  campaigns,
  type Mailbox,
  type Message,
  mailboxes,
  people,
  problems,
  workspaces,
} from "../../db/schema/index.js";
import { openProblem, resolveProblemsFor } from "../problems/service.js";

/** Dedupe key of a sender's `mailbox_down` problem (a mailbox or a LinkedIn account). */
export function senderDownKey(senderId: string): string {
  return `mailbox_down:${senderId}`;
}

/** The sender a `mailbox_down` problem is about. */
export interface DownSender {
  id: string;
  workspace_id: string;
  type: "mailbox" | "linkedin_account";
}

/** Plain words of a problem. */
export interface ProblemText {
  title: string;
  reason: string;
  remedy: string;
}

/** The context scoped to a workspace (problems are stored in the sender's workspace). */
async function scopedTo(ctx: OpContext, workspaceId: string): Promise<OpContext | null> {
  if (ctx.workspace?.id === workspaceId) return ctx;
  const [workspace] = await ctx.db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return workspace ? { ...ctx, workspace } : null;
}

/** Opens or refreshes the sender's `mailbox_down` problem (high, for a person). */
export async function openSenderDown(
  ctx: OpContext,
  sender: DownSender,
  text: ProblemText,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const scoped = await scopedTo(ctx, sender.workspace_id);
    if (!scoped) return;
    await openProblem(scoped, {
      kind: "mailbox_down",
      severity: "high",
      owner: "person",
      ...text,
      subject: { type: sender.type, id: sender.id },
      data,
      dedupeKey: senderDownKey(sender.id),
    });
  } catch (error) {
    ctx.log.warn({ err: String(error), sender_id: sender.id }, "could not open mailbox_down");
  }
}

/** Resolves the sender's `mailbox_down` problem, if one is open. */
export async function resolveSenderDown(
  ctx: OpContext,
  sender: Pick<DownSender, "id" | "workspace_id">,
  resolution: string,
): Promise<void> {
  try {
    const scoped = await scopedTo(ctx, sender.workspace_id);
    if (!scoped) return;
    await resolveProblemsFor(scoped, { dedupeKey: senderDownKey(sender.id) }, resolution);
  } catch (error) {
    ctx.log.warn({ err: String(error), sender_id: sender.id }, "could not resolve mailbox_down");
  }
}

/** Why a mailbox does not send, when an error stopped it (not a person's pause). */
export type MailboxDownCause =
  | "error"
  | "disconnected"
  | "bounce_rate"
  | "provider_block"
  | "failures";

export function mailboxDownCause(
  mailbox: Pick<Mailbox, "status" | "health">,
): MailboxDownCause | null {
  if (mailbox.status === "error" || mailbox.status === "disconnected") return mailbox.status;
  if (mailbox.status === "paused") return mailbox.health?.auto_pause?.kind ?? null;
  return null;
}

const clip = (text: string | null | undefined, max = 300) =>
  (text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/, "")
    .slice(0, max);

/** The words of a mailbox's `mailbox_down` problem. */
export function mailboxDownText(mailbox: Mailbox, cause: MailboxDownCause): ProblemText {
  const id = `(mailbox_id ${mailbox.id})`;
  const stored = clip(mailbox.status_reason ?? mailbox.health?.last_error) || null;
  const test = `check it with manage_mailboxes action test ${id}`;
  const resume = `resume it with manage_mailboxes action resume ${id}`;
  const queued =
    "Its queued emails move to the campaign's other mailboxes when they come due; replies and emails no other mailbox can take wait until it sends again.";
  const title = `Mailbox ${mailbox.email} stopped sending`;
  switch (cause) {
    case "error": {
      const oauth = mailbox.auth_type === "oauth_google" || mailbox.auth_type === "oauth_microsoft";
      return {
        title,
        reason: `It is in error: ${stored ?? "the login failed"}. ${queued}`,
        remedy: oauth
          ? `Reconnect it with manage_mailboxes action oauth_start (email ${mailbox.email}), then ${test}; a clean test makes it send again.`
          : `Fix the password (password_env) or the server settings with manage_mailboxes action update ${id}, then ${test}; a clean test makes it send again.`,
      };
    }
    case "disconnected":
      return {
        title,
        reason: `It is disconnected${stored ? `: ${stored}` : ""}. ${queued}`,
        remedy: `Reconnect it with manage_mailboxes action oauth_start (email ${mailbox.email}) or update ${id}, then ${test}.`,
      };
    case "bounce_rate":
      return {
        title,
        reason: `It is paused for its bounce rate${stored ? `: ${stored}` : ""}. Its queued emails wait for the resume.`,
        remedy: `Re-verify the list the bounces came from (enrich_leads action verify), then ${resume} and restart_ramp true.`,
      };
    case "provider_block": {
      const until = mailbox.health?.auto_pause?.until;
      return {
        title,
        reason: `It is paused after a provider block${stored ? `: ${stored}` : ""}. Its queued emails wait for the resume.`,
        remedy: until
          ? `It sends again by itself when the pause ends (${until}); cut volume and review targeting and copy meanwhile. To send earlier, ${resume}.`
          : `Check SPF, DKIM and DMARC with manage_mailboxes action check_dns ${id}, fix them, then ${resume}.`,
      };
    }
    case "failures":
      return {
        title,
        reason: `It is paused after repeated send failures${stored ? `: ${stored}` : ""}. ${queued}`,
        remedy: `Find the cause (${test}), then ${resume}.`,
      };
  }
}

/**
 * Opens (or refreshes) `mailbox_down` when the mailbox, read fresh, stopped sending because of
 * an error (see `mailboxDownCause`); a mailbox a person paused opens nothing.
 */
export async function openMailboxDown(ctx: OpContext, mailboxId: string): Promise<void> {
  try {
    const [mailbox] = await ctx.db
      .select()
      .from(mailboxes)
      .where(eq(mailboxes.id, mailboxId))
      .limit(1);
    if (!mailbox) return;
    const cause = mailboxDownCause(mailbox);
    if (!cause) return;
    await openSenderDown(
      ctx,
      { id: mailbox.id, workspace_id: mailbox.workspace_id, type: "mailbox" },
      mailboxDownText(mailbox, cause),
      {
        mailbox_id: mailbox.id,
        email: mailbox.email,
        status: mailbox.status,
        cause,
        error: mailbox.status_reason ?? mailbox.health?.last_error ?? null,
      },
    );
  } catch (error) {
    ctx.log.warn({ err: String(error), mailbox_id: mailboxId }, "could not open mailbox_down");
  }
}

/** Resolves the mailbox's `mailbox_down` problem (it sends again, or it was removed). */
export async function resolveMailboxDown(
  ctx: OpContext,
  mailbox: Pick<Mailbox, "id" | "workspace_id">,
  resolution: string,
): Promise<void> {
  await resolveSenderDown(ctx, mailbox, resolution);
}

// --- send_failed ----------------------------------------------------------------------------

/** The cause of a failed send, the second half of the `send_failed` key. */
export type SendFailureClass =
  | "bad_recipient"
  | "empty_content"
  | "template_variables"
  | "rejected"
  | "retries_used_up"
  | "too_long"
  | "invalid";

/** Start of the error an email stores when every try failed with a temporary error. */
export const RETRIES_USED_UP_PREFIX = "Temporary errors until the retries ran out";

/**
 * The cause of a message that failed for good (from the error the sender stored), or null when
 * nothing about the message can be fixed (the person or the account is gone).
 */
export function sendFailureClass(channel: Channel, error: string): SendFailureClass | null {
  const text = error.trim();
  if (channel === "email") {
    if (text === "No recipient address." || text.startsWith("The recipient must be exactly one")) {
      return "bad_recipient";
    }
    if (text === "The message has no subject." || text === "The message body is empty.") {
      return "empty_content";
    }
    if (text.startsWith("Unresolved template variables")) return "template_variables";
    if (text.startsWith(RETRIES_USED_UP_PREFIX)) return "retries_used_up";
    return text ? "rejected" : null;
  }
  if (text.startsWith("note_too_long") || text.startsWith("comment_too_long")) return "too_long";
  if (text === "empty_message" || text === "empty_comment") return "empty_content";
  if (text.startsWith("provider_error")) return "rejected";
  if (text.startsWith("unsupported_action") || text === "missing_account") return "invalid";
  return null;
}

/** Dedupe key of a `send_failed` problem. */
export function sendFailedKey(group: string, failure: SendFailureClass): string {
  return `send_failed:${group}:${failure}`;
}

function failureWords(failure: SendFailureClass, channel: Channel): string {
  switch (failure) {
    case "bad_recipient":
      return "no valid recipient address";
    case "empty_content":
      return "no subject or text";
    case "template_variables":
      return "template variables with no value";
    case "rejected":
      return channel === "email" ? "refused by the mail server" : "refused by LinkedIn";
    case "retries_used_up":
      return "temporary errors until the retries ran out";
    case "too_long":
      return "text too long";
    case "invalid":
      return "an action LinkedIn cannot run";
  }
}

function failureRemedy(
  failure: SendFailureClass,
  refs: { campaignId: string | null; threadId: string | null; personId: string | null },
  messageId: string,
): string {
  const see = `see the failed message with manage_messages action get (message_id ${messageId})`;
  const fixStep = refs.campaignId
    ? `create_campaign action update (campaign_id ${refs.campaignId})`
    : null;
  const again = refs.threadId
    ? `write the answer again with reply_to_thread action send (thread_id ${refs.threadId})`
    : "write it again";
  switch (failure) {
    case "bad_recipient":
      return `Fix the address with manage_leads action update${refs.personId ? ` (person_id ${refs.personId})` : ""} or find a new one with enrich_leads action enrich; ${see}.`;
    case "template_variables":
      return fixStep
        ? `Add fallbacks like {{first_name|there}} to the step with ${fixStep}, or fill the missing lead fields with manage_leads action update; ${see}.`
        : `Remove the variables or add fallbacks like {{first_name|there}}, then ${again}; ${see}.`;
    case "empty_content":
    case "too_long":
      return fixStep
        ? `Fix the step's text with ${fixStep}; ${see}.`
        : `Fix the text, then ${again}; ${see}.`;
    case "rejected":
      return fixStep
        ? `Read the refusal (${see}); if the content was refused, change the step with ${fixStep}.`
        : `Read the refusal (${see}), then ${again} if it should still go.`;
    case "retries_used_up":
      return fixStep
        ? `Read the last error (${see}) and check the sending mailbox with manage_mailboxes action test; the sequence tries the step again by itself.`
        : `Read the last error (${see}) and check the sending mailbox with manage_mailboxes action test, then ${again} if it should still go.`;
    case "invalid":
      return fixStep
        ? `Check the step and its LinkedIn senders with ${fixStep}; ${see}.`
        : `Check the message; ${see}.`;
  }
}

interface SendFailedData {
  count?: number;
  message_ids?: string[];
  step_ids?: string[];
}

/**
 * Records an engine message that failed for good (not retryable): opens or updates the
 * `send_failed` problem of its campaign (or thread) and cause, with the count and the latest
 * message. Errors that name nothing to fix in the message (the person or the account is gone)
 * open nothing; bounces, skips and cancels never come here.
 */
export async function recordSendFailed(
  ctx: OpContext,
  message: Pick<
    Message,
    "id" | "workspace_id" | "channel" | "campaign_id" | "thread_id" | "step_id" | "person_id"
  >,
  error: string,
): Promise<void> {
  const failure = sendFailureClass(message.channel, error);
  if (!failure) return;
  try {
    const scoped = await scopedTo(ctx, message.workspace_id);
    if (!scoped) return;
    const group = message.campaign_id ?? message.thread_id ?? message.id;
    const key = sendFailedKey(group, failure);
    const [existing] = await ctx.db
      .select({ data: problems.data })
      .from(problems)
      .where(
        and(
          eq(problems.workspace_id, message.workspace_id),
          eq(problems.dedupe_key, key),
          ne(problems.status, "resolved"),
        ),
      )
      .limit(1);
    const previous = (existing?.data ?? {}) as SendFailedData;
    const seen = previous.message_ids ?? [];
    const count = (previous.count ?? 0) + (seen.includes(message.id) ? 0 : 1);
    const messageIds = [...seen.filter((id) => id !== message.id), message.id].slice(-20);
    const stepIds = [
      ...new Set([...(previous.step_ids ?? []), ...(message.step_id ? [message.step_id] : [])]),
    ];
    const [campaign] = message.campaign_id
      ? await ctx.db
          .select({ name: campaigns.name })
          .from(campaigns)
          .where(eq(campaigns.id, message.campaign_id))
          .limit(1)
      : [];
    const [person] = message.person_id
      ? await ctx.db
          .select({ full_name: people.full_name, email: people.email })
          .from(people)
          .where(eq(people.id, message.person_id))
          .limit(1)
      : [];
    const who = person?.full_name?.trim() || person?.email || null;
    const words = failureWords(failure, message.channel);
    const where = message.campaign_id
      ? `campaign ${campaign?.name ?? message.campaign_id}`
      : message.thread_id
        ? `the conversation with ${who ?? "this person"}`
        : null;
    const detail = clip(error, 300);
    await openProblem(scoped, {
      kind: "send_failed",
      severity: "normal",
      owner: "anyone",
      title: where ? `Sends fail in ${where}: ${words}` : `A send failed: ${words}`,
      reason: `${count} ${count === 1 ? "message" : "messages"}${where ? ` in ${where}` : ""} failed for good and will not be sent (${words}). Latest: message ${message.id}${who ? ` to ${who}` : ""}: ${detail}.`,
      remedy: failureRemedy(
        failure,
        {
          campaignId: message.campaign_id,
          threadId: message.thread_id,
          personId: message.person_id,
        },
        message.id,
      ),
      subject: message.campaign_id
        ? { type: "campaign", id: message.campaign_id }
        : message.thread_id
          ? { type: "thread", id: message.thread_id }
          : { type: "message", id: message.id },
      personId: message.campaign_id ? null : message.person_id,
      data: {
        channel: message.channel,
        class: failure,
        count,
        latest_message_id: message.id,
        latest_error: detail,
        message_ids: messageIds,
        step_ids: stepIds,
      },
      dedupeKey: key,
    });
  } catch (err) {
    ctx.log.warn({ err: String(err), message_id: message.id }, "could not record send_failed");
  }
}
