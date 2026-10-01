/**
 * `reply.received` -> `inbox.classify`: deterministic prechecks, then the fast-tier
 * `inbox.reply.classify` prompt (untrusted wrapping, schema-only output, no tools), then the
 * action matrix. Inbound text never triggers anything but classification and the fixed
 * actions of its category; suspicious replies go to a human.
 */
import { eq } from "drizzle-orm";
import type { JobContext, OpContext } from "../../core/context.js";
import type { PrivacyKind, ReplyCategory } from "../../core/enums.js";
import { messages, type ReplyClassification, threads } from "../../db/schema/index.js";
import { type ActionOutcome, applyReplyActions } from "./actions.js";
import { isIsoDate, isoDateInZone } from "./dates.js";
import {
  detectInjection,
  detectReviewReasons,
  precheckReply,
  stripQuotedText,
} from "./prechecks.js";
import { inferPrivacyKind } from "./privacy-phrases.js";
import {
  type ClassifyOutput,
  classifyReplyPrompt,
  MAX_REPLY_FACT_CHARS,
  MAX_REPLY_FACTS,
} from "./prompts/classify.js";
import { normalizeEmail } from "./referral.js";
import { lastOutboundBefore, loadReplyContext, type ReplyContext } from "./reply-context.js";
import { recordReplyFacts } from "./reply-facts.js";
import { AUTOMATED_CATEGORIES, resolveReplyRule } from "./rules.js";

export const CLASSIFY_JOB = "inbox.classify";

export interface ClassifyOptions {
  /** Classify again even when a classification exists. */
  force?: boolean;
  /** Human override: use this category (confidence 1) instead of the model. */
  overrideCategory?: ReplyCategory;
}

export interface ClassifyResult {
  message_id: string;
  skipped?: "not_found" | "not_inbound" | "already_classified";
  category?: ReplyCategory;
  confidence?: number;
  suspicious?: boolean;
  action?: string;
  effects?: string[];
  attention?: string[];
}

/**
 * Categories the model may give mail with auto-reply headers. Never `privacy_request`: an
 * automatic reply (a ticket system, a privacy policy footer) is not a person asking about their
 * data. Privacy wording the prechecks find still makes one (protective, see prechecks.ts).
 */
const AUTOMATED_OK: ReadonlySet<ReplyCategory> = new Set([
  "out_of_office",
  "auto_reply_other",
  "bounce",
  "unsubscribe",
]);

/** Summaries of replies decided by the prechecks (no model), by category or privacy kind. */
const RULE_SUMMARIES: Record<"unsubscribe" | "bounce" | "privacy_request" | PrivacyKind, string> = {
  unsubscribe: "Asked to stop being contacted.",
  bounce: "Delivery failure notice.",
  privacy_request: "Asked about their personal data.",
  delete: "Asked to delete their personal data.",
  access: "Asked what personal data you hold about them.",
  source: "Asked where you got their details.",
};

/** ISO 8601 date and time with a UTC offset (or Z). */
const ISO_DATE_TIME_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;

function clamp01(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function trimOrNull(value: string | null | undefined, max: number): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/** Collapses whitespace and trims; null when nothing is left. */
function cleanText(value: string | null | undefined, max: number): string | null {
  const text = value?.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max).trim() : null;
}

/** Canonical IANA name, or null when Intl does not know the zone. */
function ianaZone(value: string | null | undefined): string | null {
  const zone = value?.trim();
  if (!zone) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

function cleanProposedTime(
  value: ClassifyOutput["proposed_time"],
): ReplyClassification["proposed_time"] {
  const text = cleanText(value?.text, 200);
  if (!value || !text) return null;
  const start = value.start?.trim() ?? "";
  return {
    text,
    start: ISO_DATE_TIME_WITH_OFFSET.test(start) && !Number.isNaN(Date.parse(start)) ? start : null,
    timezone: ianaZone(value.timezone),
  };
}

function cleanFacts(facts: ClassifyOutput["facts"]): NonNullable<ReplyClassification["facts"]> {
  const out: NonNullable<ReplyClassification["facts"]> = [];
  const seen = new Set<string>();
  for (const fact of facts ?? []) {
    const text = cleanText(fact.text, MAX_REPLY_FACT_CHARS);
    if (!text) continue;
    const key = `${fact.applies_to}:${fact.kind}:${text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: fact.kind,
      text,
      applies_to: fact.applies_to,
      expires_on: isIsoDate(fact.expires_on) ? fact.expires_on : null,
    });
    if (out.length >= MAX_REPLY_FACTS) break;
  }
  return out;
}

/** A hold suggestion needs a real date after today; the reason defaults to a plain line. */
function cleanCompanyHold(
  hold: ClassifyOutput["company_hold"],
  today: string,
): ReplyClassification["company_hold"] {
  if (!hold || !isIsoDate(hold.until) || hold.until <= today) return null;
  return {
    until: hold.until,
    reason: cleanText(hold.reason, 300) ?? "Asked not to contact anyone at the company until then.",
  };
}

function jobIdOf(ctx: OpContext): string | undefined {
  return (ctx as Partial<JobContext>).job?.id;
}

/** Heuristic flags shared by every classification source. */
function flags(reply: ReplyContext) {
  const text = `${reply.message.subject ?? ""}\n${reply.message.body_text ?? ""}`;
  const ownText = stripQuotedText(reply.message.body_text ?? "");
  return {
    injection: detectInjection(text),
    review: detectReviewReasons(ownText),
  };
}

async function classifyWithModel(
  ctx: OpContext,
  reply: ReplyContext,
  automated: boolean,
): Promise<ReplyClassification> {
  const { message, thread, person, company, workspace, settings } = reply;
  const zone = person?.timezone ?? workspace.timezone;
  const today = isoDateInZone(ctx.clock.now(), zone);
  const ours = thread
    ? await lastOutboundBefore(ctx, thread.id, message.received_at ?? message.created_at)
    : null;
  // A person's own reply from the Sent folder may quote the prospect: quotes cut, and wrapped.
  const byPerson = ours?.origin === "external";
  const ourText = byPerson ? stripQuotedText(ours?.body_text ?? "") : (ours?.body_text ?? "");
  const result = await ctx.brain.run(
    classifyReplyPrompt,
    {
      company: settings.company.name,
      channel: message.channel,
      today,
      timeZone: ianaZone(person?.timezone ?? company?.timezone ?? null),
      automated,
      ourLastMessage: ourText.trim() ? ourText.slice(0, 1500) : null,
      ourLastMessageByPerson: byPerson,
      subject: message.subject,
      reply: (message.body_text ?? "").slice(0, 6000),
    },
    { taskKey: `${CLASSIFY_JOB}:${message.id}`, jobId: jobIdOf(ctx) },
  );
  const out = result.output;
  let category = out.category;
  let confidence = clamp01(out.confidence);
  if (automated && !AUTOMATED_OK.has(category)) {
    category = "auto_reply_other";
    confidence = Math.min(confidence, 0.6);
  }
  const referralEmail = normalizeEmail(out.referral?.email);
  const referral =
    out.referral && (referralEmail || out.referral.name)
      ? {
          name: trimOrNull(out.referral.name, 120),
          email: referralEmail,
          title: trimOrNull(out.referral.title, 120),
        }
      : null;
  return {
    category,
    confidence,
    sentiment: out.sentiment,
    summary: trimOrNull(out.summary, 300) ?? undefined,
    language: trimOrNull(out.language, 10),
    return_date: isIsoDate(out.return_date) ? out.return_date : null,
    follow_up_date: isIsoDate(out.follow_up_date) ? out.follow_up_date : null,
    referral,
    question: trimOrNull(out.question, 500),
    left_company: out.left_company === true && AUTOMATED_CATEGORIES.has(category),
    asks_if_bot: out.asks_if_bot === true,
    suspicious: out.suspicious === true,
    proposed_time: cleanProposedTime(out.proposed_time),
    privacy_kind: category === "privacy_request" ? (out.privacy_kind ?? null) : null,
    facts: cleanFacts(out.facts),
    company_hold: cleanCompanyHold(out.company_hold, today),
    source: "model",
    model: result.model,
  };
}

/** Classifies an inbound message (or reuses a stored classification) and runs its actions. */
export async function classifyInboundMessage(
  ctx: OpContext,
  messageId: string,
  options: ClassifyOptions = {},
): Promise<ClassifyResult> {
  const reply = await loadReplyContext(ctx, messageId);
  if (!reply) return { message_id: messageId, skipped: "not_found" };
  const { message, thread, settings, campaign } = reply;
  if (message.direction !== "inbound") return { message_id: messageId, skipped: "not_inbound" };
  const stored = message.classification;
  if (stored?.classified_at && !options.force && !options.overrideCategory) {
    return {
      message_id: messageId,
      skipped: "already_classified",
      category: stored.category,
      confidence: stored.confidence,
    };
  }

  const heuristics = flags(reply);
  let base: ReplyClassification;
  if (options.overrideCategory) {
    base = {
      ...(stored ?? {}),
      category: options.overrideCategory,
      confidence: 1,
      source: "human",
      model: null,
    };
  } else if (stored && !options.force) {
    // A previous attempt stored the classification but did not finish its actions.
    base = stored;
  } else {
    const pre = precheckReply({
      subject: message.subject,
      text: message.body_text ?? "",
      headers: message.headers ?? null,
      from: message.from_address,
    });
    base = pre.category
      ? {
          category: pre.category,
          confidence: 1,
          sentiment: pre.category === "unsubscribe" ? "negative" : "neutral",
          summary: RULE_SUMMARIES[pre.privacyKind ?? pre.category],
          source: "rules",
          model: null,
          proposed_time: null,
          privacy_kind: pre.privacyKind,
          facts: [],
          company_hold: null,
        }
      : await classifyWithModel(ctx, reply, pre.automated);
  }

  const review = [...new Set([...heuristics.review, ...(base.asks_if_bot ? ["asks_if_bot"] : [])])];
  const suspicious = base.suspicious === true || heuristics.injection.length > 0;
  const classification: ReplyClassification = {
    ...base,
    suspicious,
    asks_if_bot: base.asks_if_bot === true || review.includes("asks_if_bot"),
    review_reasons: [...review, ...heuristics.injection.map((code) => `prompt_injection:${code}`)],
    proposed_time: base.proposed_time ?? null,
    // A privacy request always names what it asks (model answers and human overrides may not).
    privacy_kind:
      base.category === "privacy_request"
        ? (base.privacy_kind ?? inferPrivacyKind(stripQuotedText(message.body_text ?? "")))
        : null,
    // A reply that tries to instruct an AI never feeds the lead file or a company hold.
    facts: suspicious ? [] : (base.facts ?? []),
    company_hold: suspicious ? null : (base.company_hold ?? null),
  };
  delete classification.classified_at;

  // Persist first (without classified_at) so the draft job can read it; mark done at the end.
  await ctx.db.update(messages).set({ classification }).where(eq(messages.id, message.id));

  const rule = resolveReplyRule(classification.category, settings, campaign?.settings);
  const outcome: ActionOutcome = await applyReplyActions(ctx, { ...reply, classification, rule });
  // The lead file: business facts from the reply, and a suggested company hold as a problem.
  await recordReplyFacts(ctx, reply, classification);

  const now = ctx.clock.now();
  await ctx.db
    .update(messages)
    .set({ classification: { ...classification, classified_at: now.toISOString() } })
    .where(eq(messages.id, message.id));

  if (thread) {
    const inboundAt = message.received_at ?? message.created_at;
    const lastInbound =
      thread.last_inbound_at && thread.last_inbound_at > inboundAt
        ? thread.last_inbound_at
        : inboundAt;
    const lastMessage =
      thread.last_message_at && thread.last_message_at > inboundAt
        ? thread.last_message_at
        : inboundAt;
    await ctx.db
      .update(threads)
      .set({
        category: classification.category,
        sentiment: classification.sentiment ?? null,
        needs_attention: outcome.attention.length > 0,
        status: "open",
        last_inbound_at: lastInbound,
        last_message_at: lastMessage,
      })
      .where(eq(threads.id, thread.id));
  }

  await ctx.events.emit("reply.classified", {
    subject: { type: "message", id: message.id },
    data: {
      message_id: message.id,
      thread_id: thread?.id ?? message.thread_id ?? "",
      person_id: reply.person?.id ?? null,
      category: classification.category,
      confidence: classification.confidence,
    },
  });
  if (thread && outcome.attention.length > 0) {
    await ctx.events.emit("thread.needs_attention", {
      subject: { type: "thread", id: thread.id },
      data: {
        thread_id: thread.id,
        reason: outcome.attention.join(","),
        category: classification.category,
      },
    });
  }

  return {
    message_id: message.id,
    category: classification.category,
    confidence: classification.confidence,
    suspicious: classification.suspicious === true,
    action: rule.action,
    effects: outcome.effects,
    attention: outcome.attention,
  };
}
