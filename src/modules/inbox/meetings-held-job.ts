/**
 * Hourly held sweep (spec 2.5): a scheduled meeting counts as held once
 * `booking.assume_held_after_hours` have passed after its start without a cancellation or a
 * no-show. 0 turns the sweep off, so meetings wait for an explicit mark (manage_meetings action
 * mark_held). Each meeting goes through `setMeetingStatus`, so `meeting.held` fires once.
 */
import { z } from "zod";
import { type BuiltinSchedule, defineJob } from "../../core/operation.js";
import { parseWorkspaceSettings } from "../../core/settings.js";
import { scheduledMeetingsStartedBy, setMeetingStatus } from "./meeting-records.js";

export const ASSUME_HELD_JOB = "meetings.assume_held";
const HOUR_MS = 3_600_000;
const BATCH = 200;
const MAX_BATCHES = 10;

export interface AssumeHeldSummary {
  after_hours: number;
  marked_held: number;
  more_left: boolean;
}

export const assumeHeldJob = defineJob({
  name: ASSUME_HELD_JOB,
  payload: z.object({}).passthrough(),
  maxAttempts: 3,
  timeoutMs: 10 * 60_000,
  handler: async (ctx): Promise<AssumeHeldSummary | { skipped: string }> => {
    if (!ctx.workspace) return { skipped: "no_workspace" };
    const hours = parseWorkspaceSettings(ctx.workspace.settings).booking.assume_held_after_hours;
    if (hours <= 0) return { skipped: "assume_held_off" };
    const cutoff = new Date(ctx.clock.now().getTime() - hours * HOUR_MS);
    const summary: AssumeHeldSummary = { after_hours: hours, marked_held: 0, more_left: false };
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      ctx.job.signal.throwIfAborted();
      const ids = await scheduledMeetingsStartedBy(ctx, cutoff, BATCH);
      for (const id of ids) {
        // Only a meeting still scheduled: a no-show or cancellation that came in meanwhile wins.
        const { changed } = await setMeetingStatus(ctx, id, "held", { onlyFrom: "scheduled" });
        if (changed) summary.marked_held += 1;
      }
      if (ids.length < BATCH) break;
      if (batch === MAX_BATCHES - 1) summary.more_left = true;
    }
    if (summary.marked_held > 0) {
      await ctx.audit.record({
        operation: ASSUME_HELD_JOB,
        effect: "write",
        status: "ok",
        summary: `Counted ${summary.marked_held} meeting(s) as held ${hours} hours after their start`,
        input: { ...summary },
      });
    }
    return summary;
  },
});

export const assumeHeldSchedule: BuiltinSchedule = {
  name: ASSUME_HELD_JOB,
  cron: "23 * * * *",
  job: ASSUME_HELD_JOB,
  perWorkspace: true,
};
