/**
 * Realistic sandbox answers for the campaign writing prompts (campaign.email.write,
 * campaign.linkedin.write, campaign.email.fill_slots, campaign.email.check, campaign.teach).
 *
 * Each builder is a small pure function of the prompt vars: no invented facts or numbers, no
 * em dash, subjects and bodies sized to stay inside the deterministic checks
 * (src/modules/campaigns/writing/checks.ts) that run on every draft regardless of what the
 * brain answers. `facts_used` is always empty (we have no reliable way to know which source
 * strings the real pipeline will accept as valid at answer-build time); `signals_used` is
 * populated only with ids parsed straight out of the rendered signals block, so it is always a
 * subset of the caller's own `allowedSignalIds`.
 */

import type {
  CheckOutput,
  CheckVars,
  FillSlotsOutput,
  FillSlotsVars,
  TeachOutput,
  TeachVars,
  WriteEmailOutput,
  WriteLinkedInOutput,
  WritingVars,
} from "../../modules/campaigns/writing/prompts.js";
import type { FakeBrainCall } from "../../providers/brain/fake.js";
import {
  countWords,
  fitWords,
  parseProspect,
  parseSignals,
  pickOne,
  signalPhrase,
} from "./text.js";

const FIRST_TOUCH_MIN_WORDS = 35;

function keyFor(vars: WritingVars, call: FakeBrainCall, tag: string): string {
  return `${call.promptId}:${tag}:${vars.prospect}:${vars.kind}:${vars.mode}`;
}

// ---------------------------------------------------------------------------
// campaign.email.write
// ---------------------------------------------------------------------------

const SUBJECT_TEMPLATES_EN: ReadonlyArray<(company: string) => string> = [
  (c) => `quick question for ${c}`,
  (c) => `an idea for ${c}`,
  (_c) => `worth a look`,
  (c) => `one thing for ${c}`,
  (_c) => `quick idea`,
];

const SUBJECT_TEMPLATES_DE: ReadonlyArray<(company: string) => string> = [
  (c) => `kurze Frage zu ${c}`,
  (c) => `eine Idee für ${c}`,
  (_c) => `kurze Idee`,
];

const OPENERS_WITH_SIGNAL_EN: readonly string[] = ["I noticed", "I saw that", "It looks like"];

const OPENERS_NO_SIGNAL_EN: readonly string[] = [
  "I have been looking at",
  "I have been talking with",
  "I keep an eye on",
];

const HOOKS_EN: readonly string[] = [
  "Teams in that spot often end up patching this together by hand, which gets expensive fast. A lot of what we do is designed to close that gap without adding headcount.",
  "That usually means someone on the team is stitching this together manually, and it does not scale well. Most of our work is built to close exactly that gap without new hires.",
  "That is often the point where manual workarounds start costing real time every week. We built our product around closing that kind of gap without adding headcount.",
];

const CTAS_EN: ReadonlyArray<(company: string) => string> = [
  (c) => `Worth a quick look at whether that fits ${c} too?`,
  (c) => `Is that worth a short look for ${c}?`,
  (c) => `Open to a quick look at whether this fits ${c}?`,
];

const FOLLOW_UPS_EN: ReadonlyArray<(company: string) => string> = [
  (c) =>
    `Wanted to make sure this reached you. Is ${c} looking at this kind of thing this quarter?`,
  (c) => `No worries if the timing is off. Still worth a short look for ${c}?`,
  (c) => `One more note before I close this out. Any interest from ${c}'s side?`,
  (c) => `Happy to send more detail if useful. Is this worth a look for ${c} right now?`,
];

function buildFirstTouchBodyEn(key: string, companyShort: string, phrase: string | null): string {
  // Signal phrases are -ing forms ("adopting new tools"), so they follow "has been".
  const opener = phrase
    ? `${pickOne(`${key}:opener`, OPENERS_WITH_SIGNAL_EN)} ${companyShort} has been ${phrase} recently, which is usually a sign priorities are shifting.`
    : `${pickOne(`${key}:opener`, OPENERS_NO_SIGNAL_EN)} teams like ${companyShort} and wanted to share something relevant.`;
  const hook = pickOne(`${key}:hook`, HOOKS_EN);
  const cta = pickOne(`${key}:cta`, CTAS_EN)(companyShort);
  return `${opener} ${hook} ${cta}`;
}

function buildFollowUpBodyEn(key: string, companyShort: string): string {
  return pickOne(`${key}:followup`, FOLLOW_UPS_EN)(companyShort);
}

function buildFirstTouchBodyDe(companyShort: string): string {
  return `Mir ist aufgefallen, dass bei ${companyShort} gerade einiges in Bewegung ist. Solche Phasen bedeuten oft, dass Prozesse manuell zusammengehalten werden, und genau da setzen wir an, ohne dass neue Stellen nötig sind. Lohnt sich ein kurzer Blick, ob das zu ${companyShort} passt?`;
}

function buildFollowUpBodyDe(companyShort: string): string {
  return `Kurzer Nachtrag, falls das untergegangen ist. Ist das für ${companyShort} aktuell ein Thema?`;
}

/** Builds the `campaign.email.write` output from the writing vars. */
export function buildWriteEmailAnswer(vars: WritingVars, call: FakeBrainCall): WriteEmailOutput {
  const prospect = parseProspect(vars.prospect);
  const signals = parseSignals(vars.signals);
  const key = keyFor(vars, call, "email");
  const isGerman = vars.language.toLowerCase().startsWith("de");
  const maxWords = vars.max_words ?? (vars.first_touch ? 90 : 40);
  const signal = signals[0] ?? null;
  const greeting = isGerman ? `Hallo ${prospect.firstName},` : `Hi ${prospect.firstName},`;

  let core: string;
  if (isGerman) {
    core = vars.first_touch
      ? buildFirstTouchBodyDe(prospect.companyShort)
      : buildFollowUpBodyDe(prospect.companyShort);
  } else if (vars.first_touch) {
    core = buildFirstTouchBodyEn(
      key,
      prospect.companyShort,
      signal ? signalPhrase(signal.type) : null,
    );
  } else {
    core = buildFollowUpBodyEn(key, prospect.companyShort);
  }
  let body = `${greeting}\n\n${core}`;
  if (vars.first_touch && countWords(body) > maxWords) {
    // Drop the hook's second sentence before falling back further.
    const shortHook = pickOne(`${key}:hook`, HOOKS_EN).split(". ")[0];
    core = `${core.split(". ")[0]}. ${shortHook}. ${pickOne(`${key}:cta`, CTAS_EN)(prospect.companyShort)}`;
    body = `${greeting}\n\n${core}`;
  }
  if (vars.first_touch && countWords(body) < FIRST_TOUCH_MIN_WORDS) {
    body = `${body} We keep it practical and skip the sales talk.`;
  }
  body = fitWords(body, vars.max_words);

  const subjectTemplate = pickOne(
    `${key}:subject`,
    isGerman ? SUBJECT_TEMPLATES_DE : SUBJECT_TEMPLATES_EN,
  );
  const subject = subjectTemplate(prospect.companyShort);

  return {
    subject,
    body,
    angle: vars.first_touch
      ? `Lead with ${signal ? `the signal (${signalPhrase(signal.type)})` : "a relevant reason to reach out"} and one clear question.`
      : "Short, friendly nudge with one clear question.",
    signals_used: signal ? [signal.id] : [],
    facts_used: [],
  };
}

// ---------------------------------------------------------------------------
// campaign.linkedin.write
// ---------------------------------------------------------------------------

const INVITE_TEMPLATES_EN: ReadonlyArray<(company: string, title: string | null) => string> = [
  (c) => `Good to connect, always like broadening the network with people at ${c}.`,
  () => "Noticed we are both active in similar circles, thought it made sense to connect directly.",
  (_c, t) => `Always glad to connect with people in ${t ?? "similar roles"}, hence the invite.`,
];

const MESSAGE_TEMPLATES_EN: ReadonlyArray<(company: string, phrase: string | null) => string> = [
  (c, p) =>
    `Thanks for connecting. ${p ? `Saw that ${c} has been ${p}, which` : `What ${c} is working on`} caught my eye. Different angle from email: is this something your team is actively weighing right now?`,
  (c, p) =>
    `Appreciate the connection. ${p ? `Seeing ${c} ${p}` : `The work at ${c}`} stood out to me, for reasons a bit different from what I emailed about. Worth a short thought whenever you have a minute?`,
];

const COMMENT_TEMPLATES_EN: readonly string[] = [
  "Good post. This kind of shift is easy to overlook until it becomes a real bottleneck. Appreciate you sharing it, a useful reminder for anyone paying attention to this space right now.",
  "This matches what a lot of teams seem to be running into lately. Thanks for putting it into words, it is the kind of detail that gets missed until it costs real time.",
];

const INVITE_TEMPLATE_DE = "Freue mich zu vernetzen, spannend zu sehen, woran Sie gerade arbeiten.";
const MESSAGE_TEMPLATE_DE =
  "Danke für die Vernetzung. Das war eine andere Perspektive als in meiner E-Mail, passt das gerade zu Ihren Themen?";
const COMMENT_TEMPLATE_DE =
  "Guter Beitrag. Genau solche Details gehen im Alltag oft unter, bis sie an anderer Stelle Zeit kosten. Danke fürs Teilen, eine hilfreiche Erinnerung für alle, die gerade auf dieses Thema achten.";

/** Builds the `campaign.linkedin.write` output from the writing vars. */
export function buildWriteLinkedInAnswer(
  vars: WritingVars,
  call: FakeBrainCall,
): WriteLinkedInOutput {
  const prospect = parseProspect(vars.prospect);
  const signals = parseSignals(vars.signals);
  const key = keyFor(vars, call, "linkedin");
  const isGerman = vars.language.toLowerCase().startsWith("de");
  const signal = signals[0] ?? null;

  let text: string;
  if (vars.kind === "invite_note") {
    text = isGerman
      ? INVITE_TEMPLATE_DE
      : pickOne(`${key}:invite`, INVITE_TEMPLATES_EN)(prospect.companyShort, prospect.title);
  } else if (vars.kind === "comment") {
    text = isGerman ? COMMENT_TEMPLATE_DE : pickOne(`${key}:comment`, COMMENT_TEMPLATES_EN);
  } else {
    text = isGerman
      ? MESSAGE_TEMPLATE_DE
      : pickOne(`${key}:message`, MESSAGE_TEMPLATES_EN)(
          prospect.companyShort,
          signal ? signalPhrase(signal.type) : null,
        );
  }
  if (vars.kind === "invite_note") text = text.slice(0, 200);

  return {
    text,
    angle:
      vars.kind === "comment"
        ? "Neutral, on-topic acknowledgement with no pitch."
        : vars.kind === "invite_note"
          ? "Natural, low-key reason to connect."
          : "One useful point with a different angle than the emails, plus one easy question.",
    signals_used: vars.kind === "message" && signal ? [signal.id] : [],
    facts_used: [],
  };
}

// ---------------------------------------------------------------------------
// campaign.email.fill_slots
// ---------------------------------------------------------------------------

const VERB_REWRITES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^reference\s+/i, "worth noting: "],
  [/^introduce\s+/i, "one thing that might help: "],
  [/^offer\s+/i, "happy to include "],
  [/^mention\s+/i, "worth mentioning: "],
  [/^highlight\s+/i, "worth highlighting: "],
  [/^call out\s+/i, "worth calling out: "],
  [/^note\s+/i, "worth noting: "],
  [/^explain\s+/i, "in short, "],
  [/^ask\s+/i, "curious about "],
];

function rewriteClause(clause: string): string {
  const trimmed = clause.trim();
  for (const [pattern, replacement] of VERB_REWRITES) {
    if (pattern.test(trimmed)) return `${replacement}${trimmed.replace(pattern, "")}`;
  }
  return trimmed;
}

function capitalize(sentence: string): string {
  return sentence.length > 0 ? sentence[0]?.toUpperCase() + sentence.slice(1) : sentence;
}

/** The text before, and (when found) the text strictly after, the first match of `pattern`. */
function splitFirst(text: string, pattern: RegExp): [string, string | null] {
  const match = pattern.exec(text);
  if (!match) return [text, null];
  return [text.slice(0, match.index), text.slice(match.index + match[0].length)];
}

/**
 * Turns a template slot's instruction (already resolved: `{{company}}` etc. are substituted
 * before slots are extracted) into 1-2 short, safe sentences. The instruction text is the only
 * source of content, so restating it cannot invent facts; a trailing meta clause about length
 * ("two short sentences", "under 200 characters") is stripped rather than echoed. Only the
 * first " and " is treated as a clause boundary, so a later one ("stockouts and overstock")
 * stays inside its own clause instead of being cut in two.
 */
function fillSlotText(instruction: string): string {
  const sentenceCount = /\btwo\b[^.]{0,20}sentences?/i.test(instruction) ? 2 : 1;
  const cleaned = instruction
    .replace(/\bunder\s+\d+\s*characters?\.?/gi, "")
    .replace(/\b(in\s+)?(one|two|three)\s+short\s+sentences?\.?/gi, "")
    .replace(/\.\s*$/, "")
    .trim();
  if (!cleaned) return "Happy to share more detail here if it is useful.";
  const [first, second] =
    sentenceCount >= 2 ? splitFirst(cleaned, /\s+and\s+(?=[a-z])/i) : [cleaned, null];
  const clauses = [first, second]
    .filter((clause): clause is string => Boolean(clause?.trim()))
    .map((clause) => clause.trim().replace(/[,;]+$/, ""));
  return clauses.map((clause) => `${capitalize(rewriteClause(clause))}.`).join(" ");
}

/** Builds the `campaign.email.fill_slots` output from the fill-slots vars. */
export function buildFillSlotsAnswer(vars: FillSlotsVars, _call: FakeBrainCall): FillSlotsOutput {
  const signals = parseSignals(vars.signals);
  const signal = signals[0] ?? null;
  const texts = vars.slots.map((slot) => fillSlotText(slot.instruction));
  // First-touch guided steps are still held to the same 35-word minimum as free-written ones;
  // pad the last slot when the instructions alone would not clear it.
  if (vars.first_touch && texts.length > 0) {
    const total = texts.reduce((sum, text) => sum + countWords(text), 0);
    if (total < 30) {
      const lastIndex = texts.length - 1;
      texts[lastIndex] = `${texts[lastIndex]} Happy to share more detail if that would help.`;
    }
  }
  return {
    values: vars.slots.map((slot, index) => ({
      index: slot.index,
      text: texts[index] ?? "",
      missing: false,
    })),
    angle: "Fills the template's own slots from their instructions, no added claims.",
    signals_used: signal ? [signal.id] : [],
    facts_used: [],
  };
}

// ---------------------------------------------------------------------------
// campaign.email.check
// ---------------------------------------------------------------------------

/**
 * Passes whenever the automatic checks found nothing (the real enforcement is
 * `runDeterministicChecks`, which the pipeline always runs in addition to this answer and which
 * downgrades the verdict on its own when an error slipped through).
 */
export function buildEmailCheckAnswer(vars: CheckVars, _call: FakeBrainCall): CheckOutput {
  if (vars.deterministic_issues.length === 0) {
    return { verdict: "pass", confidence: 0.92, issues: [] };
  }
  return { verdict: "revise", confidence: 0.55, issues: [] };
}

// ---------------------------------------------------------------------------
// campaign.teach
// ---------------------------------------------------------------------------

/** Derives at most one short, generic rule per correction, skipping ones with no note. */
export function buildTeachAnswer(vars: TeachVars, _call: FakeBrainCall): TeachOutput {
  const existing = new Set(vars.existing_rules.map((rule) => rule.trim().toLowerCase()));
  const rules: string[] = [];
  for (const correction of vars.corrections) {
    if (rules.length >= 5) break;
    const note = correction.note?.trim();
    if (!note) continue;
    const rule = `Keep in mind: ${note}`.slice(0, 200);
    if (existing.has(rule.toLowerCase())) continue;
    if (rules.some((existingRule) => existingRule.toLowerCase() === rule.toLowerCase())) continue;
    rules.push(rule);
  }
  return { rules };
}
