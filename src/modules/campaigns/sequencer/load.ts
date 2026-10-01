import { and, eq } from "drizzle-orm";
import type { OpContext } from "../../../core/context.js";
import { requireWorkspace } from "../../../core/context.js";
import { enrollments, type Message } from "../../../db/schema/index.js";
import { loadPeople } from "../people.js";
import { loadCampaign } from "../repo.js";
import { latestRun, MOVABLE, type StepState } from "./state.js";

/**
 * The sequencer state for the step a message belongs to, or null when the enrollment moved on,
 * finished or the message is not the current attempt (so callers never act on stale state).
 * `paused` also takes a paused enrollment (an out-of-office, for example), which stays on its
 * step: for asking a review that waits until it runs again.
 */
export async function loadStepStateForMessage(
  ctx: OpContext,
  message: Pick<Message, "id" | "enrollment_id" | "step_id">,
  options: { paused?: boolean } = {},
): Promise<StepState | null> {
  const workspace = requireWorkspace(ctx);
  if (!message.enrollment_id || !message.step_id) return null;
  const [enrollment] = await ctx.db
    .select()
    .from(enrollments)
    .where(
      and(eq(enrollments.id, message.enrollment_id), eq(enrollments.workspace_id, workspace.id)),
    );
  const open = options.paused && enrollment?.status === "paused";
  if (!enrollment || !(open || MOVABLE.includes(enrollment.status))) return null;
  const loaded = await loadCampaign(ctx, enrollment.campaign_id);
  const step = loaded.steps[enrollment.current_step];
  if (!step || step.id !== message.step_id) return null;
  const run = await latestRun(ctx.db, enrollment.id, step.id);
  if (!run || run.message_id !== message.id) return null;
  const record = (await loadPeople(ctx, [enrollment.person_id])).get(enrollment.person_id);
  if (!record) return null;
  return {
    loaded,
    enrollment,
    step,
    run,
    person: record.person,
    company: record.company,
    now: ctx.clock.now(),
  };
}
