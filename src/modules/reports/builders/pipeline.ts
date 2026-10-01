import { sql } from "drizzle-orm";
import { OPPORTUNITY_STAGES } from "../../../core/enums.js";
import { metric, rate, round2 } from "../metric.js";
import type { PipelineData } from "../schemas.js";
import {
  inWorkspaces,
  meetingOutcomesDef,
  meetingsDefs,
  rows,
  windowsDef,
  withDefs,
} from "../sql.js";
import { type BuildArgs, type Built, windowsOf } from "./common.js";

interface WindowCounts {
  idx: number;
  new_opportunities: number;
  won: number;
  lost: number;
}

interface OutcomeCounts {
  idx: number;
  held: number;
  no_shows: number;
  cancelled: number;
  qualified: number;
}

type Amount = { currency: string | null; amount: number };

/**
 * Pipeline (spec 11.12): opportunities by stage right now with their value, and for the period
 * new opportunities, meetings booked, meetings held, no-shows and cancellations (by start
 * time), the held rate, qualified meetings, wins and losses with reasons.
 */
export async function buildPipeline(args: BuildArgs): Promise<Built<PipelineData>> {
  const ids = [args.workspace.id];
  const windows = windowsOf(args);
  const w = windowsDef(windows);
  const closedAt = sql`coalesce(o.closed_at, o.updated_at)`;
  const [stages, counts, meetings, outcomes, wonValue, lostReasons, wonByCampaign] =
    await Promise.all([
      rows<{ stage: string; currency: string | null; n: number; amount: number | null }>(
        args.db,
        sql`select o.stage, o.currency, count(*)::int as n, sum(o.value)::float8 as amount
        from opportunities o
        where ${inWorkspaces("o", ids)}
        group by 1, 2`,
      ),
      rows<WindowCounts>(
        args.db,
        sql`${withDefs(w)}
        select w.idx,
          count(*) filter (where o.created_at >= w.f and o.created_at < w.t)::int as new_opportunities,
          count(*) filter (
            where o.stage = 'won' and ${closedAt} >= w.f and ${closedAt} < w.t
          )::int as won,
          count(*) filter (
            where o.stage = 'lost' and ${closedAt} >= w.f and ${closedAt} < w.t
          )::int as lost
        from w cross join opportunities o
        where ${inWorkspaces("o", ids)}
        group by 1`,
      ),
      rows<{ idx: number; n: number }>(
        args.db,
        sql`${withDefs(w, ...meetingsDefs(ids))}
        select idx, count(*)::int as n from meetings group by 1`,
      ),
      rows<OutcomeCounts>(
        args.db,
        sql`${withDefs(w, meetingOutcomesDef(ids))}
        select idx,
          count(*) filter (where status = 'held')::int as held,
          count(*) filter (where status = 'no_show')::int as no_shows,
          count(*) filter (where status = 'cancelled')::int as cancelled,
          count(*) filter (where status = 'held' and qualified)::int as qualified
        from meeting_outcomes
        group by 1`,
      ),
      rows<{ currency: string | null; amount: number | null }>(
        args.db,
        sql`${withDefs(windowsDef(windows.slice(0, 1)))}
        select o.currency, sum(o.value)::float8 as amount
        from opportunities o join w on ${closedAt} >= w.f and ${closedAt} < w.t
        where ${inWorkspaces("o", ids)} and o.stage = 'won'
        group by 1`,
      ),
      rows<{ reason: string; n: number }>(
        args.db,
        sql`${withDefs(windowsDef(windows.slice(0, 1)))}
        select coalesce(nullif(trim(o.lost_reason), ''), '(no reason given)') as reason,
          count(*)::int as n
        from opportunities o join w on ${closedAt} >= w.f and ${closedAt} < w.t
        where ${inWorkspaces("o", ids)} and o.stage = 'lost'
        group by 1
        order by 2 desc, 1
        limit 10`,
      ),
      rows<{
        campaign_id: string | null;
        campaign: string | null;
        currency: string | null;
        n: number;
        amount: number | null;
      }>(
        args.db,
        sql`${withDefs(windowsDef(windows.slice(0, 1)))}
        select o.campaign_id, c.name as campaign, o.currency, count(*)::int as n,
          sum(o.value)::float8 as amount
        from opportunities o
        join w on ${closedAt} >= w.f and ${closedAt} < w.t
        left join campaigns c on c.id = o.campaign_id
        where ${inWorkspaces("o", ids)} and o.stage = 'won'
        group by 1, 2, 3`,
      ),
    ]);

  const amounts = (list: Array<{ currency: string | null; amount: number | null }>): Amount[] =>
    list
      .filter((row) => row.amount !== null)
      .map((row) => ({ currency: row.currency, amount: round2(row.amount ?? 0) }))
      .sort((a, b) => b.amount - a.amount);

  const stageRows = OPPORTUNITY_STAGES.map((stage) => {
    const own = stages.filter((row) => row.stage === stage);
    return {
      stage,
      count: own.reduce((total, row) => total + row.n, 0),
      value: amounts(own),
    };
  });

  const campaigns = new Map<
    string,
    { campaign_id: string | null; campaign: string; count: number; value: Amount[] }
  >();
  for (const row of wonByCampaign) {
    const key = row.campaign_id ?? "";
    const entry = campaigns.get(key) ?? {
      campaign_id: row.campaign_id,
      campaign: row.campaign ?? "(no campaign)",
      count: 0,
      value: [],
    };
    entry.count += row.n;
    if (row.amount !== null)
      entry.value.push({ currency: row.currency, amount: round2(row.amount) });
    campaigns.set(key, entry);
  }

  const at = (idx: number): WindowCounts =>
    counts.find((row) => row.idx === idx) ?? { idx, new_opportunities: 0, won: 0, lost: 0 };
  const meetingsAt = (idx: number) => meetings.find((row) => row.idx === idx)?.n ?? 0;
  const outcomeAt = (idx: number): OutcomeCounts =>
    outcomes.find((row) => row.idx === idx) ?? {
      idx,
      held: 0,
      no_shows: 0,
      cancelled: 0,
      qualified: 0,
    };
  const current = at(0);
  const previous = args.previous ? at(1) : undefined;
  const nowOutcome = outcomeAt(0);
  const pastOutcome = args.previous ? outcomeAt(1) : undefined;
  return {
    data: {
      type: "pipeline",
      metrics: {
        new_opportunities: metric(current.new_opportunities, previous?.new_opportunities),
        meetings: metric(meetingsAt(0), previous ? meetingsAt(1) : undefined),
        meetings_held: metric(nowOutcome.held, pastOutcome?.held),
        no_shows: metric(nowOutcome.no_shows, pastOutcome?.no_shows),
        meetings_cancelled: metric(nowOutcome.cancelled, pastOutcome?.cancelled),
        held_rate: metric(
          rate(nowOutcome.held, nowOutcome.held + nowOutcome.no_shows),
          pastOutcome ? rate(pastOutcome.held, pastOutcome.held + pastOutcome.no_shows) : undefined,
          "rate",
        ),
        qualified_meetings: metric(nowOutcome.qualified, pastOutcome?.qualified),
        won: metric(current.won, previous?.won),
        lost: metric(current.lost, previous?.lost),
        win_rate: metric(
          rate(current.won, current.won + current.lost),
          previous ? rate(previous.won, previous.won + previous.lost) : undefined,
          "rate",
        ),
      },
      stages: stageRows,
      won_value: amounts(wonValue),
      lost_reasons: lostReasons.map((row) => ({ reason: row.reason, count: row.n })),
      won_by_campaign: [...campaigns.values()].sort((a, b) => b.count - a.count),
    },
    metrics: [
      "new_opportunities",
      "meetings",
      "meetings_held",
      "no_shows",
      "meetings_cancelled",
      "held_rate",
      "qualified_meetings",
      "won",
      "lost",
      "win_rate",
    ],
    notes: [
      "Stages show every opportunity by its current stage, not only the period.",
      "Meetings count when they were booked; held, no-show and cancelled meetings count in the period they were due to take place.",
    ],
  };
}
