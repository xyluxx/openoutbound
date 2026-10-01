/**
 * Results of applied proposals: once `review_after_days` have passed, the same numbers are
 * compared for that many days before and after the change (the campaign's numbers when the
 * proposal changed a campaign, else the workspace's) and a verdict is stored:
 * `unclear` below 30 sends in either window, `better` or `worse` at a relative change of 20% or
 * more, `flat` otherwise. The verdict uses the positive reply rate, or the meeting rate when the
 * proposal changed booking settings or a booking link.
 */
import {
  and,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { type JobContext, type OpContext, requireWorkspace } from "../../core/context.js";
import type { ProposalVerdict } from "../../core/enums.js";
import { type BuiltinSchedule, defineJob } from "../../core/operation.js";
import { queryRows } from "../../db/client.js";
import {
  approvals,
  type ChangeProposal,
  change_proposals,
  meetings,
  messages,
  type ProposalOutcome,
} from "../../db/schema/index.js";
import { jobWorkspaceContext } from "../../runtime/context.js";

/** Sends needed in each window before a verdict means anything. */
export const MIN_SENDS = 30;
/** Relative change that counts as better or worse. */
export const VERDICT_THRESHOLD = 0.2;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Outreach the engine sent itself (answers to prospects are not outreach). */
const OUTREACH_ACTIONS = ["email", "invite", "message"] as const;
const AUTOMATIC_CATEGORIES = ["out_of_office", "auto_reply_other", "bounce"];
const POSITIVE_CATEGORIES = ["interested", "meeting_request"];

export interface WindowNumbers {
  sends: number;
  replies: number;
  positive_replies: number;
  meetings_booked: number;
  /** Null when the workspace records no meetings (only opportunities). */
  meetings_held: number | null;
  reply_rate: number | null;
  positive_reply_rate: number | null;
  /** Meetings booked per send. */
  meeting_rate: number | null;
}

export type VerdictMetric = "positive_reply_rate" | "meeting_rate";

export interface Window {
  from: Date;
  /** Exclusive. */
  to: Date;
}

function ts(date: Date): SQL {
  return sql`${date.toISOString()}::timestamptz`;
}

function rate(part: number, total: number): number | null {
  return total > 0 ? Math.round((part / total) * 10_000) / 10_000 : null;
}

function literalList(values: readonly string[]): SQL {
  return sql.raw(values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", "));
}

async function countSends(
  ctx: OpContext,
  workspaceId: string,
  window: Window,
  campaignId: string | null,
): Promise<number> {
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, workspaceId),
        eq(messages.direction, "outbound"),
        eq(messages.origin, "engine"),
        inArray(messages.action, [...OUTREACH_ACTIONS]),
        // A LinkedIn message is outreach only as a sequence step; without one it answers a prospect.
        or(ne(messages.action, "message"), isNotNull(messages.step_id)),
        inArray(messages.status, ["sent", "bounced"]),
        gte(messages.sent_at, window.from),
        lt(messages.sent_at, window.to),
        campaignId ? eq(messages.campaign_id, campaignId) : undefined,
      ),
    );
  return row?.n ?? 0;
}

const replyCategory = sql`coalesce(${messages.classification}->>'category', '')`;

/**
 * Replies from people (not automatic answers) received in the window. Inbound messages always
 * store received_at, and filtering on it (not on an expression) lets the (workspace_id,
 * received_at) index serve the window.
 */
export function repliesInWindow(
  workspaceId: string,
  window: Window,
  campaignId: string | null,
): SQL | undefined {
  return and(
    eq(messages.workspace_id, workspaceId),
    eq(messages.direction, "inbound"),
    isNotNull(messages.person_id),
    sql`${replyCategory} not in (${literalList(AUTOMATIC_CATEGORIES)})`,
    gte(messages.received_at, window.from),
    lt(messages.received_at, window.to),
    campaignId ? eq(messages.campaign_id, campaignId) : undefined,
  );
}

async function countReplies(
  ctx: OpContext,
  workspaceId: string,
  window: Window,
  campaignId: string | null,
): Promise<{ replies: number; positive: number }> {
  const [row] = await ctx.db
    .select({
      replies: sql<number>`count(*)`.mapWith(Number),
      positive:
        sql<number>`count(*) filter (where ${replyCategory} in (${literalList(POSITIVE_CATEGORIES)}))`.mapWith(
          Number,
        ),
    })
    .from(messages)
    .where(repliesInWindow(workspaceId, window, campaignId));
  return { replies: row?.replies ?? 0, positive: row?.positive ?? 0 };
}

async function hasMeetingRecords(ctx: OpContext, workspaceId: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ id: meetings.id })
    .from(meetings)
    .where(eq(meetings.workspace_id, workspaceId))
    .limit(1);
  return Boolean(row);
}

async function countMeetings(
  ctx: OpContext,
  workspaceId: string,
  window: Window,
  campaignId: string | null,
): Promise<{ booked: number; held: number }> {
  const campaign = campaignId ? eq(meetings.campaign_id, campaignId) : undefined;
  const [booked] = await ctx.db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(meetings)
    .where(
      and(
        eq(meetings.workspace_id, workspaceId),
        gte(meetings.created_at, window.from),
        lt(meetings.created_at, window.to),
        campaign,
      ),
    );
  const [held] = await ctx.db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(meetings)
    .where(
      and(
        eq(meetings.workspace_id, workspaceId),
        eq(meetings.status, "held"),
        gte(meetings.start_at, window.from),
        lt(meetings.start_at, window.to),
        campaign,
      ),
    );
  return { booked: booked?.n ?? 0, held: held?.n ?? 0 };
}

/**
 * Meetings booked for workspaces without meeting records: opportunities that first reached
 * meeting_booked inside the window (from their `opportunity.updated` events, else their
 * creation time when they were created with a meeting).
 */
async function countBookedOpportunities(
  ctx: OpContext,
  workspaceId: string,
  window: Window,
  campaignId: string | null,
): Promise<number> {
  const [row] = await queryRows<{ n: number | string }>(
    ctx.db,
    sql`with first_booked as (
      select e.data->>'opportunity_id' as opportunity_id, min(e.occurred_at) as at
      from events e
      where e.workspace_id = ${workspaceId} and e.type = 'opportunity.updated'
        and e.data->>'stage' = 'meeting_booked'
      group by 1
    )
    select count(*) as n
    from opportunities o
    left join first_booked fb on fb.opportunity_id = o.id
    where o.workspace_id = ${workspaceId}
      ${campaignId ? sql`and o.campaign_id = ${campaignId}` : sql``}
      and coalesce(
        fb.at,
        case when o.stage = 'meeting_booked' or o.meeting_at is not null then o.created_at end
      ) >= ${ts(window.from)}
      and coalesce(
        fb.at,
        case when o.stage = 'meeting_booked' or o.meeting_at is not null then o.created_at end
      ) < ${ts(window.to)}`,
  );
  return Number(row?.n ?? 0);
}

/** The numbers of one window (engine sends only). */
export async function windowNumbers(
  ctx: OpContext,
  workspaceId: string,
  window: Window,
  campaignId: string | null,
  meetingRecords?: boolean,
): Promise<WindowNumbers> {
  const records = meetingRecords ?? (await hasMeetingRecords(ctx, workspaceId));
  const [sends, replies, meetingCounts] = await Promise.all([
    countSends(ctx, workspaceId, window, campaignId),
    countReplies(ctx, workspaceId, window, campaignId),
    records
      ? countMeetings(ctx, workspaceId, window, campaignId)
      : countBookedOpportunities(ctx, workspaceId, window, campaignId).then((booked) => ({
          booked,
          held: null,
        })),
  ]);
  return {
    sends,
    replies: replies.replies,
    positive_replies: replies.positive,
    meetings_booked: meetingCounts.booked,
    meetings_held: meetingCounts.held,
    reply_rate: rate(replies.replies, sends),
    positive_reply_rate: rate(replies.positive, sends),
    meeting_rate: rate(meetingCounts.booked, sends),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Meetings decide for changes to booking settings or booking links; replies otherwise. */
export function verdictMetric(
  proposal: Pick<ChangeProposal, "operation" | "input">,
): VerdictMetric {
  const input = proposal.input;
  if (proposal.operation === "workspaces.update") {
    return isPlainObject(input.settings) && input.settings.booking !== undefined
      ? "meeting_rate"
      : "positive_reply_rate";
  }
  if (proposal.operation.startsWith("offers.") && input.booking_url !== undefined) {
    return "meeting_rate";
  }
  return "positive_reply_rate";
}

/** The verdict from the numbers before and after (see the file comment). */
export function verdictFor(
  before: WindowNumbers,
  after: WindowNumbers,
  metric: VerdictMetric,
): { verdict: ProposalVerdict; relative: number | null } {
  if (before.sends < MIN_SENDS || after.sends < MIN_SENDS) {
    return { verdict: "unclear", relative: null };
  }
  const was = before[metric] ?? 0;
  const now = after[metric] ?? 0;
  if (was === 0) return { verdict: now > 0 ? "better" : "flat", relative: null };
  const relative = Math.round(((now - was) / was) * 1_000_000) / 1_000_000;
  if (relative >= VERDICT_THRESHOLD) return { verdict: "better", relative };
  if (relative <= -VERDICT_THRESHOLD) return { verdict: "worse", relative };
  return { verdict: "flat", relative };
}

function percent(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value * 1000) / 10}%`;
}

function outcomeNote(
  metric: VerdictMetric,
  before: WindowNumbers,
  after: WindowNumbers,
  relative: number | null,
  verdict: ProposalVerdict,
  days: number,
): string {
  if (verdict === "unclear") {
    return `Too few sends to judge: ${before.sends} before and ${after.sends} after (${MIN_SENDS} needed in each window of ${days} days).`;
  }
  const label =
    metric === "meeting_rate" ? "Meeting rate (meetings booked per send)" : "Positive reply rate";
  const change =
    relative === null ? "" : ` (${relative >= 0 ? "+" : ""}${Math.round(relative * 100)}%)`;
  return `${label} ${percent(before[metric])} -> ${percent(after[metric])}${change} over ${days} days before and after.`;
}

/** Computes and stores the outcome of one applied proposal; emits `proposal.reviewed`. */
export async function reviewProposal(
  ctx: OpContext,
  proposal: ChangeProposal,
): Promise<ProposalOutcome | null> {
  if (!proposal.applied_at) return null;
  const days = proposal.review_after_days;
  const appliedAt = proposal.applied_at;
  const before = { from: new Date(appliedAt.getTime() - days * DAY_MS), to: appliedAt };
  const after = { from: appliedAt, to: new Date(appliedAt.getTime() + days * DAY_MS) };
  const campaignId = proposal.target_type === "campaign" ? proposal.target_id : null;
  const records = await hasMeetingRecords(ctx, proposal.workspace_id);
  const [numbersBefore, numbersAfter] = await Promise.all([
    windowNumbers(ctx, proposal.workspace_id, before, campaignId, records),
    windowNumbers(ctx, proposal.workspace_id, after, campaignId, records),
  ]);
  const metric = verdictMetric(proposal);
  const { verdict, relative } = verdictFor(numbersBefore, numbersAfter, metric);
  const outcome: ProposalOutcome = {
    window_days: days,
    before: { ...numbersBefore },
    after: { ...numbersAfter },
    verdict,
    note: outcomeNote(metric, numbersBefore, numbersAfter, relative, verdict, days),
  };
  const [stored] = await ctx.db
    .update(change_proposals)
    .set({ outcome, reviewed_at: ctx.clock.now(), updated_at: ctx.clock.now() })
    .where(and(eq(change_proposals.id, proposal.id), isNull(change_proposals.reviewed_at)))
    .returning({ id: change_proposals.id });
  if (!stored) return null;
  await ctx.events.emit("proposal.reviewed", {
    workspaceId: proposal.workspace_id,
    subject: { type: "proposal", id: proposal.id },
    data: { proposal_id: proposal.id, verdict },
  });
  return outcome;
}

/**
 * Proposals waiting on an approval that expired or was cancelled become `rejected`, so they do
 * not wait forever. Returns how many.
 */
async function closeLapsedApprovals(ctx: OpContext, workspaceId: string): Promise<number> {
  const waiting = await ctx.db
    .select({
      id: change_proposals.id,
      approval_status: approvals.status,
      approval_id: approvals.id,
    })
    .from(change_proposals)
    .innerJoin(approvals, eq(approvals.id, change_proposals.approval_id))
    .where(
      and(
        eq(change_proposals.workspace_id, workspaceId),
        eq(change_proposals.status, "awaiting_approval"),
        inArray(approvals.status, ["expired", "cancelled", "rejected"]),
      ),
    );
  for (const row of waiting) {
    await ctx.db
      .update(change_proposals)
      .set({
        status: "rejected",
        error: `Approval ${row.approval_id} was ${row.approval_status}; nothing changed.`,
        updated_at: ctx.clock.now(),
      })
      .where(
        and(eq(change_proposals.id, row.id), eq(change_proposals.status, "awaiting_approval")),
      );
  }
  return waiting.length;
}

/** Reviews every due proposal of the context workspace. */
export async function reviewDueProposals(
  ctx: OpContext,
): Promise<{ reviewed: number; closed: number }> {
  const workspace = requireWorkspace(ctx);
  const closed = await closeLapsedApprovals(ctx, workspace.id);
  const due = await ctx.db
    .select()
    .from(change_proposals)
    .where(
      and(
        eq(change_proposals.workspace_id, workspace.id),
        eq(change_proposals.status, "applied"),
        isNull(change_proposals.reviewed_at),
        lte(change_proposals.review_at, ctx.clock.now()),
      ),
    )
    .limit(200);
  let reviewed = 0;
  for (const proposal of due) {
    if (await reviewProposal(ctx, proposal)) reviewed++;
  }
  return { reviewed, closed };
}

export const REVIEW_JOB = "strategy.review_proposals";

/** Daily per workspace: results of applied proposals and lapsed approvals. */
export const reviewProposalsJob = defineJob({
  name: REVIEW_JOB,
  payload: z.object({ workspace_id: z.string().min(1).optional() }),
  maxAttempts: 3,
  handler: async (jobCtx: JobContext, payload) => {
    const workspaceId = payload.workspace_id ?? jobCtx.job.workspaceId;
    if (!workspaceId) return { skipped: "no workspace" };
    const ctx = await jobWorkspaceContext(jobCtx, workspaceId);
    if (!ctx) return { skipped: "workspace not found" };
    return reviewDueProposals(ctx);
  },
});

export const reviewProposalsSchedule: BuiltinSchedule = {
  name: REVIEW_JOB,
  cron: "37 5 * * *",
  job: REVIEW_JOB,
  perWorkspace: true,
};
