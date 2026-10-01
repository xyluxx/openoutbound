import { asc, ne, sql } from "drizzle-orm";
import type { Principal } from "../../../core/context.js";
import { forbidden, OpenOutboundError } from "../../../core/errors.js";
import type { Db } from "../../../db/client.js";
import { workspaces } from "../../../db/schema/index.js";
import { type ActivityCounts, activityCounts, EMPTY_ACTIVITY } from "../activity.js";
import type { Period } from "../period.js";
import type { AgencyData, AgencyMetrics } from "../schemas.js";
import { inWorkspaces, rows, type Window } from "../sql.js";
import { type Built, compareAmount, OUTREACH_METRIC_KEYS, outreachMetrics } from "./common.js";
import { type CostTotals, costTotals } from "./costs.js";

export interface AgencyArgs {
  db: Db;
  current: Period;
  previous: Period | null;
  now: Date;
}

/**
 * The agency report reads every workspace, so it needs an instance-level principal (not bound
 * to one workspace) with the admin scope: the local CLI or an instance API key.
 */
export function assertAgencyAccess(principal: Principal): void {
  if (principal.workspaceId !== null) {
    throw new OpenOutboundError(
      "forbidden",
      "The agency report compares all workspaces, but this key is bound to one workspace.",
      {
        hint: "Use an instance-level API key with the admin scope (or the local CLI), or call get_report with another type for this workspace.",
        details: { missing: "instance_principal" },
      },
    );
  }
  if (!principal.scopes.includes("admin")) throw forbidden("admin");
}

interface Snapshot {
  workspace_id: string;
  n: number;
}

/** All workspaces side by side (spec 11.12), one grouped query per metric family. */
export async function buildAgency(args: AgencyArgs): Promise<Built<AgencyData>> {
  const list = await args.db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      status: workspaces.status,
      is_sandbox: workspaces.is_sandbox,
    })
    .from(workspaces)
    .where(ne(workspaces.status, "archived"))
    .orderBy(asc(workspaces.name));
  const ids = list.map((workspace) => workspace.id);
  const windows: Window[] = [{ from: args.current.from, to: args.current.to }];
  if (args.previous) windows.push({ from: args.previous.from, to: args.previous.to });

  const [activity, costs, approvals, warnings] =
    ids.length === 0
      ? [new Map<string, ActivityCounts[]>(), new Map<string, CostTotals[]>(), [], []]
      : await Promise.all([
          activityCounts(args.db, ids, windows),
          costTotals(args.db, ids, windows),
          rows<Snapshot>(
            args.db,
            sql`select a.workspace_id, count(*)::int as n from approvals a
              where ${inWorkspaces("a", ids)} and a.status = 'pending'
                and (a.expires_at is null or a.expires_at > ${args.now.toISOString()}::timestamptz)
              group by 1`,
          ),
          rows<Snapshot>(
            args.db,
            sql`select x.workspace_id, count(*)::int as n from (
                select m.workspace_id from mailboxes m
                where ${inWorkspaces("m", ids)} and m.status in ('paused', 'error', 'disconnected')
                union all
                select l.workspace_id from linkedin_accounts l
                where ${inWorkspaces("l", ids)} and l.status in ('restricted', 'disconnected')
              ) x
              group by 1`,
          ),
        ]);

  const compare = args.previous !== null;
  const metricsFor = (counts: ActivityCounts[], cost: CostTotals[]): AgencyMetrics => {
    const current = counts[0] ?? EMPTY_ACTIVITY;
    const previous = compare ? (counts[1] ?? EMPTY_ACTIVITY) : undefined;
    const outreach = outreachMetrics(current, previous);
    const costNow = cost[0] ?? { ai_cost_usd: 0, data_credits: 0 };
    const costBefore = compare ? (cost[1] ?? { ai_cost_usd: 0, data_credits: 0 }) : undefined;
    return {
      contacted: outreach.contacted,
      emails_sent: outreach.emails_sent,
      linkedin_sent: outreach.linkedin_sent,
      replies: outreach.replies,
      positive_replies: outreach.positive_replies,
      meetings: outreach.meetings,
      reply_rate: outreach.reply_rate,
      positive_rate: outreach.positive_rate,
      bounce_rate: outreach.bounce_rate,
      ai_cost_usd: compareAmount(costNow, costBefore, (row) => row.ai_cost_usd),
      data_credits: compareAmount(costNow, costBefore, (row) => row.data_credits),
    };
  };

  const rowsOut = list.map((workspace) => ({
    workspace_id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    status: workspace.status,
    is_sandbox: workspace.is_sandbox,
    metrics: metricsFor(activity.get(workspace.id) ?? [], costs.get(workspace.id) ?? []),
    pending_approvals: approvals.find((row) => row.workspace_id === workspace.id)?.n ?? 0,
    warnings: warnings.find((row) => row.workspace_id === workspace.id)?.n ?? 0,
  }));

  const hasReal = list.some((workspace) => !workspace.is_sandbox);
  const counted = list.filter((workspace) => !hasReal || !workspace.is_sandbox);
  const sumActivity = (idx: number): ActivityCounts => {
    const total = { ...EMPTY_ACTIVITY };
    for (const workspace of counted) {
      const row = activity.get(workspace.id)?.[idx];
      if (!row) continue;
      for (const key of Object.keys(total) as Array<keyof ActivityCounts>) total[key] += row[key];
    }
    return total;
  };
  const sumCosts = (idx: number): CostTotals => {
    const total: CostTotals = {
      ai_cost_usd: 0,
      data_cost_usd: 0,
      data_credits: 0,
      unpriced_calls: 0,
    };
    for (const workspace of counted) {
      const row = costs.get(workspace.id)?.[idx];
      if (!row) continue;
      total.ai_cost_usd += row.ai_cost_usd;
      total.data_cost_usd += row.data_cost_usd;
      total.data_credits += row.data_credits;
      total.unpriced_calls += row.unpriced_calls;
    }
    return total;
  };
  const totalActivity = compare ? [sumActivity(0), sumActivity(1)] : [sumActivity(0)];
  const totalCosts = compare ? [sumCosts(0), sumCosts(1)] : [sumCosts(0)];

  const notes: string[] = [];
  if (hasReal && list.some((workspace) => workspace.is_sandbox)) {
    notes.push("Totals leave out sandbox workspaces.");
  }
  if (list.length === 0) notes.push("There are no workspaces yet.");
  return {
    data: {
      type: "agency",
      workspaces: rowsOut,
      totals: metricsFor(totalActivity, totalCosts),
      totals_exclude_sandbox: hasReal && list.some((workspace) => workspace.is_sandbox),
    },
    metrics: [
      ...OUTREACH_METRIC_KEYS.filter((key) => key !== "bounced"),
      "ai_cost_usd",
      "data_credits",
      "pending_approvals",
    ],
    notes,
  };
}
