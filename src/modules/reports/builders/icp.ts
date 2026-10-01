import { eq, sql } from "drizzle-orm";
import { icps } from "../../../db/schema/index.js";
import { rate, round1 } from "../metric.js";
import { ICP_TIERS, type IcpData, type IcpTier } from "../schemas.js";
import {
  attributedDef,
  CONTACT_ACTIONS,
  literalList,
  meetingsDefs,
  POSITIVE_CATEGORIES,
  repliesDef,
  rows,
  sentDef,
  windowsDef,
  withDefs,
} from "../sql.js";
import type { BuildArgs, Built } from "./common.js";

/** Person fit tiers (ICP playbook, section 7). */
export const TIER_RANGES: Record<IcpTier, string> = {
  A: "80-100",
  B: "70-79",
  C: "50-69",
  D: "0-49",
  unscored: "none",
};

/** Contacted people per tier before the A vs C calibration check means anything. */
export const MIN_CONTACTED_FOR_CALIBRATION = 300;
/** Tier A should reach at least this multiple of tier C's positive rate. */
export const CALIBRATION_RATIO = 1.5;

interface Performance {
  contacted: number;
  replies: number;
  positive_replies: number;
  meetings: number;
}

/**
 * ICP performance (spec 11.12, ICP playbook section 9): per ICP through the campaigns that
 * target it, per person fit tier, and per matched fit criterion, plus a calibration check.
 */
export async function buildIcp(args: BuildArgs): Promise<Built<IcpData>> {
  const ids = [args.workspace.id];
  const w = windowsDef([{ from: args.current.from, to: args.current.to }]);
  const flags = sql`flags as (
    select c.workspace_id, c.idx, c.person_id, c.first_at,
      exists (
        select 1 from replies r where r.workspace_id = c.workspace_id and r.idx = c.idx
          and r.person_id = c.person_id and r.at >= c.first_at
      ) as replied,
      exists (
        select 1 from replies r where r.workspace_id = c.workspace_id and r.idx = c.idx
          and r.person_id = c.person_id and r.at >= c.first_at
          and r.category in (${literalList(POSITIVE_CATEGORIES)})
      ) as positive,
      exists (
        select 1 from meetings m where m.workspace_id = c.workspace_id and m.idx = c.idx
          and m.person_id = c.person_id
      ) as met
    from contacted c
  )`;
  const contacted = sql`contacted as (
    select workspace_id, idx, person_id, min(sent_at) as first_at
    from sent
    where person_id is not null and action in (${literalList(CONTACT_ACTIONS)})
    group by 1, 2, 3
  )`;
  const cohort = [w, sentDef(ids), repliesDef(ids), ...meetingsDefs(ids), contacted, flags];

  const [icpList, contactedByIcp, repliesByIcp, meetingsByIcp, tierRows, criteriaRows] =
    await Promise.all([
      args.db
        .select({ id: icps.id, name: icps.name })
        .from(icps)
        .where(eq(icps.workspace_id, args.workspace.id)),
      rows<{ icp_id: string | null; n: number }>(
        args.db,
        sql`${withDefs(w, sentDef(ids))}
          select c.icp_id, count(distinct s.person_id)::int as n
          from sent s left join campaigns c on c.id = s.campaign_id
          where s.action in (${literalList(CONTACT_ACTIONS)})
          group by 1`,
      ),
      rows<{ icp_id: string | null; replies: number; positive_replies: number }>(
        args.db,
        sql`${withDefs(w, repliesDef(ids), attributedDef())}
          select c.icp_id, count(distinct a.person_id)::int as replies,
            count(distinct a.person_id) filter (
              where a.category in (${literalList(POSITIVE_CATEGORIES)})
            )::int as positive_replies
          from attributed a left join campaigns c on c.id = a.campaign_id
          group by 1`,
      ),
      rows<{ icp_id: string | null; n: number }>(
        args.db,
        sql`${withDefs(w, ...meetingsDefs(ids))}
          select c.icp_id, count(*)::int as n
          from meetings m left join campaigns c on c.id = m.campaign_id
          group by 1`,
      ),
      rows<Performance & { tier: IcpTier }>(
        args.db,
        sql`${withDefs(...cohort)}
          select
            case
              when p.fit_score is null then 'unscored'
              when p.fit_score >= 80 then 'A'
              when p.fit_score >= 70 then 'B'
              when p.fit_score >= 50 then 'C'
              else 'D'
            end as tier,
            count(*)::int as contacted,
            count(*) filter (where f.replied)::int as replies,
            count(*) filter (where f.positive)::int as positive_replies,
            count(*) filter (where f.met)::int as meetings
          from flags f join people p on p.id = f.person_id
          group by 1`,
      ),
      rows<{ rule: string; contacted: number; positive_replies: number }>(
        args.db,
        sql`${withDefs(...cohort)}
          select fr->>'rule' as rule, count(distinct f.person_id)::int as contacted,
            count(distinct f.person_id) filter (where f.positive)::int as positive_replies
          from flags f
          join people p on p.id = f.person_id
          cross join lateral jsonb_array_elements(
            case when jsonb_typeof(p.fit_reasons) = 'array' then p.fit_reasons else '[]'::jsonb end
          ) fr
          where fr->>'matched' = 'true' and coalesce(fr->>'rule', '') <> ''
          group by 1
          order by 2 desc, 1
          limit 15`,
      ),
    ]);

  const performance = (icpId: string | null): Performance => ({
    contacted: contactedByIcp.find((row) => row.icp_id === icpId)?.n ?? 0,
    replies: repliesByIcp.find((row) => row.icp_id === icpId)?.replies ?? 0,
    positive_replies: repliesByIcp.find((row) => row.icp_id === icpId)?.positive_replies ?? 0,
    meetings: meetingsByIcp.find((row) => row.icp_id === icpId)?.n ?? 0,
  });
  const withRates = (row: Performance) => ({
    ...row,
    reply_rate: rate(row.replies, row.contacted),
    positive_rate: rate(row.positive_replies, row.contacted),
  });

  const icpRows: IcpData["icps"] = icpList.map((icp) => ({
    icp_id: icp.id,
    name: icp.name,
    ...withRates(performance(icp.id)),
  }));
  const unassigned = performance(null);
  if (unassigned.contacted > 0 || unassigned.replies > 0 || unassigned.meetings > 0) {
    icpRows.push({
      icp_id: null,
      name: "No ICP (campaign without ICP or no campaign)",
      ...withRates(unassigned),
    });
  }

  const tiers = ICP_TIERS.map((tier) => {
    const row = tierRows.find((candidate) => candidate.tier === tier) ?? {
      contacted: 0,
      replies: 0,
      positive_replies: 0,
      meetings: 0,
    };
    return {
      tier,
      fit_range: TIER_RANGES[tier],
      ...withRates({
        contacted: row.contacted,
        replies: row.replies,
        positive_replies: row.positive_replies,
        meetings: row.meetings,
      }),
    };
  });

  return {
    data: {
      type: "icp",
      icps: icpRows,
      tiers,
      criteria: criteriaRows.map((row) => ({
        rule: row.rule,
        contacted: row.contacted,
        positive_replies: row.positive_replies,
        positive_rate: rate(row.positive_replies, row.contacted),
      })),
      calibration: calibrate(tiers),
    },
    metrics: [
      "contacted",
      "replies",
      "positive_replies",
      "meetings",
      "reply_rate",
      "positive_rate",
    ],
    notes: [
      "ICP rows count activity of the campaigns that target each ICP; tier and criterion rows count replies from the people contacted in the period, after their first touch, using their current fit score.",
      ...(args.previous ? ["The ICP report has no previous-period comparison."] : []),
    ],
  };
}

/** ICP playbook: after 300+ contacted per tier, tier A should reach 1.5x tier C's positive rate. */
export function calibrate(
  tiers: Array<{ tier: IcpTier; contacted: number; positive_replies: number }>,
): IcpData["calibration"] {
  const a = tiers.find((row) => row.tier === "A");
  const c = tiers.find((row) => row.tier === "C");
  const aCount = a?.contacted ?? 0;
  const cCount = c?.contacted ?? 0;
  if (
    !a ||
    !c ||
    aCount < MIN_CONTACTED_FOR_CALIBRATION ||
    cCount < MIN_CONTACTED_FOR_CALIBRATION
  ) {
    return {
      status: "insufficient_data",
      note: `Needs ${MIN_CONTACTED_FOR_CALIBRATION}+ contacted in tiers A and C (now A: ${aCount}, C: ${cCount}).`,
    };
  }
  const aRate = a.positive_replies / aCount;
  const cRate = c.positive_replies / cCount;
  if (cRate === 0) {
    return aRate > 0
      ? { status: "ok", note: "Tier A has positive replies and tier C has none." }
      : { status: "miscalibrated", note: "Neither tier A nor tier C has positive replies yet." };
  }
  const ratio = round1(aRate / cRate);
  return ratio >= CALIBRATION_RATIO
    ? { status: "ok", note: `Tier A converts ${ratio}x tier C (target ${CALIBRATION_RATIO}x).` }
    : {
        status: "miscalibrated",
        note: `Tier A converts only ${ratio}x tier C (target ${CALIBRATION_RATIO}x): adjust ICP weights before thresholds.`,
      };
}
