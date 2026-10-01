/**
 * Promises we make in replies ("I'll send the case study on Monday"). When a reply goes out
 * (`message.sent` with action reply, or a person's own reply that took a thread over), a small
 * fast-tier prompt lists up to 3 of them, and each becomes a task of type `promise`, due at
 * 09:00 UTC on the promised day (moved to the next working day when that is a day off) or on the
 * next working day when no day was promised. A daily job marks expired lead-file facts and turns
 * promises more than a day overdue into `promise_overdue` problems, resolved once the task is
 * done or skipped, or once the person may not be contacted any more (opted out, suppressed,
 * do not contact, erased).
 */
import { and, asc, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { z } from "zod";
import { type JobContext, type OpContext, requireWorkspace } from "../../core/context.js";
import { type BuiltinSchedule, defineJob, onEvent } from "../../core/operation.js";
import { parseWorkspaceSettings } from "../../core/settings.js";
import { people, tasks } from "../../db/schema/index.js";
import { peopleNotToContact } from "../leads/contactable.js";
import { expireFacts } from "../leads/service.js";
import { listProblems, openProblem, resolveProblem } from "../problems/service.js";
import { isIsoDate, isoDateInZone, nextWorkingDay, safeTimeZone } from "./dates.js";
import { personLabel } from "./notifications.js";
import { stripQuotedText } from "./prechecks.js";
import { MAX_PROMISES, type PromisesOutput, promisesPrompt } from "./prompts/promises.js";
import { findMessage } from "./reply-context.js";
import { createTask } from "./tasks.js";

export const EXTRACT_PROMISES_JOB = "inbox.extract_promises";
export const LEAD_FILE_DAILY_JOB = "inbox.lead_file_daily";

const DAY_MS = 86_400_000;
const PROMISE_TEXT_MAX = 200;
/** Overdue promises handled per daily run (the rest wait for the next run). */
const OVERDUE_BATCH = 500;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Dedupe key of the problem for an overdue promise task. */
export function promiseOverdueKey(taskId: string): string {
  return `promise_overdue:${taskId}`;
}

function jobIdOf(ctx: OpContext): string | undefined {
  return (ctx as Partial<JobContext>).job?.id;
}

function previousDay(isoDate: string): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
}

/**
 * Due time of a promise: 09:00 UTC on the promised day, or on the next working day when that
 * day is off; without a (usable) promised day, 09:00 UTC on the next working day after the send.
 */
export function promiseDueAt(input: {
  due: string | null;
  sentOn: string;
  workingDays: number[];
  holidays: string[];
}): Date {
  const { due, sentOn, workingDays, holidays } = input;
  const day =
    isIsoDate(due) && due >= sentOn
      ? nextWorkingDay(previousDay(due), workingDays, holidays)
      : nextWorkingDay(sentOn, workingDays, holidays);
  return new Date(`${day}T09:00:00Z`);
}

/** Cleans model output: trimmed, deduplicated, at most 3, each at most 200 characters. */
function cleanPromises(promises: PromisesOutput["promises"]): PromisesOutput["promises"] {
  const out: PromisesOutput["promises"] = [];
  const seen = new Set<string>();
  for (const promise of promises) {
    const text = promise.text.replace(/\s+/g, " ").trim().slice(0, PROMISE_TEXT_MAX).trim();
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push({ text, due: isIsoDate(promise.due) ? promise.due : null });
    if (out.length >= MAX_PROMISES) break;
  }
  return out;
}

export interface ExtractPromisesResult {
  message_id: string;
  skipped?: string;
  promises?: number;
  created?: number;
}

/** Runs the promises prompt over one sent reply and stores each promise as a task. */
export async function extractPromises(
  ctx: OpContext,
  messageId: string,
): Promise<ExtractPromisesResult> {
  const workspace = ctx.workspace;
  if (!workspace) return { message_id: messageId, skipped: "no_workspace" };
  const settings = parseWorkspaceSettings(workspace.settings);
  if (!settings.lead_file.extract_promises)
    return { message_id: messageId, skipped: "setting_off" };
  const message = await findMessage(ctx, messageId);
  if (message?.direction !== "outbound") return { message_id: messageId, skipped: "not_found" };
  if (message.status !== "sent") {
    return { message_id: messageId, skipped: `status_${message.status}` };
  }
  const text = stripQuotedText(message.body_text ?? "")
    .trim()
    .slice(0, 4000);
  if (!text) return { message_id: messageId, skipped: "no_text" };

  const zone = safeTimeZone(workspace.timezone);
  const sentOn = isoDateInZone(message.sent_at ?? message.created_at, zone);
  const result = await ctx.brain.run(
    promisesPrompt,
    {
      company: settings.company.name,
      channel: message.channel,
      sentOn,
      weekday: WEEKDAYS[new Date(`${sentOn}T00:00:00Z`).getUTCDay()] ?? "",
      timeZone: zone,
      subject: message.subject,
      text,
    },
    { taskKey: `${EXTRACT_PROMISES_JOB}:${message.id}`, jobId: jobIdOf(ctx) },
  );
  const promises = cleanPromises(result.output.promises);
  let created = 0;
  for (const [index, promise] of promises.entries()) {
    const stored = await createTask(ctx, {
      title: promise.text,
      type: "promise",
      notes: `Promised in our reply of ${sentOn} (message ${message.id}).`,
      dueAt: promiseDueAt({
        due: promise.due,
        sentOn,
        workingDays: settings.schedule.working_days,
        holidays: settings.schedule.holidays,
      }),
      personId: message.person_id,
      campaignId: message.campaign_id,
      threadId: message.thread_id,
      dedupeKey: `promise:${message.id}:${index}`,
    });
    if (stored.created) created += 1;
  }
  return { message_id: message.id, promises: promises.length, created };
}

export const extractPromisesJob = defineJob({
  name: EXTRACT_PROMISES_JOB,
  payload: z.object({ message_id: z.string() }),
  maxAttempts: 4,
  handler: (ctx, payload) => extractPromises(ctx, payload.message_id),
});

async function enqueueExtraction(ctx: JobContext, messageId: string): Promise<void> {
  if (!ctx.workspace) return;
  if (!parseWorkspaceSettings(ctx.workspace.settings).lead_file.extract_promises) return;
  await ctx.jobs.enqueue(
    EXTRACT_PROMISES_JOB,
    { message_id: messageId },
    { singletonKey: `${EXTRACT_PROMISES_JOB}:${messageId}` },
  );
}

/** Our reply went out: look for promises in it. */
export const promisesOnReplySent = onEvent(
  "message.sent",
  "inbox.promises_on_reply",
  async (ctx, event) => {
    if (event.data.action !== "reply") return;
    await enqueueExtraction(ctx, event.data.message_id);
  },
);

/** A person answered in the thread themselves: look for promises in their reply. */
export const promisesOnTakeover = onEvent(
  "thread.taken_over",
  "inbox.promises_on_takeover",
  async (ctx, event) => {
    if (!event.data.message_id) return;
    await enqueueExtraction(ctx, event.data.message_id);
  },
);

// --- Daily job -------------------------------------------------------------------------------

/** The people among `personIds` who may not be contacted any more (a promise to them lapses). */
function mayNotBeContacted(ctx: OpContext, personIds: string[]): Promise<Set<string>> {
  // Promises are read from email replies, so an email suppression lapses them too.
  return peopleNotToContact(ctx, personIds, "email");
}

export interface OverduePromisesResult {
  promises_overdue: number;
  problems_opened: number;
  problems_resolved: number;
}

/**
 * Opens a `promise_overdue` problem (normal, owner person) for every open promise task more
 * than a day past due, except to people who may not be contacted any more, and resolves the
 * ones whose task is done, skipped or gone, or whose person may not be contacted.
 */
export async function checkOverduePromises(ctx: OpContext): Promise<OverduePromisesResult> {
  const workspace = requireWorkspace(ctx);
  const now = ctx.clock.now();
  const overdue = await ctx.db
    .select({ task: tasks, person: { full_name: people.full_name, email: people.email } })
    .from(tasks)
    .leftJoin(people, eq(people.id, tasks.person_id))
    .where(
      and(
        eq(tasks.workspace_id, workspace.id),
        eq(tasks.type, "promise"),
        eq(tasks.status, "open"),
        isNotNull(tasks.due_at),
        lt(tasks.due_at, new Date(now.getTime() - DAY_MS)),
      ),
    )
    .orderBy(asc(tasks.due_at), asc(tasks.id))
    .limit(OVERDUE_BATCH);
  const blocked = await mayNotBeContacted(
    ctx,
    overdue.map(({ task }) => task.person_id).filter((id): id is string => Boolean(id)),
  );
  let opened = 0;
  for (const { task, person } of overdue) {
    if (task.person_id && blocked.has(task.person_id)) continue;
    const due = task.due_at ?? now;
    const who = person?.full_name || person?.email ? personLabel(person, null) : "a lead";
    const { created } = await openProblem(ctx, {
      kind: "promise_overdue",
      severity: "normal",
      owner: "person",
      title: `Promise overdue: ${task.title}`,
      reason: `We promised ${who}: "${task.title}". It was due ${due.toISOString().slice(0, 16).replace("T", " ")} UTC and is more than a day late.`,
      remedy: `Do it, then mark the task done with manage_tasks action complete and task_id ${task.id} (or skip it there if it no longer applies).`,
      subject: { type: "task", id: task.id },
      personId: task.person_id,
      data: { task_id: task.id, due_at: due.toISOString(), thread_id: task.thread_id },
      dueAt: due,
      dedupeKey: promiseOverdueKey(task.id),
    });
    if (created) opened += 1;
  }

  const open: Array<{ id: string; taskId: string | null }> = [];
  let cursor: string | null = null;
  do {
    const page = await listProblems(ctx, {
      kinds: ["promise_overdue"],
      statuses: ["open", "snoozed"],
      limit: 100,
      cursor,
    });
    for (const problem of page.items) open.push({ id: problem.id, taskId: problem.subject_id });
    cursor = page.next_cursor;
  } while (cursor);
  const taskIds = open.map((problem) => problem.taskId).filter((id): id is string => Boolean(id));
  const taskOf = new Map(
    taskIds.length === 0
      ? []
      : (
          await ctx.db
            .select({ id: tasks.id, status: tasks.status, person_id: tasks.person_id })
            .from(tasks)
            .where(and(eq(tasks.workspace_id, workspace.id), inArray(tasks.id, taskIds)))
        ).map((row) => [row.id, row]),
  );
  const lapsed = await mayNotBeContacted(
    ctx,
    [...taskOf.values()]
      .filter((task) => task.status === "open")
      .map((task) => task.person_id)
      .filter((id): id is string => Boolean(id)),
  );
  let resolved = 0;
  for (const problem of open) {
    const task = problem.taskId ? taskOf.get(problem.taskId) : undefined;
    const noContact = Boolean(task?.person_id && lapsed.has(task.person_id));
    if (task?.status === "open" && !noContact) continue;
    const result = await resolveProblem(ctx, problem.id, {
      resolution: noContact
        ? "The person may not be contacted any more."
        : task
          ? `The task was marked ${task.status}.`
          : "The task no longer exists.",
    });
    if (result.resolved) resolved += 1;
  }
  return { promises_overdue: overdue.length, problems_opened: opened, problems_resolved: resolved };
}

export const leadFileDailyJob = defineJob({
  name: LEAD_FILE_DAILY_JOB,
  payload: z.object({}).passthrough(),
  maxAttempts: 3,
  handler: async (ctx) => {
    if (!ctx.workspace) return { skipped: "no_workspace" };
    const factsExpired = await expireFacts(ctx);
    return { facts_expired: factsExpired, ...(await checkOverduePromises(ctx)) };
  },
});

export const leadFileDailySchedule: BuiltinSchedule = {
  name: LEAD_FILE_DAILY_JOB,
  cron: "25 4 * * *",
  job: LEAD_FILE_DAILY_JOB,
  perWorkspace: true,
};
