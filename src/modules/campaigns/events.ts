import { and, eq, inArray } from "drizzle-orm";
import type { OpContext } from "../../core/context.js";
import { requireWorkspace } from "../../core/context.js";
import { type EventType, isEventType, onEvent } from "../../core/events.js";
import type { AnyEventHandler } from "../../core/operation.js";
import {
  approvals,
  campaign_steps,
  enrollments,
  opportunities,
  people,
} from "../../db/schema/index.js";
import { markSignalsUsed } from "../signals/service.js";
import {
  PENDING_CLASSIFICATION,
  PENDING_CLASSIFICATION_MS,
  pauseEnrollments,
  stopEnrollments,
  stopForPerson,
} from "./control.js";
import { enrollPeople } from "./enrollment.js";
import { findMessage } from "./repo.js";
import { skipForReview } from "./sequencer/channel-step.js";
import { loadStepStateForMessage } from "./sequencer/load.js";
import { advance } from "./sequencer/state.js";
import { requestStatsRefresh } from "./stats.js";
import type { DraftWhy } from "./writing/pipeline.js";

const DAY = 24 * 60 * 60 * 1000;

/**
 * Advances the enrollment when its step message was sent (next step due at sent_at + delay),
 * marks the signals the message used, and refreshes stats.
 */
export const advanceOnSent = onEvent(
  "message.sent",
  "campaigns.advance_on_sent",
  async (ctx, event) => {
    const message = await findMessage(ctx, event.data.message_id);
    if (!message) return;
    const why = (message.why as DraftWhy | null) ?? {};
    if (why.signal_ids && why.signal_ids.length > 0) {
      await markSignalsUsed(ctx, why.signal_ids, { messageId: message.id });
    }
    if (!message.enrollment_id) return;
    const state = await loadStepStateForMessage(ctx, message);
    if (state) {
      const sentAt = new Date(event.data.sent_at);
      await advance(ctx, state, {
        anchor: Number.isNaN(sentAt.getTime()) ? ctx.clock.now() : sentAt,
        outcome: "done",
      });
    }
    await requestStatsRefresh(ctx, [message.campaign_id]);
  },
);

/**
 * Pauses the person's running enrollments as soon as a reply arrives, before classification
 * (reason reply_pending_classification; stopped after 24h if nobody classifies it). An
 * out-of-office reply with a return date pauses until the return date + 1 day instead.
 */
export const pauseOnReply = onEvent(
  "reply.received",
  "campaigns.pause_on_reply",
  async (ctx, event) => {
    const workspace = requireWorkspace(ctx);
    const personId = event.data.person_id;
    if (!personId) return;
    const rows = await ctx.db
      .select({ id: enrollments.id, campaign_id: enrollments.campaign_id })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.workspace_id, workspace.id),
          eq(enrollments.person_id, personId),
          inArray(enrollments.status, ["active", "waiting_review", "paused"]),
        ),
      );
    const inbound = await findMessage(ctx, event.data.message_id);
    const classification = inbound?.classification;
    const now = ctx.clock.now();
    if (classification?.category === "out_of_office" && classification.return_date) {
      const back = new Date(classification.return_date);
      if (!Number.isNaN(back.getTime()) && back.getTime() > now.getTime()) {
        await pauseEnrollments(ctx, rows, new Date(back.getTime() + DAY), "out_of_office");
        await requestStatsRefresh(ctx, [
          event.data.campaign_id,
          ...rows.map((row) => row.campaign_id),
        ]);
        return;
      }
    }
    await pauseEnrollments(
      ctx,
      rows,
      new Date(now.getTime() + PENDING_CLASSIFICATION_MS),
      PENDING_CLASSIFICATION,
    );
    await requestStatsRefresh(ctx, [event.data.campaign_id, ...rows.map((row) => row.campaign_id)]);
  },
);

/** A hard bounce stops the enrollment the message belonged to (or the person's, without one). */
export const stopOnBounce = onEvent(
  "message.bounced",
  "campaigns.stop_on_bounce",
  async (ctx, event) => {
    if (event.data.bounce_type !== "hard") return;
    const message = event.data.message_id ? await findMessage(ctx, event.data.message_id) : null;
    if (message?.enrollment_id) {
      await stopEnrollments(ctx, [{ id: message.enrollment_id }], "bounced");
      await requestStatsRefresh(ctx, [message.campaign_id]);
      return;
    }
    if (event.data.person_id) {
      await stopForPerson(ctx, { personId: event.data.person_id, reason: "bounced" });
    }
  },
);

/** An unsubscribe stops every enrollment of the person. */
export const stopOnUnsubscribe = onEvent(
  "unsubscribe.received",
  "campaigns.stop_on_unsubscribe",
  async (ctx, event) => {
    const workspace = requireWorkspace(ctx);
    let personId = event.data.person_id;
    if (!personId && event.data.email) {
      const [person] = await ctx.db
        .select({ id: people.id })
        .from(people)
        .where(
          and(
            eq(people.workspace_id, workspace.id),
            eq(people.email, event.data.email.toLowerCase()),
          ),
        );
      personId = person?.id ?? null;
    }
    if (personId) await stopForPerson(ctx, { personId, reason: "unsubscribed" });
  },
);

/** An accepted invite wakes enrollments waiting to send a LinkedIn message. */
export const wakeOnConnected = onEvent(
  "linkedin.connected",
  "campaigns.wake_on_connected",
  async (ctx, event) => {
    const workspace = requireWorkspace(ctx);
    const rows = await ctx.db
      .select({ id: enrollments.id, type: campaign_steps.type })
      .from(enrollments)
      .innerJoin(
        campaign_steps,
        and(
          eq(campaign_steps.campaign_id, enrollments.campaign_id),
          eq(campaign_steps.position, enrollments.current_step),
        ),
      )
      .where(
        and(
          eq(enrollments.workspace_id, workspace.id),
          eq(enrollments.person_id, event.data.person_id),
          eq(enrollments.status, "active"),
        ),
      );
    const waiting = rows.filter(
      (row) => row.type === "linkedin_message" || row.type === "condition",
    );
    if (waiting.length === 0) return;
    await ctx.db
      .update(enrollments)
      .set({ next_run_at: ctx.clock.now() })
      .where(
        inArray(
          enrollments.id,
          waiting.map((row) => row.id),
        ),
      );
  },
);

/** A permanent send failure wakes the enrollment so the sequencer retries or fails the step. */
export const wakeOnFailed = onEvent(
  "message.failed",
  "campaigns.wake_on_failed",
  async (ctx, event) => {
    if (event.data.retryable) return;
    const message = await findMessage(ctx, event.data.message_id);
    if (!message?.enrollment_id) return;
    await ctx.db
      .update(enrollments)
      .set({ next_run_at: ctx.clock.now() })
      .where(and(eq(enrollments.id, message.enrollment_id), eq(enrollments.status, "active")));
  },
);

/** An expired message review skips the step (the sequence continues). */
export const skipOnExpiredReview = onEvent(
  "approval.decided",
  "campaigns.skip_on_expired_review",
  async (ctx, event) => {
    if (event.data.kind !== "message" || event.data.status !== "expired") return;
    const target = await findTargetMessage(ctx, event.data.approval_id);
    if (!target) return;
    const state = await loadStepStateForMessage(ctx, target);
    if (state) await skipForReview(ctx, state, target, "approval_expired");
  },
);

async function findTargetMessage(ctx: OpContext, approvalId: string) {
  const workspace = requireWorkspace(ctx);
  const [approval] = await ctx.db
    .select({ target_type: approvals.target_type, target_id: approvals.target_id })
    .from(approvals)
    .where(and(eq(approvals.id, approvalId), eq(approvals.workspace_id, workspace.id)));
  if (approval?.target_type !== "message" || !approval.target_id) return null;
  return findMessage(ctx, approval.target_id);
}

/** Classified replies and pipeline changes change reply and meeting counters. */
export const statsOnClassified = onEvent(
  "reply.classified",
  "campaigns.stats_on_classified",
  async (ctx, event) => {
    const message = await findMessage(ctx, event.data.message_id);
    await requestStatsRefresh(ctx, [message?.campaign_id]);
  },
);

export const statsOnOpportunity = onEvent(
  "opportunity.updated",
  "campaigns.stats_on_opportunity",
  async (ctx, event) => {
    const workspace = requireWorkspace(ctx);
    const [row] = await ctx.db
      .select({ campaign_id: opportunities.campaign_id })
      .from(opportunities)
      .where(
        and(
          eq(opportunities.id, event.data.opportunity_id),
          eq(opportunities.workspace_id, workspace.id),
        ),
      );
    await requestStatsRefresh(ctx, [row?.campaign_id]);
  },
);

/** Payload accepted from automations asking to enroll people (signals module). */
export interface EnrollRequest {
  campaign_id?: string;
  person_id?: string | null;
  person_ids?: string[];
  rule_id?: string | null;
  signal_id?: string | null;
}

/** Enrolls the people an automation asked for (with every compliance check). */
export async function handleEnrollRequest(ctx: OpContext, data: EnrollRequest): Promise<number> {
  const personIds = [...(data.person_ids ?? []), ...(data.person_id ? [data.person_id] : [])];
  if (!data.campaign_id || personIds.length === 0) return 0;
  const outcome = await enrollPeople(ctx, {
    campaignId: data.campaign_id,
    personIds,
    source: data.rule_id ? `automation:${data.rule_id}` : "automation",
  });
  return outcome.enrolled;
}

const ENROLL_REQUESTED = "automation.enroll_requested";

/**
 * `automation.enroll_requested` is not in the core event map yet; the handler registers itself
 * once the event type exists, so the integrator only has to add the event.
 */
function enrollRequestedHandler(): AnyEventHandler[] {
  if (!isEventType(ENROLL_REQUESTED)) return [];
  return [
    onEvent(ENROLL_REQUESTED as EventType, "campaigns.enroll_requested", async (ctx, event) => {
      await handleEnrollRequest(ctx, event.data as unknown as EnrollRequest);
    }),
  ];
}

export const eventHandlers: AnyEventHandler[] = [
  advanceOnSent,
  pauseOnReply,
  stopOnBounce,
  stopOnUnsubscribe,
  wakeOnConnected,
  wakeOnFailed,
  skipOnExpiredReview,
  statsOnClassified,
  statsOnOpportunity,
  ...enrollRequestedHandler(),
];
