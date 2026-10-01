import { type SQL, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { queryRows } from "../../db/client.js";

/**
 * Shared SQL for report queries. Every query takes a list of time windows (usually the current
 * and the previous period) through the `w(idx, f, t)` CTE, so one pass returns both periods,
 * and a list of workspace ids, so the agency report aggregates all workspaces in one query
 * instead of one query per workspace.
 *
 * Timestamps come back as epoch milliseconds (`*_ms`): drivers disagree on timestamptz parsing
 * in raw queries, and SQL never uses the session timezone (period math happens in JS).
 */

export interface Window {
  from: Date;
  /** Exclusive. */
  to: Date;
}

/** Reply categories that are not human replies. */
export const AUTOMATIC_CATEGORIES = ["out_of_office", "auto_reply_other", "bounce"] as const;
/** Categories that count as positive replies. */
export const POSITIVE_CATEGORIES = ["interested", "meeting_request"] as const;
/** Outbound actions that count as contacting a person. */
export const CONTACT_ACTIONS = ["email", "reply", "invite", "message"] as const;
/** LinkedIn actions that deliver text to a person. */
export const LINKEDIN_SENT_ACTIONS = ["invite", "message", "reply", "comment"] as const;

/** Inlines constant string lists (never user input). */
export function literalList(values: readonly string[]): SQL {
  return sql.raw(values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", "));
}

/** Timestamp parameter. */
export function ts(date: Date): SQL {
  return sql`${date.toISOString()}::timestamptz`;
}

/** Epoch milliseconds of a timestamp expression (null stays null). */
export function epochMs(expression: SQL): SQL {
  return sql`(extract(epoch from ${expression}) * 1000)::float8`;
}

/** `<alias>.workspace_id` restricted to the given workspaces. */
export function inWorkspaces(alias: string, ids: readonly string[]): SQL {
  const column = sql.raw(`${alias}.workspace_id`);
  if (ids.length === 0) return sql`false`;
  if (ids.length === 1) return sql`${column} = ${ids[0]}`;
  return sql`${column} in ${[...ids]}`;
}

/** `w(idx, f, t)`: one row per window. */
export function windowsDef(windows: readonly Window[]): SQL {
  const rows = windows.map(
    (window, index) => sql`(${index}::int, ${ts(window.from)}, ${ts(window.to)})`,
  );
  return sql`w(idx, f, t) as (values ${sql.join(rows, sql`, `)})`;
}

/** `with a as (...), b as (...)` */
export function withDefs(...defs: SQL[]): SQL {
  return sql`with ${sql.join(defs, sql`, `)}`;
}

/**
 * `sent`: messages the engine sent in each window (bounced ones included). Emails a person
 * wrote from the mailbox itself (origin external) and sends with an unknown outcome never count.
 */
export function sentDef(ids: readonly string[]): SQL {
  return sql`sent as (
    select m.id, m.workspace_id, w.idx, m.person_id, m.company_id, m.campaign_id, m.step_id,
      m.variant, m.channel, m.action, m.status, m.mailbox_id, m.linkedin_account_id, m.sent_at,
      m.thread_id, m.why
    from messages m
    join w on m.sent_at >= w.f and m.sent_at < w.t
    where ${inWorkspaces("m", ids)} and m.direction = 'outbound' and m.origin = 'engine'
      and m.status in ('sent', 'bounced')
  )`;
}

/**
 * `replies`: human replies received in each window (inbound messages from a known person,
 * excluding auto-replies and bounces). Unclassified replies count as replies.
 */
export function repliesDef(ids: readonly string[]): SQL {
  return sql`replies as (
    select r.id, r.workspace_id, w.idx, r.person_id, r.company_id, r.thread_id, r.channel,
      r.campaign_id as reply_campaign_id, r.mailbox_id as reply_mailbox_id,
      r.linkedin_account_id as reply_account_id,
      coalesce(r.received_at, r.created_at) as at,
      coalesce(r.classification->>'category', 'unclassified') as category
    from messages r
    join w on coalesce(r.received_at, r.created_at) >= w.f
      and coalesce(r.received_at, r.created_at) < w.t
    where ${inWorkspaces("r", ids)} and r.direction = 'inbound' and r.person_id is not null
      and coalesce(r.classification->>'category', '') not in (${literalList(AUTOMATIC_CATEGORIES)})
  )`;
}

/**
 * `attributed`: each reply joined to the outbound message it answers: the latest message sent
 * to the same person before the reply (visits and likes cannot be answered), preferring the
 * same thread and the reply's campaign. Gives the campaign, step, variant and sender behind
 * every reply. Requires `replies`.
 */
export function attributedDef(): SQL {
  return sql`attributed as (
    select rp.*, o.id as out_id,
      coalesce(rp.reply_campaign_id, o.campaign_id) as campaign_id,
      o.step_id, o.variant, o.why,
      case when rp.channel = 'email' then coalesce(rp.reply_mailbox_id, o.mailbox_id) end
        as mailbox_id,
      case when rp.channel = 'linkedin' then coalesce(rp.reply_account_id, o.linkedin_account_id) end
        as linkedin_account_id
    from replies rp
    left join lateral (
      select o.id, o.campaign_id, o.step_id, o.variant, o.why, o.mailbox_id, o.linkedin_account_id
      from messages o
      where o.workspace_id = rp.workspace_id and o.person_id = rp.person_id
        and o.direction = 'outbound' and o.sent_at is not null and o.sent_at <= rp.at
        and o.action not in ('visit', 'like')
        and (rp.reply_campaign_id is null or o.campaign_id = rp.reply_campaign_id)
      order by (o.thread_id = rp.thread_id) desc nulls last, o.sent_at desc
      limit 1
    ) o on true
  )`;
}

/**
 * `meetings`: meetings booked inside each window. Meeting records count at the time they were
 * booked or recorded, whatever happened to them later. Opportunities that reached
 * meeting_booked without any meeting record (bookings from before meetings were recorded)
 * still count as before: at their first `opportunity.updated` event with stage meeting_booked,
 * else at their creation time when they were created with a meeting.
 *
 * The CTE is named like the `meetings` table and shadows it in later CTEs and the main query,
 * so the table is read first, in `booked_meetings`.
 */
export function meetingsDefs(ids: readonly string[]): SQL[] {
  return [
    sql`booked_meetings as (
      select mt.id, mt.workspace_id, mt.person_id, mt.company_id, mt.campaign_id,
        mt.opportunity_id, mt.created_at
      from meetings mt
      where ${inWorkspaces("mt", ids)}
    )`,
    sql`first_booked as (
      select e.data->>'opportunity_id' as opportunity_id, min(e.occurred_at) as at
      from events e
      where ${inWorkspaces("e", ids)} and e.type = 'opportunity.updated'
        and e.data->>'stage' = 'meeting_booked'
      group by 1
    )`,
    sql`meetings as (
      select bm.id, bm.workspace_id, w.idx, bm.person_id, bm.company_id,
        coalesce(bm.campaign_id, o.campaign_id) as campaign_id,
        coalesce(o.source_signal_keys, '{}'::text[]) as source_signal_keys, bm.created_at as at
      from booked_meetings bm
      join w on bm.created_at >= w.f and bm.created_at < w.t
      left join opportunities o on o.id = bm.opportunity_id and o.workspace_id = bm.workspace_id
      union all
      select o.id, o.workspace_id, w.idx, o.person_id, o.company_id, o.campaign_id,
        o.source_signal_keys, b.at
      from opportunities o
      left join first_booked fb on fb.opportunity_id = o.id
      cross join lateral (
        select coalesce(
          fb.at,
          case when o.stage = 'meeting_booked' or o.meeting_at is not null then o.created_at end
        ) as at
      ) b
      join w on b.at >= w.f and b.at < w.t
      where ${inWorkspaces("o", ids)}
        and not exists (
          select 1 from booked_meetings bm
          where bm.workspace_id = o.workspace_id and bm.opportunity_id = o.id
        )
    )`,
  ];
}

/**
 * `meeting_outcomes`: meeting records due inside each window (by start time, else the time
 * they were recorded) with their status (scheduled, held, no_show, cancelled), the qualified
 * flag, the opportunity's signal keys and the booking time (`booked_at`). Reads the `meetings`
 * table, so it must come before `meetingsDefs` when both are used in one query.
 */
export function meetingOutcomesDef(ids: readonly string[]): SQL {
  return sql`meeting_outcomes as (
    select mt.id, mt.workspace_id, w.idx, mt.person_id,
      coalesce(mt.campaign_id, o.campaign_id) as campaign_id,
      coalesce(o.source_signal_keys, '{}'::text[]) as source_signal_keys,
      mt.status, mt.qualified, coalesce(mt.start_at, mt.created_at) as at,
      mt.created_at as booked_at
    from meetings mt
    join w on coalesce(mt.start_at, mt.created_at) >= w.f
      and coalesce(mt.start_at, mt.created_at) < w.t
    left join opportunities o on o.id = mt.opportunity_id and o.workspace_id = mt.workspace_id
    where ${inWorkspaces("mt", ids)}
  )`;
}

/** Runs a query and returns typed rows. */
export function rows<T>(db: Db, query: SQL): Promise<T[]> {
  return queryRows<T>(db, query);
}

/** Groups rows by workspace id and window index. */
export function byWorkspaceWindow<T extends { workspace_id: string; idx: number }>(
  list: readonly T[],
): Map<string, Map<number, T>> {
  const out = new Map<string, Map<number, T>>();
  for (const row of list) {
    let perWindow = out.get(row.workspace_id);
    if (!perWindow) {
      perWindow = new Map();
      out.set(row.workspace_id, perWindow);
    }
    perWindow.set(row.idx, row);
  }
  return out;
}
