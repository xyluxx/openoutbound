import { Cron } from "croner";
import { OpenOutboundError } from "../../../core/errors.js";

const MIN_INTERVAL_MS = 60 * 60_000;

function parse(cron: string, timezone: string): Cron {
  try {
    return new Cron(cron, { timezone, paused: true });
  } catch (error) {
    throw new OpenOutboundError("validation_failed", `Invalid cron schedule "${cron}".`, {
      hint: 'Use a 5-field cron expression, e.g. "0 6 * * *" (daily at 06:00) or "0 6 * * 1" (Mondays).',
      details: { field: "schedule", error: error instanceof Error ? error.message : String(error) },
    });
  }
}

/**
 * Validates a monitor schedule: a valid cron with at most one run per hour (monitors crawl
 * other people's websites and may spend credits).
 */
export function assertMonitorSchedule(cron: string, timezone: string, now: Date): void {
  const runs = parse(cron, timezone).nextRuns(3, now);
  if (runs.length === 0) {
    throw new OpenOutboundError("validation_failed", `The schedule "${cron}" never runs.`, {
      hint: 'Use a recurring cron expression, e.g. "0 6 * * *".',
      details: { field: "schedule" },
    });
  }
  for (let i = 1; i < runs.length; i++) {
    const gap = (runs[i]?.getTime() ?? 0) - (runs[i - 1]?.getTime() ?? 0);
    if (gap < MIN_INTERVAL_MS) {
      throw new OpenOutboundError(
        "validation_failed",
        `The schedule "${cron}" runs more than once per hour.`,
        {
          hint: 'Monitors run at most hourly; daily ("0 6 * * *") suits most collectors.',
          details: { field: "schedule" },
        },
      );
    }
  }
}

/** Next run strictly after `after`, or null. */
export function nextMonitorRun(cron: string, timezone: string, after: Date): Date | null {
  try {
    return new Cron(cron, { timezone, paused: true }).nextRun(after);
  } catch {
    return null;
  }
}

/** Approximate runs per 30 days, for monthly cost estimates. */
export function runsPerMonth(cron: string, timezone: string, from: Date): number {
  try {
    const until = from.getTime() + 30 * 86_400_000;
    const runs = new Cron(cron, { timezone, paused: true }).nextRuns(800, from);
    return runs.filter((run) => run.getTime() <= until).length;
  } catch {
    return 0;
  }
}
