/**
 * Messages that went out twice are never silent. Every write of a send attempt checks its claim
 * (unknown-sends.ts), so the answer of an attempt that lost its claim is never recorded as if it
 * were the current one. When such a late answer says the message went out, `settleLateSuccess`
 * decides:
 * - a newer attempt sent the message too: it went out twice. That is recorded: the event
 *   `message.duplicate`, a `duplicate_send` problem for a person, `why.duplicate_attempts`.
 * - a newer attempt is handing it over right now: the message remembers that the earlier one
 *   went out (`why.earlier_attempt_went_out`). When the newer one goes out too, that is the same
 *   duplicate; when it does not, the message is recorded as sent.
 * - nothing else went out (the message is unknown, failed, cancelled, skipped, queued again or
 *   back in review): it is recorded as sent, which is no duplicate, and a request still pending
 *   about it (a reply's approval, a resend) is cancelled.
 * Shared by the email and LinkedIn send paths.
 */
import { and, eq, sql } from "drizzle-orm";
import type { OpContext } from "../../core/context.js";
import type { MessageStatus } from "../../core/enums.js";
import { type Message, messages, people } from "../../db/schema/index.js";
import { openProblem } from "../problems/service.js";
import { stillHeld } from "./unknown-sends.js";

/** Dedupe key of a message's `duplicate_send` problem. */
export function duplicateSendKey(messageId: string): string {
  return `duplicate_send:${messageId}`;
}

/**
 * Statuses of a message that, as far as the engine knew, did not go out: a late answer that
 * says it did is recorded as a send from any of them. A reply back in review (`draft`,
 * `pending_review`) is one too: approving it would send it a second time.
 */
export const NOT_SENT_STATUSES: readonly MessageStatus[] = [
  "unknown",
  "failed",
  "cancelled",
  "skipped",
  "scheduled",
  "approved",
  "pending_review",
  "draft",
];

/** The earlier attempt a late answer showed went out, when one did (see module doc). */
export function earlierAttemptWentOut(message: Pick<Message, "why" | "attempt">): number | null {
  const earlier = message.why?.earlier_attempt_went_out;
  return typeof earlier === "number" && earlier < message.attempt ? earlier : null;
}

const NOUN: Record<string, string> = {
  email: "email",
  reply: "email",
  invite: "LinkedIn invitation",
  message: "LinkedIn message",
  comment: "LinkedIn comment",
  like: "LinkedIn like",
  visit: "LinkedIn profile visit",
};

async function recipientOf(ctx: OpContext, message: Message): Promise<string> {
  if (message.channel === "email" && message.to_address) return message.to_address;
  if (!message.person_id) return "the person";
  const [person] = await ctx.db
    .select({ name: people.full_name })
    .from(people)
    .where(and(eq(people.id, message.person_id), eq(people.workspace_id, message.workspace_id)))
    .limit(1);
  return person?.name ?? "the person";
}

/** What a person can do about a copy too many: nothing to undo, and where to look. */
function remedyFor(message: Message, to: string): string {
  const close = "Then close this with resolve_exception action resolve.";
  switch (message.action) {
    case "email":
    case "reply":
      return `Nothing to undo, and the engine does not send it again. If it matters, tell ${to} that the second copy was a mistake. ${close}`;
    case "invite":
      return `Nothing to undo: LinkedIn keeps one invitation per person, and the engine does not send it again. ${close}`;
    default:
      return `Nothing will be sent again. If you want, delete the extra copy on LinkedIn. ${close}`;
  }
}

export interface DuplicateInput {
  /** The attempt numbers that went out (or, when not proven, may have), oldest first. */
  attempts: number[];
  /**
   * True when every attempt in `attempts` went out. False when the newest one's own outcome is
   * unknown, so it only may have gone out: no event then, and the problem says "may have".
   */
  proven: boolean;
}

/**
 * Records that a message went out twice (see module doc): `why.duplicate_attempts`, the event
 * `message.duplicate` (proven duplicates only) and a `duplicate_send` problem (normal severity,
 * for a person, one per message).
 */
export async function recordDuplicateSend(
  ctx: OpContext,
  message: Message,
  input: DuplicateInput,
): Promise<void> {
  const attempts = [...new Set(input.attempts)].sort((a, b) => a - b);
  await ctx.db
    .update(messages)
    .set({
      why: sql`coalesce(${messages.why}, '{}'::jsonb) || ${JSON.stringify({ duplicate_attempts: attempts })}::jsonb`,
    })
    .where(and(eq(messages.id, message.id), eq(messages.workspace_id, message.workspace_id)));
  if (input.proven) {
    await ctx.events.emit("message.duplicate", {
      workspaceId: message.workspace_id,
      subject: { type: "message", id: message.id },
      data: {
        message_id: message.id,
        attempts,
        channel: message.channel,
        campaign_id: message.campaign_id,
        person_id: message.person_id,
      },
    });
  }
  const noun = NOUN[message.action] ?? "message";
  const to = await recipientOf(ctx, message);
  const subject =
    message.channel === "email"
      ? ` (subject "${(message.subject ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || "no subject"}")`
      : "";
  const tries = attempts.join(" and ");
  await openProblem(ctx, {
    kind: "duplicate_send",
    severity: "normal",
    owner: "person",
    title: input.proven
      ? `${capitalize(noun)} went out twice`
      : `${capitalize(noun)} may have gone out twice`,
    reason: input.proven
      ? `The ${noun} to ${to}${subject} went out twice: the answer to an earlier try came late, after the engine had sent it again (tries ${tries}).`
      : `The ${noun} to ${to}${subject} went out with an earlier try whose answer came late, and a newer try may have gone out too (tries ${tries}): the newer one got no clear answer.`,
    remedy: remedyFor(message, to),
    subject: { type: "message", id: message.id },
    personId: message.person_id,
    companyId: message.company_id,
    data: {
      message_id: message.id,
      channel: message.channel,
      attempts,
      proven: input.proven,
      campaign_id: message.campaign_id,
    },
    dedupeKey: duplicateSendKey(message.id),
  });
  ctx.log.warn(
    { message_id: message.id, attempts, proven: input.proven },
    "a message went out twice: an earlier attempt's answer came late",
  );
}

function capitalize(text: string): string {
  return text ? `${text[0]?.toUpperCase()}${text.slice(1)}` : text;
}

/** `why.earlier_attempt_went_out` on a message a newer attempt still holds (false: it moved on). */
async function rememberEarlierAttempt(
  ctx: OpContext,
  held: Message,
  earlier: number,
): Promise<boolean> {
  const rows = await ctx.db
    .update(messages)
    .set({
      why: sql`coalesce(${messages.why}, '{}'::jsonb) || jsonb_build_object('earlier_attempt_went_out', ${earlier}::int)`,
    })
    .where(stillHeld(held.id, { status: "sending", attempt: held.attempt }))
    .returning({ id: messages.id });
  return rows.length > 0;
}

export interface LateSuccess {
  /** The message as the attempt read it (id and workspace are used). */
  message: Pick<Message, "id" | "workspace_id">;
  /** The attempt whose answer came late and said the message went out. */
  attempt: number;
  /**
   * Repeating the action is harmless (LinkedIn visits and likes, done at least once by
   * design): a second copy is not recorded, and a newer attempt is left to record its own result.
   */
  repeatable?: boolean;
  /**
   * Records the message as sent from `fresh.status` at `fresh.attempt` with the channel's own
   * bookkeeping (the text that went out, counters, `message.sent`). False when the message
   * changed meanwhile.
   */
  record(fresh: Message, resolution: string): Promise<boolean>;
}

/** What `settleLateSuccess` did. */
export type LateSuccessOutcome = "duplicate" | "recorded" | "remembered" | "ignored";

const SETTLE_ROUNDS = 3;

/**
 * Settles the answer of an attempt that lost its claim and says the message went out (see
 * module doc). Reads the message again each round, since other attempts may change it.
 */
export async function settleLateSuccess(
  ctx: OpContext,
  input: LateSuccess,
): Promise<LateSuccessOutcome> {
  for (let round = 0; round < SETTLE_ROUNDS; round++) {
    const [fresh] = await ctx.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.id, input.message.id),
          eq(messages.workspace_id, input.message.workspace_id),
        ),
      )
      .limit(1);
    if (!fresh) return "ignored";
    if (fresh.status === "sent") {
      // Recorded already from this attempt (a reconcile found it): nothing more to say. A copy
      // too many of a repeatable action is harmless.
      if (fresh.attempt === input.attempt || input.repeatable) return "ignored";
      await recordDuplicateSend(ctx, fresh, {
        attempts: [input.attempt, fresh.attempt],
        proven: true,
      });
      return "duplicate";
    }
    if (fresh.status === "sending") {
      // A newer attempt of a repeatable action records its own result.
      if (fresh.attempt === input.attempt || input.repeatable) return "ignored";
      if (await rememberEarlierAttempt(ctx, fresh, input.attempt)) return "remembered";
      continue;
    }
    if (!NOT_SENT_STATUSES.includes(fresh.status)) return "ignored";
    const newerUnknown = fresh.status === "unknown" && fresh.attempt > input.attempt;
    const recorded = await input.record(
      fresh,
      `An earlier try's answer came late: it went out (try ${input.attempt}).`,
    );
    if (!recorded) continue;
    // It went out: an approval or a resend still asked for about it would send it again.
    await ctx.approvals.cancel(
      { target: { type: "message", id: fresh.id } },
      "It went out: an earlier try's answer came late.",
    );
    if (newerUnknown) {
      await recordDuplicateSend(ctx, fresh, {
        attempts: [input.attempt, fresh.attempt],
        proven: false,
      });
    }
    return "recorded";
  }
  ctx.log.warn(
    { message_id: input.message.id, attempt: input.attempt },
    "a late answer said a message went out, but the message kept changing; it is not recorded",
  );
  return "ignored";
}
