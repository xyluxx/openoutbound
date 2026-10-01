import { and, asc, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { StepType } from "../../../core/enums.js";
import { OpenOutboundError } from "../../../core/errors.js";
import { parseCampaignSettings } from "../../../core/settings.js";
import type { Db } from "../../../db/client.js";
import { campaign_steps, campaigns } from "../../../db/schema/index.js";
import { type ActivityCounts, EMPTY_ACTIVITY } from "../activity.js";
import { rate } from "../metric.js";
import type { CampaignData, CampaignRow, StepRow } from "../schemas.js";
import {
  attributedDef,
  CONTACT_ACTIONS,
  LINKEDIN_SENT_ACTIONS,
  literalList,
  meetingsDefs,
  POSITIVE_CATEGORIES,
  repliesDef,
  rows,
  sentDef,
  ts,
  type Window,
  windowsDef,
  withDefs,
} from "../sql.js";
import { type AbMetric, rankVariants } from "./ab-ranking.js";
import {
  type BuildArgs,
  type Built,
  compareCount,
  OUTREACH_METRIC_KEYS,
  outreachMetrics,
  windowsOf,
} from "./common.js";

/** Most campaigns listed when no campaign_id is given. */
export const MAX_CAMPAIGNS = 25;

const MESSAGE_STEP_TYPES: ReadonlySet<StepType> = new Set([
  "email",
  "linkedin_visit",
  "linkedin_like",
  "linkedin_comment",
  "linkedin_invite",
  "linkedin_message",
]);

const STEP_LABELS: Record<StepType, string> = {
  email: "Email",
  linkedin_visit: "LinkedIn visit",
  linkedin_like: "LinkedIn like",
  linkedin_comment: "LinkedIn comment",
  linkedin_invite: "LinkedIn invite",
  linkedin_message: "LinkedIn message",
  wait: "Wait",
  condition: "Condition",
  task: "Task",
  webhook: "Webhook",
};

interface FunnelRow {
  campaign_id: string;
  step_id: string | null;
  variant: string | null;
  is_total: number;
}

interface SentFunnelRow extends FunnelRow {
  sent: number;
  people: number;
  bounced: number;
}

interface ReplyFunnelRow extends FunnelRow {
  replies: number;
  positive_replies: number;
}

interface AcceptedRow {
  campaign_id: string;
  step_id: string | null;
  variant: string | null;
  is_total: number;
  accepted: number;
}

interface VariantMeetingRow {
  campaign_id: string;
  step_id: string | null;
  variant: string;
  meetings: number;
}

/**
 * Campaign funnel by step and variant (spec 11.12). With `campaignId`, one campaign; otherwise
 * every non-template campaign that is active or paused or had activity, busiest first.
 */
export async function buildCampaign(args: BuildArgs): Promise<Built<CampaignData>> {
  const workspaceId = args.workspace.id;
  const conditions = [eq(campaigns.workspace_id, workspaceId), eq(campaigns.is_template, false)];
  if (args.campaignId) conditions.push(eq(campaigns.id, args.campaignId));
  const list = await args.db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      status: campaigns.status,
      settings: campaigns.settings,
    })
    .from(campaigns)
    .where(and(...conditions))
    .orderBy(asc(campaigns.created_at));
  if (args.campaignId && list.length === 0) {
    throw new OpenOutboundError("not_found", `Campaign ${args.campaignId} not found.`, {
      hint: "List campaigns with get_campaigns, then pass one of their ids as campaign_id.",
      details: { what: "Campaign", id: args.campaignId },
    });
  }

  const windows = windowsOf(args);
  const [activity, sentFunnel, replyFunnel, accepted, snapshot, variantMeetings, duplicates] =
    await Promise.all([
      campaignActivity(args.db, workspaceId, windows),
      stepSent(args.db, workspaceId, windows),
      stepReplies(args.db, workspaceId, windows),
      stepAccepted(args.db, workspaceId, windows),
      enrollmentSnapshot(args.db, workspaceId),
      stepVariantMeetings(args.db, workspaceId, windows),
      campaignDuplicates(args.db, workspaceId, windows),
    ]);

  const counts = (id: string) => activity.get(id) ?? [];
  const hasActivity = (id: string) =>
    counts(id).some((row) => Object.values(row).some((value) => value > 0));
  const selected = list
    .filter(
      (campaign) =>
        args.campaignId ||
        campaign.status === "active" ||
        campaign.status === "paused" ||
        hasActivity(campaign.id),
    )
    .sort((a, b) => {
      const left = counts(a.id)[0] ?? EMPTY_ACTIVITY;
      const right = counts(b.id)[0] ?? EMPTY_ACTIVITY;
      return (
        right.contacted - left.contacted ||
        right.emails_sent + right.linkedin_sent - (left.emails_sent + left.linkedin_sent) ||
        a.name.localeCompare(b.name)
      );
    });
  const truncated = selected.length > MAX_CAMPAIGNS;
  const shown = selected.slice(0, MAX_CAMPAIGNS);

  const steps =
    shown.length === 0
      ? []
      : await args.db
          .select()
          .from(campaign_steps)
          .where(
            and(
              eq(campaign_steps.workspace_id, workspaceId),
              inArray(
                campaign_steps.campaign_id,
                shown.map((campaign) => campaign.id),
              ),
            ),
          )
          .orderBy(asc(campaign_steps.position));

  const campaignRows: CampaignRow[] = shown.map((campaign) => {
    const [current = EMPTY_ACTIVITY, previousRow] = counts(campaign.id);
    const previous = args.previous ? (previousRow ?? EMPTY_ACTIVITY) : undefined;
    const ownSteps = steps.filter((step) => step.campaign_id === campaign.id);
    return {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      metrics: {
        enrolled: compareCount(current, previous, (row) => row.enrolled),
        ...outreachMetrics(current, previous),
      },
      enrollments: snapshot.get(campaign.id) ?? {},
      duplicates: duplicates.get(campaign.id) ?? 0,
      steps: stepRows(
        ownSteps,
        {
          sent: sentFunnel.filter((row) => row.campaign_id === campaign.id),
          replies: replyFunnel.filter((row) => row.campaign_id === campaign.id),
          accepted: accepted.filter((row) => row.campaign_id === campaign.id),
          meetings: variantMeetings.filter((row) => row.campaign_id === campaign.id),
        },
        abMetricOf(campaign.settings),
      ),
    };
  });

  const notes: string[] = [];
  if (truncated) {
    notes.push(
      `Showing the ${MAX_CAMPAIGNS} busiest of ${selected.length} campaigns; pass campaign_id for one campaign.`,
    );
  }
  if (campaignRows.length === 0)
    notes.push("No campaigns are active or had activity in this period.");
  for (const row of campaignRows) {
    if (row.duplicates > 0) {
      notes.push(
        `${row.name}: ${row.duplicates} message${row.duplicates === 1 ? "" : "s"} went out twice (an earlier try's answer came late, after a resend); see the duplicate_send problems.`,
      );
    }
  }
  return {
    data: { type: "campaign", campaigns: campaignRows, truncated },
    metrics: ["enrolled", ...OUTREACH_METRIC_KEYS, "sent", "people", "accepted", "duplicates"],
    notes,
  };
}

/** The campaign's A/B metric (`ab_test.metric`), default positive_reply_rate. */
function abMetricOf(settings: unknown): AbMetric {
  try {
    return parseCampaignSettings(settings).ab_test.metric;
  } catch {
    return "positive_reply_rate";
  }
}

/** Variant keys configured on an email step. */
function configuredVariants(config: unknown): string[] {
  if (!isRecord(config) || !Array.isArray(config.variants)) return [];
  return config.variants.flatMap((variant) =>
    isRecord(variant) && typeof variant.key === "string" ? [variant.key] : [],
  );
}

interface StepFunnels {
  sent: SentFunnelRow[];
  replies: ReplyFunnelRow[];
  accepted: AcceptedRow[];
  meetings: VariantMeetingRow[];
}

function stepRows(
  steps: Array<{ id: string; position: number; type: StepType; config: unknown }>,
  funnels: StepFunnels,
  abMetric: AbMetric,
): StepRow[] {
  const messageSteps = steps.filter((step) => MESSAGE_STEP_TYPES.has(step.type));
  const known = new Set(messageSteps.map((step) => step.id));
  const out: StepRow[] = messageSteps.map((step) =>
    funnelRow({
      stepId: step.id,
      position: step.position + 1,
      type: step.type,
      label: stepLabel(step.type, step.config),
      sent: funnels.sent.filter((row) => row.step_id === step.id),
      replies: funnels.replies.filter((row) => row.step_id === step.id),
      accepted: funnels.accepted.filter((row) => row.step_id === step.id),
      meetings: funnels.meetings.filter((row) => row.step_id === step.id),
      configured: configuredVariants(step.config),
      abMetric,
      isEmail: step.type === "email",
    }),
  );
  const other = funnelRow({
    stepId: null,
    position: null,
    type: null,
    label: "Other messages (manual replies, removed steps)",
    sent: funnels.sent.filter((row) => !row.step_id || !known.has(row.step_id)),
    replies: funnels.replies.filter((row) => !row.step_id || !known.has(row.step_id)),
    accepted: [],
    meetings: [],
    configured: [],
    abMetric,
    isEmail: true,
  });
  if (other.sent > 0 || other.replies > 0) {
    out.push({
      ...other,
      variants: [],
      ab_metric: null,
      leader: null,
      confidence: null,
      enough_data: false,
    });
  }
  return out;
}

function funnelRow(input: {
  stepId: string | null;
  position: number | null;
  type: StepType | null;
  label: string;
  sent: SentFunnelRow[];
  replies: ReplyFunnelRow[];
  accepted: AcceptedRow[];
  meetings: VariantMeetingRow[];
  /** Variant keys in the step's config: listed even before they are sent. */
  configured: string[];
  abMetric: AbMetric;
  isEmail: boolean;
}): StepRow {
  const totals = <T extends { is_total: number }>(list: T[]): T[] =>
    list.filter((row) => row.is_total === 1);
  const sum = <T>(list: T[], pick: (row: T) => number) =>
    list.reduce((total, row) => total + pick(row), 0);
  const sentTotals = totals(input.sent);
  const replyTotals = totals(input.replies);
  const acceptedTotals = totals(input.accepted);
  const sentCount = sum(sentTotals, (row) => row.sent);
  const people = sum(sentTotals, (row) => row.people);
  const bounced = sum(sentTotals, (row) => row.bounced);
  const replyCount = sum(replyTotals, (row) => row.replies);
  const positive = sum(replyTotals, (row) => row.positive_replies);

  const variantKeys = new Set<string>(input.configured);
  for (const row of [...input.sent, ...input.replies]) {
    if (row.is_total === 0 && row.variant) variantKeys.add(row.variant);
  }
  const variants = [...variantKeys].sort().map((variant) => {
    const sentRows = input.sent.filter((row) => row.is_total === 0 && row.variant === variant);
    const replyRows = input.replies.filter((row) => row.is_total === 0 && row.variant === variant);
    const vSent = sum(sentRows, (row) => row.sent);
    const vPeople = sum(sentRows, (row) => row.people);
    const vBounced = sum(sentRows, (row) => row.bounced);
    const vReplies = sum(replyRows, (row) => row.replies);
    const vPositive = sum(replyRows, (row) => row.positive_replies);
    const vMeetings = sum(
      input.meetings.filter((row) => row.variant === variant),
      (row) => row.meetings,
    );
    return {
      variant,
      sent: vSent,
      people: vPeople,
      bounced: vBounced,
      replies: vReplies,
      positive_replies: vPositive,
      reply_rate: rate(vReplies, vPeople),
      positive_rate: rate(vPositive, vPeople),
      bounce_rate: input.isEmail ? rate(vBounced, vSent) : null,
      meetings: vMeetings,
      meeting_rate: rate(vMeetings, vPeople),
    };
  });
  const ranking = rankVariants(variants, input.abMetric);
  return {
    step_id: input.stepId,
    position: input.position,
    type: input.type,
    label: input.label,
    sent: sentCount,
    people,
    bounced,
    replies: replyCount,
    positive_replies: positive,
    reply_rate: rate(replyCount, people),
    positive_rate: rate(positive, people),
    bounce_rate: input.isEmail ? rate(bounced, sentCount) : null,
    accepted: input.type === "linkedin_invite" ? sum(acceptedTotals, (row) => row.accepted) : null,
    variants,
    ab_metric: variants.length > 0 ? input.abMetric : null,
    leader: ranking.leader,
    confidence: ranking.confidence,
    enough_data: ranking.enough_data,
  };
}

function stepLabel(type: StepType, config: unknown): string {
  const base = STEP_LABELS[type];
  if (type === "email" && isRecord(config) && config.mode === "reply")
    return `${base} (same thread)`;
  return base;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Activity per campaign and window (contacted, sent, replies, meetings, enrolled). */
async function campaignActivity(
  db: Db,
  workspaceId: string,
  windows: Window[],
): Promise<Map<string, ActivityCounts[]>> {
  const ids = [workspaceId];
  const w = windowsDef(windows);
  interface Keyed {
    campaign_id: string;
    idx: number;
  }
  const [sent, replies, meetings, enrolled] = await Promise.all([
    rows<
      Keyed & { emails_sent: number; bounced: number; linkedin_sent: number; contacted: number }
    >(db, sqlCampaignSent(w, ids)),
    rows<Keyed & { replies: number; positive_replies: number }>(
      db,
      sql`${withDefs(w, repliesDef(ids), attributedDef())}
        select campaign_id, idx,
          count(distinct person_id)::int as replies,
          count(distinct person_id) filter (
            where category in (${literalList(POSITIVE_CATEGORIES)})
          )::int as positive_replies
        from attributed where campaign_id is not null
        group by 1, 2`,
    ),
    rows<Keyed & { n: number }>(
      db,
      sql`${withDefs(w, ...meetingsDefs(ids))}
        select campaign_id, idx, count(*)::int as n
        from meetings where campaign_id is not null group by 1, 2`,
    ),
    rows<Keyed & { n: number }>(
      db,
      sql`${withDefs(w)}
        select e.campaign_id, w.idx, count(*)::int as n
        from enrollments e join w on e.enrolled_at >= w.f and e.enrolled_at < w.t
        where e.workspace_id = ${workspaceId}
        group by 1, 2`,
    ),
  ]);
  const out = new Map<string, ActivityCounts[]>();
  const at = (row: Keyed): ActivityCounts | undefined => {
    let list = out.get(row.campaign_id);
    if (!list) {
      list = windows.map(() => ({ ...EMPTY_ACTIVITY }));
      out.set(row.campaign_id, list);
    }
    return list[row.idx];
  };
  for (const row of sent) {
    const target = at(row);
    if (!target) continue;
    target.emails_sent = row.emails_sent;
    target.bounced = row.bounced;
    target.linkedin_sent = row.linkedin_sent;
    target.contacted = row.contacted;
  }
  for (const row of replies) {
    const target = at(row);
    if (!target) continue;
    target.replies = row.replies;
    target.positive_replies = row.positive_replies;
  }
  for (const row of meetings) {
    const target = at(row);
    if (target) target.meetings = row.n;
  }
  for (const row of enrolled) {
    const target = at(row);
    if (target) target.enrolled = row.n;
  }
  return out;
}

function sqlCampaignSent(w: SQL, ids: string[]): SQL {
  return sql`${withDefs(w, sentDef(ids))}
    select campaign_id, idx,
      count(*) filter (where channel = 'email')::int as emails_sent,
      count(*) filter (where channel = 'email' and status = 'bounced')::int as bounced,
      count(*) filter (
        where channel = 'linkedin' and action in (${literalList(LINKEDIN_SENT_ACTIONS)})
      )::int as linkedin_sent,
      count(distinct person_id) filter (
        where action in (${literalList(CONTACT_ACTIONS)})
      )::int as contacted
    from sent where campaign_id is not null
    group by 1, 2`;
}

/** Sent per step and variant in the current window, with exact per-step totals. */
function stepSent(db: Db, workspaceId: string, windows: Window[]): Promise<SentFunnelRow[]> {
  return rows<SentFunnelRow>(
    db,
    sql`${withDefs(windowsDef(windows.slice(0, 1)), sentDef([workspaceId]))}
      select campaign_id, step_id, variant, grouping(variant)::int as is_total,
        count(*)::int as sent,
        count(distinct person_id)::int as people,
        count(*) filter (where status = 'bounced')::int as bounced
      from sent where campaign_id is not null
      group by grouping sets ((campaign_id, step_id, variant), (campaign_id, step_id))`,
  );
}

/** Replies per step and variant in the current window, with exact per-step totals. */
function stepReplies(db: Db, workspaceId: string, windows: Window[]): Promise<ReplyFunnelRow[]> {
  return rows<ReplyFunnelRow>(
    db,
    sql`${withDefs(windowsDef(windows.slice(0, 1)), repliesDef([workspaceId]), attributedDef())}
      select campaign_id, step_id, variant, grouping(variant)::int as is_total,
        count(distinct person_id)::int as replies,
        count(distinct person_id) filter (
          where category in (${literalList(POSITIVE_CATEGORIES)})
        )::int as positive_replies
      from attributed where campaign_id is not null
      group by grouping sets ((campaign_id, step_id, variant), (campaign_id, step_id))`,
  );
}

/** LinkedIn invites sent in the current window whose relation is now connected. */
function stepAccepted(db: Db, workspaceId: string, windows: Window[]): Promise<AcceptedRow[]> {
  return rows<AcceptedRow>(
    db,
    sql`${withDefs(windowsDef(windows.slice(0, 1)), sentDef([workspaceId]))}
      select s.campaign_id, s.step_id, s.variant, grouping(s.variant)::int as is_total,
        count(distinct s.person_id)::int as accepted
      from sent s
      join linkedin_relations lr
        on lr.account_id = s.linkedin_account_id and lr.person_id = s.person_id
      where s.action = 'invite' and lr.status = 'connected' and s.campaign_id is not null
      group by grouping sets ((s.campaign_id, s.step_id, s.variant), (s.campaign_id, s.step_id))`,
  );
}

/**
 * Per step and variant: people who got the variant in the current window and booked a meeting
 * at or after that send (up to now), from the meetings table (not cancelled) or, for data from
 * before it existed, an opportunity that reached meeting_booked and has no meeting record (so a
 * cancelled meeting never comes back through its opportunity). A meeting counts for the
 * variant's campaign or when it names no campaign.
 */
function stepVariantMeetings(
  db: Db,
  workspaceId: string,
  windows: Window[],
): Promise<VariantMeetingRow[]> {
  return rows<VariantMeetingRow>(
    db,
    sql`${withDefs(
      windowsDef(windows.slice(0, 1)),
      sentDef([workspaceId]),
      sql`first_booked as (
        select e.data->>'opportunity_id' as opportunity_id, min(e.occurred_at) as at
        from events e
        where e.workspace_id = ${workspaceId} and e.type = 'opportunity.updated'
          and e.data->>'stage' = 'meeting_booked'
        group by 1
      )`,
      sql`booked as (
        select mt.person_id, mt.campaign_id, mt.created_at as at
        from meetings mt
        where mt.workspace_id = ${workspaceId} and mt.person_id is not null
          and mt.status <> 'cancelled'
        union all
        select o.person_id, o.campaign_id, coalesce(fb.at, o.created_at) as at
        from opportunities o
        left join first_booked fb on fb.opportunity_id = o.id
        where o.workspace_id = ${workspaceId} and o.person_id is not null
          and (fb.at is not null or o.stage = 'meeting_booked' or o.meeting_at is not null)
          and not exists (
            select 1 from meetings mt
            where mt.workspace_id = o.workspace_id and mt.opportunity_id = o.id
          )
      )`,
    )}
      select s.campaign_id, s.step_id, s.variant, count(distinct s.person_id)::int as meetings
      from sent s
      where s.campaign_id is not null and s.variant is not null
        and exists (
          select 1 from booked b
          where b.person_id = s.person_id and b.at >= s.sent_at
            and (b.campaign_id is null or b.campaign_id = s.campaign_id)
        )
      group by 1, 2, 3`,
  );
}

/**
 * Messages per campaign that went out twice in the current window: one per message, from the
 * `message.duplicate` events (docs/concepts/delivery-guarantees.md).
 */
async function campaignDuplicates(
  db: Db,
  workspaceId: string,
  windows: Window[],
): Promise<Map<string, number>> {
  const [current] = windows;
  if (!current) return new Map();
  const list = await rows<{ campaign_id: string; n: number }>(
    db,
    sql`select e.data->>'campaign_id' as campaign_id,
        count(distinct e.data->>'message_id')::int as n
      from events e
      where e.workspace_id = ${workspaceId} and e.type = 'message.duplicate'
        and e.occurred_at >= ${ts(current.from)} and e.occurred_at < ${ts(current.to)}
        and e.data->>'campaign_id' is not null
      group by 1`,
  );
  return new Map(list.map((row) => [row.campaign_id, row.n]));
}

/** Enrollments by status right now, per campaign. */
async function enrollmentSnapshot(
  db: Db,
  workspaceId: string,
): Promise<Map<string, Record<string, number>>> {
  const list = await rows<{ campaign_id: string; status: string; n: number }>(
    db,
    sql`select campaign_id, status, count(*)::int as n
      from enrollments where workspace_id = ${workspaceId}
      group by 1, 2 order by 2`,
  );
  const out = new Map<string, Record<string, number>>();
  for (const row of list) {
    const record = out.get(row.campaign_id) ?? {};
    record[row.status] = row.n;
    out.set(row.campaign_id, record);
  }
  return out;
}
