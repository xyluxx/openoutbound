import { wrapUntrusted } from "../../../brain/prompt.js";
import type { BrainRunOptions, OpContext } from "../../../core/context.js";
import type { CampaignSettings, StepConfigOf } from "../../../core/settings.js";
import type { CampaignStep, ContentWhy, MessageCheck } from "../../../db/schema/index.js";
import type { LinkedInPost } from "../../../providers/types.js";
import { anyStepConfig } from "../steps.js";
import { phrasesFromRules } from "./banned-phrases.js";
import {
  type CheckIssue,
  type DraftFact,
  type DraftKind,
  hasErrors,
  runDeterministicChecks,
  sanitizeDraft,
} from "./checks.js";
import type { WritingContext } from "./context.js";
import {
  checkPrompt,
  fillSlotsPrompt,
  type WritingVars,
  writeEmailPrompt,
  writeLinkedInPrompt,
} from "./prompts.js";
import { extractSlots, fillSlots, numberSlots, renderTemplate } from "./render.js";

/** `messages.why`: the angle, signals and sourced facts behind a draft. */
export interface DraftWhy extends ContentWhy {
  facts?: DraftFact[];
  style?: string;
  variant?: string | null;
  /** The AI draft before a human or agent edited it (used by teach). */
  original?: { subject: string | null; body: string | null };
}

/** `messages.check`: deterministic checks + checker verdict. */
export interface DraftCheck extends MessageCheck {
  verdict: "pass" | "revise" | "fail";
}

export interface Draft {
  kind: DraftKind;
  subject: string | null;
  body: string;
  variant: string | null;
  why: DraftWhy;
  check: DraftCheck;
}

export type DraftResult =
  | { ok: true; draft: Draft }
  | {
      ok: false;
      /** e.g. "missing_variable:first_name", "slot_unsupported", "no_post". */
      reason: string;
    };

export interface DraftRequest {
  context: WritingContext;
  step: Pick<CampaignStep, "id" | "type" | "config" | "position">;
  /** No earlier sent message in this enrollment. */
  firstTouch: boolean;
  variantSeed: number;
  /** Subject of the thread a reply-mode email continues (null = start a new thread). */
  threadSubject: string | null;
  post?: LinkedInPost | null;
  /** Extra instruction for a regeneration. */
  extraInstruction?: string | null;
  brainOptions?: BrainRunOptions;
}

/** Max invite note length: 200 characters works for free and premium accounts. */
export const INVITE_NOTE_MAX_CHARS = 200;
const LINKEDIN_MESSAGE_MAX_WORDS = 60;
const COMMENT_MAX_WORDS = 60;
const COMMENT_MIN_WORDS = 20;
const FIRST_TOUCH_MIN_WORDS = 35;
const LINK = /https?:\/\/|www\.|\{\{\s*booking_url/i;

interface VariantChoice {
  key: string | null;
  subject?: string | undefined;
  body?: string | undefined;
  instruction?: string | undefined;
}

/**
 * A/B arm for an email step, chosen deterministically from the enrollment's variant seed.
 * With A/B testing on, the arms are the variants (missing fields fall back to the step's own
 * fields). With it off, the step's own fields are used (or the first variant when the step has
 * no body of its own).
 */
export function pickVariant(
  config: StepConfigOf<"email">,
  settings: CampaignSettings,
  seed: number,
): VariantChoice {
  const variants = config.variants ?? [];
  const base: VariantChoice = {
    key: null,
    subject: config.subject,
    body: config.body,
    instruction: config.instruction,
  };
  if (variants.length === 0) return base;
  const useArm = settings.ab_test.enabled || (config.style !== "free" && !config.body);
  if (!useArm) return base;
  const index = settings.ab_test.enabled ? Math.abs(Math.trunc(seed)) % variants.length : 0;
  const arm = variants[index] ?? variants[0];
  if (!arm) return base;
  return {
    key: arm.key,
    subject: arm.subject ?? config.subject,
    body: arm.body ?? config.body,
    instruction: arm.instruction ?? config.instruction,
  };
}

function limitsFor(
  kind: DraftKind,
  firstTouch: boolean,
  maxWords: number | null,
  linksAllowed: number,
): {
  maxWords: number | null;
  minWords: number | null;
  maxChars: number | null;
  linksAllowed: number;
} {
  switch (kind) {
    case "email":
      return {
        maxWords,
        minWords: firstTouch ? FIRST_TOUCH_MIN_WORDS : null,
        maxChars: null,
        linksAllowed,
      };
    case "invite_note":
      return { maxWords: null, minWords: null, maxChars: INVITE_NOTE_MAX_CHARS, linksAllowed: 0 };
    case "message":
      return {
        maxWords: LINKEDIN_MESSAGE_MAX_WORDS,
        minWords: null,
        maxChars: null,
        linksAllowed: firstTouch ? 0 : linksAllowed,
      };
    case "comment":
      return {
        maxWords: COMMENT_MAX_WORDS,
        minWords: COMMENT_MIN_WORDS,
        maxChars: null,
        linksAllowed: 0,
      };
  }
}

interface Written {
  subject: string | null;
  body: string;
  angle: string;
  signalsUsed: string[];
  facts: DraftFact[];
}

interface Spec {
  kind: DraftKind;
  style: "exact" | "guided" | "free";
  mode: "new_thread" | "reply";
  subjectTemplate: string | null;
  bodyTemplate: string | null;
  instruction: string | null;
  variant: string | null;
  maxWords: number | null;
  linksAllowed: number;
}

function specFor(request: DraftRequest): Spec {
  const config = anyStepConfig(request.step);
  const settings = request.context.settings;
  switch (config.type) {
    case "email": {
      const variant = pickVariant(config, settings, request.variantSeed);
      const templateText = `${variant.subject ?? ""} ${variant.body ?? ""} ${variant.instruction ?? ""}`;
      const stepAllowsLink = LINK.test(templateText);
      return {
        kind: "email",
        style: config.style,
        mode: config.mode === "reply" && request.threadSubject !== null ? "reply" : "new_thread",
        subjectTemplate: variant.subject ?? null,
        bodyTemplate: variant.body ?? null,
        instruction: variant.instruction ?? null,
        variant: variant.key,
        maxWords: config.max_words,
        linksAllowed: request.firstTouch ? (stepAllowsLink ? 1 : 0) : 1,
      };
    }
    case "linkedin_invite":
      return {
        kind: "invite_note",
        style: config.note === "none" ? "exact" : config.note,
        mode: "new_thread",
        subjectTemplate: null,
        bodyTemplate: config.note === "none" ? "" : (config.text ?? null),
        instruction: config.instruction ?? null,
        variant: null,
        maxWords: null,
        linksAllowed: 0,
      };
    case "linkedin_message":
      return {
        kind: "message",
        style: config.style,
        mode: "new_thread",
        subjectTemplate: null,
        bodyTemplate: config.text ?? null,
        instruction: config.instruction ?? null,
        variant: null,
        maxWords: LINKEDIN_MESSAGE_MAX_WORDS,
        linksAllowed: 1,
      };
    case "linkedin_comment":
      return {
        kind: "comment",
        style: "free",
        mode: "new_thread",
        subjectTemplate: null,
        bodyTemplate: null,
        instruction: config.instruction ?? null,
        variant: null,
        maxWords: COMMENT_MAX_WORDS,
        linksAllowed: 0,
      };
    default:
      throw new Error(`Step type ${config.type} has no text to write`);
  }
}

function writingVars(
  request: DraftRequest,
  spec: Spec,
  revision: WritingVars["revision"],
): WritingVars {
  const { context } = request;
  const settings = context.settings;
  const limits = limitsFor(spec.kind, request.firstTouch, spec.maxWords, spec.linksAllowed);
  return {
    channel: spec.kind === "email" ? "email" : "linkedin",
    kind: spec.kind,
    language: context.language,
    first_touch: request.firstTouch,
    mode: spec.mode,
    max_words: limits.maxWords,
    max_chars: limits.maxChars,
    links_allowed: limits.linksAllowed,
    goal: context.campaign.goal,
    instructions: [
      settings.writing.instructions,
      settings.writing.style_notes ? `Style: ${settings.writing.style_notes}` : "",
      settings.writing.length === "short" ? "Keep it short." : "",
      spec.instruction ? `This step: ${spec.instruction}` : "",
      request.extraInstruction ? `Also: ${request.extraInstruction}` : "",
      context.workspaceSettings.ai.tone_notes
        ? `Tone: ${context.workspaceSettings.ai.tone_notes}`
        : "",
    ].filter((item) => item.trim()),
    rules: [...context.grounding.rules, ...settings.writing.rules],
    sender: { name: context.senderName, company: context.senderCompany },
    grounding: context.grounding.text,
    guidance: context.grounding.guidanceText ?? null,
    prospect: context.rendered.prospect,
    brief: context.rendered.brief,
    signals: context.rendered.signals,
    history: context.rendered.history,
    lead_context: context.rendered.lead_context,
    post: request.post
      ? wrapUntrusted(
          "linkedin post",
          `${request.post.text}${request.post.url ? `\n(${request.post.url})` : ""}`,
        )
      : null,
    revision,
  };
}

function replySubject(threadSubject: string): string {
  return /^\s*re\s*:/i.test(threadSubject) ? threadSubject : `Re: ${threadSubject}`;
}

interface CheckResult {
  issues: CheckIssue[];
  verdict: DraftCheck["verdict"];
  confidence: number;
  model: string | null;
}

async function checkDraft(
  ctx: OpContext,
  request: DraftRequest,
  spec: Spec,
  written: Written,
  aiWritten: boolean,
): Promise<CheckResult> {
  const { context } = request;
  const limits = limitsFor(spec.kind, request.firstTouch, spec.maxWords, spec.linksAllowed);
  const extraPhrases = phrasesFromRules([
    ...context.settings.writing.rules,
    ...context.grounding.rules,
  ]);
  const deterministic = runDeterministicChecks({
    kind: spec.kind,
    subject: written.subject,
    body: written.body,
    firstTouch: request.firstTouch,
    mode: spec.mode,
    maxWords: limits.maxWords,
    minWords: limits.minWords,
    maxChars: limits.maxChars,
    linksAllowed: limits.linksAllowed,
    extraPhrases,
    aiWritten,
    facts: written.facts,
    allowedSources: context.allowedSources,
    signalsUsed: written.signalsUsed,
    allowedSignalIds: context.allowedSignalIds,
    evidenceText: context.evidenceText,
    language: context.language,
  });
  if (!aiWritten) {
    const failed = hasErrors(deterministic);
    return { issues: deterministic, verdict: failed ? "fail" : "pass", confidence: 1, model: null };
  }
  const result = await ctx.brain.run(
    checkPrompt,
    {
      channel: spec.kind === "email" ? "email" : "linkedin",
      kind: spec.kind,
      first_touch: request.firstTouch,
      language: context.language,
      max_words: limits.maxWords,
      subject: written.subject,
      body: written.body,
      grounding: context.grounding.text,
      evidence: context.rendered.evidence,
      rules: [...context.grounding.rules, ...context.settings.writing.rules],
      deterministic_issues: deterministic.map((issue) => `${issue.code}: ${issue.message}`),
    },
    request.brainOptions,
  );
  const issues = [...deterministic, ...result.output.issues];
  let verdict = result.output.verdict;
  if (verdict === "pass" && hasErrors(issues)) verdict = "revise";
  return { issues, verdict, confidence: result.output.confidence, model: result.model };
}

async function writeFree(
  ctx: OpContext,
  request: DraftRequest,
  spec: Spec,
  revision: WritingVars["revision"],
): Promise<Written> {
  const vars = writingVars(request, spec, revision);
  if (spec.kind === "email") {
    const { output } = await ctx.brain.run(writeEmailPrompt, vars, request.brainOptions);
    return {
      subject:
        spec.mode === "reply" && request.threadSubject
          ? replySubject(request.threadSubject)
          : sanitizeDraft(output.subject),
      body: sanitizeDraft(output.body),
      angle: output.angle,
      signalsUsed: output.signals_used,
      facts: output.facts_used,
    };
  }
  const { output } = await ctx.brain.run(writeLinkedInPrompt, vars, request.brainOptions);
  return {
    subject: null,
    body: sanitizeDraft(output.text),
    angle: output.angle,
    signalsUsed: output.signals_used,
    facts: output.facts_used,
  };
}

type GuidedResult = { ok: true; written: Written } | { ok: false; reason: string };

async function writeGuided(
  ctx: OpContext,
  request: DraftRequest,
  spec: Spec,
  template: { subject: string | null; body: string },
  revision: WritingVars["revision"],
): Promise<GuidedResult> {
  const slots = extractSlots(template.body);
  if (slots.length === 0) {
    return {
      ok: true,
      written: {
        subject: template.subject,
        body: sanitizeDraft(template.body),
        angle: "",
        signalsUsed: [],
        facts: [],
      },
    };
  }
  const { output } = await ctx.brain.run(
    fillSlotsPrompt,
    { ...writingVars(request, spec, revision), template: numberSlots(template.body), slots },
    request.brainOptions,
  );
  const values = new Map<number, string>();
  for (const value of output.values) {
    if (value.missing) return { ok: false, reason: `slot_unsupported:${value.index}` };
    values.set(value.index, value.text);
  }
  const unfilled = slots.filter((slot) => !values.has(slot.index));
  if (unfilled.length > 0) {
    return { ok: false, reason: `slot_unfilled:${unfilled.map((slot) => slot.index).join(",")}` };
  }
  return {
    ok: true,
    written: {
      subject: template.subject,
      body: sanitizeDraft(fillSlots(template.body, values)),
      angle: output.angle,
      signalsUsed: output.signals_used,
      facts: output.facts_used,
    },
  };
}

function buildWhy(request: DraftRequest, spec: Spec, written: Written): DraftWhy {
  const { context } = request;
  const signalIds = written.signalsUsed.filter((id) => context.allowedSignalIds.has(id));
  const keys = context.signals
    .filter((signal) => signalIds.includes(signal.id))
    .map((signal) => signal.definition_key);
  const knowledgeIds = [
    ...new Set(written.facts.map((fact) => fact.source).filter((source) => /^kn_/.test(source))),
  ];
  return {
    angle: written.angle,
    signal_ids: signalIds,
    signal_keys: [...new Set(keys)],
    brief_id: context.brief?.id ?? null,
    knowledge_item_ids: knowledgeIds,
    offer_id: context.campaign.offer_id,
    facts: written.facts,
    style: spec.style,
    variant: spec.variant,
  };
}

function toCheck(result: CheckResult, revised: boolean): DraftCheck {
  const passed = result.verdict === "pass" && !hasErrors(result.issues);
  return {
    passed,
    verdict: passed ? "pass" : result.verdict === "pass" ? "revise" : result.verdict,
    confidence: result.confidence,
    issues: result.issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      severity: issue.severity,
    })),
    revised,
    checker_model: result.model,
  };
}

/**
 * The writing pipeline for one step and lead: exact templates are rendered; guided templates
 * get their [[ai: ...]] slots filled; free steps are written by the brain. AI-written drafts
 * go through the deterministic checks plus the checker model and get one rewrite when either
 * finds a problem. Never writes to the database (preview uses it as is).
 */
export async function writeDraft(ctx: OpContext, request: DraftRequest): Promise<DraftResult> {
  const spec = specFor(request);
  const { context } = request;

  if (spec.kind === "comment" && !request.post) return { ok: false, reason: "no_recent_post" };

  let subjectTemplate: string | null = null;
  let bodyTemplate: string | null = null;
  if (spec.style !== "free") {
    const subject =
      spec.subjectTemplate !== null ? renderTemplate(spec.subjectTemplate, context.vars) : null;
    const body = renderTemplate(spec.bodyTemplate ?? "", context.vars);
    const missing = [...(subject?.missing ?? []), ...body.missing];
    if (missing.length > 0) return { ok: false, reason: `missing_variable:${missing.join(",")}` };
    subjectTemplate = subject?.text ?? null;
    bodyTemplate = body.text;
  }
  const threadSubject =
    spec.kind === "email" && spec.mode === "reply" && request.threadSubject
      ? replySubject(request.threadSubject)
      : null;

  if (spec.style === "exact") {
    const written: Written = {
      subject: threadSubject ?? subjectTemplate,
      body: sanitizeDraft(bodyTemplate ?? ""),
      angle: "",
      signalsUsed: [],
      facts: [],
    };
    if (spec.kind === "invite_note" && !written.body) {
      return {
        ok: true,
        draft: {
          kind: spec.kind,
          subject: null,
          body: "",
          variant: null,
          why: { ...buildWhy(request, spec, written), style: "none" },
          check: { passed: true, verdict: "pass", confidence: 1, issues: [], revised: false },
        },
      };
    }
    const result = await checkDraft(ctx, request, spec, written, false);
    return {
      ok: true,
      draft: {
        kind: spec.kind,
        subject: written.subject,
        body: written.body,
        variant: spec.variant,
        why: buildWhy(request, spec, written),
        check: toCheck(result, false),
      },
    };
  }

  const produce = async (revision: WritingVars["revision"]): Promise<GuidedResult> => {
    if (spec.style === "guided") {
      const guided = await writeGuided(
        ctx,
        request,
        spec,
        { subject: threadSubject ?? subjectTemplate, body: bodyTemplate ?? "" },
        revision,
      );
      return guided;
    }
    return { ok: true, written: await writeFree(ctx, request, spec, revision) };
  };

  const first = await produce(null);
  if (!first.ok) return first;
  let written = first.written;
  let result = await checkDraft(ctx, request, spec, written, true);
  let revised = false;
  if (result.verdict !== "pass" || hasErrors(result.issues)) {
    const second = await produce({
      subject: written.subject,
      body: written.body,
      issues: result.issues.map((issue) => `${issue.code}: ${issue.message}`),
    });
    if (second.ok) {
      written = second.written;
      result = await checkDraft(ctx, request, spec, written, true);
      revised = true;
    }
  }
  return {
    ok: true,
    draft: {
      kind: spec.kind,
      subject: written.subject,
      body: written.body,
      variant: spec.variant,
      why: buildWhy(request, spec, written),
      check: toCheck(result, revised),
    },
  };
}

/**
 * Deterministic checks for text a human or agent edited (no checker model): length, phrases,
 * variables, links, subject and punctuation rules for the step.
 */
export function checkEditedText(input: {
  step: Pick<CampaignStep, "id" | "type" | "config" | "position">;
  settings: CampaignSettings;
  subject: string | null;
  body: string;
  firstTouch: boolean;
  isReply: boolean;
}): DraftCheck {
  const config = anyStepConfig(input.step);
  const kind: DraftKind =
    config.type === "email"
      ? "email"
      : config.type === "linkedin_invite"
        ? "invite_note"
        : config.type === "linkedin_comment"
          ? "comment"
          : "message";
  const maxWords =
    config.type === "email"
      ? config.max_words
      : kind === "message"
        ? LINKEDIN_MESSAGE_MAX_WORDS
        : null;
  const limits = limitsFor(kind, input.firstTouch, maxWords, input.firstTouch ? 0 : 1);
  const issues = runDeterministicChecks({
    kind,
    subject: input.subject,
    body: input.body,
    firstTouch: input.firstTouch,
    mode: input.isReply ? "reply" : "new_thread",
    maxWords: limits.maxWords,
    minWords: null,
    maxChars: limits.maxChars,
    linksAllowed:
      kind === "email" && input.firstTouch && LINK.test(input.body) ? 1 : limits.linksAllowed,
    extraPhrases: phrasesFromRules(input.settings.writing.rules),
    aiWritten: false,
    language: input.settings.writing.language ?? null,
  });
  const failed = hasErrors(issues);
  return {
    passed: !failed,
    verdict: failed ? "revise" : "pass",
    confidence: 1,
    issues: issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      severity: issue.severity,
    })),
    revised: false,
    checker_model: null,
  };
}
