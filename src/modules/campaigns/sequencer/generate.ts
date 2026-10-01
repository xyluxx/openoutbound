import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { BrainRunOptions, OpContext } from "../../../core/context.js";
import { requireWorkspace } from "../../../core/context.js";
import { isOpenOutboundError, JobWaitError } from "../../../core/errors.js";
import { defineJob } from "../../../core/operation.js";
import { enrollments, type Message, messages } from "../../../db/schema/index.js";
import type { LinkedInPost } from "../../../providers/types.js";
import { loadPerson } from "../people.js";
import { findMessage, loadCampaign } from "../repo.js";
import { stepChannel } from "../steps.js";
import { buildWritingContext } from "../writing/context.js";
import { writeDraft } from "../writing/pipeline.js";

export const GENERATE_JOB = "campaigns.generate_message";

/** Header keys used to carry the LinkedIn post a like or comment step acts on. */
export const POST_HEADERS = {
  id: "x-linkedin-post-id",
  url: "x-linkedin-post-url",
  text: "x-linkedin-post-text",
} as const;

export function postFromMessage(message: Pick<Message, "headers">): LinkedInPost | null {
  const headers = message.headers ?? {};
  const id = headers[POST_HEADERS.id];
  if (!id) return null;
  return { id, url: headers[POST_HEADERS.url] || null, text: headers[POST_HEADERS.text] ?? "" };
}

/** Enqueues generation for a message (one job per message at a time). */
export async function enqueueGeneration(
  ctx: OpContext,
  messageId: string,
  extraInstruction?: string | null,
): Promise<{ jobId: string; deduplicated: boolean }> {
  const handle = await ctx.jobs.enqueue(
    GENERATE_JOB,
    { message_id: messageId, ...(extraInstruction ? { extra_instruction: extraInstruction } : {}) },
    { singletonKey: `${GENERATE_JOB}:${messageId}` },
  );
  return { jobId: handle.job_id, deduplicated: handle.deduplicated === true };
}

async function wakeEnrollment(ctx: OpContext, enrollmentId: string | null): Promise<void> {
  if (!enrollmentId) return;
  await ctx.db
    .update(enrollments)
    .set({ next_run_at: ctx.clock.now() })
    .where(and(eq(enrollments.id, enrollmentId), eq(enrollments.status, "active")));
}

async function finish(
  ctx: OpContext,
  message: Message,
  status: "skipped" | "cancelled" | "failed",
  error: string,
): Promise<{ status: string }> {
  await ctx.db
    .update(messages)
    .set({ status, error })
    .where(and(eq(messages.id, message.id), eq(messages.status, "generating")));
  await wakeEnrollment(ctx, message.enrollment_id);
  return { status };
}

/**
 * Writes the content of a `generating` message with the writing pipeline and moves it to
 * `draft` (or `skipped` with a missing-data reason). Idempotent: other statuses are left alone.
 * Wakes the enrollment so the next tick applies the review level.
 */
export async function generateMessage(
  ctx: OpContext,
  messageId: string,
  options: { extraInstruction?: string | null; brain?: BrainRunOptions } = {},
): Promise<{ status: string }> {
  requireWorkspace(ctx);
  const message = await findMessage(ctx, messageId);
  if (!message) return { status: "missing" };
  if (message.status !== "generating") return { status: message.status };
  if (!message.enrollment_id || !message.campaign_id || !message.person_id || !message.step_id) {
    return finish(ctx, message, "failed", "generation_failed:not_a_campaign_message");
  }
  const loaded = await loadCampaign(ctx, message.campaign_id);
  const step = loaded.steps.find((candidate) => candidate.id === message.step_id);
  if (!step) return finish(ctx, message, "cancelled", "step_removed");
  const [enrollment] = await ctx.db
    .select()
    .from(enrollments)
    .where(eq(enrollments.id, message.enrollment_id));
  if (!enrollment) return finish(ctx, message, "cancelled", "enrollment_removed");
  const { person, company } = await loadPerson(ctx, message.person_id);
  const channel = stepChannel(step.type) ?? "email";

  const context = await buildWritingContext(ctx, {
    campaign: loaded.campaign,
    settings: loaded.settings,
    person,
    company,
    enrollmentId: enrollment.id,
    mailboxId: enrollment.mailbox_id,
    linkedinAccountId: enrollment.linkedin_account_id,
    channel,
  });
  const firstTouch = !context.history.some(
    (sent) => Boolean(sent.body_text?.trim()) && sent.action !== "visit" && sent.action !== "like",
  );
  const result = await writeDraft(ctx, {
    context,
    step,
    firstTouch,
    variantSeed: enrollment.variant_seed ?? 0,
    threadSubject: message.thread_id || message.in_reply_to ? (message.subject ?? null) : null,
    post: postFromMessage(message),
    extraInstruction: options.extraInstruction ?? null,
    ...(options.brain ? { brainOptions: options.brain } : {}),
  });
  if (!result.ok) return finish(ctx, message, "skipped", `missing_data:${result.reason}`);

  const { draft } = result;
  const updated = await ctx.db
    .update(messages)
    .set({
      status: "draft",
      subject: draft.subject,
      body_text: draft.body,
      variant: draft.variant,
      why: draft.why,
      check: draft.check,
      error: null,
    })
    .where(and(eq(messages.id, message.id), eq(messages.status, "generating")))
    .returning({ id: messages.id });
  if (updated.length > 0) {
    await ctx.events.emit("message.drafted", {
      subject: { type: "message", id: message.id },
      data: {
        message_id: message.id,
        person_id: message.person_id,
        campaign_id: message.campaign_id,
        channel: message.channel,
        action: message.action,
        status: "draft",
      },
    });
  }
  await wakeEnrollment(ctx, message.enrollment_id);
  return { status: "draft" };
}

export const generateMessageJob = defineJob({
  name: GENERATE_JOB,
  payload: z.object({ message_id: z.string(), extra_instruction: z.string().optional() }),
  maxAttempts: 3,
  timeoutMs: 3 * 60_000,
  handler: async (ctx, payload) => {
    try {
      return await generateMessage(ctx, payload.message_id, {
        extraInstruction: payload.extra_instruction ?? null,
        brain: { jobId: ctx.job.id, signal: ctx.job.signal },
      });
    } catch (error) {
      if (isOpenOutboundError(error) && error.code === "budget_exceeded") {
        // Wait for budget instead of burning attempts; the sequencer keeps the step in place.
        throw new JobWaitError(
          `budget:${ctx.workspace?.id ?? "instance"}`,
          new Date(ctx.clock.now().getTime() + 60 * 60 * 1000),
        );
      }
      throw error;
    }
  },
});
