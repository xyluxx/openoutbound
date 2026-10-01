/** Everything the relationship view reads about one person, in a few workspace-scoped queries. */
import { and, asc, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { OpContext } from "../../core/context.js";
import type { Channel, ReplyCategory } from "../../core/enums.js";
import { queryRows } from "../../db/client.js";
import {
  approvals,
  type Campaign,
  type CampaignStep,
  type Company,
  campaign_steps,
  campaigns,
  type Enrollment,
  enrollments,
  type Meeting,
  type Message,
  meetings,
  messages,
  type Opportunity,
  opportunities,
  type Person,
  problems,
  type Suppression,
  type Task,
  tasks,
} from "../../db/schema/index.js";
import { findSuppressions, suppressionCandidates } from "../leads/suppressions.js";
import { OPEN_MESSAGE_STATUSES } from "./eligibility-loader.js";

/** A thread that is not closed, with its latest real message (sent or received). */
export interface OpenThread {
  id: string;
  channel: Channel;
  owner: "engine" | "person";
  owner_changed_at: Date | null;
  campaign_id: string | null;
  latest_direction: "inbound" | "outbound" | null;
  latest_category: ReplyCategory | null;
  latest_at: Date | null;
}

export interface LatestReply {
  id: string;
  thread_id: string | null;
  category: ReplyCategory | null;
  at: Date;
}

export interface EnrollmentWithCampaign {
  enrollment: Enrollment;
  campaign: Pick<Campaign, "id" | "name" | "status">;
  /** The step at `current_step`, when it still exists. */
  step: Pick<CampaignStep, "id" | "type" | "position" | "config"> | null;
}

export interface RelationshipFacts {
  person: Person;
  company: Company | null;
  suppressions: Suppression[];
  /** Their privacy requests still open, oldest first. */
  privacy: Array<{ id: string; created_at: Date }>;
  /** They made a privacy request at some point (open or resolved). */
  askedForPrivacy: boolean;
  opportunities: Opportunity[];
  meetings: Meeting[];
  threads: OpenThread[];
  latestReply: LatestReply | null;
  enrollments: EnrollmentWithCampaign[];
  openMessages: Message[];
  /** Pending approvals of the open messages, by message id. */
  approvals: Map<string, { id: string; created_at: Date; expires_at: Date | null }>;
  /** Pending approvals naming the person in their payload (not tied to one of their messages). */
  otherApprovals: Array<{ id: string; title: string; created_at: Date }>;
  tasks: Task[];
}

const toDate = (value: number | null): Date | null => (value === null ? null : new Date(value));

export async function loadRelationshipFacts(
  ctx: OpContext,
  person: Person,
  company: Company | null,
): Promise<RelationshipFacts> {
  const ws = person.workspace_id;
  const db = ctx.db;
  const [
    suppressionRows,
    privacy,
    opportunityRows,
    meetingRows,
    threadRows,
    latest,
    enrollmentRows,
    openRows,
    otherApprovalRows,
    taskRows,
  ] = await Promise.all([
    findSuppressions(
      db,
      ws,
      suppressionCandidates({
        email: person.email,
        linkedin_url: person.linkedin_url,
        person_id: person.id,
        company_id: person.company_id,
        company_domain: company?.domain ?? null,
      }),
    ),
    db
      .select({ id: problems.id, created_at: problems.created_at, status: problems.status })
      .from(problems)
      .where(
        and(
          eq(problems.workspace_id, ws),
          eq(problems.kind, "privacy_request"),
          eq(problems.person_id, person.id),
        ),
      )
      .orderBy(asc(problems.created_at)),
    db
      .select()
      .from(opportunities)
      .where(and(eq(opportunities.workspace_id, ws), eq(opportunities.person_id, person.id)))
      .orderBy(desc(opportunities.updated_at)),
    db
      .select()
      .from(meetings)
      .where(and(eq(meetings.workspace_id, ws), eq(meetings.person_id, person.id)))
      .orderBy(asc(meetings.start_at)),
    queryRows<{
      id: string;
      channel: Channel;
      owner: "engine" | "person";
      owner_ms: number | null;
      campaign_id: string | null;
      direction: "inbound" | "outbound" | null;
      category: ReplyCategory | null;
      at_ms: number | null;
    }>(
      db,
      sql`select t.id, t.channel, t.owner,
          (extract(epoch from t.owner_changed_at) * 1000)::float8 as owner_ms, t.campaign_id,
          lm.direction, lm.category, (extract(epoch from lm.at) * 1000)::float8 as at_ms
        from threads t
        left join lateral (
          select m.direction, m.classification->>'category' as category,
            coalesce(m.received_at, m.sent_at, m.created_at) as at
          from messages m
          where m.thread_id = t.id and m.status in ('sent', 'received')
          order by coalesce(m.received_at, m.sent_at, m.created_at) desc
          limit 1
        ) lm on true
        where t.workspace_id = ${ws} and t.person_id = ${person.id} and t.status <> 'closed'
        order by t.last_message_at desc nulls last, t.id`,
    ),
    queryRows<{
      id: string;
      thread_id: string | null;
      category: ReplyCategory | null;
      at_ms: number;
    }>(
      db,
      sql`select m.id, m.thread_id, m.classification->>'category' as category,
          (extract(epoch from coalesce(m.received_at, m.created_at)) * 1000)::float8 as at_ms
        from messages m
        where m.workspace_id = ${ws} and m.person_id = ${person.id} and m.direction = 'inbound'
        order by coalesce(m.received_at, m.created_at) desc
        limit 1`,
    ),
    db
      .select({
        enrollment: enrollments,
        campaign: { id: campaigns.id, name: campaigns.name, status: campaigns.status },
        step: {
          id: campaign_steps.id,
          type: campaign_steps.type,
          position: campaign_steps.position,
          config: campaign_steps.config,
        },
      })
      .from(enrollments)
      .innerJoin(campaigns, eq(campaigns.id, enrollments.campaign_id))
      .leftJoin(
        campaign_steps,
        and(
          eq(campaign_steps.campaign_id, enrollments.campaign_id),
          eq(campaign_steps.position, enrollments.current_step),
        ),
      )
      .where(and(eq(enrollments.workspace_id, ws), eq(enrollments.person_id, person.id)))
      .orderBy(desc(enrollments.enrolled_at)),
    db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.workspace_id, ws),
          eq(messages.person_id, person.id),
          eq(messages.direction, "outbound"),
          inArray(messages.status, [...OPEN_MESSAGE_STATUSES]),
        ),
      )
      .orderBy(asc(messages.scheduled_for), asc(messages.created_at)),
    db
      .select({ id: approvals.id, title: approvals.title, created_at: approvals.created_at })
      .from(approvals)
      .where(
        and(
          eq(approvals.workspace_id, ws),
          eq(approvals.status, "pending"),
          sql`${approvals.payload}->>'person_id' = ${person.id}`,
          or(sql`${approvals.target_type} is null`, ne(approvals.target_type, "message")),
        ),
      )
      .orderBy(asc(approvals.created_at)),
    db
      .select()
      .from(tasks)
      .where(
        and(eq(tasks.workspace_id, ws), eq(tasks.person_id, person.id), eq(tasks.status, "open")),
      )
      .orderBy(asc(tasks.due_at), asc(tasks.created_at)),
  ]);

  const openIds = openRows.map((row) => row.id);
  const approvalRows =
    openIds.length > 0
      ? await db
          .select({
            id: approvals.id,
            target_id: approvals.target_id,
            created_at: approvals.created_at,
            expires_at: approvals.expires_at,
          })
          .from(approvals)
          .where(
            and(
              eq(approvals.workspace_id, ws),
              eq(approvals.status, "pending"),
              eq(approvals.target_type, "message"),
              inArray(approvals.target_id, openIds),
            ),
          )
      : [];
  const byMessage = new Map<string, { id: string; created_at: Date; expires_at: Date | null }>();
  for (const row of approvalRows) {
    if (row.target_id && !byMessage.has(row.target_id)) {
      byMessage.set(row.target_id, {
        id: row.id,
        created_at: row.created_at,
        expires_at: row.expires_at,
      });
    }
  }

  const reply = latest[0];
  return {
    person,
    company,
    suppressions: suppressionRows,
    privacy: privacy
      .filter((row) => row.status !== "resolved")
      .map((row) => ({ id: row.id, created_at: row.created_at })),
    askedForPrivacy: privacy.length > 0,
    opportunities: opportunityRows,
    meetings: meetingRows,
    threads: threadRows.map((row) => ({
      id: row.id,
      channel: row.channel,
      owner: row.owner,
      owner_changed_at: toDate(row.owner_ms),
      campaign_id: row.campaign_id,
      latest_direction: row.direction,
      latest_category: row.category,
      latest_at: toDate(row.at_ms),
    })),
    latestReply: reply
      ? {
          id: reply.id,
          thread_id: reply.thread_id,
          category: reply.category,
          at: new Date(reply.at_ms),
        }
      : null,
    enrollments: enrollmentRows.map((row) => ({
      enrollment: row.enrollment,
      campaign: row.campaign,
      step: row.step?.id ? row.step : null,
    })),
    openMessages: openRows,
    approvals: byMessage,
    otherApprovals: otherApprovalRows,
    tasks: taskRows,
  };
}
