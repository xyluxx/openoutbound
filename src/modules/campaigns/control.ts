import { and, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { OpContext } from "../../core/context.js";
import { requireWorkspace } from "../../core/context.js";
import type { EnrollmentStatus, MessageStatus } from "../../core/enums.js";
import { type CampaignSettings, parseCampaignSettings } from "../../core/settings.js";
import {
  campaigns,
  type Enrollment,
  enrollment_step_runs,
  enrollments,
  messages,
  people,
} from "../../db/schema/index.js";
import { requestStatsRefresh } from "./stats.js";

/** Enrollments that are not finished. */
export const IN_PROGRESS: EnrollmentStatus[] = ["queued", "active", "paused", "waiting_review"];
/** Message statuses that can still be stopped before sending. */
export const PENDING_MESSAGE_STATUSES: MessageStatus[] = [
  "generating",
  "draft",
  "pending_review",
  "approved",
  "scheduled",
];

export const PENDING_CLASSIFICATION = "reply_pending_classification";
/** How long a reply may wait for classification before the enrollment stops. */
export const PENDING_CLASSIFICATION_MS = 24 * 60 * 60 * 1000;

const REPLY_REASONS = new Set(["replied", "reply", "reply_received"]);
const MEETING_REASONS = new Set(["meeting", "meeting_booked"]);

/**
 * Whether the campaign's stop rules allow stopping for this reason. Reply reasons follow
 * `stop.on_reply`, meeting reasons follow `stop.on_meeting`, and for colleagues of the person
 * both follow `stop.on_company_reply`; every other reason (unsubscribed, bounced, won,
 * left_company, manual, ...) always stops.
 */
export function stopAllowed(
  settings: CampaignSettings,
  reason: string,
  colleague: boolean,
): boolean {
  const key = reason.toLowerCase();
  if (colleague) {
    return REPLY_REASONS.has(key) || MEETING_REASONS.has(key)
      ? settings.stop.on_company_reply
      : true;
  }
  if (REPLY_REASONS.has(key)) return settings.stop.on_reply;
  if (MEETING_REASONS.has(key)) return settings.stop.on_meeting;
  return true;
}

async function settingsByCampaign(
  ctx: OpContext,
  campaignIds: string[],
): Promise<Map<string, CampaignSettings>> {
  const workspace = requireWorkspace(ctx);
  if (campaignIds.length === 0) return new Map();
  const rows = await ctx.db
    .select({ id: campaigns.id, settings: campaigns.settings })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.workspace_id, workspace.id),
        inArray(campaigns.id, [...new Set(campaignIds)]),
      ),
    );
  return new Map(rows.map((row) => [row.id, parseCampaignSettings(row.settings)]));
}

/** Cancels the not-yet-sent messages (and their pending approvals) of these enrollments. */
export async function cancelPendingMessages(
  ctx: OpContext,
  enrollmentIds: string[],
  reason: string,
): Promise<number> {
  const workspace = requireWorkspace(ctx);
  if (enrollmentIds.length === 0) return 0;
  const pending = await ctx.db
    .select({ id: messages.id, status: messages.status })
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, workspace.id),
        inArray(messages.enrollment_id, enrollmentIds),
        eq(messages.direction, "outbound"),
        inArray(messages.status, PENDING_MESSAGE_STATUSES),
      ),
    );
  if (pending.length === 0) return 0;
  await ctx.db
    .update(messages)
    .set({ status: "cancelled", error: reason })
    .where(
      and(
        eq(messages.workspace_id, workspace.id),
        inArray(
          messages.id,
          pending.map((message) => message.id),
        ),
        inArray(messages.status, PENDING_MESSAGE_STATUSES),
      ),
    );
  for (const message of pending) {
    if (message.status === "pending_review") {
      await ctx.approvals.cancel({ target: { type: "message", id: message.id } }, reason);
    }
  }
  return pending.length;
}

/**
 * Stops enrollments that are still in progress: status stopped, pending messages and approvals
 * cancelled, open step runs closed, `enrollment.stopped` emitted. Returns how many stopped.
 */
export async function stopEnrollments(
  ctx: OpContext,
  rows: Array<Pick<Enrollment, "id">>,
  reason: string,
): Promise<number> {
  const workspace = requireWorkspace(ctx);
  if (rows.length === 0) return 0;
  const now = ctx.clock.now();
  const stopped = await ctx.db
    .update(enrollments)
    .set({
      status: "stopped",
      stop_reason: reason,
      completed_at: now,
      next_run_at: null,
      paused_until: null,
    })
    .where(
      and(
        eq(enrollments.workspace_id, workspace.id),
        inArray(
          enrollments.id,
          rows.map((row) => row.id),
        ),
        inArray(enrollments.status, IN_PROGRESS),
      ),
    )
    .returning({
      id: enrollments.id,
      campaign_id: enrollments.campaign_id,
      person_id: enrollments.person_id,
    });
  if (stopped.length === 0) return 0;
  const ids = stopped.map((row) => row.id);
  await cancelPendingMessages(ctx, ids, `enrollment_stopped:${reason}`);
  await ctx.db
    .update(enrollment_step_runs)
    .set({
      status: "skipped",
      finished_at: now,
      detail: sql`${enrollment_step_runs.detail} || ${JSON.stringify({ reason: `enrollment_stopped:${reason}` })}::jsonb`,
    })
    .where(
      and(
        inArray(enrollment_step_runs.enrollment_id, ids),
        inArray(enrollment_step_runs.status, ["running", "waiting"]),
      ),
    );
  for (const row of stopped) {
    await ctx.events.emit("enrollment.stopped", {
      subject: { type: "enrollment", id: row.id },
      data: {
        enrollment_id: row.id,
        campaign_id: row.campaign_id,
        person_id: row.person_id,
        reason,
      },
    });
  }
  await requestStatsRefresh(
    ctx,
    stopped.map((row) => row.campaign_id),
  );
  return stopped.length;
}

/**
 * Pauses enrollments until a date. Scheduled messages go back to `approved` (unscheduled) so
 * nothing is sent while paused; the sequencer plans them again after the pause.
 * Manual pauses (stop_reason "manual") are left alone. With `keepLongerPauses`, so are pauses
 * that end after `until` or never (an out-of-office that outlasts a company hold keeps its date).
 */
export async function pauseEnrollments(
  ctx: OpContext,
  rows: Array<Pick<Enrollment, "id">>,
  until: Date | null,
  reason: string,
  options: { keepLongerPauses?: boolean } = {},
): Promise<number> {
  const workspace = requireWorkspace(ctx);
  if (rows.length === 0) return 0;
  const paused = await ctx.db
    .update(enrollments)
    .set({ status: "paused", stop_reason: reason, paused_until: until })
    .where(
      and(
        eq(enrollments.workspace_id, workspace.id),
        inArray(
          enrollments.id,
          rows.map((row) => row.id),
        ),
        inArray(enrollments.status, ["active", "waiting_review", "paused"]),
        or(isNull(enrollments.stop_reason), ne(enrollments.stop_reason, "manual")),
        options.keepLongerPauses && until
          ? or(ne(enrollments.status, "paused"), lte(enrollments.paused_until, until))
          : undefined,
      ),
    )
    .returning({ id: enrollments.id });
  if (paused.length === 0) return 0;
  await ctx.db
    .update(messages)
    .set({ status: "approved", scheduled_for: null, error: `unscheduled:${reason}` })
    .where(
      and(
        eq(messages.workspace_id, workspace.id),
        inArray(
          messages.enrollment_id,
          paused.map((row) => row.id),
        ),
        eq(messages.status, "scheduled"),
      ),
    );
  return paused.length;
}

/** Resumes paused enrollments (they run again at their next step time, or now). */
export async function resumeEnrollments(
  ctx: OpContext,
  rows: Array<Pick<Enrollment, "id">>,
): Promise<number> {
  const workspace = requireWorkspace(ctx);
  if (rows.length === 0) return 0;
  const now = ctx.clock.now().toISOString();
  const resumed = await ctx.db
    .update(enrollments)
    .set({
      status: "active",
      stop_reason: null,
      paused_until: null,
      next_run_at: sql`greatest(coalesce(${enrollments.next_run_at}, ${now}::timestamptz), ${now}::timestamptz)`,
    })
    .where(
      and(
        eq(enrollments.workspace_id, workspace.id),
        inArray(
          enrollments.id,
          rows.map((row) => row.id),
        ),
        eq(enrollments.status, "paused"),
      ),
    )
    .returning({ id: enrollments.id });
  return resumed.length;
}

async function personEnrollments(
  ctx: OpContext,
  personId: string,
  statuses: EnrollmentStatus[],
): Promise<Enrollment[]> {
  const workspace = requireWorkspace(ctx);
  return ctx.db
    .select()
    .from(enrollments)
    .where(
      and(
        eq(enrollments.workspace_id, workspace.id),
        eq(enrollments.person_id, personId),
        inArray(enrollments.status, statuses),
      ),
    );
}

/** Implementation of the binding `stopEnrollmentsForPerson` (see service.ts). */
export async function stopForPerson(
  ctx: OpContext,
  input: { personId: string; reason: string; companyWide?: boolean },
): Promise<number> {
  const workspace = requireWorkspace(ctx);
  const own = await personEnrollments(ctx, input.personId, IN_PROGRESS);
  const settings = await settingsByCampaign(
    ctx,
    own.map((row) => row.campaign_id),
  );
  const toStop: Enrollment[] = [];
  const toResume: Enrollment[] = [];
  for (const row of own) {
    const campaignSettings = settings.get(row.campaign_id) ?? parseCampaignSettings({});
    if (stopAllowed(campaignSettings, input.reason, false)) toStop.push(row);
    else if (row.status === "paused" && row.stop_reason === PENDING_CLASSIFICATION) {
      toResume.push(row);
    }
  }
  let total = await stopEnrollments(ctx, toStop, input.reason);
  await resumeEnrollments(ctx, toResume);

  if (input.companyWide) {
    const [person] = await ctx.db
      .select({ company_id: people.company_id })
      .from(people)
      .where(and(eq(people.id, input.personId), eq(people.workspace_id, workspace.id)));
    if (person?.company_id) {
      const colleagues = await ctx.db
        .select({ enrollment: enrollments })
        .from(enrollments)
        .innerJoin(people, eq(people.id, enrollments.person_id))
        .where(
          and(
            eq(enrollments.workspace_id, workspace.id),
            eq(people.company_id, person.company_id),
            ne(enrollments.person_id, input.personId),
            inArray(enrollments.status, IN_PROGRESS),
          ),
        );
      const colleagueSettings = await settingsByCampaign(
        ctx,
        colleagues.map((row) => row.enrollment.campaign_id),
      );
      const colleagueStops = colleagues
        .map((row) => row.enrollment)
        .filter((row) =>
          stopAllowed(
            colleagueSettings.get(row.campaign_id) ?? parseCampaignSettings({}),
            input.reason,
            true,
          ),
        );
      const key = input.reason.toLowerCase();
      const colleagueReason = REPLY_REASONS.has(key) ? "company_replied" : `company_${key}`;
      total += await stopEnrollments(ctx, colleagueStops, colleagueReason);
    }
  }
  return total;
}

/** Implementation of the binding `pauseEnrollmentsForPerson` (see service.ts). */
export async function pauseForPerson(
  ctx: OpContext,
  input: { personId: string; until: Date; reason: string; keepLongerPauses?: boolean },
): Promise<number> {
  const rows = await personEnrollments(ctx, input.personId, ["active", "waiting_review", "paused"]);
  return pauseEnrollments(ctx, rows, input.until, input.reason, {
    keepLongerPauses: input.keepLongerPauses,
  });
}

/** Implementation of the binding `resumeEnrollmentsForPerson` (see service.ts). */
export async function resumeForPerson(
  ctx: OpContext,
  input: { personId: string; reason?: string },
): Promise<number> {
  const rows = await personEnrollments(ctx, input.personId, ["paused"]);
  return resumeEnrollments(
    ctx,
    rows.filter(
      (row) =>
        row.stop_reason !== "manual" &&
        (input.reason === undefined || row.stop_reason === input.reason),
    ),
  );
}
