/**
 * Realistic sandbox answers for the inbox prompts: inbox.reply.classify, inbox.reply.draft,
 * inbox.reply.check.
 *
 * Note on inbox.reply.classify: `classifyInboundMessage` (src/modules/inbox/classify.ts) runs a
 * deterministic precheck first (src/modules/inbox/prechecks.ts) that decides bounce and most
 * unsubscribe replies, and forces `suspicious: true` whenever its own injection patterns match,
 * regardless of what this answer returns. This answer only has to get it right for the replies
 * that reach the brain: everything except clear bounces and the most direct "unsubscribe me"
 * wording.
 */

import type {
  CheckOutput as ReplyCheckOutput,
  CheckVars as ReplyCheckVars,
} from "../../modules/inbox/prompts/check.js";
import type { ClassifyOutput, ClassifyVars } from "../../modules/inbox/prompts/classify.js";
import type { DraftOutput, DraftVars } from "../../modules/inbox/prompts/draft.js";
import { firstIsoDate } from "./text.js";

const EM_DASH = String.fromCharCode(0x2014);

type Category = ClassifyOutput["category"];
type PrivacyKind = NonNullable<ClassifyOutput["privacy_kind"]>;

interface CategoryGuess {
  category: Category;
  sentiment: ClassifyOutput["sentiment"];
  confidence: number;
  summary: string;
}

const INJECTION_PATTERN =
  /ignore\s+(all\s+)?previous\s+instructions|disregard\s+(all\s+)?(previous|prior)\s+instructions|system prompt|reveal (your |the )?(instructions|prompt)|send (me|us)\b[^.\n]{0,30}\b(lead|contact|customer|prospect)s?\s*(list|data|database)|api keys?/i;
const OUT_OF_OFFICE_PATTERN =
  /out of (the )?office|\booo\b|automatic reply|auto-reply|away from (my desk|the office)|abwesen|nicht im büro/i;
const PRIVACY_DELETE_PATTERN =
  /\b(delete|erase|remove|wipe)\b[^.?!\n]{0,40}\b(my|our|all) (personal )?(data|details|information|info)\b|\berase\b|\berasure\b|\bl(ö|oe)schen sie meine daten\b/i;
const PRIVACY_ACCESS_PATTERN =
  /\bwhat (personal )?(data|information|info|details) (do )?you (have|hold|store|keep)\b|\b(subject )?access request\b|\bcopy of (my|the) (personal )?(data|information)\b/i;
const PRIVACY_SOURCE_PATTERN =
  /\bwhere (did|do) you (get|find|obtain|source) (my|this|our) (e-?mail|email address|details|address|contact details|contact|number|data|information)\b|\bwoher haben sie meine\b/i;
const GDPR_PATTERN = /\b(gdpr|dsgvo)\b/i;
const UNSUBSCRIBE_PATTERN =
  /remove me from|unsubscribe|opt.?out|take me off|do not email me again|don't email me again|entfernen sie mich|bitte austragen/i;
const NEGATIVE_PATTERN =
  /not interested|stop emailing|stop contacting|unacceptable|third .{0,20}email|furious|this is spam|legal action|kein interesse|nicht akzeptabel/i;
const OBJECTION_PATTERN =
  /already (have|use|using|running)|similar (solution|system|tool|product)|no budget|too expensive|not a priority|send (me |us )?(info|information)\b|bereits (eine )?ähnliche|im einsatz/i;
const REFERRAL_PATTERN =
  /not (really )?my area|wrong person|talk to (our|my|the) [a-z][a-z ]{1,30}|forward (this|it) along|wenden sie sich an/i;
const NOT_NOW_PATTERN =
  /timing is not right|not (the )?right time|check back in|in a few months|reconnect (later|in)|zeitpunkt passt/i;
const QUESTION_INDICATOR =
  /\bhow does\b|\bhow do\b|\bwhat is\b|\bwhat are\b|\bdoes (this|it)\b|\bis there\b|\bcan you\b|\bcould you\b|\bhow much\b|\bpricing\b|\bwie funktioniert\b/i;
const INTERESTED_PATTERN =
  /would like to learn more|sounds interesting|this looks relevant|interested in learning|klingt interessant|sounds good/i;
const ASKS_IF_BOT_PATTERN =
  /\b(are|is) (you|this|that) (an? )?(bot|ai|robot|automated|real person|human)\b|\bam i (talking|speaking|writing) (to|with)\b/i;
const GERMAN_HINT = /\b(bitte|nicht|sie|und|ich|möchte|wäre|zeitpunkt|kontaktieren)\b/i;

/** What a privacy request asks for, or null when the text is not one. */
export function privacyKindOf(text: string): PrivacyKind | null {
  if (PRIVACY_DELETE_PATTERN.test(text)) return "delete";
  if (PRIVACY_ACCESS_PATTERN.test(text)) return "access";
  if (PRIVACY_SOURCE_PATTERN.test(text)) return "source";
  // A bare GDPR mention in a reply to cold email is almost always about erasure.
  if (GDPR_PATTERN.test(text)) return "delete";
  return null;
}

const WEEKDAY = "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow)";
const MONTH =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const DAY_OF_MONTH = "\\d{1,2}(?:st|nd|rd|th)?";
const CALENDAR_DATE = `(?:${MONTH}\\s+${DAY_OF_MONTH}|${DAY_OF_MONTH}\\s+${MONTH}|\\d{4}-\\d{2}-\\d{2})`;
const CLOCK_TIME = "(?:\\d{1,2}(?::\\d{2})?\\s?(?:am|pm)|\\d{1,2}:\\d{2})";
/** A weekday or a date, then a time within a few words: "Tuesday at 3pm", "Oct 8, 10:00". */
const PROPOSED_TIME_PATTERN = new RegExp(
  `\\b(?:${WEEKDAY}|${CALENDAR_DATE})\\b[^.?!\\n]{0,20}?\\b${CLOCK_TIME}(?![\\w:])`,
  "i",
);

/** The proposed time as written, e.g. "Tuesday at 3pm", or null. */
export function proposedTimeText(text: string): string | null {
  return PROPOSED_TIME_PATTERN.exec(text)?.[0].trim() ?? null;
}

function guessCategory(text: string): CategoryGuess {
  if (INJECTION_PATTERN.test(text)) {
    return {
      category: "other",
      sentiment: "neutral",
      confidence: 0.5,
      summary: "The reply tries to direct an AI system rather than answer the outreach.",
    };
  }
  if (OUT_OF_OFFICE_PATTERN.test(text)) {
    return {
      category: "out_of_office",
      sentiment: "neutral",
      confidence: 0.95,
      summary: "Automatic out-of-office notice.",
    };
  }
  if (privacyKindOf(text)) {
    return {
      category: "privacy_request",
      sentiment: "negative",
      confidence: 0.9,
      summary: "Asked about or for the removal of their personal data.",
    };
  }
  if (UNSUBSCRIBE_PATTERN.test(text)) {
    return {
      category: "unsubscribe",
      sentiment: "negative",
      confidence: 0.9,
      summary: "Asked to stop being contacted.",
    };
  }
  if (NEGATIVE_PATTERN.test(text)) {
    return {
      category: "negative",
      sentiment: "negative",
      confidence: 0.85,
      summary: "Reacted negatively to the outreach.",
    };
  }
  if (OBJECTION_PATTERN.test(text)) {
    return {
      category: "objection",
      sentiment: "neutral",
      confidence: 0.8,
      summary: "Says an existing solution or constraint rules this out for now.",
    };
  }
  if (REFERRAL_PATTERN.test(text)) {
    return {
      category: "referral",
      sentiment: "positive",
      confidence: 0.8,
      summary: "Points to a different, more relevant contact.",
    };
  }
  if (NOT_NOW_PATTERN.test(text)) {
    return {
      category: "not_now",
      sentiment: "neutral",
      confidence: 0.8,
      summary: "Says the timing is not right and asks to reconnect later.",
    };
  }
  if (text.includes("?") && QUESTION_INDICATOR.test(text)) {
    return {
      category: "question",
      sentiment: "neutral",
      confidence: 0.75,
      summary: "Asks a direct question about the offer before going further.",
    };
  }
  if (INTERESTED_PATTERN.test(text)) {
    return {
      category: "interested",
      sentiment: "positive",
      confidence: 0.75,
      summary: "Shows genuine interest and asks to continue the conversation.",
    };
  }
  return {
    category: "other",
    sentiment: "neutral",
    confidence: 0.3,
    summary: "Reply received; intent is not clear from the text alone.",
  };
}

function extractQuestion(reply: string): string | null {
  const sentence = reply.split(/(?<=[.?!])\s+/).find((part) => part.includes("?"));
  return sentence?.trim() || null;
}

function extractReferralTitle(reply: string): string | null {
  const match = /talk to (?:our|my|the) ([a-z][a-z ]{1,30}?)(?:\s+instead|,|\.|$)/i.exec(reply);
  return match?.[1]?.trim() || null;
}

/** Builds the `inbox.reply.classify` output from the reply text (see module note above). */
export function buildClassifyAnswer(vars: ClassifyVars, _call: unknown): ClassifyOutput {
  const reply = vars.reply ?? "";
  const combined = `${vars.subject ?? ""} ${reply}`;
  const guess = guessCategory(combined);
  const category =
    vars.automated && guess.category === "unsubscribe" ? "auto_reply_other" : guess.category;
  const isGerman = GERMAN_HINT.test(reply);
  const proposed = category === "out_of_office" ? null : proposedTimeText(reply);

  return {
    category,
    confidence: guess.confidence,
    sentiment: guess.sentiment,
    summary: guess.summary,
    language: isGerman ? "de" : "en",
    return_date: category === "out_of_office" ? firstIsoDate(reply) : null,
    follow_up_date: null,
    referral:
      category === "referral"
        ? { name: null, email: null, title: extractReferralTitle(reply) }
        : null,
    question: category === "question" ? extractQuestion(reply) : null,
    left_company: false,
    asks_if_bot: ASKS_IF_BOT_PATTERN.test(combined),
    suspicious: INJECTION_PATTERN.test(combined),
    proposed_time: proposed ? { text: proposed, start: null, timezone: null } : null,
    privacy_kind: category === "privacy_request" ? privacyKindOf(combined) : null,
    facts: [],
    company_hold: null,
  };
}

const NEEDS_HUMAN_CATEGORIES = new Set(["negative", "other", "wrong_person"]);

const DRAFT_BODIES: Record<string, (bookingUrl: string | null) => string> = {
  interested: (url) =>
    url
      ? `Great to hear. Feel free to grab a time that works here: ${url}`
      : "Great to hear, what does your week look like for a short call?",
  meeting_request: (url) =>
    url
      ? `Happy to find a time, here is my calendar: ${url}`
      : "Happy to find a time, what works best on your end?",
  question: (url) =>
    url
      ? `Good question, happy to walk through it live if useful: ${url}`
      : "Good question, happy to walk through the details, does a short call work?",
  objection: () =>
    "Totally fair, and no pressure either way. Happy to send one relevant detail if that helps you decide.",
  not_now: () => "No problem at all, I will follow up again further down the line.",
  referral: () => "Appreciate you pointing me the right way, I will reach out there instead.",
  wrong_person: () => "Thanks for letting me know, I will find the right contact instead.",
  out_of_office: () => "Thanks for the note, I will follow up once you are back.",
  unsubscribe: () => "Understood, you will not hear from us again.",
  privacy_request: () => "Understood, a colleague will follow up on your data request personally.",
  bounce: () => "Noted, I will update this address on our side.",
  negative: () => "Sorry to hear that, I will make sure this gets handled properly.",
  auto_reply_other: () => "Thanks for the note, following up at a better time.",
  other: () => "Thanks for getting back to me, happy to help however is useful.",
};

/** Bodies for booking mode off: no links and no meeting offers. */
const NO_MEETING_BODIES: Record<string, string> = {
  interested: "Great to hear. Happy to share more details, what would be most useful to you?",
  meeting_request: "Thanks for getting back to me, a colleague will follow up with you personally.",
  question: "Good question, happy to walk you through the details here by email.",
};

/**
 * The draft body. Like the real prompt (schedulingInstruction), it never accepts or confirms a
 * meeting time: with a proposed time it points to the booking link (link mode) or says a time
 * will be confirmed (a person books); in off mode it offers no meeting at all.
 */
function draftBody(vars: DraftVars): string {
  const url = vars.bookingMode === "link" ? vars.bookingUrl : null;
  const scheduling = vars.category === "meeting_request" || Boolean(vars.proposedTime);
  if (vars.bookingMode === "off") {
    const body = NO_MEETING_BODIES[vars.category];
    if (body) return body;
  } else if (vars.proposedTime && url) {
    return `That time could work. Please grab it here so it lands on both calendars: ${url}`;
  } else if (scheduling && !url) {
    return vars.proposedTime
      ? "Thanks for suggesting a time. I will confirm a time with you shortly."
      : "Happy to find a time, I will confirm one with you shortly.";
  }
  const bodyBuilder = DRAFT_BODIES[vars.category] ?? DRAFT_BODIES.other;
  return bodyBuilder?.(url) ?? "Thanks for getting back to me.";
}

/** Builds the `inbox.reply.draft` output: a short, generic reply with no invented facts. */
export function buildDraftAnswer(vars: DraftVars, _call: unknown): DraftOutput {
  const lastFromThem = [...vars.thread].reverse().find((turn) => turn.from === "them");
  const theirText = (lastFromThem?.text ?? "").toLowerCase();
  const asksIfBot = ASKS_IF_BOT_PATTERN.test(theirText);
  const body = draftBody(vars);
  const needsHuman = asksIfBot || NEEDS_HUMAN_CATEGORIES.has(vars.category);

  return {
    subject: null,
    body,
    used_fact_ids: [],
    needs_human: needsHuman,
    needs_human_reason: asksIfBot
      ? "Prospect asked whether a bot or an AI is writing."
      : needsHuman
        ? "Reply needs a human tone or judgment call."
        : null,
  };
}

/** Wording that accepts or confirms a meeting time (only a person or the booking link may). */
const CONFIRMS_TIME_PATTERN =
  /\b(see you (then|on|at|there)|(it|that|this)( time)? works for (me|us)|(you are|you're|we are|we're) (all )?(set|booked|confirmed)|confirmed for|locked (it )?in|invite is on its way)\b/i;

/** Builds the `inbox.reply.check` output: passes unless the draft breaks an obvious rule. */
export function buildReplyCheckAnswer(vars: ReplyCheckVars, _call: unknown): ReplyCheckOutput {
  const issues: Array<{ code: string; message: string }> = [];
  if (!vars.body.trim()) issues.push({ code: "empty", message: "The reply is empty." });
  if (CONFIRMS_TIME_PATTERN.test(vars.body)) {
    issues.push({
      code: "confirms_time",
      message:
        "The reply confirms a meeting time; offer the booking link or say a time will be confirmed.",
    });
  }
  if (vars.body.includes(EM_DASH)) {
    issues.push({ code: "long_dash", message: "Replace the long dash with a comma or period." });
  }
  if (vars.body.includes("!"))
    issues.push({ code: "exclamation", message: "Remove exclamation marks." });
  return issues.length === 0
    ? { verdict: "pass", confidence: 0.9, issues: [] }
    : { verdict: "revise", confidence: 0.5, issues };
}
