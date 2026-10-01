import { BANNED_PHRASES, findPhrases } from "./banned-phrases.js";

export interface CheckIssue {
  code: string;
  message: string;
  severity: "error" | "warning";
}

/** What kind of text is checked. */
export type DraftKind = "email" | "invite_note" | "message" | "comment";

export interface DraftFact {
  text: string;
  source: string;
}

export interface DeterministicCheckInput {
  kind: DraftKind;
  subject: string | null;
  body: string;
  /** First outbound touch of the sequence (stricter rules: no links, min length). */
  firstTouch: boolean;
  /** Email mode; subjects are only checked for new threads. */
  mode: "new_thread" | "reply";
  maxWords: number | null;
  minWords: number | null;
  maxChars: number | null;
  /** How many links the text may contain. */
  linksAllowed: number;
  /** Extra phrases from workspace and campaign rules. */
  extraPhrases: readonly string[];
  /** Written by the AI (length minimums and grounding checks apply). */
  aiWritten: boolean;
  facts?: DraftFact[];
  /** URLs and record ids the text may cite. */
  allowedSources?: ReadonlySet<string>;
  signalsUsed?: string[];
  allowedSignalIds?: ReadonlySet<string>;
  /** Text that numbers (percentages, money, multiples) must come from. */
  evidenceText?: string;
  /** Language of the draft (ISO code such as "de"); some rules depend on it. */
  language?: string | null;
}

const EM_DASH = String.fromCharCode(0x2014);
const URL_PATTERN = /\bhttps?:\/\/[^\s)>\]]+|\bwww\.[^\s)>\]]+/gi;
const EMOJI = /\p{Extended_Pictographic}/u;
const PLACEHOLDER = /\[(?:[A-Z][A-Za-z]*)(?: [A-Za-z]+){0,3}\]|<(?:company|first name|name)>/;
const UNRESOLVED = /\{\{|\}\}|\[\[|\]\]/;
const NUMBER_CLAIM =
  /(?:[$€£]\s?\d[\d,.]*\s?(?:k|m|bn|million|billion)?)|(?:\b\d[\d,.]*\s?%)|(?:\b\d+(?:\.\d+)?\s?x\b)/gi;

/** Words in a text (split on whitespace, punctuation-only tokens ignored). */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

/**
 * Normalizes machine-looking punctuation the checks would reject anyway: the long dash
 * becomes a comma (between words) or a hyphen, and stray whitespace is trimmed.
 */
export function sanitizeDraft(text: string): string {
  return text
    .replaceAll(` ${EM_DASH} `, ", ")
    .replaceAll(EM_DASH, "-")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/** German and Luxembourgish capitalize every noun, so capital letters do not mean headline case. */
function capitalizesNouns(language: string | null | undefined): boolean {
  return /^(?:de|lb)(?:[-_]|$)|^(?:german|deutsch)/i.test((language ?? "").trim());
}

/**
 * Subject length for new threads (copywriting playbook): 2-5 words. The writing prompt asks
 * for exactly this range and the check enforces it, so the two never disagree.
 */
export const SUBJECT_MIN_WORDS = 2;
export const SUBJECT_MAX_WORDS = 5;

function subjectIssues(
  subject: string | null,
  language: string | null | undefined,
  aiWritten: boolean,
): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const value = (subject ?? "").trim();
  if (!value) {
    return [{ code: "subject_missing", message: "The email needs a subject.", severity: "error" }];
  }
  const words = countWords(value);
  const range = `${SUBJECT_MIN_WORDS}-${SUBJECT_MAX_WORDS} words`;
  if (words > SUBJECT_MAX_WORDS) {
    issues.push({
      code: "subject_length",
      message: `Subject has ${words} words; keep it to ${range}.`,
      severity: "error",
    });
  } else if (words < SUBJECT_MIN_WORDS) {
    // Like the body minimum, only AI-written subjects must be revised; your own is your call.
    issues.push({
      code: "subject_length",
      message: `Subject has ${words} word${words === 1 ? "" : "s"}; use ${range}.`,
      severity: aiWritten ? "error" : "warning",
    });
  }
  if (/^\s*(re|fwd?|aw|wg)\s*:/i.test(value)) {
    issues.push({
      code: "subject_fake_reply",
      message: 'New threads must not start with "Re:" or "Fwd:".',
      severity: "error",
    });
  }
  const capitalized = value
    .split(/\s+/)
    .filter((word) => word.length > 3 && /^[A-Z][a-z]/.test(word)).length;
  if (words >= 3 && capitalized >= Math.ceil(words / 2) && !capitalizesNouns(language)) {
    issues.push({
      code: "subject_case",
      message: "Subject reads like a headline; prefer lowercase like an internal email.",
      severity: "warning",
    });
  }
  return issues;
}

/**
 * Deterministic checks from the copywriting playbook: length, banned phrases, unresolved
 * variables and slots, links, subject rules, punctuation, emojis, unsupported numbers, and
 * facts or signals that do not come from the provided evidence.
 */
export function runDeterministicChecks(input: DeterministicCheckInput): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const body = input.body ?? "";
  const full = `${input.subject ?? ""}\n${body}`;

  if (!body.trim()) {
    issues.push({ code: "empty", message: "The text is empty.", severity: "error" });
    return issues;
  }

  const words = countWords(body);
  if (input.maxWords !== null && words > input.maxWords) {
    issues.push({
      code: "too_long",
      message: `Body has ${words} words; the limit is ${input.maxWords}.`,
      severity: "error",
    });
  }
  if (input.aiWritten && input.minWords !== null && words < input.minWords) {
    issues.push({
      code: "too_short",
      message: `Body has ${words} words; write at least ${input.minWords}.`,
      severity: "error",
    });
  }
  if (input.maxChars !== null && body.length > input.maxChars) {
    issues.push({
      code: "too_long",
      message: `Text has ${body.length} characters; the limit is ${input.maxChars}.`,
      severity: "error",
    });
  }

  if (input.kind === "email" && input.mode === "new_thread") {
    issues.push(...subjectIssues(input.subject, input.language, input.aiWritten));
  }

  const phrases = findPhrases(full, [...BANNED_PHRASES, ...input.extraPhrases]);
  for (const phrase of phrases) {
    issues.push({
      code: "banned_phrase",
      message: `Avoid the phrase "${phrase}".`,
      severity: "error",
    });
  }

  if (UNRESOLVED.test(full)) {
    issues.push({
      code: "unresolved_variable",
      message: "Unresolved {{variable}} or [[slot]] left in the text.",
      severity: "error",
    });
  }
  if (PLACEHOLDER.test(full)) {
    issues.push({
      code: "placeholder",
      message: "Placeholder text such as [Company] left in the text.",
      severity: "error",
    });
  }

  const links = full.match(URL_PATTERN) ?? [];
  if (links.length > input.linksAllowed) {
    issues.push({
      code: "links",
      message:
        input.linksAllowed === 0
          ? "No links in this message (first touches and notes stay plain)."
          : `At most ${input.linksAllowed} link(s) here; found ${links.length}.`,
      severity: "error",
    });
  }

  if (body.includes("!")) {
    issues.push({
      code: "exclamation",
      message: "Remove exclamation marks.",
      severity: "error",
    });
  }
  const questions = (body.match(/\?/g) ?? []).length;
  if (questions > 1) {
    issues.push({
      code: "multiple_questions",
      message: "Ask one question only.",
      severity: input.firstTouch ? "error" : "warning",
    });
  }
  const shouting = body.match(/\b[A-Z]{4,}\b/g) ?? [];
  if (shouting.length > 0) {
    issues.push({
      code: "all_caps",
      message: `ALL CAPS words (${shouting.slice(0, 3).join(", ")}); use normal case unless it is a real acronym.`,
      severity: "warning",
    });
  }
  if (full.includes(EM_DASH)) {
    issues.push({
      code: "long_dash",
      message: "Replace the long dash with a comma, colon or hyphen.",
      severity: "error",
    });
  }
  if (EMOJI.test(full)) {
    issues.push({ code: "emoji", message: "Remove emojis.", severity: "error" });
  }

  if (input.aiWritten && input.evidenceText !== undefined) {
    const evidence = input.evidenceText.toLowerCase().replace(/\s+/g, "");
    for (const claim of full.match(NUMBER_CLAIM) ?? []) {
      const compact = claim.toLowerCase().replace(/\s+/g, "");
      if (!evidence.includes(compact)) {
        issues.push({
          code: "unsupported_number",
          message: `"${claim.trim()}" is not stated in the knowledge base or the research.`,
          severity: "error",
        });
      }
    }
  }

  if (input.facts && input.allowedSources) {
    for (const fact of input.facts) {
      const source = fact.source.trim();
      if (!source) {
        issues.push({
          code: "unsourced_fact",
          message: `Fact without a source: "${fact.text.slice(0, 80)}".`,
          severity: "error",
        });
      } else if (!input.allowedSources.has(source)) {
        issues.push({
          code: "unknown_source",
          message: `Source "${source.slice(0, 120)}" is not in the research brief, signals or knowledge base.`,
          severity: "error",
        });
      }
    }
  }
  if (input.signalsUsed && input.allowedSignalIds) {
    for (const id of input.signalsUsed) {
      if (!input.allowedSignalIds.has(id)) {
        issues.push({
          code: "unknown_signal",
          message: `Signal ${id} was not provided for this lead.`,
          severity: "error",
        });
      }
    }
  }
  return issues;
}

export function hasErrors(issues: readonly CheckIssue[]): boolean {
  return issues.some((issue) => issue.severity === "error");
}
