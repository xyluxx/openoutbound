/**
 * get_next_actions: what the engine and the people will do in the next hours, in time order
 * (scheduled and approved messages, due sequence steps, tasks, meetings), and which of those
 * are blocked (the senders' own checks, evaluated in one batch for the page).
 */
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { CHANNELS, type Channel, type MessageAction, type StepType } from "../../core/enums.js";
import { OpenOutboundError } from "../../core/errors.js";
import { isoDateTime } from "../../core/operation.js";
import { decodeCursor, encodeCursor } from "../../core/pagination.js";
import { queryRows } from "../../db/client.js";
import { stepAction, stepChannel } from "../campaigns/steps.js";
import { type Blocker, withoutTimingWaits } from "./blockers.js";
import { checkEligibilityMany } from "./eligibility.js";
import type { EligibilityInput } from "./eligibility-types.js";
import { blockerSchema } from "./schemas.js";

const HOUR_MS = 3_600_000;
/** Overdue items this old still show (they go out as soon as nothing blocks them). */
const OVERDUE_LOOKBACK_MS = 7 * 24 * HOUR_MS;

export const NEXT_ITEM_KINDS = ["send_message", "campaign_step", "task", "meeting"] as const;
type NextItemKind = (typeof NEXT_ITEM_KINDS)[number];

export const nextActionsInput = z.object({
  hours: z
    .number()
    .int()
    .min(1)
    .max(168)
    .default(24)
    .describe("How far ahead to look, in hours (1-168, default 24)"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(50)
    .describe("Max items (1-100, default 50); blockers are checked for these items"),
  cursor: z.string().optional().describe("next_cursor from the previous page"),
});

const refSchema = z.object({ type: z.string(), id: z.string() });

export const nextActionItemSchema = z.object({
  at: isoDateTime(),
  overdue: z.boolean().describe("Its time passed: it happens as soon as nothing blocks it"),
  kind: z.enum(NEXT_ITEM_KINDS),
  channel: z.enum(CHANNELS).nullable(),
  what: z.string().describe("Plain words"),
  person_id: z.string().nullable(),
  person_name: z.string().nullable(),
  company_name: z.string().nullable(),
  campaign_id: z.string().nullable(),
  campaign_name: z.string().nullable(),
  ref: refSchema,
  blocked: z.boolean(),
});
type NextActionItem = z.input<typeof nextActionItemSchema>;

export const nextActionsOutput = z.object({
  from: isoDateTime(),
  to: isoDateTime(),
  items: z.array(nextActionItemSchema),
  blocked: z
    .array(
      z.object({
        ref: refSchema,
        person_id: z.string().nullable(),
        person_name: z.string().nullable(),
        at: isoDateTime(),
        blockers: z.array(blockerSchema),
      }),
    )
    .describe("Items of this page that will not go out as planned, with every blocker"),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

interface Row {
  id: string;
  at_ms: number;
  kind: NextItemKind;
  channel: Channel | null;
  action: string | null;
  status: string | null;
  step_type: StepType | null;
  current_step: number | null;
  title: string | null;
  person_id: string | null;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
}

const ts = (date: Date): SQL => sql`${date.toISOString()}::timestamptz`;
const ms = (expression: SQL): SQL => sql`(extract(epoch from ${expression}) * 1000)::float8`;
const OPEN_OUTBOUND = sql.raw(
  "'generating', 'draft', 'pending_review', 'approved', 'scheduled', 'sending', 'unknown'",
);
/**
 * When a message goes out: its scheduled time; an approved message parked without one waits for
 * its paused sequence, its next step, or (a parked reply) since it was parked.
 */
const MESSAGE_AT = sql.raw(
  "coalesce(m.scheduled_for, e.paused_until, e.next_run_at, m.updated_at)",
);

/** `(time, id) > cursor` on millisecond precision, or nothing without a cursor. */
function after(at: SQL, id: SQL, cursor: { at: string; id: string } | null): SQL {
  if (!cursor) return sql``;
  return sql`and (date_trunc('milliseconds', ${at}), ${id}) > (${cursor.at}::timestamptz, ${cursor.id})`;
}

function nameOf(row: Row): string | null {
  return (
    row.full_name?.trim() ||
    [row.first_name, row.last_name].filter(Boolean).join(" ").trim() ||
    null
  );
}

const LINKEDIN_WORDS: Record<string, string> = {
  invite: "LinkedIn invitation",
  message: "LinkedIn message",
  visit: "LinkedIn profile visit",
  like: "LinkedIn like",
  comment: "LinkedIn comment",
};

function describe(row: Row): string {
  const who = nameOf(row) ?? "an unnamed lead";
  const campaign = row.campaign_name ? ` (campaign ${row.campaign_name})` : "";
  switch (row.kind) {
    case "send_message": {
      const what =
        row.channel === "email"
          ? row.action === "reply"
            ? "Reply"
            : "Email"
          : (LINKEDIN_WORDS[row.action ?? ""] ?? "LinkedIn action");
      const approved = row.status === "approved" ? ", approved and waiting to be scheduled" : "";
      return `${what} to ${who}${campaign}${approved}.`;
    }
    case "campaign_step": {
      const step = row.step_type ? row.step_type.replace(/_/g, " ") : "next step";
      const resumes = row.status === "paused" ? ", after the pause ends" : "";
      return `Step ${(row.current_step ?? 0) + 1} (${step}) for ${who}${campaign}${resumes}.`;
    }
    case "task":
      return `${row.action === "promise" ? "Promise" : "Task"} for ${who}: ${row.title ?? ""}`.trim();
    default:
      return `Meeting with ${who}.`;
  }
}

/** Upcoming items of the workspace in time order, with blockers for this page. */
export async function buildNextActions(
  ctx: OpContext,
  input: z.output<typeof nextActionsInput>,
): Promise<z.input<typeof nextActionsOutput>> {
  const workspace = requireWorkspace(ctx);
  const ws = workspace.id;
  const now = ctx.clock.now();
  const from = new Date(now.getTime() - OVERDUE_LOOKBACK_MS);
  const to = new Date(now.getTime() + input.hours * HOUR_MS);
  let cursor: { at: string; id: string } | null = null;
  if (input.cursor) {
    const decoded = decodeCursor<{ at?: unknown; id?: unknown }>(input.cursor);
    if (typeof decoded.at !== "string" || typeof decoded.id !== "string") {
      throw new OpenOutboundError("validation_failed", "Invalid cursor.", {
        hint: "Pass next_cursor exactly as returned by the previous page, or omit it to start over.",
      });
    }
    cursor = { at: decoded.at, id: decoded.id };
  }
  const n = input.limit + 1;
  const names = sql`p.full_name, p.first_name, p.last_name, co.name as company_name`;

  const [messageRows, stepRows, taskRows, meetingRows] = await Promise.all([
    queryRows<Row>(
      ctx.db,
      sql`select m.id, ${ms(MESSAGE_AT)} as at_ms, 'send_message' as kind, m.channel,
          m.action, m.status, null as step_type, null::int as current_step, null as title,
          m.person_id, ${names}, m.campaign_id, c.name as campaign_name
        from messages m
        left join enrollments e on e.id = m.enrollment_id
        left join people p on p.id = m.person_id
        left join companies co on co.id = coalesce(m.company_id, p.company_id)
        left join campaigns c on c.id = m.campaign_id
        where m.workspace_id = ${ws} and m.direction = 'outbound'
          and m.status in ('scheduled', 'approved')
          and ${MESSAGE_AT} >= ${ts(from)} and ${MESSAGE_AT} < ${ts(to)}
          ${after(MESSAGE_AT, sql`m.id`, cursor)}
        order by date_trunc('milliseconds', ${MESSAGE_AT}), m.id
        limit ${n}`,
    ),
    queryRows<Row>(
      ctx.db,
      sql`select x.* from (
          select e.id,
            case when e.status = 'active' then e.next_run_at else e.paused_until end as at_ts,
            ${ms(sql`case when e.status = 'active' then e.next_run_at else e.paused_until end`)}
              as at_ms,
            'campaign_step' as kind, null as channel, null as action, e.status,
            s.type as step_type, e.current_step, null as title, e.person_id, ${names},
            e.campaign_id, c.name as campaign_name
          from enrollments e
          join campaigns c on c.id = e.campaign_id
          left join campaign_steps s on s.campaign_id = e.campaign_id
            and s.position = e.current_step
          left join people p on p.id = e.person_id
          left join companies co on co.id = p.company_id
          where e.workspace_id = ${ws}
            and ((e.status = 'active' and e.next_run_at >= ${ts(from)} and e.next_run_at < ${ts(to)})
              or (e.status = 'paused' and e.paused_until >= ${ts(from)}
                and e.paused_until < ${ts(to)}))
            and not exists (
              select 1 from messages m
              where m.enrollment_id = e.id and m.status in (${OPEN_OUTBOUND})
            )
        ) x
        where true ${after(sql`x.at_ts`, sql`x.id`, cursor)}
        order by date_trunc('milliseconds', x.at_ts), x.id
        limit ${n}`,
    ),
    queryRows<Row>(
      ctx.db,
      sql`select t.id, ${ms(sql`t.due_at`)} as at_ms, 'task' as kind,
          case t.type when 'manual_email' then 'email' when 'linkedin' then 'linkedin' end
            as channel,
          t.type as action, t.status, null as step_type, null::int as current_step, t.title,
          t.person_id, ${names}, t.campaign_id, c.name as campaign_name
        from tasks t
        left join people p on p.id = t.person_id
        left join companies co on co.id = p.company_id
        left join campaigns c on c.id = t.campaign_id
        where t.workspace_id = ${ws} and t.status = 'open'
          and t.due_at >= ${ts(from)} and t.due_at < ${ts(to)}
          ${after(sql`t.due_at`, sql`t.id`, cursor)}
        order by date_trunc('milliseconds', t.due_at), t.id
        limit ${n}`,
    ),
    upcomingMeetings(ctx, ws, now, to, cursor, n),
  ]);

  const rows = [...messageRows, ...stepRows, ...taskRows, ...meetingRows]
    .map((row) => ({ ...row, at_ms: Math.floor(row.at_ms) }))
    .sort((a, b) => a.at_ms - b.at_ms || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const page = rows.slice(0, input.limit);
  const hasMore = rows.length > input.limit;

  // Blockers for the page's channel items, in one batch.
  const checks: Array<{ index: number; input: EligibilityInput }> = [];
  page.forEach((row, index) => {
    if (!row.person_id) return;
    if (row.kind === "send_message" && row.channel) {
      checks.push({
        index,
        input: { personId: row.person_id, channel: row.channel, messageId: row.id },
      });
    } else if (row.kind === "campaign_step" && row.step_type) {
      const channel = stepChannel(row.step_type);
      if (!channel) return;
      const at = new Date(row.at_ms);
      checks.push({
        index,
        input: {
          personId: row.person_id,
          channel,
          campaignId: row.campaign_id,
          action: stepAction(row.step_type) as MessageAction,
          messageId: null,
          ...(at > now ? { at } : {}),
        },
      });
    }
  });
  const results = await checkEligibilityMany(
    ctx,
    checks.map((check) => check.input),
  );
  const blockedByIndex = new Map<number, Blocker[]>();
  checks.forEach((check, position) => {
    const result = results[position];
    const row = page[check.index];
    if (!result || result.ok || !row) return;
    // A wait for the window or a cap that ends by the item's own time blocks nothing.
    const blockers = withoutTimingWaits(result.blockers, new Date(row.at_ms));
    if (blockers.length > 0) blockedByIndex.set(check.index, blockers);
  });

  const items: NextActionItem[] = page.map((row, index) => ({
    at: new Date(row.at_ms),
    overdue: row.at_ms < now.getTime(),
    kind: row.kind,
    channel:
      row.kind === "campaign_step" && row.step_type ? stepChannel(row.step_type) : row.channel,
    what: describe(row),
    person_id: row.person_id,
    person_name: nameOf(row),
    company_name: row.company_name,
    campaign_id: row.campaign_id,
    campaign_name: row.campaign_name,
    ref: { type: refType(row), id: row.id },
    blocked: blockedByIndex.has(index),
  }));
  const last = page.at(-1);
  return {
    from,
    to,
    items,
    blocked: [...blockedByIndex].map(([index, blockers]) => {
      const row = page[index] as Row;
      return {
        ref: { type: refType(row), id: row.id },
        person_id: row.person_id,
        person_name: nameOf(row),
        at: new Date(row.at_ms),
        blockers,
      };
    }),
    next_cursor:
      hasMore && last
        ? encodeCursor({ at: new Date(last.at_ms).toISOString(), id: last.id })
        : null,
    has_more: hasMore,
  };
}

function refType(row: Row): string {
  switch (row.kind) {
    case "send_message":
      return "message";
    case "campaign_step":
      return "enrollment";
    case "task":
      return "task";
    default:
      return row.id.startsWith("opp_") ? "opportunity" : "meeting";
  }
}

/** Scheduled meetings ahead; v0.1 workspaces without meeting records use opportunities. */
async function upcomingMeetings(
  ctx: OpContext,
  ws: string,
  now: Date,
  to: Date,
  cursor: { at: string; id: string } | null,
  n: number,
): Promise<Row[]> {
  const [any] = await queryRows<{ found: boolean }>(
    ctx.db,
    sql`select exists (select 1 from meetings where workspace_id = ${ws}) as found`,
  );
  const names = sql`p.full_name, p.first_name, p.last_name, co.name as company_name`;
  if (any?.found) {
    return queryRows<Row>(
      ctx.db,
      sql`select mt.id, ${ms(sql`mt.start_at`)} as at_ms, 'meeting' as kind, null as channel,
          null as action, mt.status, null as step_type, null::int as current_step, null as title,
          mt.person_id, ${names}, mt.campaign_id, c.name as campaign_name
        from meetings mt
        left join people p on p.id = mt.person_id
        left join companies co on co.id = coalesce(mt.company_id, p.company_id)
        left join campaigns c on c.id = mt.campaign_id
        where mt.workspace_id = ${ws} and mt.status = 'scheduled'
          and mt.start_at >= ${ts(now)} and mt.start_at < ${ts(to)}
          ${after(sql`mt.start_at`, sql`mt.id`, cursor)}
        order by date_trunc('milliseconds', mt.start_at), mt.id
        limit ${n}`,
    );
  }
  return queryRows<Row>(
    ctx.db,
    sql`select o.id, ${ms(sql`o.meeting_at`)} as at_ms, 'meeting' as kind, null as channel,
        null as action, o.stage as status, null as step_type, null::int as current_step,
        null as title, o.person_id, ${names}, o.campaign_id, c.name as campaign_name
      from opportunities o
      left join people p on p.id = o.person_id
      left join companies co on co.id = coalesce(o.company_id, p.company_id)
      left join campaigns c on c.id = o.campaign_id
      where o.workspace_id = ${ws} and o.stage = 'meeting_booked'
        and o.meeting_at >= ${ts(now)} and o.meeting_at < ${ts(to)}
        ${after(sql`o.meeting_at`, sql`o.id`, cursor)}
      order by date_trunc('milliseconds', o.meeting_at), o.id
      limit ${n}`,
  );
}
