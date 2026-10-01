/**
 * LinkedIn actions with an unknown outcome (never send twice). An invite, message or comment
 * that may have reached LinkedIn without a clear answer (a timeout, a lost connection, a worker
 * that stopped mid-action) becomes `unknown` instead of being retried:
 * - invite: reconciled from the live profile. A pending invitation or a connection means it went
 *   out (sent); no invitation after three lookups means it did not, so it is sent again once.
 * - message: a `send_unknown` problem asks a person to check the conversation; when the provider
 *   can read recent chat messages, the same text sent by the account in the person's own
 *   conversation confirms it (never the text alone).
 * - comment: a `send_unknown` problem asks a person to check the post.
 * Visits and likes are harmless to repeat (at least once by design): one found mid-action is
 * tried again, up to MAX_REPEATABLE_ATTEMPTS.
 */
import { and, asc, eq, lt } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import type { MessageStatus } from "../../core/enums.js";
import {
  type LinkedInAccount,
  type Message,
  messages,
  type Person,
  people,
  threads,
  type Workspace,
} from "../../db/schema/index.js";
import type { LinkedInInboundMessage, LinkedInProfile } from "../../providers/types.js";
import { earlierAttemptWentOut, recordDuplicateSend } from "../email/duplicate-sends.js";
import {
  countReconcileCheck,
  failedWhy,
  markSendUnknown,
  openSendUnknownProblem,
  RECONCILE_CHECKS,
  rescheduleUnknown,
  stillHeld,
  stopReconciling,
  wasResentAfterUnknown,
} from "../email/unknown-sends.js";
import { errorText, findAccount, providerFor } from "./accounts.js";
import { accountSchedule } from "./capacity.js";
import { recordLinkedInSent } from "./record-sent.js";
import { findRelation } from "./relations.js";
import { enqueueAction, isLinkedInAction } from "./service.js";

/** Attempts of a visit or like before it fails for good: repeating them is harmless. */
export const MAX_REPEATABLE_ATTEMPTS = 3;

/** Actions that are never repeated blindly (they reach the prospect). */
export const UNKNOWN_ACTIONS: ReadonlySet<string> = new Set(["invite", "message", "comment"]);

const MAX_PER_RUN = 50;
/** Chat pages read when looking for a message's text. */
const MAX_CHAT_PAGES = 3;

const NOUN: Record<string, string> = {
  invite: "invitation",
  message: "message",
  comment: "comment",
};
const WHERE: Record<string, string> = {
  invite: "the person's LinkedIn profile (a sent invitation shows as Pending)",
  message: "the conversation on LinkedIn",
  comment: "the post's comments on LinkedIn",
};

async function loadPerson(ctx: OpContext, message: Message): Promise<Person | null> {
  if (!message.person_id) return null;
  const [person] = await ctx.db
    .select()
    .from(people)
    .where(and(eq(people.id, message.person_id), eq(people.workspace_id, message.workspace_id)))
    .limit(1);
  return person ?? null;
}

/** Opens (or refreshes) the `send_unknown` problem of a LinkedIn action. */
export async function openLinkedInUnknownProblem(
  ctx: OpContext,
  message: Message,
  detail: string,
): Promise<void> {
  const person = await loadPerson(ctx, message);
  const noun = NOUN[message.action] ?? "action";
  const to = person?.full_name ? ` to ${person.full_name}` : "";
  await openSendUnknownProblem(
    ctx,
    message,
    {
      title: `Check whether a LinkedIn ${noun} went out`,
      reason: `A LinkedIn ${noun}${to} may or may not have gone out: ${detail}. The engine will not send it again on its own.`,
      remedy: `Check ${WHERE[message.action] ?? "LinkedIn"} before sending again, then use manage_messages action resolve_unknown with outcome sent or resend (message_id ${message.id}).`,
    },
    { linkedin_account_id: message.linkedin_account_id, action: message.action },
  );
}

/**
 * Moves an uncertain LinkedIn action (only from `sending`, and only while `message.attempt` is
 * still the attempt that holds it) to `unknown`; messages and comments also open their problem
 * at once. False when the message had moved on already.
 */
export async function markLinkedInUnknown(
  ctx: OpContext,
  message: Message,
  reason: string,
): Promise<boolean> {
  const marked = await markSendUnknown(ctx, message, reason);
  if (marked && message.action !== "invite") await openLinkedInUnknownProblem(ctx, message, reason);
  return marked;
}

/**
 * Records an `unknown` LinkedIn action as sent (found on LinkedIn, or confirmed by a person):
 * the same bookkeeping as a normal send, and its problem is resolved. False (nothing changes)
 * for anything but an unknown LinkedIn action of the context workspace.
 */
export async function confirmLinkedInSent(
  ctx: OpContext,
  messageId: string,
  input: {
    resolution: string;
    sentAt?: Date | null;
    chatId?: string | null;
    providerMessageId?: string | null;
    memberId?: string | null;
    connected?: boolean;
  },
): Promise<boolean> {
  const workspace = requireWorkspace(ctx);
  const [message] = await ctx.db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.workspace_id, workspace.id)))
    .limit(1);
  if (message?.channel !== "linkedin" || message.status !== "unknown") return false;
  return recordStoredLinkedInSend(ctx, message, { ...input, from: ["unknown"] });
}

/**
 * Records a stored LinkedIn action as sent with what the message row knows (its account, its
 * conversation, the time its attempt started): a confirmed unknown action, or one an earlier
 * attempt sent (its late answer said so). Only from the `from` statuses at the message's own
 * attempt; false when it moved on or is no LinkedIn action with a person.
 */
export async function recordStoredLinkedInSend(
  ctx: OpContext,
  message: Message,
  input: {
    from: readonly MessageStatus[];
    resolution: string;
    /** False: this attempt did not act itself (see `LinkedInSent.wentOut`). */
    wentOut?: boolean;
    sentAt?: Date | null;
    chatId?: string | null;
    providerMessageId?: string | null;
    memberId?: string | null;
    connected?: boolean;
  },
): Promise<boolean> {
  if (!message.person_id || !isLinkedInAction(message.action)) return false;
  const workspace = requireWorkspace(ctx);
  const account = message.linkedin_account_id
    ? await findAccount(ctx.db, workspace.id, message.linkedin_account_id)
    : null;
  const now = ctx.clock.now();
  const candidate = input.sentAt ?? message.dispatch_started_at ?? message.updated_at;
  const sentAt = candidate.getTime() > now.getTime() ? now : candidate;
  const thread = message.action === "message" ? await conversationOf(ctx, message, account) : null;
  const recorded = await recordLinkedInSent(ctx, {
    workspaceId: workspace.id,
    message,
    attempt: message.attempt,
    from: input.from,
    ...(input.wentOut === undefined ? {} : { wentOut: input.wentOut }),
    account,
    personId: message.person_id,
    action: message.action,
    sentAt,
    timezone: account ? accountSchedule(account, workspace).timezone : workspace.timezone || "UTC",
    threadId: message.thread_id ?? thread?.id ?? null,
    chatId: input.chatId ?? thread?.external_ref ?? null,
    providerMessageId: input.providerMessageId ?? message.provider_message_id,
    memberId: input.memberId ?? null,
    connected: input.connected === true,
    resolution: input.resolution,
  });
  return recorded !== null;
}

/** The LinkedIn conversation thread of the message's account and person. */
async function conversationOf(
  ctx: OpContext,
  message: Message,
  account: LinkedInAccount | null,
): Promise<{ id: string; external_ref: string | null } | null> {
  if (!account || !message.person_id) return null;
  const [thread] = await ctx.db
    .select({ id: threads.id, external_ref: threads.external_ref })
    .from(threads)
    .where(
      and(
        eq(threads.workspace_id, message.workspace_id),
        eq(threads.channel, "linkedin"),
        eq(threads.linkedin_account_id, account.id),
        eq(threads.person_id, message.person_id),
      ),
    )
    .orderBy(asc(threads.created_at))
    .limit(1);
  return thread ?? null;
}

export interface LinkedInReconcileSummary {
  checked: number;
  confirmed: number;
  resent: number;
  problems: number;
  pending: number;
  errors: number;
}

type Outcome = "confirmed" | "resent" | "problems" | "pending";

/**
 * Looks at the workspace's unknown LinkedIn actions once (called by the reconcile job every 10
 * minutes; see module doc). Messages and comments that cannot be checked are left to their
 * problem.
 */
export async function reconcileLinkedInUnknowns(ctx: OpContext): Promise<LinkedInReconcileSummary> {
  const workspace = requireWorkspace(ctx);
  const summary: LinkedInReconcileSummary = {
    checked: 0,
    confirmed: 0,
    resent: 0,
    problems: 0,
    pending: 0,
    errors: 0,
  };
  const rows = await ctx.db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, workspace.id),
        eq(messages.channel, "linkedin"),
        eq(messages.direction, "outbound"),
        eq(messages.status, "unknown"),
        lt(messages.reconcile_checks, RECONCILE_CHECKS),
      ),
    )
    .orderBy(asc(messages.updated_at))
    .limit(MAX_PER_RUN);
  for (const row of rows) {
    summary.checked += 1;
    try {
      const outcome: Outcome =
        row.action === "invite"
          ? await reconcileInvite(ctx, workspace, row)
          : row.action === "message"
            ? await reconcileMessage(ctx, workspace, row)
            : await leaveToProblem(ctx, row, "the engine cannot check comments on LinkedIn");
      summary[outcome] += 1;
    } catch (error) {
      summary.errors += 1;
      ctx.log.error(
        { message_id: row.id, err: errorText(error) },
        "linkedin: an unknown action could not be reconciled",
      );
    }
  }
  return summary;
}

async function leaveToProblem(ctx: OpContext, message: Message, detail: string): Promise<Outcome> {
  await openLinkedInUnknownProblem(ctx, message, detail);
  await stopReconciling(ctx, message.id);
  return "problems";
}

async function reconcileInvite(
  ctx: OpContext,
  workspace: Workspace,
  message: Message,
): Promise<Outcome> {
  const account = message.linkedin_account_id
    ? await findAccount(ctx.db, workspace.id, message.linkedin_account_id)
    : null;
  const person = await loadPerson(ctx, message);
  if (!account?.external_account_id || !person) {
    return leaveToProblem(ctx, message, "the LinkedIn account or the person is gone");
  }
  let profile: LinkedInProfile;
  try {
    if (account.status !== "active") throw new Error(`the LinkedIn account is ${account.status}`);
    const relation = await findRelation(ctx.db, account.id, person.id);
    const provider = await providerFor(ctx, account);
    profile = await provider.getProfile(account.external_account_id, {
      profile_url: person.linkedin_url,
      provider_id: relation?.provider_ref ?? null,
    });
  } catch (error) {
    const checks = await countReconcileCheck(ctx, message.id);
    if (checks < RECONCILE_CHECKS) return "pending";
    await openLinkedInUnknownProblem(
      ctx,
      message,
      `the profile could not be read to check (${errorText(error)})`,
    );
    return "problems";
  }
  if (profile.invitation_pending || profile.connection_degree === 1) {
    const confirmed = await confirmLinkedInSent(ctx, message.id, {
      resolution: "LinkedIn shows the invitation.",
      memberId: profile.provider_id || null,
      connected: profile.connection_degree === 1,
    });
    return confirmed ? "confirmed" : "pending";
  }
  const checks = await countReconcileCheck(ctx, message.id);
  if (checks < RECONCILE_CHECKS) return "pending";
  if (wasResentAfterUnknown(message)) {
    await openLinkedInUnknownProblem(
      ctx,
      message,
      "LinkedIn shows no invitation, even after it was sent again once",
    );
    return "problems";
  }
  if (!(await rescheduleUnknown(ctx, message, "LinkedIn shows no invitation"))) return "pending";
  await enqueueAction(ctx, message.id, ctx.clock.now());
  return "resent";
}

function sameText(a: string, b: string): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  return normalize(a) === normalize(b);
}

async function reconcileMessage(
  ctx: OpContext,
  workspace: Workspace,
  message: Message,
): Promise<Outcome> {
  const account = message.linkedin_account_id
    ? await findAccount(ctx.db, workspace.id, message.linkedin_account_id)
    : null;
  if (!account?.external_account_id || account.status !== "active") {
    return leaveToProblem(ctx, message, "the LinkedIn account cannot be read");
  }
  const provider = await providerFor(ctx, account);
  if (!provider.syncMessages) {
    return leaveToProblem(ctx, message, "the LinkedIn provider cannot read sent messages");
  }
  const text = message.body_text ?? "";
  // The person's own conversation: the chat of its thread, else every chat in which the person
  // (by their LinkedIn member id) wrote. The same text in another conversation proves nothing.
  const chats = new Set<string>();
  const known = (await conversationOf(ctx, message, account))?.external_ref ?? null;
  if (known) chats.add(known);
  const memberId = message.person_id
    ? ((await findRelation(ctx.db, account.id, message.person_id))?.provider_ref ?? null)
    : null;
  const since = new Date(
    (message.dispatch_started_at ?? message.updated_at).getTime() - 5 * 60_000,
  );
  let found: LinkedInInboundMessage | undefined;
  try {
    const seen: LinkedInInboundMessage[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < MAX_CHAT_PAGES && !found; page++) {
      const result = await provider.syncMessages(account.external_account_id, { since, cursor });
      seen.push(...result.messages);
      for (const candidate of seen) {
        if (!candidate.is_outbound && memberId && candidate.sender_provider_id === memberId) {
          chats.add(candidate.chat_id);
        }
      }
      found = seen.find(
        (candidate) =>
          candidate.is_outbound && chats.has(candidate.chat_id) && sameText(candidate.text, text),
      );
      cursor = result.cursor;
      if (!cursor) break;
    }
  } catch (error) {
    ctx.log.warn(
      { message_id: message.id, err: errorText(error) },
      "linkedin: recent messages could not be read to reconcile",
    );
  }
  if (found) {
    const sentAt = new Date(found.sent_at);
    const confirmed = await confirmLinkedInSent(ctx, message.id, {
      resolution: "The message is in the LinkedIn conversation.",
      sentAt: Number.isNaN(sentAt.getTime()) ? null : sentAt,
      chatId: found.chat_id,
      providerMessageId: found.id,
    });
    return confirmed ? "confirmed" : "pending";
  }
  const checks = await countReconcileCheck(ctx, message.id);
  // Not found after the last lookup: the open problem stays with a person.
  return checks < RECONCILE_CHECKS ? "pending" : "problems";
}

/**
 * What `markLinkedInInterrupted` did: `unknown` (an invite, message or comment), `retried` (a
 * visit or like back in the queue: the caller runs or queues it), `failed` (a visit or like
 * after MAX_REPEATABLE_ATTEMPTS), `sent` (a late answer showed an earlier attempt went out) or
 * `moved_on` (another attempt or a person settled it meanwhile).
 */
export type InterruptedOutcome = "unknown" | "retried" | "failed" | "sent" | "moved_on";

/**
 * The action job found a LinkedIn action `sending` (the previous attempt stopped mid-action):
 * invites, messages and comments become unknown; visits and likes, harmless to repeat, go back
 * to the queue (failed after MAX_REPEATABLE_ATTEMPTS). Also used by the reconcile job's sweep of
 * actions stuck in `sending`.
 */
export async function markLinkedInInterrupted(
  ctx: OpContext,
  message: Message,
  reason: string,
): Promise<InterruptedOutcome> {
  if (UNKNOWN_ACTIONS.has(message.action)) {
    if (await markLinkedInUnknown(ctx, message, reason)) return "unknown";
    const [fresh] = await ctx.db
      .select()
      .from(messages)
      .where(and(eq(messages.id, message.id), eq(messages.workspace_id, message.workspace_id)))
      .limit(1);
    const earlier =
      fresh?.status === "sending" && fresh.attempt === message.attempt
        ? earlierAttemptWentOut(fresh)
        : null;
    if (!fresh || earlier === null) return "moved_on";
    // A late answer showed an earlier attempt went out; the stopped one may have gone out too.
    const recorded = await recordStoredLinkedInSend(ctx, fresh, {
      from: ["sending"],
      wentOut: false,
      resolution: `An earlier try went out (try ${earlier}); its answer came late.`,
    });
    if (!recorded) return "moved_on";
    await recordDuplicateSend(
      ctx,
      { ...fresh, status: "sent" },
      { attempts: [earlier, fresh.attempt], proven: false },
    );
    return "sent";
  }
  const hold = stillHeld(message.id, { status: "sending", attempt: message.attempt });
  if (message.attempt < MAX_REPEATABLE_ATTEMPTS) {
    const rows = await ctx.db
      .update(messages)
      .set({ status: "scheduled", error: `retrying: ${reason}` })
      .where(hold)
      .returning({ id: messages.id });
    return rows.length > 0 ? "retried" : "moved_on";
  }
  const error = `interrupted: the last ${message.attempt} attempts stopped mid-action`;
  const rows = await ctx.db
    .update(messages)
    .set({ status: "failed", error, why: failedWhy(false) })
    .where(hold)
    .returning({ id: messages.id });
  if (rows.length === 0) return "moved_on";
  await ctx.events.emit("message.failed", {
    workspaceId: message.workspace_id,
    subject: { type: "message", id: message.id },
    data: { message_id: message.id, error, retryable: false },
  });
  return "failed";
}
