/**
 * get_operating_state: one compact summary of a workspace for an agent starting its day.
 * Aggregate queries only (a fixed number, whatever the size of the workspace).
 */
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import {
  APPROVAL_KINDS,
  type ApprovalKind,
  CAMPAIGN_STATUSES,
  type CampaignStatus,
  CHANGE_AREAS,
  LINKEDIN_ACCOUNT_STATUSES,
  type LinkedInAccountStatus,
  MAILBOX_STATUSES,
  type MailboxStatus,
  PROBLEM_KINDS,
  PROBLEM_SEVERITIES,
  type ProblemSeverity,
  WORKSPACE_STATUSES,
} from "../../core/enums.js";
import { isoDateTime } from "../../core/operation.js";
import { queryRows } from "../../db/client.js";
import { change_log, mailboxes } from "../../db/schema/index.js";
import { rampLimit } from "../email/capacity.js";
import { holdsQueuedMail } from "../email/mailbox-state.js";
import { SENDABLE_STATUSES } from "../email/plan.js";
import {
  addDays,
  isoWeekday,
  isValidTimeZone,
  localDate,
  startOfNextDay,
  zonedTimeToUtc,
} from "../email/timezone.js";
import { listProblems } from "../problems/service.js";
import { hotReplies } from "../reports/attention/hot-replies.js";

const countsOf = <T extends string>(keys: readonly T[]) =>
  z.object(Object.fromEntries(keys.map((key) => [key, z.number()])) as Record<T, z.ZodNumber>);

export const operatingStateSchema = z.object({
  workspace: z.object({
    id: z.string(),
    name: z.string(),
    status: z.enum(WORKSPACE_STATUSES),
    timezone: z.string(),
  }),
  generated_at: isoDateTime(),
  campaigns: z.object({
    by_status: countsOf(CAMPAIGN_STATUSES),
    top_active: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          sent_today: z.number(),
          scheduled_today: z.number(),
        }),
      )
      .describe("Up to 5 active campaigns, most engine sends today first"),
  }),
  sending_today: z.object({
    day: z.string().describe("Today in the workspace timezone (daily caps reset at its midnight)"),
    emails_sent: z.number().describe("Engine emails sent today (bounced ones included)"),
    emails_scheduled: z.number().describe("Emails still scheduled for today"),
    email_capacity: z
      .number()
      .describe("Today's cold email cap of all sending mailboxes (ramp included)"),
    linkedin_sent: z.number().describe("Engine LinkedIn actions done today"),
    mailboxes: countsOf(MAILBOX_STATUSES),
    linkedin_accounts: countsOf(LINKEDIN_ACCOUNT_STATUSES),
  }),
  replies: z.object({
    hot_waiting: z.number().describe("Interested or meeting-request replies waiting over 2 hours"),
    drafts_waiting_review: z.number().describe("Reply drafts waiting for a review"),
  }),
  meetings_this_week: z.object({
    week_start: z.string().describe("Monday of this week in the workspace timezone"),
    source: z
      .enum(["meetings", "opportunities"])
      .describe("opportunities = no meeting records yet (older data): counted from opportunities"),
    booked: z.number(),
    held: z.number(),
    no_shows: z.number(),
    upcoming: z.array(
      z.object({
        meeting_id: z.string().nullable(),
        opportunity_id: z.string().nullable(),
        person_id: z.string().nullable(),
        person_name: z.string().nullable(),
        start_at: isoDateTime(),
      }),
    ),
  }),
  problems: z.object({
    open: z.number(),
    by_severity: countsOf(PROBLEM_SEVERITIES),
    top: z.array(
      z.object({
        id: z.string(),
        kind: z.enum(PROBLEM_KINDS),
        severity: z.enum(PROBLEM_SEVERITIES),
        title: z.string(),
        remedy: z.string(),
      }),
    ),
  }),
  approvals_pending: z.object({
    total: z.number(),
    by_kind: z.array(z.object({ kind: z.enum(APPROVAL_KINDS), count: z.number() })),
  }),
  brain: z.object({
    provider: z.string().nullable().describe("The configured AI provider, null when none"),
    healthy: z.boolean().describe("false while a brain_down problem is open"),
    problem_id: z.string().nullable(),
  }),
  budgets: z.object({
    ai: z.object({ used: z.number(), limit: z.number().nullable(), unit: z.string() }),
    data: z.object({ used: z.number(), limit: z.number().nullable(), unit: z.string() }),
  }),
  recent_changes: z.array(
    z.object({
      version: z.number(),
      area: z.enum(CHANGE_AREAS),
      target_id: z.string().nullable(),
      summary: z.string().describe("Changed paths, e.g. booking.mode, sending.catch_all"),
      by: z.string().nullable(),
      reason: z.string().nullable(),
      at: isoDateTime(),
      undone: z.boolean(),
    }),
  ),
});
export type OperatingState = z.input<typeof operatingStateSchema>;

const ts = (date: Date) => sql`${date.toISOString()}::timestamptz`;

function zeroCounts<T extends string>(keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The workspace summary. */
export async function buildOperatingState(ctx: OpContext): Promise<OperatingState> {
  const workspace = requireWorkspace(ctx);
  const ws = workspace.id;
  const db = ctx.db;
  const now = ctx.clock.now();
  const zone = isValidTimeZone(workspace.timezone) ? workspace.timezone : "UTC";
  const today = localDate(now, zone);
  const dayStart = zonedTimeToUtc(today, 0, 0, zone);
  const dayEnd = startOfNextDay(today, zone);
  const monday = addDays(today, 1 - isoWeekday(today));
  const weekStart = zonedTimeToUtc(monday, 0, 0, zone);
  const weekEnd = zonedTimeToUtc(addDays(monday, 7), 0, 0, zone);

  const [
    campaignCounts,
    topActive,
    sends,
    mailboxRows,
    accountCounts,
    hot,
    approvalCounts,
    meetingCounts,
    upcomingMeetings,
    problemCounts,
    topProblems,
    brainDown,
    changes,
  ] = await Promise.all([
    queryRows<{ status: CampaignStatus; n: number }>(
      db,
      sql`select status, count(*)::int as n from campaigns
        where workspace_id = ${ws} and is_template = false group by status`,
    ),
    queryRows<{ id: string; name: string; sent: number; scheduled: number }>(
      db,
      sql`select c.id, c.name, coalesce(s.sent, 0)::int as sent,
          coalesce(q.scheduled, 0)::int as scheduled
        from campaigns c
        left join (
          select campaign_id, count(*) as sent from messages
          where workspace_id = ${ws} and sent_at >= ${ts(dayStart)} and sent_at < ${ts(dayEnd)}
            and direction = 'outbound' and status in ('sent', 'bounced') and origin = 'engine'
            and campaign_id is not null
          group by campaign_id
        ) s on s.campaign_id = c.id
        left join (
          select campaign_id, count(*) as scheduled from messages
          where workspace_id = ${ws} and status = 'scheduled'
            and scheduled_for >= ${ts(now)} and scheduled_for < ${ts(dayEnd)}
            and campaign_id is not null
          group by campaign_id
        ) q on q.campaign_id = c.id
        where c.workspace_id = ${ws} and c.status = 'active' and c.is_template = false
        order by sent desc, scheduled desc, c.name, c.id
        limit 5`,
    ),
    queryRows<{ emails_sent: number; linkedin_sent: number; emails_scheduled: number }>(
      db,
      sql`select
          (select count(*) from messages
            where workspace_id = ${ws} and sent_at >= ${ts(dayStart)} and sent_at < ${ts(dayEnd)}
              and direction = 'outbound' and status in ('sent', 'bounced') and origin = 'engine'
              and channel = 'email')::int as emails_sent,
          (select count(*) from messages
            where workspace_id = ${ws} and sent_at >= ${ts(dayStart)} and sent_at < ${ts(dayEnd)}
              and direction = 'outbound' and status = 'sent' and origin = 'engine'
              and channel = 'linkedin')::int as linkedin_sent,
          (select count(*) from messages
            where workspace_id = ${ws} and status = 'scheduled' and channel = 'email'
              and scheduled_for >= ${ts(now)} and scheduled_for < ${ts(dayEnd)})::int
            as emails_scheduled`,
    ),
    db
      .select({
        id: mailboxes.id,
        status: mailboxes.status,
        health: mailboxes.health,
        daily_limit: mailboxes.daily_limit,
        ramp: mailboxes.ramp,
        created_at: mailboxes.created_at,
      })
      .from(mailboxes)
      .where(eq(mailboxes.workspace_id, ws)),
    queryRows<{ status: LinkedInAccountStatus; n: number }>(
      db,
      sql`select status, count(*)::int as n from linkedin_accounts
        where workspace_id = ${ws} group by status`,
    ),
    hotReplies(db, ws, now, 1),
    queryRows<{ kind: ApprovalKind; n: number }>(
      db,
      sql`select kind, count(*)::int as n from approvals
        where workspace_id = ${ws} and status = 'pending'
          and (expires_at is null or expires_at > ${ts(now)})
        group by kind order by count(*) desc, kind`,
    ),
    queryRows<{ total: number; booked: number; held: number; no_shows: number }>(
      db,
      sql`select count(*)::int as total,
          count(*) filter (where created_at >= ${ts(weekStart)} and created_at < ${ts(weekEnd)})::int
            as booked,
          count(*) filter (where status = 'held' and start_at >= ${ts(weekStart)}
            and start_at < ${ts(weekEnd)})::int as held,
          count(*) filter (where status = 'no_show' and start_at >= ${ts(weekStart)}
            and start_at < ${ts(weekEnd)})::int as no_shows
        from meetings where workspace_id = ${ws}`,
    ),
    queryRows<{
      id: string;
      person_id: string | null;
      start_ms: number;
      full_name: string | null;
      first_name: string | null;
      last_name: string | null;
    }>(
      db,
      sql`select mt.id, mt.person_id, (extract(epoch from mt.start_at) * 1000)::float8 as start_ms,
          p.full_name, p.first_name, p.last_name
        from meetings mt left join people p on p.id = mt.person_id
        where mt.workspace_id = ${ws} and mt.status = 'scheduled' and mt.start_at >= ${ts(now)}
        order by mt.start_at asc, mt.id limit 5`,
    ),
    queryRows<{ severity: ProblemSeverity; n: number }>(
      db,
      sql`select severity, count(*)::int as n from problems
        where workspace_id = ${ws} and (status = 'open'
          or (status = 'snoozed' and snoozed_until <= ${ts(now)}))
        group by severity`,
    ),
    listProblems(ctx, { limit: 5 }),
    queryRows<{ id: string }>(
      db,
      sql`select id from problems
        where workspace_id = ${ws} and kind = 'brain_down' and (status = 'open'
          or (status = 'snoozed' and snoozed_until <= ${ts(now)}))
        order by created_at limit 1`,
    ),
    db
      .select()
      .from(change_log)
      .where(eq(change_log.workspace_id, ws))
      .orderBy(desc(change_log.version))
      .limit(3),
  ]);

  const campaigns = zeroCounts(CAMPAIGN_STATUSES);
  for (const row of campaignCounts) campaigns[row.status] = row.n;

  const mailboxCounts = zeroCounts(MAILBOX_STATUSES);
  let capacity = 0;
  for (const row of mailboxRows) {
    mailboxCounts[row.status as MailboxStatus] += 1;
    if ((SENDABLE_STATUSES as readonly string[]).includes(row.status) && !holdsQueuedMail(row)) {
      capacity += rampLimit(row.daily_limit, row.ramp, localDate(row.created_at, zone), today);
    }
  }
  const accounts = zeroCounts(LINKEDIN_ACCOUNT_STATUSES);
  for (const row of accountCounts) accounts[row.status] = row.n;

  const approvalsByKind = approvalCounts.map((row) => ({ kind: row.kind, count: row.n }));
  const severities = zeroCounts(PROBLEM_SEVERITIES);
  for (const row of problemCounts) severities[row.severity] = row.n;

  const meetingsSummary = await meetingsThisWeek(ctx, {
    counts: meetingCounts[0] ?? { total: 0, booked: 0, held: 0, no_shows: 0 },
    upcoming: upcomingMeetings,
    now,
    weekStart,
    weekEnd,
    monday,
  });

  const brain = await ctx.providers.tryGet("brain").catch(() => null);
  const [ai, data] = await Promise.all([
    ctx.usage.budgetStatus(ws, "ai"),
    ctx.usage.budgetStatus(ws, "data"),
  ]);
  const sent = sends[0] ?? { emails_sent: 0, linkedin_sent: 0, emails_scheduled: 0 };

  return {
    workspace: { id: ws, name: workspace.name, status: workspace.status, timezone: zone },
    generated_at: now,
    campaigns: {
      by_status: campaigns,
      top_active: topActive.map((row) => ({
        id: row.id,
        name: row.name,
        sent_today: row.sent,
        scheduled_today: row.scheduled,
      })),
    },
    sending_today: {
      day: today,
      emails_sent: sent.emails_sent,
      emails_scheduled: sent.emails_scheduled,
      email_capacity: capacity,
      linkedin_sent: sent.linkedin_sent,
      mailboxes: mailboxCounts,
      linkedin_accounts: accounts,
    },
    replies: {
      hot_waiting: hot.total,
      drafts_waiting_review: approvalsByKind.find((row) => row.kind === "reply")?.count ?? 0,
    },
    meetings_this_week: meetingsSummary,
    problems: {
      open: Object.values(severities).reduce((sum, value) => sum + value, 0),
      by_severity: severities,
      top: topProblems.items.map((row) => ({
        id: row.id,
        kind: row.kind,
        severity: row.severity,
        title: row.title,
        remedy: row.remedy,
      })),
    },
    approvals_pending: {
      total: approvalsByKind.reduce((sum, row) => sum + row.count, 0),
      by_kind: approvalsByKind,
    },
    brain: {
      provider: brain?.id ?? null,
      healthy: Boolean(brain) && brainDown.length === 0,
      problem_id: brainDown[0]?.id ?? null,
    },
    budgets: {
      ai: { used: round2(ai.used), limit: ai.budget, unit: ai.unit },
      data: { used: round2(data.used), limit: data.budget, unit: data.unit },
    },
    recent_changes: changes.map((row) => ({
      version: row.version,
      area: row.area,
      target_id: row.target_id,
      summary: [...new Set((row.diff ?? []).map((entry) => entry.path))].slice(0, 8).join(", "),
      by: row.actor?.name ?? null,
      reason: row.reason,
      at: row.created_at,
      undone: row.undone_at !== null,
    })),
  };
}

interface MeetingCounts {
  total: number;
  booked: number;
  held: number;
  no_shows: number;
}

/** Meetings this week from the meetings table, or from opportunities when there is none yet. */
async function meetingsThisWeek(
  ctx: OpContext,
  input: {
    counts: MeetingCounts;
    upcoming: Array<{
      id: string;
      person_id: string | null;
      start_ms: number;
      full_name: string | null;
      first_name: string | null;
      last_name: string | null;
    }>;
    now: Date;
    weekStart: Date;
    weekEnd: Date;
    monday: string;
  },
): Promise<OperatingState["meetings_this_week"]> {
  const name = (row: {
    full_name: string | null;
    first_name: string | null;
    last_name: string | null;
  }) => row.full_name?.trim() || [row.first_name, row.last_name].filter(Boolean).join(" ") || null;
  if (input.counts.total > 0) {
    return {
      week_start: input.monday,
      source: "meetings",
      booked: input.counts.booked,
      held: input.counts.held,
      no_shows: input.counts.no_shows,
      upcoming: input.upcoming.map((row) => ({
        meeting_id: row.id,
        opportunity_id: null,
        person_id: row.person_id,
        person_name: name(row),
        start_at: new Date(row.start_ms),
      })),
    };
  }
  const ws = requireWorkspace(ctx).id;
  const { weekStart, weekEnd, now } = input;
  const [counts] = await queryRows<{ booked: number; held: number }>(
    ctx.db,
    sql`with first_booked as (
        select e.data->>'opportunity_id' as opportunity_id, min(e.occurred_at) as at
        from events e
        where e.workspace_id = ${ws} and e.type = 'opportunity.updated'
          and e.data->>'stage' = 'meeting_booked'
        group by 1
      )
      select
        count(*) filter (where coalesce(fb.at, case when o.stage = 'meeting_booked'
          or o.meeting_at is not null then o.created_at end) >= ${ts(weekStart)}
          and coalesce(fb.at, case when o.stage = 'meeting_booked'
          or o.meeting_at is not null then o.created_at end) < ${ts(weekEnd)})::int as booked,
        count(*) filter (where o.meeting_at >= ${ts(weekStart)} and o.meeting_at < ${ts(weekEnd)}
          and o.meeting_at <= ${ts(now)} and o.stage in ('meeting_booked', 'won'))::int as held
      from opportunities o
      left join first_booked fb on fb.opportunity_id = o.id
      where o.workspace_id = ${ws}`,
  );
  const upcoming = await queryRows<{
    id: string;
    person_id: string | null;
    start_ms: number;
    full_name: string | null;
    first_name: string | null;
    last_name: string | null;
  }>(
    ctx.db,
    sql`select o.id, o.person_id, (extract(epoch from o.meeting_at) * 1000)::float8 as start_ms,
        p.full_name, p.first_name, p.last_name
      from opportunities o left join people p on p.id = o.person_id
      where o.workspace_id = ${ws} and o.stage = 'meeting_booked' and o.meeting_at >= ${ts(now)}
      order by o.meeting_at asc, o.id limit 5`,
  );
  return {
    week_start: input.monday,
    source: "opportunities",
    booked: counts?.booked ?? 0,
    held: counts?.held ?? 0,
    no_shows: 0,
    upcoming: upcoming.map((row) => ({
      meeting_id: null,
      opportunity_id: row.id,
      person_id: row.person_id,
      person_name: name(row),
      start_at: new Date(row.start_ms),
    })),
  };
}
