import { sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import {
  CONTACT_ACTIONS,
  inWorkspaces,
  LINKEDIN_SENT_ACTIONS,
  literalList,
  meetingsDefs,
  POSITIVE_CATEGORIES,
  repliesDef,
  rows,
  sentDef,
  type Window,
  windowsDef,
  withDefs,
} from "./sql.js";

/** Outreach activity of one workspace in one window (the overview numbers). */
export interface ActivityCounts {
  new_leads: number;
  enrolled: number;
  contacted: number;
  emails_sent: number;
  linkedin_sent: number;
  bounced: number;
  replies: number;
  positive_replies: number;
  meetings: number;
}

export const EMPTY_ACTIVITY: ActivityCounts = {
  new_leads: 0,
  enrolled: 0,
  contacted: 0,
  emails_sent: 0,
  linkedin_sent: 0,
  bounced: 0,
  replies: 0,
  positive_replies: 0,
  meetings: 0,
};

interface Keyed {
  workspace_id: string;
  idx: number;
}

/**
 * Activity counts per workspace and window: `result.get(workspaceId)?.[windowIndex]`. Five
 * grouped queries in total, whatever the number of workspaces or windows.
 */
export async function activityCounts(
  db: Db,
  workspaceIds: readonly string[],
  windows: readonly Window[],
): Promise<Map<string, ActivityCounts[]>> {
  const w = windowsDef(windows);
  const [leads, enrolled, sent, replies, meetings] = await Promise.all([
    rows<Keyed & { n: number }>(
      db,
      sql`${withDefs(w)}
        select p.workspace_id, w.idx, count(*)::int as n
        from people p join w on p.created_at >= w.f and p.created_at < w.t
        where ${inWorkspaces("p", workspaceIds)}
        group by 1, 2`,
    ),
    rows<Keyed & { n: number }>(
      db,
      sql`${withDefs(w)}
        select e.workspace_id, w.idx, count(*)::int as n
        from enrollments e join w on e.enrolled_at >= w.f and e.enrolled_at < w.t
        where ${inWorkspaces("e", workspaceIds)}
        group by 1, 2`,
    ),
    rows<
      Keyed & { emails_sent: number; bounced: number; linkedin_sent: number; contacted: number }
    >(
      db,
      sql`${withDefs(w, sentDef(workspaceIds))}
        select workspace_id, idx,
          count(*) filter (where channel = 'email')::int as emails_sent,
          count(*) filter (where channel = 'email' and status = 'bounced')::int as bounced,
          count(*) filter (
            where channel = 'linkedin' and action in (${literalList(LINKEDIN_SENT_ACTIONS)})
          )::int as linkedin_sent,
          count(distinct person_id) filter (
            where action in (${literalList(CONTACT_ACTIONS)})
          )::int as contacted
        from sent
        group by 1, 2`,
    ),
    rows<Keyed & { replies: number; positive_replies: number }>(
      db,
      sql`${withDefs(w, repliesDef(workspaceIds))}
        select workspace_id, idx,
          count(distinct person_id)::int as replies,
          count(distinct person_id) filter (
            where category in (${literalList(POSITIVE_CATEGORIES)})
          )::int as positive_replies
        from replies
        group by 1, 2`,
    ),
    rows<Keyed & { n: number }>(
      db,
      sql`${withDefs(w, ...meetingsDefs(workspaceIds))}
        select workspace_id, idx, count(*)::int as n from meetings group by 1, 2`,
    ),
  ]);

  const out = new Map<string, ActivityCounts[]>();
  for (const id of workspaceIds) {
    out.set(
      id,
      windows.map(() => ({ ...EMPTY_ACTIVITY })),
    );
  }
  const at = (row: Keyed): ActivityCounts | undefined => out.get(row.workspace_id)?.[row.idx];
  for (const row of leads) {
    const target = at(row);
    if (target) target.new_leads = row.n;
  }
  for (const row of enrolled) {
    const target = at(row);
    if (target) target.enrolled = row.n;
  }
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
  return out;
}

/** Distinct people per reply category in one window, per workspace. */
export async function repliesByCategory(
  db: Db,
  workspaceIds: readonly string[],
  window: Window,
): Promise<Map<string, Record<string, number>>> {
  const list = await rows<{ workspace_id: string; category: string; n: number }>(
    db,
    sql`${withDefs(windowsDef([window]), repliesDef(workspaceIds))}
      select workspace_id, category, count(distinct person_id)::int as n
      from replies
      group by 1, 2
      order by 3 desc, 2`,
  );
  const out = new Map<string, Record<string, number>>();
  for (const row of list) {
    const record = out.get(row.workspace_id) ?? {};
    record[row.category] = row.n;
    out.set(row.workspace_id, record);
  }
  return out;
}
