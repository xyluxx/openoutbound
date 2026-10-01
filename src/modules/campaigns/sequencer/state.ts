import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { OpContext } from "../../../core/context.js";
import { requireWorkspace } from "../../../core/context.js";
import type { EnrollmentStatus } from "../../../core/enums.js";
import type { Db } from "../../../db/client.js";
import {
  type CampaignStep,
  type Company,
  type Enrollment,
  type EnrollmentStepRun,
  enrollment_step_runs,
  enrollments,
  list_members,
  lists,
  type Person,
  people,
  type StepRunDetail,
} from "../../../db/schema/index.js";
import { stopEnrollments } from "../control.js";
import type { LoadedCampaign } from "../repo.js";
import { requestStatsRefresh } from "../stats.js";
import { stepDelayMs } from "../steps.js";

/** Everything the sequencer knows while running one step for one enrollment. */
export interface StepState {
  loaded: LoadedCampaign;
  enrollment: Enrollment;
  step: CampaignStep;
  run: EnrollmentStepRun;
  person: Person;
  company: Company | null;
  now: Date;
}

/** Enrollment statuses the sequencer moves forward. */
export const MOVABLE: EnrollmentStatus[] = ["active", "waiting_review"];
/** Send attempts per step before the enrollment fails. */
export const MAX_STEP_ATTEMPTS = 2;

export async function latestRun(
  db: Db,
  enrollmentId: string,
  stepId: string,
): Promise<EnrollmentStepRun | null> {
  const [row] = await db
    .select()
    .from(enrollment_step_runs)
    .where(
      and(
        eq(enrollment_step_runs.enrollment_id, enrollmentId),
        eq(enrollment_step_runs.step_id, stepId),
      ),
    )
    .orderBy(desc(enrollment_step_runs.attempt))
    .limit(1);
  return row ?? null;
}

/**
 * The run for the enrollment's current step: the latest attempt, or a new attempt when there
 * is none or the latest failed. Created with ON CONFLICT DO NOTHING, so concurrent callers
 * share one row.
 */
export async function ensureRun(
  ctx: OpContext,
  enrollment: Enrollment,
  step: CampaignStep,
): Promise<EnrollmentStepRun> {
  const latest = await latestRun(ctx.db, enrollment.id, step.id);
  if (latest && latest.status !== "failed") return latest;
  const attempt = (latest?.attempt ?? 0) + 1;
  await ctx.db
    .insert(enrollment_step_runs)
    .values({
      workspace_id: enrollment.workspace_id,
      enrollment_id: enrollment.id,
      campaign_id: enrollment.campaign_id,
      step_id: step.id,
      position: step.position,
      attempt,
      status: "running",
    })
    .onConflictDoNothing();
  const created = await latestRun(ctx.db, enrollment.id, step.id);
  if (!created) throw new Error(`Could not create step run for ${enrollment.id}/${step.id}`);
  return created;
}

function runKey(run: Pick<EnrollmentStepRun, "enrollment_id" | "step_id" | "attempt">) {
  return and(
    eq(enrollment_step_runs.enrollment_id, run.enrollment_id),
    eq(enrollment_step_runs.step_id, run.step_id),
    eq(enrollment_step_runs.attempt, run.attempt),
  );
}

/** Updates a run; `detail` is merged into the stored detail. */
export async function updateRun(
  db: Db,
  run: Pick<EnrollmentStepRun, "enrollment_id" | "step_id" | "attempt">,
  patch: {
    status?: string;
    message_id?: string | null;
    approval_id?: string | null;
    detail?: StepRunDetail;
    finishedAt?: Date | null;
  },
): Promise<void> {
  const set: Record<string, unknown> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.message_id !== undefined) set.message_id = patch.message_id;
  if (patch.approval_id !== undefined) set.approval_id = patch.approval_id;
  if (patch.finishedAt !== undefined) set.finished_at = patch.finishedAt;
  if (patch.detail !== undefined) {
    set.detail = sql`${enrollment_step_runs.detail} || ${JSON.stringify(patch.detail)}::jsonb`;
  }
  if (Object.keys(set).length === 0) return;
  await db.update(enrollment_step_runs).set(set).where(runKey(run));
}

/** Sets when the sequencer looks at the enrollment next (only if it is still on this step). */
export async function reschedule(
  ctx: OpContext,
  state: Pick<StepState, "enrollment">,
  at: Date,
  status: "active" | "waiting_review" = "active",
): Promise<void> {
  await ctx.db
    .update(enrollments)
    .set({ next_run_at: at, status })
    .where(
      and(
        eq(enrollments.id, state.enrollment.id),
        eq(enrollments.current_step, state.enrollment.current_step),
        inArray(enrollments.status, MOVABLE),
      ),
    );
}

export type AdvanceResult = "advanced" | "completed" | "stale";

/**
 * Closes the current step run and moves the enrollment to `to` (default: the next step), with
 * the next step due at `anchor` + its delay. Past the last step the enrollment completes and
 * the campaign end action runs. Atomic: the run, the enrollment and the end action change
 * together, and only when the enrollment is still on this step.
 */
export async function advance(
  ctx: OpContext,
  state: StepState,
  options: {
    to?: number | null;
    anchor: Date;
    outcome: "done" | "skipped";
    detail?: StepRunDetail;
  },
): Promise<AdvanceResult> {
  const { steps } = state.loaded;
  const from = state.enrollment.current_step;
  const target = options.to ?? from + 1;
  const now = ctx.clock.now();
  const next = target < steps.length ? steps[target] : undefined;
  let tagged = false;
  const result = await ctx.db.transaction(async (tx) => {
    const guard = and(
      eq(enrollments.id, state.enrollment.id),
      eq(enrollments.current_step, from),
      inArray(enrollments.status, MOVABLE),
    );
    const moved = next
      ? await tx
          .update(enrollments)
          .set({
            status: "active",
            current_step: target,
            next_run_at: new Date(options.anchor.getTime() + stepDelayMs(next)),
          })
          .where(guard)
          .returning({ id: enrollments.id })
      : await tx
          .update(enrollments)
          .set({
            status: "completed",
            current_step: Math.min(target, steps.length),
            next_run_at: null,
            completed_at: now,
          })
          .where(guard)
          .returning({ id: enrollments.id });
    if (moved.length === 0) return "stale" as const;
    await updateRun(tx, state.run, {
      status: options.outcome,
      finishedAt: now,
      ...(options.detail ? { detail: options.detail } : {}),
    });
    if (next) return "advanced" as const;
    tagged = await writeEndAction(ctx, tx, state.loaded, state.person.id);
    return "completed" as const;
  });
  if (result === "completed") await afterCompletion(ctx, state.loaded, state.person.id, tagged);
  return result;
}

/**
 * Completes an enrollment whose current step no longer exists (a step edit removed the steps
 * it had left): the same end as advancing past the last step, end action included. Only the
 * call that moves it runs the end action, so it runs exactly once. False when the enrollment
 * already moved on (another tick, a stop).
 */
export async function completePastLastStep(
  ctx: OpContext,
  loaded: LoadedCampaign,
  enrollment: Enrollment,
  personId: string,
): Promise<boolean> {
  const now = ctx.clock.now();
  let tagged = false;
  const completed = await ctx.db.transaction(async (tx) => {
    const moved = await tx
      .update(enrollments)
      .set({ status: "completed", completed_at: now, next_run_at: null })
      .where(
        and(
          eq(enrollments.id, enrollment.id),
          eq(enrollments.current_step, enrollment.current_step),
          inArray(enrollments.status, MOVABLE),
        ),
      )
      .returning({ id: enrollments.id });
    if (moved.length === 0) return false;
    tagged = await writeEndAction(ctx, tx, loaded, personId);
    return true;
  });
  if (completed) await afterCompletion(ctx, loaded, personId, tagged);
  return completed;
}

/** What follows a completion once it is committed: the tag event and a stats refresh. */
async function afterCompletion(
  ctx: OpContext,
  loaded: LoadedCampaign,
  personId: string,
  tagged: boolean,
): Promise<void> {
  if (tagged) {
    await ctx.events.emit("lead.updated", {
      subject: { type: "person", id: personId },
      data: { kind: "person", id: personId, changes: ["tags"] },
    });
  }
  await requestStatsRefresh(ctx, [loaded.campaign.id]);
}

/**
 * Campaign end action for a person who finished the sequence, written with `db` (the
 * transaction that completes the enrollment): tag, add to a list (a retry-later list, say),
 * or nothing. Returns true when a tag was added.
 */
async function writeEndAction(
  ctx: OpContext,
  db: Db,
  loaded: LoadedCampaign,
  personId: string,
): Promise<boolean> {
  const workspace = requireWorkspace(ctx);
  const action = loaded.settings.end_action;
  const value = action.value?.trim();
  if (action.type === "none" || !value) return false;
  if (action.type === "tag") {
    const updated = await db
      .update(people)
      .set({ tags: sql`array_append(${people.tags}, ${value})` })
      .where(
        and(
          eq(people.id, personId),
          eq(people.workspace_id, workspace.id),
          sql`not (${value} = any(${people.tags}))`,
        ),
      )
      .returning({ id: people.id });
    return updated.length > 0;
  }
  const [list] = await db
    .select({ id: lists.id })
    .from(lists)
    .where(and(eq(lists.id, value), eq(lists.workspace_id, workspace.id)));
  if (!list) {
    ctx.log.warn({ campaign_id: loaded.campaign.id, list_id: value }, "end action list not found");
    return false;
  }
  await db
    .insert(list_members)
    .values({ list_id: list.id, person_id: personId })
    .onConflictDoNothing();
  return false;
}

/**
 * The campaign's missing-data policy: `skip_step` skips this step and continues, `skip_lead`
 * stops the enrollment (reason "missing_data").
 */
export async function applyMissingData(
  ctx: OpContext,
  state: StepState,
  reason: string,
  codes?: string[],
): Promise<void> {
  const detail: StepRunDetail = { reason, ...(codes ? { codes } : {}) };
  if (state.loaded.settings.missing_data === "skip_lead") {
    await updateRun(ctx.db, state.run, { status: "skipped", detail, finishedAt: ctx.clock.now() });
    await stopEnrollments(ctx, [state.enrollment], "missing_data");
    return;
  }
  await advance(ctx, state, { anchor: ctx.clock.now(), outcome: "skipped", detail });
}

/** Marks the enrollment failed (e.g. a step kept failing to send). */
export async function failEnrollment(
  ctx: OpContext,
  state: StepState,
  reason: string,
): Promise<void> {
  const now = ctx.clock.now();
  await ctx.db.transaction(async (tx) => {
    await updateRun(tx, state.run, { status: "failed", detail: { reason }, finishedAt: now });
    await tx
      .update(enrollments)
      .set({ status: "failed", stop_reason: reason, next_run_at: null, completed_at: now })
      .where(
        and(
          eq(enrollments.id, state.enrollment.id),
          eq(enrollments.current_step, state.enrollment.current_step),
          inArray(enrollments.status, MOVABLE),
        ),
      );
  });
  await requestStatsRefresh(ctx, [state.loaded.campaign.id]);
}
