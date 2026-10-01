import { sql } from "drizzle-orm";
import type { Db } from "../../../db/client.js";
import { REPORT_JOB_NAME } from "../schedule-config.js";
import { rows, ts } from "../sql.js";
import { DAY_MS } from "../timezone.js";
import type { Suggestion } from "./schema.js";

/** Signals younger than this count as fresh. */
export const FRESH_SIGNAL_DAYS = 14;
export const MAX_SUGGESTIONS = 3;

const ACTIVE_ENROLLMENT = sql.raw("'queued', 'active', 'paused', 'waiting_review'");

/**
 * 1-3 data-driven next steps beyond the queue (spec 11.12), most valuable first:
 * fresh-signal leads outside every campaign, active campaigns with nobody left to contact,
 * tier A leads never contacted, and no scheduled report. Falls back to one neutral suggestion.
 */
export async function buildSuggestions(
  db: Db,
  workspaceId: string,
  now: Date,
): Promise<Suggestion[]> {
  const freshSince = new Date(now.getTime() - FRESH_SIGNAL_DAYS * DAY_MS);
  const activeSince = new Date(now.getTime() - 30 * DAY_MS);
  const [signalLeads, dryCampaigns, tierA, reporting] = await Promise.all([
    rows<{ key: string; leads: number }>(
      db,
      sql`select s.definition_key as key, count(distinct p.id)::int as leads
        from signals s
        join people p on p.workspace_id = s.workspace_id
          and (p.id = s.person_id or (s.person_id is null and p.company_id = s.company_id))
        where s.workspace_id = ${workspaceId} and s.status in ('new', 'seen')
          and s.detected_at >= ${ts(freshSince)}
          and p.status in ('new', 'active')
          and (p.email is not null or p.linkedin_url is not null)
          and not exists (
            select 1 from enrollments e
            where e.person_id = p.id and e.status in (${ACTIVE_ENROLLMENT})
          )
        group by 1
        order by 2 desc, 1
        limit 1`,
    ),
    rows<{ id: string; name: string }>(
      db,
      sql`select c.id, c.name from campaigns c
        where c.workspace_id = ${workspaceId} and c.status = 'active' and not c.is_template
          and not exists (
            select 1 from enrollments e
            where e.campaign_id = c.id and e.status in (${ACTIVE_ENROLLMENT})
          )
        order by c.launched_at nulls last, c.name
        limit 3`,
    ),
    rows<{ n: number }>(
      db,
      sql`select count(*)::int as n from people p
        where p.workspace_id = ${workspaceId} and p.fit_score >= 80 and p.status = 'new'
          and (p.email is not null or p.linkedin_url is not null)
          and not exists (select 1 from enrollments e where e.person_id = p.id)`,
    ),
    rows<{ schedules: number; sent: number }>(
      db,
      sql`select
          (select count(*)::int from schedules s
            where s.workspace_id = ${workspaceId} and s.job_name = ${REPORT_JOB_NAME}) as schedules,
          (select count(*)::int from messages m
            where m.workspace_id = ${workspaceId} and m.direction = 'outbound'
              and m.origin = 'engine' and m.status in ('sent', 'bounced')
              and m.sent_at >= ${ts(activeSince)}) as sent`,
    ),
  ]);

  const out: Suggestion[] = [];
  const fresh = signalLeads[0];
  if (fresh && fresh.leads > 0) {
    out.push({
      code: "fresh_signal_leads_not_enrolled",
      message: `${fresh.leads} ${fresh.leads === 1 ? "lead" : "leads"} with fresh ${fresh.key} signals ${fresh.leads === 1 ? "is" : "are"} not in any campaign.`,
      hint: `Find them with search_leads (signal ${fresh.key}), check fit, then add them with enroll_leads (action enroll).`,
    });
  }
  for (const campaign of dryCampaigns) {
    out.push({
      code: "campaign_out_of_leads",
      message: `Campaign "${campaign.name}" is active but has nobody left to contact.`,
      hint: `Enroll more leads with enroll_leads (campaign_id ${campaign.id}), or stop it with launch_campaign (action stop).`,
    });
  }
  const tierACount = tierA[0]?.n ?? 0;
  if (tierACount > 0) {
    out.push({
      code: "tier_a_not_contacted",
      message: `${tierACount} tier A ${tierACount === 1 ? "lead" : "leads"} (fit 80+) ${tierACount === 1 ? "has" : "have"} never been contacted.`,
      hint: "List them with search_leads (fit 80 and up, status new) and enroll the best ones with enroll_leads.",
    });
  }
  const report = reporting[0];
  if (report && report.schedules === 0 && report.sent > 0) {
    out.push({
      code: "no_scheduled_report",
      message: "No scheduled report: results are only visible when someone asks.",
      hint: "Send a weekly overview to a channel with manage_report_schedules (action create, cron 0 8 * * 1).",
    });
  }
  if (out.length === 0) {
    out.push({
      code: "all_clear",
      message: "Nothing else needs you right now.",
      hint: "Check results with get_report (type overview) or look for new leads with find_leads.",
    });
  }
  return out.slice(0, MAX_SUGGESTIONS);
}
