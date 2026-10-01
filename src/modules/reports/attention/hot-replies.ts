import { sql } from "drizzle-orm";
import type { Channel } from "../../../core/enums.js";
import type { Db } from "../../../db/client.js";
import { round1 } from "../metric.js";
import { epochMs, literalList, POSITIVE_CATEGORIES, rows, ts } from "../sql.js";
import type { HotReply } from "./schema.js";

/** A hot reply needs a human answer after this long. */
export const HOT_REPLY_WAIT_MS = 2 * 3_600_000;
/** Older hot replies are considered handled elsewhere. */
export const HOT_REPLY_LOOKBACK_MS = 30 * 86_400_000;
const SUMMARY_MAX = 280;

/**
 * Threads whose latest inbound message is interested or meeting_request, arrived more than 2
 * hours ago (and within 30 days), with no reply approved, scheduled or sent since. Oldest first.
 * Left out: threads a person took over (they answer there themselves), and replies whose person
 * has a meeting recorded since (not cancelled): the meeting answered them.
 */
export async function hotReplies(
  db: Db,
  workspaceId: string,
  now: Date,
  maxItems: number,
): Promise<{ total: number; items: HotReply[] }> {
  const olderThan = new Date(now.getTime() - HOT_REPLY_WAIT_MS);
  const since = new Date(now.getTime() - HOT_REPLY_LOOKBACK_MS);
  const list = await rows<{
    thread_id: string;
    person_id: string | null;
    channel: Channel;
    category: string;
    summary: string | null;
    received_ms: number;
    full_name: string | null;
    first_name: string | null;
    last_name: string | null;
    company_name: string | null;
    draft_status: string | null;
    total: number;
  }>(
    db,
    sql`select t.id as thread_id, t.person_id, t.channel, li.category, li.summary,
        ${epochMs(sql`li.at`)} as received_ms,
        p.full_name, p.first_name, p.last_name, co.name as company_name,
        (
          select o.status from messages o
          where o.thread_id = t.id and o.direction = 'outbound' and o.created_at >= li.at
          order by o.created_at desc limit 1
        ) as draft_status,
        count(*) over ()::int as total
      from threads t
      join lateral (
        select coalesce(m.received_at, m.created_at) as at,
          coalesce(m.classification->>'category', t.category) as category,
          m.classification->>'summary' as summary
        from messages m
        where m.thread_id = t.id and m.direction = 'inbound'
        order by coalesce(m.received_at, m.created_at) desc
        limit 1
      ) li on true
      left join people p on p.id = t.person_id
      left join companies co on co.id = coalesce(t.company_id, p.company_id)
      where t.workspace_id = ${workspaceId} and t.status <> 'closed' and t.owner <> 'person'
        and (t.last_inbound_at is null or t.last_inbound_at >= ${ts(since)})
        and li.category in (${literalList(POSITIVE_CATEGORIES)})
        and li.at <= ${ts(olderThan)} and li.at >= ${ts(since)}
        and not exists (
          select 1 from messages o
          where o.thread_id = t.id and o.direction = 'outbound'
            and o.status in ('approved', 'scheduled', 'sending', 'unknown', 'sent')
            and coalesce(o.sent_at, o.scheduled_for, o.created_at) >= li.at
        )
        and not exists (
          select 1 from meetings mt
          where mt.workspace_id = t.workspace_id and mt.person_id = t.person_id
            and mt.status <> 'cancelled' and mt.created_at >= li.at
        )
      order by li.at asc
      limit ${maxItems}`,
  );
  return {
    total: list[0]?.total ?? 0,
    items: list.map((row) => ({
      thread_id: row.thread_id,
      person_id: row.person_id,
      person_name:
        row.full_name ?? ([row.first_name, row.last_name].filter(Boolean).join(" ") || null),
      company_name: row.company_name,
      channel: row.channel,
      category: row.category,
      received_at: new Date(row.received_ms),
      waiting_hours: round1((now.getTime() - row.received_ms) / 3_600_000),
      draft_status: row.draft_status,
      summary: row.summary ? truncate(row.summary, SUMMARY_MAX) : null,
      untrusted: true as const,
    })),
  };
}

export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 3).trimEnd()}...`;
}
