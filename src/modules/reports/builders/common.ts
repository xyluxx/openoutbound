import type { OpContext } from "../../../core/context.js";
import { parseWorkspaceSettings, type WorkspaceSettings } from "../../../core/settings.js";
import type { Db } from "../../../db/client.js";
import type { Workspace } from "../../../db/schema/index.js";
import type { ActivityCounts } from "../activity.js";
import type { MetricKey } from "../definitions.js";
import { type Metric, metric, rate } from "../metric.js";
import type { Period } from "../period.js";
import type { ReportData } from "../schemas.js";
import type { Window } from "../sql.js";

/** What every workspace report builder gets. */
export interface BuildArgs {
  ctx: OpContext;
  db: Db;
  workspace: Workspace;
  current: Period;
  /** Null when the caller turned comparison off. */
  previous: Period | null;
  now: Date;
  campaignId?: string | null;
}

/** A builder's result: the data plus the metrics to define and notes for the reader. */
export interface Built<T extends ReportData> {
  data: T;
  metrics: MetricKey[];
  notes: string[];
}

/** Workspace settings with defaults; stored settings that no longer parse fall back to defaults. */
export function settingsOf(workspace: Pick<Workspace, "settings">): WorkspaceSettings {
  try {
    return parseWorkspaceSettings(workspace.settings);
  } catch {
    return parseWorkspaceSettings({});
  }
}

/** [current] or [current, previous]. */
export function windowsOf(args: Pick<BuildArgs, "current" | "previous">): Window[] {
  const windows: Window[] = [{ from: args.current.from, to: args.current.to }];
  if (args.previous) windows.push({ from: args.previous.from, to: args.previous.to });
  return windows;
}

/** Metric from a current and optional previous row (previous undefined = no comparison). */
export function compareCount<T>(
  current: T,
  previous: T | undefined,
  pick: (row: T) => number,
): Metric {
  return metric(pick(current), previous === undefined ? undefined : pick(previous));
}

export function compareRate<T>(
  current: T,
  previous: T | undefined,
  numerator: (row: T) => number,
  denominator: (row: T) => number,
): Metric {
  return metric(
    rate(numerator(current), denominator(current)),
    previous === undefined ? undefined : rate(numerator(previous), denominator(previous)),
    "rate",
  );
}

export function compareAmount<T>(
  current: T,
  previous: T | undefined,
  pick: (row: T) => number,
): Metric {
  return metric(pick(current), previous === undefined ? undefined : pick(previous), "amount");
}

/** The shared outreach metrics (overview, campaigns, agency). */
export function outreachMetrics(current: ActivityCounts, previous: ActivityCounts | undefined) {
  const count = (pick: (row: ActivityCounts) => number) => compareCount(current, previous, pick);
  return {
    contacted: count((row) => row.contacted),
    emails_sent: count((row) => row.emails_sent),
    linkedin_sent: count((row) => row.linkedin_sent),
    replies: count((row) => row.replies),
    positive_replies: count((row) => row.positive_replies),
    meetings: count((row) => row.meetings),
    bounced: count((row) => row.bounced),
    reply_rate: compareRate(
      current,
      previous,
      (row) => row.replies,
      (row) => row.contacted,
    ),
    positive_rate: compareRate(
      current,
      previous,
      (row) => row.positive_replies,
      (row) => row.contacted,
    ),
    bounce_rate: compareRate(
      current,
      previous,
      (row) => row.bounced,
      (row) => row.emails_sent,
    ),
  };
}

export const OUTREACH_METRIC_KEYS: MetricKey[] = [
  "contacted",
  "emails_sent",
  "linkedin_sent",
  "replies",
  "positive_replies",
  "meetings",
  "bounced",
  "reply_rate",
  "positive_rate",
  "bounce_rate",
];
