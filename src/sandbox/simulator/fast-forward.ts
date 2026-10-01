/**
 * Fast-forward for the prospect simulator (`sandbox.simulate`): processes every currently
 * pending simulated outcome right away, instead of waiting for its delayed job to fire. Used
 * for demos and evals, and to report a pending count from `sandbox.status`. Pending counts
 * only what will arrive (the simulator's decision is deterministic), so a fast-forward delivers
 * exactly what it reported. Meetings are booked right away too, but keep their simulated time:
 * a no-show is only reported once the meeting was due, and held meetings come from the held
 * sweep after their start.
 */
import { eq, inArray } from "drizzle-orm";
import type { OpContext } from "../../core/context.js";
import { mailboxes, messages, people, workspaces } from "../../db/schema/index.js";
import { decideEmailOutcome, decideLinkedInAccept, decideLinkedInMessageReply } from "./decide.js";
import { findPendingEmailCandidates, processEmailMessage } from "./email-reply.js";
import {
  findPendingLinkedInAccepts,
  findPendingLinkedInMessageReplies,
  processLinkedInAccept,
  processLinkedInMessage,
} from "./linkedin-reply.js";
import {
  findPendingMeetingBookings,
  findPendingMeetingNoShows,
  processMeetingBooking,
  processMeetingNoShow,
} from "./meetings.js";

export interface PendingSimulationCounts {
  email_replies: number;
  linkedin_accepts: number;
  linkedin_replies: number;
  meeting_bookings: number;
  meeting_no_shows: number;
}

export interface FastForwardResult extends PendingSimulationCounts {
  delivered: PendingSimulationCounts;
}

type Db = Pick<OpContext, "db">;

/** First-touch emails whose simulated prospect will reply or bounce (the rest stay silent). */
async function arrivingEmailReplies(ctx: Db, workspaceId: string): Promise<string[]> {
  const candidates = await findPendingEmailCandidates(ctx, workspaceId);
  if (candidates.length === 0) return [];
  const rows = await ctx.db
    .select({
      id: messages.id,
      personId: people.id,
      email: people.email,
      emailStatus: people.email_status,
    })
    .from(messages)
    .innerJoin(people, eq(people.id, messages.person_id))
    .innerJoin(mailboxes, eq(mailboxes.id, messages.mailbox_id))
    .where(inArray(messages.id, candidates));
  const arriving = new Set(
    rows
      .filter(
        (row) =>
          Boolean(row.email) &&
          decideEmailOutcome({
            personId: row.personId,
            messageId: row.id,
            emailStatus: row.emailStatus,
          }).kind !== "none",
      )
      .map((row) => row.id),
  );
  return candidates.filter((id) => arriving.has(id));
}

/** Pending invitations the simulated prospect will accept. */
async function arrivingAccepts(ctx: Db, workspaceId: string) {
  return (await findPendingLinkedInAccepts(ctx, workspaceId)).filter((pending) =>
    decideLinkedInAccept(pending.personId),
  );
}

/** LinkedIn messages the simulated prospect will answer. */
async function arrivingLinkedInReplies(ctx: Db, workspaceId: string): Promise<string[]> {
  const candidates = await findPendingLinkedInMessageReplies(ctx, workspaceId);
  if (candidates.length === 0) return [];
  const rows = await ctx.db
    .select({ id: messages.id, personId: people.id })
    .from(messages)
    .innerJoin(people, eq(people.id, messages.person_id))
    .where(inArray(messages.id, candidates));
  const arriving = new Set(
    rows.filter((row) => decideLinkedInMessageReply(row.personId, row.id)).map((row) => row.id),
  );
  return candidates.filter((id) => arriving.has(id));
}

/** Everything that will arrive for this workspace, without delivering anything. */
export async function countPendingSimulations(
  ctx: Pick<OpContext, "db" | "clock">,
  workspaceId: string,
): Promise<PendingSimulationCounts> {
  const [workspace] = await ctx.db
    .select({ id: workspaces.id, settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const [emails, accepts, liReplies, bookings, noShows] = await Promise.all([
    arrivingEmailReplies(ctx, workspaceId),
    arrivingAccepts(ctx, workspaceId),
    arrivingLinkedInReplies(ctx, workspaceId),
    workspace ? findPendingMeetingBookings(ctx, workspace) : [],
    findPendingMeetingNoShows(ctx, workspaceId),
  ]);
  return {
    email_replies: emails.length,
    linkedin_accepts: accepts.length,
    linkedin_replies: liReplies.length,
    meeting_bookings: bookings.length,
    meeting_no_shows: noShows.length,
  };
}

/** Processes every pending simulated reply, bounce and LinkedIn acceptance for one workspace now. */
export async function fastForwardSandbox(
  ctx: OpContext,
  workspaceId: string,
): Promise<FastForwardResult> {
  const pending = await countPendingSimulations(ctx, workspaceId);

  let emailDelivered = 0;
  for (const messageId of await arrivingEmailReplies(ctx, workspaceId)) {
    const result = await processEmailMessage(ctx, messageId);
    if (result.delivered) emailDelivered++;
  }

  let acceptDelivered = 0;
  for (const { accountId, personId } of await arrivingAccepts(ctx, workspaceId)) {
    const result = await processLinkedInAccept(ctx, accountId, personId);
    if (result.connected) acceptDelivered++;
  }

  let liReplyDelivered = 0;
  for (const messageId of await arrivingLinkedInReplies(ctx, workspaceId)) {
    const result = await processLinkedInMessage(ctx, messageId);
    if (result.delivered) liReplyDelivered++;
  }

  let bookingsDelivered = 0;
  const workspace = ctx.workspace?.id === workspaceId ? ctx.workspace : null;
  for (const messageId of workspace ? await findPendingMeetingBookings(ctx, workspace) : []) {
    const result = await processMeetingBooking(ctx, messageId);
    if (result.delivered) bookingsDelivered++;
  }

  let noShowsDelivered = 0;
  for (const messageId of await findPendingMeetingNoShows(ctx, workspaceId)) {
    const result = await processMeetingNoShow(ctx, messageId);
    if (result.delivered) noShowsDelivered++;
  }

  return {
    ...pending,
    delivered: {
      email_replies: emailDelivered,
      linkedin_accepts: acceptDelivered,
      linkedin_replies: liReplyDelivered,
      meeting_bookings: bookingsDelivered,
      meeting_no_shows: noShowsDelivered,
    },
  };
}
