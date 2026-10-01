/**
 * Deterministic checks on inbound replies, run before (and next to) the model:
 * privacy requests, unsubscribe keywords and delivery failures decide without a model,
 * auto-reply headers constrain the model (privacy wording still counts with them: protective),
 * and prompt-injection and human-only cues route replies to a human. Everything here reads
 * untrusted text and only returns codes.
 */
import type { PrivacyKind } from "../../core/enums.js";
import { detectPrivacyRequest } from "./privacy-phrases.js";

export interface PrecheckInput {
  subject: string | null;
  text: string;
  headers: Record<string, string> | null;
  from: string | null;
}

export interface PrecheckResult {
  /** Decided without a model (confidence 1). */
  category: "unsubscribe" | "privacy_request" | "bounce" | null;
  /** What a privacy request asks (set only with category `privacy_request`). */
  privacyKind: PrivacyKind | null;
  /** Automatic mail (auto-reply headers or subject). */
  automated: boolean;
  reasons: string[];
}

function header(headers: Record<string, string> | null, name: string): string | null {
  if (!headers) return null;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return String(value);
  }
  return null;
}

const QUOTE_MARKERS = [
  /^On .{1,200}wrote:\s*$/m,
  /^Am .{1,200}schrieb.{0,100}:\s*$/m,
  /^Le .{1,200}a écrit\s*:\s*$/m,
  /^El .{1,200}escribió\s*:\s*$/m,
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^-{2,}\s*Ursprüngliche Nachricht\s*-{2,}/im,
  /^From:\s.+\r?\n(Sent|Date):\s/im,
  /^Von:\s.+\r?\n(Gesendet|Datum):\s/im,
];

/** The reply's own text: quoted history (">" lines and "On ... wrote:" blocks) removed. */
export function stripQuotedText(text: string): string {
  let cut = text.length;
  for (const marker of QUOTE_MARKERS) {
    const match = marker.exec(text);
    if (match && match.index < cut) cut = match.index;
  }
  return text
    .slice(0, cut)
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n")
    .trim();
}

const UNSUBSCRIBE_PHRASES = [
  /\bunsubscribe me\b/,
  /\bplease unsubscribe\b/,
  /\bremove me from (your|this|the|all)( \w+)? (list|lists|mailing list|emails?|database)\b/,
  /\btake me off (your|this|the|all)( \w+)? (list|lists|mailing list|emails?)\b/,
  /\b(stop|quit) (emailing|e-mailing|mailing|contacting|messaging|spamming|sending me) ?(me)?\b/,
  /\b(do not|don't|dont|never) (email|e-mail|contact|message|write to) me\b/,
  /\bopt me out\b/,
  /\bno more emails\b/,
  /\bnicht mehr (kontaktieren|anschreiben)\b/,
  /\bbitte (abmelden|austragen)\b/,
];

const SHORT_UNSUBSCRIBE =
  /^(unsubscribe|stop|remove|remove me|opt out|optout|opt-out|unsubscribe please|please remove me|abmelden|austragen)$/;

/** True when the reply's own text asks to stop contact. Conservative on purpose (locked rule). */
export function isUnsubscribeRequest(ownText: string): boolean {
  const normalized = ownText.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();
  const bare = normalized.replace(/[^a-z' -]/g, "").trim();
  if (SHORT_UNSUBSCRIBE.test(bare)) return true;
  if (
    /\b(don't|dont|do not|not|never)\s+(please\s+)?(unsubscribe|remove|take me off)\b/.test(bare)
  ) {
    return false;
  }
  const words = bare.split(" ").filter(Boolean).length;
  if (words <= 8 && /\bunsubscribe\b/.test(bare) && !/\b(not|don't|dont)\b/.test(bare)) return true;
  return UNSUBSCRIBE_PHRASES.some((pattern) => pattern.test(normalized));
}

const BOUNCE_SUBJECT =
  /(undeliver(able|ed)|delivery status notification \(failure\)|mail delivery (failed|failure|subsystem)|returned mail|failure notice|delivery has failed|message not delivered|nicht zustellbar|unzustellbar)/i;
const AUTO_REPLY_SUBJECT =
  /^\s*(automatic reply|auto(matic)?[- ]?(reply|response)|autoreply|out of (the )?office|ooo\b|abwesenheit|abwesenheitsnotiz|automatische antwort|r[ée]ponse automatique|absence|respuesta autom[áa]tica|fuera de la oficina|risposta automatica|afwezig)/i;

/** Automatic mail: auto-reply headers (Auto-Submitted, X-Autoreply, Precedence) or subject. */
export function hasAutoReplyHeaders(input: Pick<PrecheckInput, "subject" | "headers">): boolean {
  const autoSubmitted = header(input.headers, "auto-submitted");
  const precedence = (header(input.headers, "precedence") ?? "").toLowerCase();
  return (
    (autoSubmitted !== null && autoSubmitted.trim().toLowerCase() !== "no") ||
    header(input.headers, "x-autoreply") !== null ||
    header(input.headers, "x-autorespond") !== null ||
    ["auto_reply", "auto-reply", "junk"].includes(precedence) ||
    AUTO_REPLY_SUBJECT.test(input.subject ?? "")
  );
}

/** Deterministic pre-classification of an inbound email or message. */
export function precheckReply(input: PrecheckInput): PrecheckResult {
  const reasons: string[] = [];
  const subject = input.subject ?? "";
  const from = (input.from ?? "").toLowerCase();
  const contentType = (header(input.headers, "content-type") ?? "").toLowerCase();

  const isDsn =
    /(^|<|\s)(mailer-daemon|postmaster)@/.test(from) ||
    (contentType.includes("multipart/report") && contentType.includes("delivery-status")) ||
    BOUNCE_SUBJECT.test(subject);
  if (isDsn) {
    reasons.push("delivery_status_notification");
    return { category: "bounce", privacyKind: null, automated: true, reasons };
  }

  const automated = hasAutoReplyHeaders(input);
  if (automated) reasons.push("auto_reply_headers");

  const ownText = stripQuotedText(input.text);
  // Before unsubscribe: "unsubscribe me and delete my data" is a privacy request, and the
  // privacy action includes everything an unsubscribe does. Privacy wording counts with
  // auto-reply headers too (protective): the privacy problem then asks a person to check who
  // wrote it. A plain auto-reply is never an unsubscribe.
  const privacyKind = detectPrivacyRequest(ownText);
  if (privacyKind) {
    reasons.push("privacy_keywords");
    return { category: "privacy_request", privacyKind, automated, reasons };
  }
  if (!automated && isUnsubscribeRequest(ownText)) {
    reasons.push("unsubscribe_keywords");
    return { category: "unsubscribe", privacyKind: null, automated: false, reasons };
  }
  return { category: null, privacyKind: null, automated, reasons };
}

const INJECTION_PATTERNS: Array<[code: string, pattern: RegExp]> = [
  [
    "ignore_instructions",
    /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|your|the|any|system)\b[^.\n]{0,20}\b(instructions?|prompts?|rules|directions|guidelines|context)\b/i,
  ],
  [
    "system_prompt",
    /\b(system prompt|system message|developer message|jailbreak|prompt injection|new instructions)\b/i,
  ],
  [
    "addresses_ai",
    /\b(dear|hey|hi|hello|attention|note to|instructions? (to|for)) (the )?(ai|assistant|bot|llm|language model|chatgpt|gpt|claude|agent)\b/i,
  ],
  [
    "role_marker",
    /(^|\n)\s*(system|assistant|developer)\s*:|<\/?(system|instructions?)>|\[INST\]|<\|im_start\|>/i,
  ],
  [
    "data_exfiltration",
    /\b(send|forward|export|share|give|email|dump|leak)\s+(me|us)\b[^.\n]{0,30}\b(lead|contact|customer|prospect|client|email|user)s?\s*(list|lists|database|data|export|addresses)\b/i,
  ],
  [
    "reveal_secrets",
    /\b(reveal|show|print|output|repeat|tell me)\b[^.\n]{0,30}\b(your|the)\s+(instructions|prompt|system prompt|configuration|settings|api keys?|passwords?|credentials|secrets?)\b/i,
  ],
  [
    "tool_manipulation",
    /\b((call|use|run|execute|invoke) (the |a |your )?(tool|function|command|api)|(mark|set|change|update) (this|the|my) (lead|thread|status|contact|deal|opportunity)|(delete|wipe|erase|drop) (all|every|the entire|your) (leads|contacts|database|tables?))\b/i,
  ],
];

/** Codes for text that tries to instruct an AI (prompt injection). Empty = none found. */
export function detectInjection(text: string): string[] {
  const found: string[] = [];
  for (const [code, pattern] of INJECTION_PATTERNS) {
    if (pattern.test(text)) found.push(code);
  }
  return found;
}

const REVIEW_PATTERNS: Array<[code: string, pattern: RegExp]> = [
  [
    "asks_if_bot",
    /\b(are|is) (you|this|that) (an? )?(bot|ai|robot|automated|machine|real person|human)\b|\bam i (talking|speaking|writing) (to|with) (an? )?(bot|ai|robot|human|real person)\b/i,
  ],
  [
    "legal",
    /\b(lawyer|attorney|legal action|lawsuit|sue you|court|cease and desist|abmahnung|anwalt|data protection authority|supervisory authority|ico complaint|report you)\b/i,
  ],
  [
    "data_request",
    /\b(where did you get my (email|e-mail|data|details|address|number)|delete my (data|details|information)|right to erasure|data subject|subject access|gdpr request|dsgvo|woher haben sie meine)\b/i,
  ],
  ["security_review", /\b(security questionnaire|soc ?2|iso ?27001|penetration test|dpa\b)/i],
  ["press", /\b(journalist|reporter|press inquiry|for an article|media inquiry)\b/i],
];

/** Codes for topics that always need a human answer, whatever the category (replies playbook). */
export function detectReviewReasons(text: string): string[] {
  const found: string[] = [];
  for (const [code, pattern] of REVIEW_PATTERNS) {
    if (pattern.test(text)) found.push(code);
  }
  return found;
}

/** Bare lowercase address from a From value like `Dana Reyes <dana@example.com>`. */
export function bareAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(value);
  const candidate = (angle?.[1] ?? value).trim().toLowerCase();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(candidate) ? candidate : null;
}
