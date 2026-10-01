/**
 * Stuck rules: relationships that stopped moving without anyone noticing. Every 15 minutes per
 * workspace the job opens or refreshes one `stuck` problem per case (dedupe
 * `stuck:<rule>:<id>`) and resolves the ones whose condition cleared. A problem whose wording and
 * data did not change is left alone, so a quiet workspace writes nothing. People nobody may
 * contact any more (a privacy request, an opt-out, do not contact) are left out: nothing should
 * prompt reaching them. The relationship view runs the same queries for one person. Unknown sends, overdue promises and privacy deadlines
 * are other problem kinds and are not repeated here.
 */
import { and, eq, like, ne, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { stableStringify } from "../../brain/hash.js";
import type { OpContext } from "../../core/context.js";
import type { ProblemOwner, ProblemSeverity } from "../../core/enums.js";
import { defineJob } from "../../core/operation.js";
import { parseWorkspaceSettings, type WorkspaceSettings } from "../../core/settings.js";
import { queryRows } from "../../db/client.js";
import { type Problem, problems, workspaces } from "../../db/schema/index.js";
import { isValidTimeZone } from "../email/timezone.js";
import { peopleNotToContact } from "../leads/contactable.js";
import { openProblem, resolveProblem } from "../problems/service.js";
import { whenInWords } from "./blockers.js";

export const STUCK_RULES = [
  "hot_reply_unanswered",
  "active_no_next_step",
  "approval_waiting",
  "meeting_unmarked",
] as const;
export type StuckRule = (typeof STUCK_RULES)[number];

/** One stuck case, ready to open as a problem. */
export interface StuckItem {
  rule: StuckRule;
  dedupeKey: string;
  severity: ProblemSeverity;
  /** Who should handle it (default anyone): a person for a conversation a person owns. */
  owner: ProblemOwner;
  title: string;
  reason: string;
  remedy: string;
  personId: string | null;
  companyId: string | null;
  subject: { type: string; id: string };
  dueAt: Date | null;
  data: Record<string, unknown>;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** A hot reply with nothing sent or drafted for this long is stuck. */
export const HOT_REPLY_STUCK_MS = 24 * HOUR_MS;
/** Hot replies older than this are handled elsewhere (the attention queue's lookback). */
const HOT_REPLY_LOOKBACK_MS = 30 * DAY_MS;
/** An approval waiting this long is stuck. */
export const APPROVAL_STUCK_MS = 72 * HOUR_MS;
/** A past meeting still `scheduled` this long after its start is stuck (automatic held off). */
export const MEETING_UNMARKED_MS = 48 * HOUR_MS;
/** A due sequence step not picked up for this long counts as no step due. */
const OVERDUE_STEP_MS = 6 * HOUR_MS;
/** At most this many problems per rule and run; the rest wait for the next run. */
export const STUCK_CAP = 200;

const OPEN_OUTBOUND = sql.raw(
  "'generating', 'draft', 'pending_review', 'approved', 'scheduled', 'sending', 'unknown'",
);

interface RuleContext {
  ctx: OpContext;
  workspaceId: string;
  zone: string;
  now: Date;
  settings: WorkspaceSettings;
  personId: string | null;
  limit: number;
}

interface RuleDefinition {
  rule: StuckRule;
  /** Plain words stored as the resolution when the condition clears. */
  cleared: string;
  /** Skipped while the workspace is paused (nothing moves then; the pause is the reason). */
  skipWhenPaused: boolean;
  find(env: RuleContext): Promise<StuckItem[]>;
}

const ts = (date: Date): SQL => sql`${date.toISOString()}::timestamptz`;
const ms = (expression: SQL): SQL => sql`(extract(epoch from ${expression}) * 1000)::float8`;
const personFilter = (column: string, personId: string | null): SQL =>
  personId ? sql`and ${sql.raw(column)} = ${personId}` : sql``;

interface NameColumns {
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

function nameOf(row: NameColumns): string {
  return (
    row.full_name?.trim() ||
    [row.first_name, row.last_name].filter(Boolean).join(" ").trim() ||
    row.email ||
    "an unnamed lead"
  );
}

/**
 * Hot replies with nothing drafted or sent for 24 hours. A reply whose person has a meeting
 * recorded since (not cancelled) is answered by that meeting. In a conversation a person took
 * over, the problem is theirs: the remedy reminds them instead of asking anyone to draft.
 */
const hotReplyRule: RuleDefinition = {
  rule: "hot_reply_unanswered",
  cleared: "An answer was drafted or sent, a meeting was recorded, or the conversation moved on.",
  skipWhenPaused: false,
  async find({ ctx, workspaceId, now, personId, limit, zone }) {
    const rows = await queryRows<
      NameColumns & {
        thread_id: string;
        person_id: string | null;
        company_id: string | null;
        channel: string;
        owner: string;
        inbound_id: string;
        category: string;
        at_ms: number;
      }
    >(
      ctx.db,
      sql`select t.id as thread_id, t.person_id, coalesce(t.company_id, p.company_id) as company_id,
          t.channel, t.owner, li.id as inbound_id, li.category, ${ms(sql`li.at`)} as at_ms,
          p.full_name, p.first_name, p.last_name, p.email
        from threads t
        join lateral (
          select m.id, coalesce(m.received_at, m.created_at) as at,
            coalesce(m.classification->>'category', t.category) as category
          from messages m
          where m.thread_id = t.id and m.direction = 'inbound'
          order by coalesce(m.received_at, m.created_at) desc
          limit 1
        ) li on true
        left join people p on p.id = t.person_id
        where t.workspace_id = ${workspaceId} and t.status <> 'closed'
          and t.last_inbound_at >= ${ts(new Date(now.getTime() - HOT_REPLY_LOOKBACK_MS))}
          and li.category in ('interested', 'meeting_request')
          and li.at <= ${ts(new Date(now.getTime() - HOT_REPLY_STUCK_MS))}
          and li.at >= ${ts(new Date(now.getTime() - HOT_REPLY_LOOKBACK_MS))}
          and not exists (
            select 1 from messages o
            where o.thread_id = t.id and o.direction = 'outbound'
              and o.status in (${OPEN_OUTBOUND}, 'sent')
              and coalesce(o.sent_at, o.created_at) >= li.at
          )
          and not exists (
            select 1 from meetings mt
            where mt.workspace_id = t.workspace_id and mt.person_id = t.person_id
              and mt.status <> 'cancelled' and mt.created_at >= li.at
          )
          ${personFilter("t.person_id", personId)}
        order by li.at asc, t.id
        limit ${limit}`,
    );
    return rows.map((row) => {
      const who = nameOf(row);
      const category = row.category === "meeting_request" ? "meeting request" : "interested";
      const owned = row.owner === "person";
      return {
        rule: "hot_reply_unanswered",
        dedupeKey: `stuck:hot_reply_unanswered:${row.thread_id}`,
        severity: "high",
        owner: owned ? "person" : "anyone",
        title: `Hot reply from ${who} waits for an answer`,
        reason: `${who} replied (${category}) on ${whenInWords(new Date(row.at_ms), zone, now)}, and nothing has been drafted or sent since.`,
        remedy: owned
          ? `A person owns this conversation: remind them to answer ${who}. Hand it back with reply_to_thread action release (thread_id ${row.thread_id}) only if they ask.`
          : `Draft an answer with reply_to_thread action draft (thread_id ${row.thread_id}), then send it with reply_to_thread action send.`,
        personId: row.person_id,
        companyId: row.company_id,
        subject: { type: "thread", id: row.thread_id },
        dueAt: new Date(row.at_ms + HOT_REPLY_STUCK_MS),
        data: {
          thread_id: row.thread_id,
          inbound_message_id: row.inbound_id,
          category: row.category,
          channel: row.channel,
          received_at: new Date(row.at_ms).toISOString(),
        },
      };
    });
  },
};

const activeNoStepRule: RuleDefinition = {
  rule: "active_no_next_step",
  cleared: "The sequence has a next step or a queued message again, or it ended.",
  skipWhenPaused: true,
  async find({ ctx, workspaceId, now, personId, limit, zone }) {
    const rows = await queryRows<
      NameColumns & {
        enrollment_id: string;
        person_id: string;
        company_id: string | null;
        campaign_id: string;
        campaign_name: string;
        current_step: number;
        next_ms: number | null;
      }
    >(
      ctx.db,
      sql`select e.id as enrollment_id, e.person_id, p.company_id, e.campaign_id,
          c.name as campaign_name, e.current_step, ${ms(sql`e.next_run_at`)} as next_ms,
          p.full_name, p.first_name, p.last_name, p.email
        from enrollments e
        join campaigns c on c.id = e.campaign_id
        join people p on p.id = e.person_id
        where e.workspace_id = ${workspaceId} and e.status = 'active' and c.status = 'active'
          and (e.next_run_at is null
            or e.next_run_at < ${ts(new Date(now.getTime() - OVERDUE_STEP_MS))})
          and not exists (
            select 1 from messages m
            where m.enrollment_id = e.id and m.status in (${OPEN_OUTBOUND})
          )
          ${personFilter("e.person_id", personId)}
        order by e.next_run_at asc nulls first, e.id
        limit ${limit}`,
    );
    return rows.map((row) => {
      const who = nameOf(row);
      const when =
        row.next_ms === null
          ? "no step is due"
          : `its step was due on ${whenInWords(new Date(row.next_ms), zone, now)} and never ran`;
      return {
        rule: "active_no_next_step",
        dedupeKey: `stuck:active_no_next_step:${row.enrollment_id}`,
        severity: "normal",
        owner: "anyone",
        title: `Sequence stuck for ${who}`,
        reason: `${who} is active in campaign ${row.campaign_name} (step ${row.current_step + 1}), but no message is queued and ${when}.`,
        remedy: `Look at the enrollment with get_campaigns action enrollments (campaign_id ${row.campaign_id}); if the step cannot run, fix it with create_campaign action update, or take ${who} out with enroll_leads action unenroll.`,
        personId: row.person_id,
        companyId: row.company_id,
        subject: { type: "enrollment", id: row.enrollment_id },
        dueAt: null,
        data: {
          enrollment_id: row.enrollment_id,
          campaign_id: row.campaign_id,
          step: row.current_step + 1,
          next_run_at: row.next_ms === null ? null : new Date(row.next_ms).toISOString(),
        },
      };
    });
  },
};

const approvalRule: RuleDefinition = {
  rule: "approval_waiting",
  cleared: "The approval was decided or expired.",
  skipWhenPaused: false,
  async find({ ctx, workspaceId, now, personId, limit, zone }) {
    const person = sql`coalesce(a.payload->>'person_id', m.person_id)`;
    const rows = await queryRows<
      NameColumns & {
        id: string;
        kind: string;
        title: string;
        person_id: string | null;
        company_id: string | null;
        created_ms: number;
        expires_ms: number | null;
      }
    >(
      ctx.db,
      sql`select a.id, a.kind, a.title, ${person} as person_id, p.company_id,
          ${ms(sql`a.created_at`)} as created_ms, ${ms(sql`a.expires_at`)} as expires_ms,
          p.full_name, p.first_name, p.last_name, p.email
        from approvals a
        left join messages m on a.target_type = 'message' and m.id = a.target_id
        left join people p on p.id = ${person}
        where a.workspace_id = ${workspaceId} and a.status = 'pending'
          and a.created_at < ${ts(new Date(now.getTime() - APPROVAL_STUCK_MS))}
          and (a.expires_at is null or a.expires_at > ${ts(now)})
          ${personId ? sql`and ${person} = ${personId}` : sql``}
        order by a.created_at asc, a.id
        limit ${limit}`,
    );
    return rows.map((row) => {
      const days = Math.floor((now.getTime() - row.created_ms) / DAY_MS);
      const who = row.person_id ? ` for ${nameOf(row)}` : "";
      return {
        rule: "approval_waiting",
        dedupeKey: `stuck:approval_waiting:${row.id}`,
        severity: "normal",
        owner: "anyone",
        title: `Approval waiting ${days} days: ${row.title}`.slice(0, 300),
        reason: `"${row.title}"${who} has waited for a decision since ${whenInWords(new Date(row.created_ms), zone, now)} (${days} days).${row.expires_ms ? ` It expires ${whenInWords(new Date(row.expires_ms), zone, now)}.` : ""}`,
        remedy: `Decide it with review_items action decide (approval_id ${row.id}).`,
        personId: row.person_id,
        companyId: row.company_id,
        subject: { type: "approval", id: row.id },
        dueAt: row.expires_ms === null ? null : new Date(row.expires_ms),
        data: { approval_id: row.id, kind: row.kind },
      };
    });
  },
};

const meetingRule: RuleDefinition = {
  rule: "meeting_unmarked",
  cleared: "The meeting was marked held, no-show or cancelled, or moved to a later time.",
  skipWhenPaused: false,
  async find({ ctx, workspaceId, now, personId, limit, settings, zone }) {
    if (settings.booking.assume_held_after_hours !== 0) return [];
    const rows = await queryRows<
      NameColumns & {
        id: string;
        person_id: string | null;
        company_id: string | null;
        start_ms: number;
      }
    >(
      ctx.db,
      sql`select mt.id, mt.person_id, coalesce(mt.company_id, p.company_id) as company_id,
          ${ms(sql`mt.start_at`)} as start_ms, p.full_name, p.first_name, p.last_name, p.email
        from meetings mt
        left join people p on p.id = mt.person_id
        where mt.workspace_id = ${workspaceId} and mt.status = 'scheduled'
          and mt.start_at < ${ts(new Date(now.getTime() - MEETING_UNMARKED_MS))}
          ${personFilter("mt.person_id", personId)}
        order by mt.start_at asc, mt.id
        limit ${limit}`,
    );
    return rows.map((row) => {
      const who = row.person_id ? nameOf(row) : "a lead";
      return {
        rule: "meeting_unmarked",
        dedupeKey: `stuck:meeting_unmarked:${row.id}`,
        severity: "normal",
        owner: "anyone",
        title: `Meeting with ${who} has no outcome`,
        reason: `The meeting on ${whenInWords(new Date(row.start_ms), zone, now)} started over 48 hours ago and is still marked scheduled; automatic held is off (booking.assume_held_after_hours is 0).`,
        remedy: `Record what happened with manage_meetings action mark_held or mark_no_show (meeting_id ${row.id}).`,
        personId: row.person_id,
        companyId: row.company_id,
        subject: { type: "meeting", id: row.id },
        dueAt: null,
        data: { meeting_id: row.id, start_at: new Date(row.start_ms).toISOString() },
      };
    });
  },
};

/** Resolution of a stuck problem whose person may not be contacted any more. */
const NOT_TO_CONTACT = "The person may not be contacted any more.";

/**
 * Leaves out the cases of people nobody may contact any more: on any channel, and for a reply
 * also on the channel it came in on. Returns the dedupe keys it left out.
 */
async function contactableOnly(
  ctx: OpContext,
  items: StuckItem[],
): Promise<{ kept: StuckItem[]; left: Set<string> }> {
  const ids = items.map((item) => item.personId);
  const channelOf = (item: StuckItem) => {
    const channel = item.rule === "hot_reply_unanswered" ? item.data.channel : null;
    return channel === "email" || channel === "linkedin" ? channel : null;
  };
  const [anyChannel, email, linkedin] = await Promise.all([
    peopleNotToContact(ctx, ids),
    peopleNotToContact(
      ctx,
      items.filter((item) => channelOf(item) === "email").map((item) => item.personId),
      "email",
    ),
    peopleNotToContact(
      ctx,
      items.filter((item) => channelOf(item) === "linkedin").map((item) => item.personId),
      "linkedin",
    ),
  ]);
  const kept: StuckItem[] = [];
  const left = new Set<string>();
  for (const item of items) {
    const id = item.personId;
    const channel = channelOf(item);
    const blocked =
      id !== null &&
      (anyChannel.has(id) ||
        (channel === "email" && email.has(id)) ||
        (channel === "linkedin" && linkedin.has(id)));
    if (blocked) left.add(item.dedupeKey);
    else kept.push(item);
  }
  return { kept, left };
}

/** Every rule, most urgent first. */
const RULES: readonly RuleDefinition[] = [
  hotReplyRule,
  activeNoStepRule,
  approvalRule,
  meetingRule,
];

function zoneOf(timezone: string | null | undefined): string {
  return isValidTimeZone(timezone) ? timezone : "UTC";
}

/**
 * The stuck cases of one person (for the relationship view), most urgent first. Uses the job's
 * queries; a paused workspace skips the sequence rule like the job does.
 */
export async function stuckForPerson(ctx: OpContext, personId: string): Promise<StuckItem[]> {
  const workspace = ctx.workspace;
  if (!workspace) return [];
  const settings = parseWorkspaceSettings(workspace.settings);
  const env: RuleContext = {
    ctx,
    workspaceId: workspace.id,
    zone: zoneOf(workspace.timezone),
    now: ctx.clock.now(),
    settings,
    personId,
    limit: 5,
  };
  const found: StuckItem[] = [];
  for (const rule of RULES) {
    if (rule.skipWhenPaused && workspace.status !== "active") continue;
    found.push(...(await rule.find(env)));
  }
  return (await contactableOnly(ctx, found)).kept;
}

export interface StuckCheckResult {
  opened: number;
  /** Open problems whose wording, data or due time changed. */
  refreshed: number;
  /** Open problems still true and worded the same: nothing written. */
  unchanged: number;
  resolved: number;
}

/** Text as `openProblem` stores it (trimmed, at most 300 characters for a title, else 4,000). */
const stored = (text: string, max: number) => text.trim().slice(0, max);

/** True when `openProblem` would write nothing new for this case over the stored problem. */
function sameProblem(row: Problem, item: StuckItem): boolean {
  return (
    row.title === stored(item.title, 300) &&
    row.reason === stored(item.reason, 4000) &&
    row.remedy === stored(item.remedy, 4000) &&
    row.severity === item.severity &&
    row.owner === item.owner &&
    (row.due_at?.getTime() ?? null) === (item.dueAt?.getTime() ?? null) &&
    stableStringify(row.data) === stableStringify({ rule: item.rule, ...item.data })
  );
}

/**
 * Opens or refreshes a `stuck` problem per case and resolves the ones that cleared. A rule that
 * hit the per-run cap resolves nothing (the list was incomplete).
 */
export async function runStuckCheck(ctx: OpContext): Promise<StuckCheckResult> {
  const result: StuckCheckResult = { opened: 0, refreshed: 0, unchanged: 0, resolved: 0 };
  if (!ctx.workspace) return result;
  const [workspace] = await ctx.db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspace.id));
  if (!workspace || workspace.status === "archived") return result;
  const scoped: OpContext = { ...ctx, workspace };
  const settings = parseWorkspaceSettings(workspace.settings);
  const env: RuleContext = {
    ctx: scoped,
    workspaceId: workspace.id,
    zone: zoneOf(workspace.timezone),
    now: ctx.clock.now(),
    settings,
    personId: null,
    limit: STUCK_CAP + 1,
  };
  for (const rule of RULES) {
    if (rule.skipWhenPaused && workspace.status !== "active") continue;
    const found = await rule.find(env);
    const complete = found.length <= STUCK_CAP;
    const { kept: items, left } = await contactableOnly(scoped, found.slice(0, STUCK_CAP));
    const open = await scoped.db
      .select()
      .from(problems)
      .where(
        and(
          eq(problems.workspace_id, workspace.id),
          eq(problems.kind, "stuck"),
          ne(problems.status, "resolved"),
          like(problems.dedupe_key, `stuck:${rule.rule}:%`),
        ),
      );
    const byKey = new Map(open.map((row) => [row.dedupe_key, row]));
    for (const item of items) {
      const current = byKey.get(item.dedupeKey);
      if (current && sameProblem(current, item)) {
        result.unchanged++;
        continue;
      }
      const opened = await openProblem(scoped, {
        kind: "stuck",
        severity: item.severity,
        owner: item.owner,
        title: item.title,
        reason: item.reason,
        remedy: item.remedy,
        subject: item.subject,
        personId: item.personId,
        companyId: item.companyId,
        data: { rule: item.rule, ...item.data },
        dueAt: item.dueAt,
        dedupeKey: item.dedupeKey,
      });
      if (opened.created) result.opened++;
      else result.refreshed++;
    }
    if (!complete) continue;
    const keys = new Set(items.map((item) => item.dedupeKey));
    for (const row of open) {
      if (row.dedupe_key && keys.has(row.dedupe_key)) continue;
      const resolution = row.dedupe_key && left.has(row.dedupe_key) ? NOT_TO_CONTACT : rule.cleared;
      const done = await resolveProblem(scoped, row.id, { resolution });
      if (done.resolved) result.resolved++;
    }
  }
  return result;
}

export const STUCK_CHECK_JOB = "relationships.stuck_check";

export const stuckCheckJob = defineJob({
  name: STUCK_CHECK_JOB,
  payload: z.object({ workspace_id: z.string().optional() }).passthrough(),
  maxAttempts: 3,
  timeoutMs: 5 * 60_000,
  handler: (ctx) => runStuckCheck(ctx),
});
