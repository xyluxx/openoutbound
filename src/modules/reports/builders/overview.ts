import { activityCounts, EMPTY_ACTIVITY, repliesByCategory } from "../activity.js";
import type { OverviewData } from "../schemas.js";
import {
  type BuildArgs,
  type Built,
  compareCount,
  OUTREACH_METRIC_KEYS,
  outreachMetrics,
  windowsOf,
} from "./common.js";

/** Overview: this period vs the previous one (spec 11.12). */
export async function buildOverview(args: BuildArgs): Promise<Built<OverviewData>> {
  const windows = windowsOf(args);
  const ids = [args.workspace.id];
  const [counts, categories] = await Promise.all([
    activityCounts(args.db, ids, windows),
    repliesByCategory(args.db, ids, windows[0] ?? { from: args.current.from, to: args.current.to }),
  ]);
  const perWindow = counts.get(args.workspace.id) ?? [];
  const current = perWindow[0] ?? EMPTY_ACTIVITY;
  const previous = args.previous ? (perWindow[1] ?? EMPTY_ACTIVITY) : undefined;
  const notes: string[] = [];
  if (current.contacted === 0) {
    notes.push("Nobody was contacted in this period, so rates are empty.");
  }
  return {
    data: {
      type: "overview",
      metrics: {
        new_leads: compareCount(current, previous, (row) => row.new_leads),
        enrolled: compareCount(current, previous, (row) => row.enrolled),
        ...outreachMetrics(current, previous),
      },
      replies_by_category: categories.get(args.workspace.id) ?? {},
    },
    metrics: ["new_leads", "enrolled", ...OUTREACH_METRIC_KEYS],
    notes,
  };
}
