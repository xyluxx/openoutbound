/**
 * Daily reminders for open privacy requests (problems of kind `privacy_request` with a
 * deadline): one notification when 7 days or fewer remain (remembered in `data.reminded_at`),
 * then one a day once the deadline has passed (`data.overdue_notified_on`), with the problem
 * title raised to say it is overdue. Resolved problems are skipped, and so are snoozed ones
 * until their snooze ends.
 */
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import type { OpContext } from "../../core/context.js";
import { type BuiltinSchedule, defineJob } from "../../core/operation.js";
import { problems } from "../../db/schema/index.js";
import { listProblems, type ProblemRecord } from "../problems/service.js";
import { isoDateInZone } from "./dates.js";
import { safeNotify } from "./notifications.js";
import { plainDate } from "./privacy-source.js";

export const PRIVACY_REMINDERS_JOB = "inbox.privacy_reminders";
/** The reminder fires when this many days or fewer remain. */
export const PRIVACY_REMINDER_DAYS = 7;
/** Put before the title of a privacy problem once its deadline passed. */
export const OVERDUE_PREFIX = "Overdue: ";
const DAY_MS = 86_400_000;
const PAGE = 100;
const MAX_PAGES = 50;

export interface PrivacyReminderSummary {
  checked: number;
  reminded: number;
  overdue: number;
}

/** The first paragraph of a remedy (the next step, without the suggested reply). */
function nextStep(remedy: string): string {
  return remedy.split("\n\n")[0]?.trim() ?? remedy;
}

/**
 * Stores the reminder on the problem, only while it is unresolved: a problem someone resolved
 * in the meantime is left alone (never reopened).
 */
async function markReminded(
  ctx: OpContext,
  problem: ProblemRecord,
  patch: { title?: string; data: Record<string, unknown> },
): Promise<void> {
  await ctx.db
    .update(problems)
    .set({ ...patch, updated_at: ctx.clock.now() })
    .where(
      and(
        eq(problems.workspace_id, problem.workspace_id),
        eq(problems.id, problem.id),
        ne(problems.status, "resolved"),
      ),
    );
}

async function remind(
  ctx: OpContext,
  problem: ProblemRecord,
  now: Date,
  today: string,
  timeZone: string,
): Promise<"reminded" | "overdue" | null> {
  const due = problem.due_at;
  if (!due) return null;
  const data = problem.data ?? {};
  const left = due.getTime() - now.getTime();
  if (left <= 0) {
    if (data.overdue_notified_on === today) return null;
    const title = problem.title.startsWith(OVERDUE_PREFIX)
      ? problem.title
      : `${OVERDUE_PREFIX}${problem.title}`;
    const late = Math.max(1, Math.floor(-left / DAY_MS));
    await safeNotify(ctx, {
      title,
      lines: [
        `The answer was due on ${plainDate(due, timeZone)}, ${late} ${late === 1 ? "day" : "days"} ago.`,
        problem.reason,
        `Next step: ${nextStep(problem.remedy)}`,
        `Problem ${problem.id}`,
      ],
      severity: "critical",
    });
    await markReminded(ctx, problem, {
      title,
      data: {
        ...data,
        overdue_notified_on: today,
        overdue_since: data.overdue_since ?? due.toISOString(),
      },
    });
    return "overdue";
  }
  if (left > PRIVACY_REMINDER_DAYS * DAY_MS || data.reminded_at) return null;
  const days = Math.ceil(left / DAY_MS);
  await safeNotify(ctx, {
    title: `${problem.title} (${days} ${days === 1 ? "day" : "days"} left)`,
    lines: [problem.reason, `Next step: ${nextStep(problem.remedy)}`, `Problem ${problem.id}`],
    severity: "warning",
  });
  await markReminded(ctx, problem, { data: { ...data, reminded_at: now.toISOString() } });
  return "reminded";
}

/** Sends the due reminders for the context workspace's open privacy requests. */
export async function sendPrivacyReminders(ctx: OpContext): Promise<PrivacyReminderSummary> {
  const summary: PrivacyReminderSummary = { checked: 0, reminded: 0, overdue: 0 };
  if (!ctx.workspace) return summary;
  const timeZone = ctx.workspace.timezone;
  const now = ctx.clock.now();
  const today = isoDateInZone(now, timeZone);
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await listProblems(ctx, {
      statuses: ["open"],
      kinds: ["privacy_request"],
      limit: PAGE,
      cursor,
    });
    for (const problem of result.items) {
      summary.checked += 1;
      const sent = await remind(ctx, problem, now, today, timeZone);
      if (sent) summary[sent] += 1;
    }
    if (!result.has_more || !result.next_cursor) break;
    cursor = result.next_cursor;
  }
  return summary;
}

export const privacyRemindersJob = defineJob({
  name: PRIVACY_REMINDERS_JOB,
  payload: z.object({}).passthrough(),
  maxAttempts: 3,
  handler: async (ctx) => {
    if (!ctx.workspace) return { skipped: "no_workspace" };
    return sendPrivacyReminders(ctx);
  },
});

/** Every morning (UTC), for every workspace that is not archived, paused ones included. */
export const privacyRemindersSchedule: BuiltinSchedule = {
  name: PRIVACY_REMINDERS_JOB,
  cron: "5 8 * * *",
  job: PRIVACY_REMINDERS_JOB,
  perWorkspace: true,
};
