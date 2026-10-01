/**
 * Runs the action matrix for a classified reply (spec 11.11). Order:
 * 1. protective actions (suppress, privacy, mark_invalid, notify_human): always, even for
 *    suspicious replies; 2. suspicious replies stop here (human routing only); 3. stop rules
 *    and person status; 4. hot bookkeeping (opportunity + notification); 5. the category's action;
 * 6. drafting (enqueued as a job), never for people who may not be contacted. Every step is
 *    idempotent so a retried job is safe.
 */
import { and, desc, eq, ne, notInArray, sql } from "drizzle-orm";
import type { OpContext } from "../../core/context.js";
import { parseCampaignSettings } from "../../core/settings.js";
import { events, people, type ReplyClassification } from "../../db/schema/index.js";
import type { NotifyInput } from "../../runtime/notify.js";
import {
  pauseEnrollmentsForPerson,
  resumeEnrollmentsForPerson,
  stopEnrollmentsForPerson,
} from "../campaigns/service.js";
import { applySenderRejectedReply } from "../email/service.js";
import { openKnowledgeGap, searchKnowledge } from "../knowledge/service.js";
import { addSuppression } from "../leads/service.js";
import { followUpDueAt, outOfOfficeResumeAt } from "./dates.js";
import { DRAFT_REPLY_JOB } from "./draft.js";
import { applyMeetingIntent } from "./meeting-intent.js";
import { personLabel, safeNotify } from "./notifications.js";
import { ensureOpportunityForReply } from "./opportunities.js";
import { advancePersonStatus } from "./person-status.js";
import { stripQuotedText } from "./prechecks.js";
import { applyPrivacyRequest } from "./privacy-requests.js";
import { requestReferralApproval } from "./referral.js";
import type { ReplyContext } from "./reply-context.js";
import {
  AUTOMATED_CATEGORIES,
  DRAFT_ACTIONS,
  HOT_CATEGORIES,
  LOW_CONFIDENCE,
  PROTECTIVE_ACTIONS,
  type ResolvedReplyRule,
} from "./rules.js";
import { replyBlockers } from "./send.js";
import { repliesSupersededBy } from "./stale-replies.js";
import { THREAD_OWNED_BY_PERSON } from "./takeover.js";
import { createTask } from "./tasks.js";

export interface ActionOutcome {
  /** Machine-readable effects, e.g. "enrollments_stopped", "suppressed:email". */
  effects: string[];
  /** Why a human should look at the thread; empty = no attention needed. */
  attention: string[];
  draft: "none" | "review" | "auto";
  notified: boolean;
}

export interface ClassifiedReply extends ReplyContext {
  classification: ReplyClassification;
  rule: ResolvedReplyRule;
}

async function suppressContact(
  ctx: OpContext,
  reply: ClassifiedReply,
  reason: "unsubscribed" | "bounced" | "do_not_contact",
  scope: { email: boolean; person: boolean; linkedin: boolean },
  effects: string[],
): Promise<void> {
  const { person } = reply;
  if (!person) return;
  const note = `From reply ${reply.message.id}`;
  if (scope.email && person.email) {
    await addSuppression(ctx, {
      type: "email",
      value: person.email,
      reason,
      source: "reply",
      note,
    });
    effects.push("suppressed:email");
  }
  if (scope.linkedin && person.linkedin_url) {
    await addSuppression(ctx, {
      type: "linkedin",
      value: person.linkedin_url,
      reason,
      source: "reply",
      note,
    });
    effects.push("suppressed:linkedin");
  }
  if (scope.person) {
    await addSuppression(ctx, { type: "person", value: person.id, reason, source: "reply", note });
    effects.push("suppressed:person");
  }
}

async function alreadyEmitted(
  ctx: OpContext,
  type: "unsubscribe.received",
  messageId: string,
): Promise<boolean> {
  const workspaceId = ctx.workspace?.id;
  if (!workspaceId) return false;
  const [row] = await ctx.db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.workspace_id, workspaceId),
        eq(events.type, type),
        sql`${events.data}->>'message_id' = ${messageId}`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Applies protective actions. Returns true when the action was protective. */
async function applyProtective(
  ctx: OpContext,
  reply: ClassifiedReply,
  companyWide: boolean,
  outcome: ActionOutcome,
  notes: NotifyInput[],
): Promise<boolean> {
  const { rule, person, message, company, classification } = reply;
  const label = personLabel(person, company);
  if (!PROTECTIVE_ACTIONS.has(rule.action)) return false;
  if (rule.action === "privacy") {
    // Everything an unsubscribe does on every channel, an urgent problem with the deadline,
    // and a human: the engine never answers a privacy request by itself (privacy-requests.ts).
    await applyPrivacyRequest(ctx, reply, outcome, notes);
    return true;
  }
  if (rule.action === "suppress") {
    await suppressContact(
      ctx,
      reply,
      rule.category === "unsubscribe" ? "unsubscribed" : "do_not_contact",
      { email: true, person: true, linkedin: message.channel === "linkedin" },
      outcome.effects,
    );
    if (person) {
      // Not a "replied" reason, so campaign stop settings cannot keep the sequence going.
      await stopEnrollmentsForPerson(ctx, {
        personId: person.id,
        reason: rule.category === "unsubscribe" ? "unsubscribed" : "do_not_contact",
      });
      outcome.effects.push("enrollments_stopped");
      const status = rule.category === "unsubscribe" ? "unsubscribed" : "do_not_contact";
      if (await advancePersonStatus(ctx, person, status)) {
        outcome.effects.push(`person_status:${status}`);
      }
      if (
        rule.category === "unsubscribe" &&
        !(await alreadyEmitted(ctx, "unsubscribe.received", message.id))
      ) {
        await ctx.events.emit("unsubscribe.received", {
          subject: { type: "person", id: person.id },
          data: {
            person_id: person.id,
            email: person.email,
            source: "reply",
            message_id: message.id,
          },
        });
      }
    }
    return true;
  }
  if (rule.action === "mark_invalid") {
    // A bounce that refused our sender (authentication, blocklist, reputation, rate limit) is
    // the sending mailbox's problem: its health takes it and the recipient stays untouched.
    const rejected =
      message.channel === "email" ? await applySenderRejectedReply(ctx, message) : null;
    if (rejected) {
      outcome.effects.push(`sender_rejected:${rejected.kind}`);
      outcome.attention.push("sender_rejected");
      ctx.log.info(
        { message_id: message.id, kind: rejected.kind, status: rejected.status },
        "inbox: the bounce refused our sender, not the address; the recipient is left alone",
      );
      return true;
    }
    if (person) {
      if (message.channel === "email" && person.email) {
        await ctx.db
          .update(people)
          .set({ email_status: "invalid", email_checked_at: ctx.clock.now() })
          .where(and(eq(people.workspace_id, person.workspace_id), eq(people.id, person.id)));
        outcome.effects.push("email_invalid");
      }
      await suppressContact(
        ctx,
        reply,
        "bounced",
        { email: message.channel === "email", person: false, linkedin: false },
        outcome.effects,
      );
      await stopEnrollmentsForPerson(ctx, { personId: person.id, reason: "bounced" });
      outcome.effects.push("enrollments_stopped");
      if (message.channel === "email" && (await advancePersonStatus(ctx, person, "bounced"))) {
        outcome.effects.push("person_status:bounced");
      }
    }
    return true;
  }
  // notify_human: stop everything and hand the thread to a person; no draft.
  if (person && rule.category === "negative") {
    // Locked: a negative or angry reply stops every sequence to the person whatever the
    // campaign stop settings (reason "negative" always stops; colleagues follow
    // stop.on_company_reply) and suppresses both the address and the person.
    await stopEnrollmentsForPerson(ctx, { personId: person.id, reason: "negative", companyWide });
    outcome.effects.push("enrollments_stopped");
    await suppressContact(
      ctx,
      reply,
      "do_not_contact",
      { email: true, person: true, linkedin: message.channel === "linkedin" },
      outcome.effects,
    );
    if (await advancePersonStatus(ctx, person, "not_interested")) {
      outcome.effects.push("person_status:not_interested");
    }
  } else if (person) {
    await stopEnrollmentsForPerson(ctx, { personId: person.id, reason: "replied", companyWide });
    outcome.effects.push("enrollments_stopped");
  }
  outcome.attention.push(rule.category === "negative" ? "negative_reply" : "needs_human");
  notes.push({
    title: `${rule.category === "negative" ? "Negative reply" : "Reply needs a human"} from ${label}`,
    lines: [classification.summary ?? "", "No automatic reply will be sent."].filter(Boolean),
    severity: "warning",
    event: "thread.needs_attention",
  });
  return true;
}

async function applyStopRules(
  ctx: OpContext,
  reply: ClassifiedReply,
  outcome: ActionOutcome,
): Promise<void> {
  const { person, rule, classification, settings, company, workspace } = reply;
  if (!person) return;
  const stop = parseCampaignSettings(reply.campaign?.settings).stop;
  if (rule.action === "pause_until_return") {
    const resume = outOfOfficeResumeAt({
      returnDate: classification.return_date,
      now: ctx.clock.now(),
      timeZone: person.timezone ?? company?.timezone ?? workspace.timezone,
      workingDays: settings.schedule.working_days,
      holidays: settings.schedule.holidays,
    });
    await pauseEnrollmentsForPerson(ctx, {
      personId: person.id,
      until: resume.until,
      reason: "out_of_office",
    });
    outcome.effects.push(`enrollments_paused_until:${resume.until.toISOString()}`);
    if (resume.defaulted) outcome.effects.push("return_date_defaulted");
    return;
  }
  if (AUTOMATED_CATEGORIES.has(rule.category)) {
    if (classification.left_company) {
      await stopEnrollmentsForPerson(ctx, { personId: person.id, reason: "left_company" });
      outcome.effects.push("enrollments_stopped");
    } else {
      await resumeEnrollmentsForPerson(ctx, { personId: person.id });
      outcome.effects.push("enrollments_resumed");
    }
    return;
  }
  if (stop.on_reply) {
    await stopEnrollmentsForPerson(ctx, {
      personId: person.id,
      reason: "replied",
      companyWide: stop.on_company_reply,
    });
    outcome.effects.push(
      stop.on_company_reply ? "enrollments_stopped_company" : "enrollments_stopped",
    );
  } else {
    await resumeEnrollmentsForPerson(ctx, { personId: person.id });
    outcome.effects.push("enrollments_resumed");
  }
  const status = HOT_CATEGORIES.has(rule.category) ? "interested" : "replied";
  if (await advancePersonStatus(ctx, person, status))
    outcome.effects.push(`person_status:${status}`);
}

async function suggestBetterContact(
  ctx: OpContext,
  reply: ClassifiedReply,
  outcome: ActionOutcome,
): Promise<void> {
  const { person, company, message, thread, campaign } = reply;
  if (!person) return;
  const others = person.company_id
    ? await ctx.db
        .select({ id: people.id, full_name: people.full_name, title: people.title })
        .from(people)
        .where(
          and(
            eq(people.workspace_id, person.workspace_id),
            eq(people.company_id, person.company_id),
            ne(people.id, person.id),
            notInArray(people.status, [
              "unsubscribed",
              "bounced",
              "do_not_contact",
              "not_interested",
            ]),
          ),
        )
        .orderBy(sql`${people.fit_score} desc nulls last`, desc(people.created_at))
        .limit(3)
    : [];
  const notes =
    others.length > 0
      ? others
          .map(
            (other) =>
              `- ${other.full_name ?? other.id}${other.title ? `, ${other.title}` : ""} (${other.id})`,
          )
          .join("\n")
      : "No other contacts are stored for this company. Find one with find_leads.";
  const { task, created } = await createTask(ctx, {
    title: `Pick a better contact at ${company?.name ?? "the company"} (${person.full_name ?? person.email ?? person.id} is the wrong person)`,
    type: "other",
    notes,
    personId: person.id,
    campaignId: campaign?.id ?? null,
    threadId: thread?.id ?? null,
    dedupeKey: `wrong_person:${message.id}`,
  });
  outcome.effects.push(created ? `task_created:${task.id}` : `task_exists:${task.id}`);
  if (others.length > 0)
    outcome.effects.push(`suggested:${others.map((other) => other.id).join(",")}`);
}

async function followUpTask(
  ctx: OpContext,
  reply: ClassifiedReply,
  outcome: ActionOutcome,
): Promise<void> {
  const { person, company, message, thread, campaign, classification, workspace } = reply;
  if (!person) return;
  const due = followUpDueAt({
    date: classification.follow_up_date ?? null,
    now: ctx.clock.now(),
    timeZone: person.timezone ?? company?.timezone ?? workspace.timezone,
  });
  const { task, created } = await createTask(ctx, {
    title: `Follow up with ${personLabel(person, company)} (asked to reconnect later)`,
    type: "follow_up",
    notes: classification.summary ?? null,
    dueAt: due,
    personId: person.id,
    campaignId: campaign?.id ?? null,
    threadId: thread?.id ?? null,
    dedupeKey: `follow_up:${message.id}`,
  });
  outcome.effects.push(created ? `task_created:${task.id}` : `task_exists:${task.id}`);
}

/**
 * The follow-up of a category's default action, kept when a rule swaps that action for a
 * drafted or automatic reply (draft_reply, opportunity_and_draft, auto_reply): the reminder task
 * for not_now, the referral approval for referral, the better-contact suggestion for
 * wrong_person. Answering the prospect never replaces the bookkeeping.
 */
async function categoryFollowUp(
  ctx: OpContext,
  reply: ClassifiedReply,
  outcome: ActionOutcome,
): Promise<void> {
  switch (reply.rule.category) {
    case "not_now":
      await followUpTask(ctx, reply, outcome);
      return;
    case "wrong_person":
      await suggestBetterContact(ctx, reply, outcome);
      return;
    case "referral": {
      const result = await requestReferralApproval(ctx, reply, reply.classification);
      outcome.effects.push(...result.effects);
      outcome.attention.push(...result.attention);
      return;
    }
    default:
      return;
  }
}

async function leftCompanyTask(ctx: OpContext, reply: ClassifiedReply, outcome: ActionOutcome) {
  const { person, company, message, thread, campaign } = reply;
  if (!person) return;
  const { task, created } = await createTask(ctx, {
    title: `${person.full_name ?? person.email ?? "A contact"} left ${company?.name ?? "the company"}: find a replacement contact`,
    type: "other",
    personId: person.id,
    campaignId: campaign?.id ?? null,
    threadId: thread?.id ?? null,
    dedupeKey: `left_company:${message.id}`,
  });
  outcome.effects.push(created ? `task_created:${task.id}` : `task_exists:${task.id}`);
}

/** Runs the matrix. Notifications are sent once at the end. */
export async function applyReplyActions(
  ctx: OpContext,
  reply: ClassifiedReply,
): Promise<ActionOutcome> {
  const { classification, rule, person, company, message, thread, campaign } = reply;
  const outcome: ActionOutcome = { effects: [], attention: [], draft: "none", notified: false };
  const notes: NotifyInput[] = [];
  const label = personLabel(person, company);
  const stop = parseCampaignSettings(campaign?.settings).stop;

  const protective = await applyProtective(ctx, reply, stop.on_company_reply, outcome, notes);

  if (classification.suspicious) {
    outcome.attention.push("possible_prompt_injection");
    notes.push({
      title: `Possible prompt injection in a reply from ${label}`,
      lines: [
        "The reply contains instructions aimed at an AI. Nothing was done beyond classification.",
        thread ? `Thread: ${thread.id}` : "",
      ].filter(Boolean),
      severity: "warning",
      event: "thread.needs_attention",
    });
    await flushNotes(ctx, notes, outcome);
    return outcome;
  }

  if (!protective) await applyStopRules(ctx, reply, outcome);

  const hot = HOT_CATEGORIES.has(rule.category) || rule.action === "opportunity_and_draft";
  if (!protective && hot && person) {
    const { opportunity, created } = await ensureOpportunityForReply(ctx, {
      person,
      company,
      campaign,
      thread,
      note: `${rule.category.replace(/_/g, " ")} reply: ${classification.summary ?? ""}`.trim(),
    });
    outcome.effects.push(
      created ? `opportunity_created:${opportunity.id}` : `opportunity_updated:${opportunity.id}`,
    );
    notes.push({
      title: `Hot reply from ${label}`,
      lines: [
        `${rule.category.replace(/_/g, " ")} (confidence ${classification.confidence.toFixed(2)})`,
        classification.summary ?? "",
      ].filter(Boolean),
      severity: "info",
      event: "reply.classified",
    });
  }

  if (!protective) {
    switch (rule.action) {
      case "approve_referral": {
        const result = await requestReferralApproval(ctx, reply, classification);
        outcome.effects.push(...result.effects);
        outcome.attention.push(...result.attention);
        break;
      }
      case "stop_and_suggest":
        await suggestBetterContact(ctx, reply, outcome);
        break;
      case "stop_and_follow_up":
        await followUpTask(ctx, reply, outcome);
        outcome.draft = "review";
        break;
      case "opportunity_and_draft":
      case "draft_reply":
        await categoryFollowUp(ctx, reply, outcome);
        outcome.draft = "review";
        break;
      case "auto_reply":
        await categoryFollowUp(ctx, reply, outcome);
        outcome.draft = "auto";
        break;
      case "human":
        outcome.attention.push("needs_human");
        break;
      default:
        break;
    }
    if (rule.category === "auto_reply_other" && classification.left_company) {
      await leftCompanyTask(ctx, reply, outcome);
    }
  }

  // Booking mode and proposed times: never confirm a time, open "book a meeting" when needed.
  if (!protective) await applyMeetingIntent(ctx, reply, outcome);

  // Locked code rule: a question the knowledge base cannot answer goes to a human + a gap.
  if (!protective && rule.category === "question" && rule.action !== "ignore") {
    const query = (
      classification.question ??
      classification.summary ??
      stripQuotedText(message.body_text ?? "")
    ).slice(0, 300);
    const known = query ? await searchKnowledge(ctx, query, { limit: 3 }) : [];
    if (known.length === 0) {
      const gap = await openKnowledgeGap(ctx, {
        question: classification.question ?? query,
        ...(classification.summary ? { context: classification.summary } : {}),
        ...(thread ? { threadId: thread.id } : {}),
      });
      outcome.effects.push(`knowledge_gap:${gap.id}`);
      outcome.attention.push("question_not_in_knowledge");
      outcome.draft = "none";
    }
  }

  const reviewReasons = (classification.review_reasons ?? []).filter(
    (reason) => !reason.startsWith("prompt_injection:"),
  );
  if (reviewReasons.length > 0) {
    outcome.attention.push(...reviewReasons.map((reason) => `needs_human:${reason}`));
    if (outcome.draft === "auto") outcome.draft = "review";
    if (classification.asks_if_bot) {
      notes.push({
        title: `${label} asks whether they are talking to a bot`,
        lines: ["Answer honestly yourself; no automatic reply will be sent."],
        severity: "warning",
        event: "thread.needs_attention",
      });
    }
  }
  if (classification.confidence < LOW_CONFIDENCE) {
    outcome.attention.push("low_confidence");
    if (outcome.draft === "auto") outcome.draft = "review";
  }

  // No draft (and so no approval) for someone who opted out, is suppressed, marked do not
  // contact or erased: the engine would refuse to send it anyway.
  const blockers =
    outcome.draft !== "none" && DRAFT_ACTIONS.has(rule.action) && thread
      ? await replyBlockers(ctx, person?.id, message.channel)
      : [];
  if (blockers.length > 0) {
    outcome.effects.push(`draft_skipped:${blockers.join(",")}`);
    ctx.log.info(
      { message_id: message.id, thread_id: thread?.id ?? null, reasons: blockers },
      "inbox: no reply drafted, the person may not be contacted",
    );
    outcome.draft = "none";
  } else if (
    outcome.draft !== "none" &&
    DRAFT_ACTIONS.has(rule.action) &&
    thread?.owner === "person"
  ) {
    // A person answers this thread: no AI draft; the flag shows them the new message instead.
    outcome.effects.push(`draft_skipped:${THREAD_OWNED_BY_PERSON}`);
    outcome.attention.push(THREAD_OWNED_BY_PERSON);
    outcome.draft = "none";
  } else if (outcome.draft !== "none" && DRAFT_ACTIONS.has(rule.action) && thread) {
    const handle = await ctx.jobs.enqueue(
      DRAFT_REPLY_JOB,
      { message_id: message.id, auto_send: outcome.draft === "auto" },
      { singletonKey: `${DRAFT_REPLY_JOB}:${message.id}` },
    );
    outcome.effects.push(`draft_enqueued:${handle.job_id}`);
    if (outcome.draft === "review") outcome.attention.push("reply_draft_needs_review");
  } else {
    outcome.draft = "none";
  }

  // This message cancelled an automatic answer to an earlier one (stale-replies.ts). When it
  // gets no answer of its own (an out-of-office, say), a human must answer the earlier one.
  if (outcome.draft === "none" && !protective && thread) {
    const dropped = await repliesSupersededBy(ctx, {
      threadId: thread.id,
      inboundMessageId: message.id,
    });
    if (dropped.length > 0) outcome.attention.push("auto_reply_cancelled");
  }

  await flushNotes(ctx, notes, outcome);
  return outcome;
}

async function flushNotes(ctx: OpContext, notes: NotifyInput[], outcome: ActionOutcome) {
  for (const note of notes) {
    if (await safeNotify(ctx, note)) outcome.notified = true;
  }
}
