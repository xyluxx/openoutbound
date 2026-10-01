/** Deterministic checks on a drafted reply (run before the checker model and on human edits). */
import type { MessageCheck } from "../../db/schema/index.js";
import { allowedLinkKeys, displayLink, linkKey, linksIn } from "./link-match.js";

export type CheckIssue = MessageCheck["issues"][number];

export interface ReplyTextInput {
  body: string;
  maxWords: number;
  /**
   * Links the reply may contain (booking link, company website), matched as whole URLs; the
   * booking tag may differ (see link-match.ts).
   */
  allowedLinks: string[];
  /** Grounding text: prices and amounts must appear here. */
  grounding: string;
}

const AMOUNT_PATTERN = /(?:[$€£]\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:usd|eur|gbp|dollars?|euros?)\b)/gi;

function digitsOf(value: string): string {
  return value.replace(/[^\d]/g, "");
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Issues with severity `error` block auto-send and trigger one rewrite. */
export function checkReplyText(input: ReplyTextInput): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const body = input.body.trim();
  if (!body) {
    return [{ code: "empty", message: "The reply is empty.", severity: "error" }];
  }
  const words = wordCount(body);
  if (words > input.maxWords * 1.5) {
    issues.push({
      code: "too_long",
      message: `The reply has ${words} words; keep it under ${input.maxWords}.`,
      severity: "error",
    });
  } else if (words > input.maxWords) {
    issues.push({
      code: "long",
      message: `The reply has ${words} words; aim for ${input.maxWords} or fewer.`,
      severity: "warning",
    });
  }
  if (/\{\{[^}]*\}\}|\[\[[^\]]*\]\]/.test(body)) {
    issues.push({
      code: "template_leftover",
      message: "The reply contains an unfilled template variable or AI slot.",
      severity: "error",
    });
  }
  if (
    /\[(?:your |first |last |company |prospect )?(?:name|company|date|time|link|insert[^\]]*)\]/i.test(
      body,
    )
  ) {
    issues.push({
      code: "placeholder",
      message: "The reply contains a placeholder like [Name].",
      severity: "error",
    });
  }
  const allowed = allowedLinkKeys(input.allowedLinks, { ignoreTag: true });
  for (const link of linksIn(body)) {
    const key = linkKey(link, { ignoreTag: true });
    if (!key || !allowed.includes(key)) {
      issues.push({
        code: "unknown_link",
        message: `The link ${displayLink(link)} is not the booking link or our website.`,
        severity: "error",
      });
    }
  }
  if (/\b(as an ai|as a language model|i am an ai|i'm an ai|large language model)\b/i.test(body)) {
    issues.push({
      code: "ai_self_reference",
      message: "The reply talks about being an AI; a human must answer that.",
      severity: "error",
    });
  }
  const groundingNumbers = new Set((input.grounding.match(/\d[\d,.]*/g) ?? []).map(digitsOf));
  for (const amount of body.match(AMOUNT_PATTERN) ?? []) {
    const digits = digitsOf(amount);
    if (digits && !groundingNumbers.has(digits)) {
      issues.push({
        code: "unsupported_amount",
        message: `The amount "${amount.trim()}" is not in the knowledge base.`,
        severity: "error",
      });
    }
  }
  return issues;
}
