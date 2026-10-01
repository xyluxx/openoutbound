/**
 * Reply drafting (`inbox.reply.draft`, standard tier): grounding pack for the campaign offer,
 * thread history and classification, booking link for hot replies; deterministic checks plus
 * the checker model (`inbox.reply.check`) with one rewrite. The draft is sent automatically
 * only when every gate passes (see `autoSendBlockers`); otherwise it waits for approval
 * (kind `reply`).
 */
import { and, eq, inArray, ne } from "drizzle-orm";
import type { BrainResult, JobContext, OpContext } from "../../core/context.js";
import { invalid } from "../../core/errors.js";
import { parseCampaignSettings } from "../../core/settings.js";
import {
  linkedin_accounts,
  type Message,
  type MessageCheck,
  mailboxes,
  messages,
  threads,
} from "../../db/schema/index.js";
import { buildGroundingPack, type GroundingPack, openKnowledgeGap } from "../knowledge/service.js";
import { wrappedLeadContext } from "../leads/service.js";
import { replyBookingLink } from "./booking-links.js";
import { type CheckIssue, checkReplyText } from "./checks.js";
import {
  isSchedulingReply,
  meetingAutoSendBlockers,
  proposedTimeOf,
  schedulingConversation,
} from "./meeting-intent.js";
import { personLabel } from "./notifications.js";
import { stripQuotedText } from "./prechecks.js";
import { checkReplyPrompt } from "./prompts/check.js";
import {
  type DraftOutput,
  type DraftVars,
  draftReplyPrompt,
  type ThreadTurn,
} from "./prompts/draft.js";
import {
  findMessage,
  latestInbound,
  loadReplyContext,
  type ReplyContext,
  threadMessages,
} from "./reply-context.js";
import { autoSendBlockers, HOT_CATEGORIES, resolveReplyRule } from "./rules.js";
import {
  aiDisclosureLine,
  replyReferences,
  replySubject,
  type ScheduleResult,
  scheduleReplySend,
} from "./send.js";
import {
  markAutoReply,
  SUPERSEDED_BY_PERSON,
  supersededError,
  unmarkAutoReply,
} from "./stale-replies.js";
import { isThreadOwnedByPerson, THREAD_OWNED_BY_PERSON } from "./takeover.js";

export const DRAFT_REPLY_JOB = "inbox.draft_reply";
const MAX_WORDS = 90;

export interface DraftReplyInput {
  inboundMessageId: string;
  /** Guidance for the AI (ignored when `text` is given). */
  instruction?: string | null;
  /** Exact reply text (no AI). */
  text?: string | null;
  subject?: string | null;
  /** Try to send without review (automatic flow only). */
  autoSend: boolean;
  /** Request a `reply` approval when not sent automatically (default true). */
  requestApproval?: boolean;
  /**
   * Drafted on the engine's own initiative (the reply pipeline), not asked for: dropped when a
   * person owns the thread (see takeover.ts).
   */
  automatic?: boolean;
}

export interface DraftReplyResult {
  message_id: string;
  thread_id: string;
  approval_id: string | null;
  status: Message["status"];
  subject: string | null;
  body: string;
  check: MessageCheck;
  auto_sent: boolean;
  send_at: Date | null;
  /** Why the draft was not sent automatically. */
  blockers: string[];
  needs_human: boolean;
  needs_human_reason: string | null;
}

function jobIdOf(ctx: OpContext): string | undefined {
  return (ctx as Partial<JobContext>).job?.id;
}

async function senderName(ctx: OpContext, reply: ReplyContext): Promise<string> {
  const { thread, workspace, settings } = reply;
  if (thread?.mailbox_id) {
    const [row] = await ctx.db
      .select({ from_name: mailboxes.from_name })
      .from(mailboxes)
      .where(and(eq(mailboxes.workspace_id, workspace.id), eq(mailboxes.id, thread.mailbox_id)))
      .limit(1);
    if (row?.from_name) return row.from_name;
  }
  if (thread?.linkedin_account_id) {
    const [row] = await ctx.db
      .select({ name: linkedin_accounts.name })
      .from(linkedin_accounts)
      .where(
        and(
          eq(linkedin_accounts.workspace_id, workspace.id),
          eq(linkedin_accounts.id, thread.linkedin_account_id),
        ),
      )
      .limit(1);
    if (row?.name) return row.name;
  }
  return settings.company.name || "our team";
}

function toTurns(rows: Message[]): ThreadTurn[] {
  return rows
    .filter(
      (row) =>
        row.direction === "inbound" ||
        ["sent", "scheduled", "sending", "unknown"].includes(row.status),
    )
    .map((row) => ({
      from: row.direction === "inbound" ? ("them" as const) : ("us" as const),
      subject: row.subject,
      text: (row.direction === "inbound" || row.origin === "external"
        ? stripQuotedText(row.body_text ?? "")
        : (row.body_text ?? "")
      ).slice(0, 2000),
    }));
}

/** The grounding text with the plain booking link replaced by the tagged one. */
function withTaggedLink(text: string, plain: string | null, tagged: string | null): string {
  if (!plain || !tagged || plain === tagged) return text;
  const escaped = plain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Only the link itself, not a longer link that starts with it (trailing punctuation is fine).
  const link = new RegExp(`${escaped}(?=[.,;:!?]*(?:[\\s<>()"']|$))`, "g");
  return text.replace(link, () => tagged);
}

interface CheckedDraft {
  subject: string | null;
  body: string;
  usedFactIds: string[];
  needsHuman: boolean;
  needsHumanReason: string | null;
  check: MessageCheck;
  verdict: "pass" | "revise" | "fail" | null;
}

async function runChecker(
  ctx: OpContext,
  vars: DraftVars,
  prospectMessage: string,
  subject: string | null,
  body: string,
  deterministic: CheckIssue[],
): Promise<{
  verdict: "pass" | "revise" | "fail";
  confidence: number;
  issues: CheckIssue[];
  model: string;
}> {
  const result = await ctx.brain.run(
    checkReplyPrompt,
    {
      category: vars.category,
      language: vars.language,
      prospectMessage,
      grounding: vars.grounding,
      bookingUrl: vars.bookingUrl,
      subject,
      body,
    },
    { jobId: jobIdOf(ctx) },
  );
  const confidence = Math.max(0, Math.min(1, Number(result.output.confidence) || 0));
  const modelIssues: CheckIssue[] = result.output.issues.map((issue) => ({
    code: issue.code || "checker",
    message: issue.message,
    severity: result.output.verdict === "pass" ? "warning" : "error",
  }));
  return {
    verdict: result.output.verdict,
    confidence,
    issues: [...deterministic, ...modelIssues],
    model: result.model,
  };
}

async function writeWithChecks(
  ctx: OpContext,
  vars: DraftVars,
  prospectMessage: string,
  allowedLinks: string[],
  taskKey: string,
): Promise<CheckedDraft> {
  let revision: DraftVars["revision"] = null;
  let revised = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const draft: BrainResult<DraftOutput> = await ctx.brain.run(
      draftReplyPrompt,
      { ...vars, revision },
      { taskKey: `${taskKey}:${attempt}`, jobId: jobIdOf(ctx) },
    );
    const body: string = draft.output.body.trim();
    const subject = draft.output.subject?.trim() || null;
    const deterministic = checkReplyText({
      body,
      maxWords: vars.maxWords,
      allowedLinks,
      grounding: vars.grounding,
    });
    const checker = await runChecker(ctx, vars, prospectMessage, subject, body, deterministic);
    const errors = checker.issues.filter((issue) => issue.severity === "error");
    const deterministicErrors = deterministic.some((issue) => issue.severity === "error");
    const needsRewrite = checker.verdict === "revise" || deterministicErrors;
    if (!needsRewrite || attempt === 1) {
      return {
        subject,
        body,
        usedFactIds: draft.output.used_fact_ids,
        needsHuman: draft.output.needs_human,
        needsHumanReason: draft.output.needs_human_reason,
        verdict: checker.verdict,
        check: {
          passed: checker.verdict === "pass" && !deterministicErrors,
          confidence: checker.confidence,
          issues: checker.issues,
          revised,
          checker_model: checker.model,
        },
      };
    }
    revision = { previous: body, issues: errors.map((issue) => issue.message) };
    revised = true;
  }
  throw new Error("writeWithChecks: unreachable");
}

/** Cancels older unsent reply drafts of the thread (and their pending approvals). */
async function supersedeOlderDrafts(ctx: OpContext, threadId: string, keepId: string) {
  const stale = await ctx.db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.thread_id, threadId),
        eq(messages.direction, "outbound"),
        inArray(messages.status, ["draft", "pending_review"]),
        ne(messages.id, keepId),
      ),
    );
  for (const row of stale) {
    // Only while it is still a draft: one approved or queued meanwhile is left alone.
    const [cancelled] = await ctx.db
      .update(messages)
      .set({ status: "cancelled" })
      .where(and(eq(messages.id, row.id), inArray(messages.status, ["draft", "pending_review"])))
      .returning({ id: messages.id });
    if (cancelled) {
      await ctx.approvals.cancel({ target: { type: "message", id: row.id } }, "superseded");
    }
  }
}

/** Drafts (and, when allowed, schedules) a reply to an inbound message. */
export async function draftReply(
  ctx: OpContext,
  input: DraftReplyInput,
): Promise<DraftReplyResult> {
  const reply = await loadReplyContext(ctx, input.inboundMessageId);
  if (reply?.message.direction !== "inbound" || !reply.thread) {
    throw invalid("Replies need an inbound message in a thread.", {
      message_id: input.inboundMessageId,
    });
  }
  const { message: inbound, thread, person, company, campaign, settings } = reply;
  const classification = inbound.classification;
  const category = classification?.category ?? "other";
  const rule = resolveReplyRule(category, settings, campaign?.settings);
  const campaignSettings = parseCampaignSettings(campaign?.settings);
  const ownText = stripQuotedText(inbound.body_text ?? "");

  const pack: GroundingPack = await buildGroundingPack(ctx, {
    offerId: campaign?.offer_id ?? null,
    query: (classification?.question ?? ownText).slice(0, 500),
    maxChars: 6000,
    // Outside link mode replies never share the booking link, so the writer never sees it.
    bookingLink: settings.booking.mode === "link",
  });
  // Scheduling is judged on the conversation, not only on this message: an earlier proposed
  // time since our last message, or a meeting still to book, keeps the time guard on.
  const conversation = await schedulingConversation(ctx, {
    threadId: thread.id,
    personId: person?.id ?? null,
  });
  const proposedTime = proposedTimeOf(classification) ?? conversation.proposedTime;
  const scheduling = isSchedulingReply(category, proposedTime) || conversation.meetingToBook;
  const wantsLink =
    HOT_CATEGORIES.has(category) ||
    scheduling ||
    /\b(book|calendar|link|meeting|call)\b/i.test(input.instruction ?? "");
  // The tagged link (booking.mode link only): the prompt, the grounding, the allowed links and
  // the checker all use the same one. The plain link stays allowed (a person may paste it).
  const link = wantsLink
    ? await replyBookingLink(ctx, {
        personId: person?.id ?? null,
        offerId: campaign?.offer_id ?? null,
        offer: pack.offer,
      })
    : null;
  const bookingUrl = link?.url ?? null;
  const plainBookingUrl = link?.plain ?? null;
  const grounding = withTaggedLink(pack.text, plainBookingUrl, bookingUrl);
  const allowedLinks = [
    bookingUrl,
    plainBookingUrl,
    pack.company.website,
    settings.company.website,
  ].filter((link): link is string => Boolean(link));
  const language = classification?.language || person?.language || settings.ai.language;
  const vars: DraftVars = {
    senderName: await senderName(ctx, reply),
    company: settings.company.name || pack.company.name || "",
    language,
    category,
    prospect: `${personLabel(person, company)}${person?.title ? `, ${person.title}` : ""}`,
    whatWeKnow: await wrappedLeadContext(ctx, person?.id),
    grounding,
    guidance: pack.guidanceText ?? null,
    bookingUrl,
    bookingMode: settings.booking.mode,
    proposedTime: proposedTime?.text ?? null,
    thread: toTurns(await threadMessages(ctx, thread.id, 8)),
    instruction: input.instruction?.trim() || null,
    toneNotes: [settings.ai.tone_notes, campaignSettings.writing.style_notes]
      .filter(Boolean)
      .join(" "),
    rules: campaignSettings.writing.rules,
    maxWords: MAX_WORDS,
    revision: null,
  };

  let drafted: CheckedDraft;
  if (input.text?.trim()) {
    const body = input.text.trim();
    const issues = checkReplyText({
      body,
      maxWords: MAX_WORDS * 2,
      allowedLinks,
      grounding: pack.text,
    });
    drafted = {
      subject: input.subject?.trim() || null,
      body,
      usedFactIds: [],
      needsHuman: false,
      needsHumanReason: null,
      verdict: null,
      check: {
        passed: !issues.some((issue) => issue.severity === "error"),
        issues,
        revised: false,
        checker_model: null,
      },
    };
  } else {
    drafted = await writeWithChecks(ctx, vars, ownText, allowedLinks, `inbox.draft:${inbound.id}`);
    if (input.subject?.trim()) drafted.subject = input.subject.trim();
  }

  const isEmail = thread.channel === "email";
  const subject = isEmail
    ? (drafted.subject ?? replySubject(inbound.subject ?? thread.subject))
    : null;
  const factIds = drafted.usedFactIds.filter((id) => pack.facts.some((fact) => fact.id === id));
  const [row] = await ctx.db
    .insert(messages)
    .values({
      workspace_id: reply.workspace.id,
      thread_id: thread.id,
      person_id: person?.id ?? inbound.person_id,
      company_id: company?.id ?? inbound.company_id,
      campaign_id: campaign?.id ?? null,
      channel: thread.channel,
      action: isEmail ? "reply" : "message",
      direction: "outbound",
      status: "draft",
      subject,
      body_text: drafted.body,
      to_address: isEmail ? (person?.email ?? null) : null,
      mailbox_id: isEmail ? thread.mailbox_id : null,
      linkedin_account_id: isEmail ? null : thread.linkedin_account_id,
      in_reply_to: isEmail ? inbound.message_id_header : null,
      references: isEmail ? replyReferences(inbound) : [],
      why: {
        notes: `reply:${category}`,
        knowledge_item_ids: factIds,
        offer_id: pack.offer?.id ?? campaign?.offer_id ?? null,
      },
      check: drafted.check,
    })
    .returning();
  if (!row) throw new Error("draftReply: insert returned no row");
  if (input.automatic && (await isThreadOwnedByPerson(ctx, thread.id))) {
    // A person took the thread over while this was written: the engine steps back.
    await ctx.db
      .update(messages)
      .set({ status: "cancelled", error: SUPERSEDED_BY_PERSON })
      .where(eq(messages.id, row.id));
    return {
      message_id: row.id,
      thread_id: thread.id,
      approval_id: null,
      status: "cancelled",
      subject,
      body: drafted.body,
      check: drafted.check,
      auto_sent: false,
      send_at: null,
      blockers: [THREAD_OWNED_BY_PERSON],
      needs_human: drafted.needsHuman,
      needs_human_reason: drafted.needsHumanReason,
    };
  }
  await supersedeOlderDrafts(ctx, thread.id, row.id);

  if (drafted.needsHuman && classification?.question) {
    await openKnowledgeGap(ctx, {
      question: classification.question,
      context: drafted.needsHumanReason ?? classification.summary ?? undefined,
      threadId: thread.id,
    });
  }

  const blockers = input.autoSend
    ? [
        ...autoSendBlockers({
          rule,
          classificationConfidence: classification?.confidence ?? 0,
          suspicious: classification?.suspicious === true,
          reviewReasons: (classification?.review_reasons ?? []).filter(
            (reason) => !reason.startsWith("prompt_injection:"),
          ),
          needsHuman: drafted.needsHuman,
          check: {
            passed: drafted.check.passed,
            verdict: drafted.verdict,
            confidence: drafted.check.confidence ?? 0,
          },
        }),
        // Never propose or confirm a time: a scheduling reply goes out alone only with the
        // booking link and without naming a day or time.
        ...meetingAutoSendBlockers({
          mode: settings.booking.mode,
          category,
          proposedTime,
          scheduling,
          bookingUrl,
          body: drafted.body,
        }),
      ]
    : ["review_requested"];

  let status: Message["status"] = row.status;
  let body = drafted.body;
  let approvalId: string | null = null;
  let sendAt: Date | null = null;
  let autoSent = false;
  let markedAuto = false;

  if (blockers.length === 0) {
    // Mark first: from now on a newer reply cancels this answer (see stale-replies.ts). Then
    // make sure the prospect did not write again while it was being written.
    await markAutoReply(ctx, row.id, inbound.id);
    markedAuto = true;
    const latest = await latestInbound(ctx, thread.id);
    if (latest && latest.id !== inbound.id) {
      await ctx.db
        .update(messages)
        .set({ status: "cancelled", error: supersededError(latest.id) })
        .where(eq(messages.id, row.id));
      status = "cancelled";
      blockers.push("newer_reply");
    }
  }

  if (blockers.length === 0) {
    // An unknown recipient country counts as EU/EEA (see aiDisclosureLine).
    const disclosure = aiDisclosureLine(settings, person?.country || company?.country || null);
    if (disclosure) {
      body = `${body}\n\n${disclosure}`;
      await ctx.db.update(messages).set({ body_text: body }).where(eq(messages.id, row.id));
    }
    const scheduled: ScheduleResult = await scheduleReplySend(ctx, row.id, {
      delay: true,
      respectWindow: true,
    });
    if (scheduled.status === "blocked") {
      blockers.push(scheduled.reason);
      // Opted out since, or cancelled by a newer reply meanwhile: never revive it for review.
      if ((await findMessage(ctx, row.id))?.status === "cancelled") status = "cancelled";
    } else {
      autoSent = true;
      status = scheduled.status === "scheduled" ? "scheduled" : "approved";
      sendAt = scheduled.status === "scheduled" ? scheduled.send_at : scheduled.retry_at;
      await ctx.db
        .update(threads)
        .set({ needs_attention: false, status: "waiting" })
        .where(eq(threads.id, thread.id));
    }
  }

  // Going to human review instead: a person approves it, so it is no longer automatic.
  if (!autoSent && markedAuto && status !== "cancelled") await unmarkAutoReply(ctx, row.id);
  if (!autoSent && body !== drafted.body) {
    body = drafted.body;
    await ctx.db.update(messages).set({ body_text: body }).where(eq(messages.id, row.id));
  }
  if (!autoSent && status !== "cancelled" && input.requestApproval !== false) {
    const summaryParts = [
      `${category.replace(/_/g, " ")} reply to ${personLabel(person, company)}.`,
      drafted.needsHuman
        ? `Needs a human: ${drafted.needsHumanReason ?? "knowledge missing"}.`
        : "",
      `Draft: ${body.slice(0, 280)}${body.length > 280 ? "..." : ""}`,
    ].filter(Boolean);
    const approval = await ctx.approvals.request({
      kind: "reply",
      title: `Reply to ${personLabel(person, company)}`,
      summary: summaryParts.join(" "),
      payload: {
        message_id: row.id,
        thread_id: thread.id,
        channel: thread.channel,
        subject,
        body,
        category,
        blockers,
      },
      target: { type: "message", id: row.id },
    });
    // Only while it is still a draft: a newer draft that replaced it meanwhile cancelled it, and
    // a cancelled draft never comes back for review.
    const [held] = await ctx.db
      .update(messages)
      .set({ status: "pending_review" })
      .where(and(eq(messages.id, row.id), eq(messages.status, "draft")))
      .returning({ id: messages.id });
    if (held) {
      approvalId = approval.id;
      status = "pending_review";
    } else {
      await ctx.approvals.cancel({ id: approval.id }, "superseded");
      status = (await findMessage(ctx, row.id))?.status ?? "cancelled";
    }
  }
  if (approvalId && !thread.needs_attention) {
    await ctx.db.update(threads).set({ needs_attention: true }).where(eq(threads.id, thread.id));
    await ctx.events.emit("thread.needs_attention", {
      subject: { type: "thread", id: thread.id },
      data: { thread_id: thread.id, reason: "reply_draft_needs_review", category },
    });
  }

  await ctx.events.emit("message.drafted", {
    subject: { type: "message", id: row.id },
    data: {
      message_id: row.id,
      person_id: row.person_id,
      campaign_id: row.campaign_id,
      channel: row.channel,
      action: row.action,
      status,
    },
  });

  return {
    message_id: row.id,
    thread_id: thread.id,
    approval_id: approvalId,
    status,
    subject,
    body,
    check: drafted.check,
    auto_sent: autoSent,
    send_at: sendAt,
    blockers,
    needs_human: drafted.needsHuman,
    needs_human_reason: drafted.needsHumanReason,
  };
}
