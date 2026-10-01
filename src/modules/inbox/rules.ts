/**
 * Reply action matrix (spec 11.11): which action runs for a classified reply. Workspace
 * defaults live in `settings.replies`, campaigns may override unlocked categories in
 * `campaigns.settings.replies`, and locked categories (unsubscribe, privacy_request, bounce,
 * negative) always use their built-in action, whatever the settings say.
 */
import { z } from "zod";
import { REPLY_CATEGORIES, type ReplyCategory } from "../../core/enums.js";
import {
  DEFAULT_REPLY_RULES,
  REPLY_ACTIONS,
  type ReplyAction,
  type WorkspaceSettings,
} from "../../core/settings.js";

/** Replies that deserve an immediate human notification and an opportunity. */
export const HOT_CATEGORIES: ReadonlySet<ReplyCategory> = new Set([
  "interested",
  "meeting_request",
]);

/**
 * Categories whose drafts may ever be sent without review (still only when the rule is
 * `auto_reply` and every gate passes). Objections are always reviewed (replies playbook).
 */
export const AUTO_SEND_CATEGORIES: ReadonlySet<ReplyCategory> = new Set([
  "interested",
  "meeting_request",
  "question",
  "not_now",
  "wrong_person",
]);

/** Machine-written mail: it does not count as the person replying (no stop.on_reply). */
export const AUTOMATED_CATEGORIES: ReadonlySet<ReplyCategory> = new Set([
  "out_of_office",
  "auto_reply_other",
  "bounce",
]);

/** Actions that protect the recipient; they run even when a reply looks like prompt injection. */
export const PROTECTIVE_ACTIONS: ReadonlySet<ReplyAction> = new Set([
  "suppress",
  "privacy",
  "mark_invalid",
  "notify_human",
]);

/** Actions that produce a reply draft. */
export const DRAFT_ACTIONS: ReadonlySet<ReplyAction> = new Set([
  "stop_and_follow_up",
  "opportunity_and_draft",
  "draft_reply",
  "auto_reply",
]);

/** Minimum classification and checker confidence for sending without review. */
export const AUTO_SEND_MIN_CONFIDENCE = 0.8;
/** Below this classification confidence the thread always goes to a human as well. */
export const LOW_CONFIDENCE = 0.7;

export interface ResolvedReplyRule {
  category: ReplyCategory;
  action: ReplyAction;
  locked: boolean;
  /** Where the action came from. */
  source: "locked" | "campaign" | "workspace";
}

const campaignOverrideSchema = z.object({ action: z.enum(REPLY_ACTIONS) });

/**
 * Reads per-category overrides from raw campaign settings (`settings.replies`). Unknown
 * categories and invalid entries are ignored; locked categories are never returned.
 */
export function readCampaignReplyOverrides(
  rawCampaignSettings: unknown,
): Partial<Record<ReplyCategory, ReplyAction>> {
  const out: Partial<Record<ReplyCategory, ReplyAction>> = {};
  if (typeof rawCampaignSettings !== "object" || rawCampaignSettings === null) return out;
  const replies = (rawCampaignSettings as { replies?: unknown }).replies;
  if (typeof replies !== "object" || replies === null) return out;
  for (const [key, value] of Object.entries(replies)) {
    if (!(REPLY_CATEGORIES as readonly string[]).includes(key)) continue;
    const category = key as ReplyCategory;
    if (DEFAULT_REPLY_RULES[category].locked) continue;
    const parsed = campaignOverrideSchema.safeParse(value);
    if (parsed.success) out[category] = parsed.data.action;
  }
  return out;
}

/** The action for a category: locked rule, else campaign override, else workspace setting. */
export function resolveReplyRule(
  category: ReplyCategory,
  settings: WorkspaceSettings,
  rawCampaignSettings?: unknown,
): ResolvedReplyRule {
  const builtin = DEFAULT_REPLY_RULES[category];
  if (builtin.locked) {
    return { category, action: builtin.action, locked: true, source: "locked" };
  }
  const override = readCampaignReplyOverrides(rawCampaignSettings)[category];
  if (override) return { category, action: override, locked: false, source: "campaign" };
  const workspace = settings.replies[category];
  return { category, action: workspace.action, locked: false, source: "workspace" };
}

export interface AutoSendInput {
  rule: ResolvedReplyRule;
  classificationConfidence: number;
  suspicious: boolean;
  /** Reasons that always need a human (bot question, legal, data requests, ...). */
  reviewReasons: string[];
  /** The draft model said the knowledge base cannot answer. */
  needsHuman: boolean;
  check: { passed: boolean; verdict: "pass" | "revise" | "fail" | null; confidence: number };
}

/**
 * Whether a drafted reply may be sent without review: the rule for the category is
 * `auto_reply` (workspace or campaign opted in), the category may be auto-sent at all, the
 * reply is not suspicious or flagged for a human, and the classification and the checker are
 * both confident (>= 0.8) with a `pass` verdict and no failed deterministic checks.
 * Returns the reasons it may not (empty = allowed).
 */
export function autoSendBlockers(input: AutoSendInput): string[] {
  const blockers: string[] = [];
  if (input.rule.action !== "auto_reply") blockers.push("rule_requires_review");
  if (!AUTO_SEND_CATEGORIES.has(input.rule.category)) blockers.push("category_not_auto_sendable");
  if (input.suspicious) blockers.push("suspicious_reply");
  if (input.reviewReasons.length > 0) blockers.push("needs_human_review");
  if (input.needsHuman) blockers.push("knowledge_missing");
  if (input.classificationConfidence < AUTO_SEND_MIN_CONFIDENCE) {
    blockers.push("classification_not_confident");
  }
  if (!input.check.passed) blockers.push("checks_failed");
  if (input.check.verdict !== "pass") blockers.push("checker_verdict_not_pass");
  if (input.check.confidence < AUTO_SEND_MIN_CONFIDENCE) blockers.push("checker_not_confident");
  return blockers;
}
