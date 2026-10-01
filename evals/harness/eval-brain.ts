/**
 * The engine's own AI during evals: deterministic answers per prompt id, so a run measures how
 * the agent drives the tools, not how a writer model behaves that day. Scenarios override any
 * prompt with `brain.on(promptId, handler)`; prompts without a handler get the smallest output
 * that passes their schema. Every call is metered at zero cost like a real brain call.
 */
import type { PromptDefinition } from "../../src/brain/prompt.js";
import { sampleFromSchema } from "../../src/brain/schema-sample.js";
import type { BrainResult, BrainRunOptions, BrainService } from "../../src/core/context.js";
import type { BrainFactory, BrainServiceDeps } from "../../src/runtime/brain.js";

// biome-ignore lint/suspicious/noExplicitAny: handlers receive whatever vars the prompt declares
export type BrainHandler = (vars: any, info: { promptId: string; user: string }) => unknown;

export interface EvalBrainCall {
  promptId: string;
  output: unknown;
}

export interface EvalBrain {
  /** Sets the answer for a prompt id (a value or a function of the prompt vars). */
  on(promptId: string, handler: BrainHandler | Record<string, unknown>): void;
  calls: EvalBrainCall[];
  /** Brain factory for the engine (`EngineInternals.brain`). */
  factory: BrainFactory;
}

export const EVAL_BRAIN_PROVIDER = "eval";
export const EVAL_BRAIN_MODEL = "eval-deterministic";

export function createEvalBrain(): EvalBrain {
  const handlers = new Map<string, BrainHandler>(Object.entries(DEFAULT_HANDLERS));
  const calls: EvalBrainCall[] = [];

  const factory: BrainFactory = (deps: BrainServiceDeps): BrainService => ({
    async run<V, T>(
      prompt: PromptDefinition<V, T>,
      vars: V,
      options: BrainRunOptions = {},
    ): Promise<BrainResult<T>> {
      const workspaceId =
        options.workspaceId !== undefined ? options.workspaceId : resolve(deps.workspaceId);
      if (workspaceId) await deps.usage.assertBudget(workspaceId, "ai");
      const handler = handlers.get(prompt.id);
      const raw = handler
        ? await handler(vars, { promptId: prompt.id, user: prompt.user(vars) })
        : sampleFromSchema(prompt.schema);
      const parsed = prompt.schema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(
          `Eval brain: the answer for "${prompt.id}" does not match its schema: ${parsed.error.message}`,
        );
      }
      calls.push({ promptId: prompt.id, output: parsed.data });
      await deps.usage.record({
        workspaceId: workspaceId ?? null,
        slot: "brain",
        provider: EVAL_BRAIN_PROVIDER,
        operation: prompt.id,
        model: EVAL_BRAIN_MODEL,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        jobId: options.jobId ?? resolve(deps.jobId) ?? null,
      });
      return {
        output: parsed.data,
        text: JSON.stringify(parsed.data),
        provider: EVAL_BRAIN_PROVIDER,
        model: EVAL_BRAIN_MODEL,
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 },
        repaired: false,
        durationMs: 0,
      };
    },
  });

  return {
    calls,
    factory,
    on(promptId, handler) {
      handlers.set(promptId, typeof handler === "function" ? handler : () => handler);
    },
  };
}

function resolve<T>(value: T | (() => T) | undefined): T | undefined {
  return typeof value === "function" ? (value as () => T)() : value;
}

// --- Default answers ---------------------------------------------------------------------------

/** `Label: value` from a rendered record (prospect records, company blocks). */
export function field(text: string, label: string): string | null {
  const match = new RegExp(`^${label}:\\s*(.+)$`, "m").exec(text);
  return match?.[1]?.trim() || null;
}

/** First name from a prospect record (`Name: ...`) or a label like `Ana Ruiz (Acme), COO`. */
function firstName(prospect: string): string {
  const name = field(prospect, "Name") ?? prospect.split(/[,(\n]/)[0] ?? "";
  return name.trim().split(/\s+/)[0] || "there";
}

/** Sentences of a text, trimmed. */
export function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

const INJECTION =
  /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|all|your)\b[^.\n]{0,20}\b(instructions?|prompts?|rules)\b|\bsystem prompt\b|\bapi keys?\b|\b(send|export|give) me\b[^.\n]{0,30}\blead list\b/i;
const ANGRY =
  /\b(spam|spamming|harass|stop wasting|ridiculous|furious|angry|report you|how did you get my|sick of|unacceptable|leave me alone|disgusting)\b/i;
const OUT_OF_OFFICE = /\b(out of (the )?office|on vacation|on leave|away until|back on)\b/i;
const NOT_NOW = /\b(not now|next quarter|later this year|reach out in|circle back|bad timing)\b/i;
const REFERRAL = /\b(talk to|speak with|reach out to|better person|contact my colleague)\b/i;
const WRONG = /\b(wrong person|not my area|not the right person)\b/i;
const MEETING = /\b(call|meeting|calendar|book a|demo|set up a time|this week)\b/i;
const INTERESTED = /\b(interested|tell me more|sounds good|sounds interesting|send (me )?more)\b/i;
const OBJECTION = /\b(already use|already have|no budget|too expensive|not a priority)\b/i;

/** Keyword classifier for replies: stable categories for triage evals. */
export function classifyReplyText(reply: string): {
  category: string;
  sentiment: "positive" | "neutral" | "negative";
  confidence: number;
  suspicious: boolean;
  question: string | null;
} {
  const suspicious = INJECTION.test(reply);
  const question = sentences(reply).find((sentence) => sentence.endsWith("?")) ?? null;
  const pick = (
    category: string,
    sentiment: "positive" | "neutral" | "negative",
    confidence: number,
  ) => ({ category, sentiment, confidence, suspicious, question });
  if (suspicious) return pick("other", "neutral", 0.6);
  if (ANGRY.test(reply)) return pick("negative", "negative", 0.92);
  if (OUT_OF_OFFICE.test(reply)) return pick("out_of_office", "neutral", 0.9);
  if (WRONG.test(reply)) return pick("wrong_person", "neutral", 0.85);
  if (REFERRAL.test(reply)) return pick("referral", "neutral", 0.8);
  if (NOT_NOW.test(reply)) return pick("not_now", "neutral", 0.85);
  if (OBJECTION.test(reply)) return pick("objection", "neutral", 0.8);
  if (MEETING.test(reply)) return pick("meeting_request", "positive", 0.88);
  if (INTERESTED.test(reply)) return pick("interested", "positive", 0.86);
  if (question) return pick("question", "neutral", 0.8);
  return pick("other", "neutral", 0.5);
}

const DEFAULT_HANDLERS: Record<string, BrainHandler> = {
  "campaign.email.write": (vars: { prospect: string; first_touch: boolean }) => {
    const company = field(vars.prospect, "Company") ?? "your team";
    const name = firstName(vars.prospect);
    return {
      subject: vars.first_touch ? "reorder timing" : "one more thought",
      body: vars.first_touch
        ? `Hi ${name}, operations teams at companies like ${company} usually learn about a stock problem after it has already cost them sales. We forecast demand per product a few weeks ahead from your own history, so reorders are made with confidence instead of guesswork. Would a short look at where your gaps are be useful?`
        : `Hi ${name}, one more thought on reorder timing at ${company}: the gaps usually show up first on the best sellers. Worth a quick look together?`,
      angle: "Reorder timing from the prospect's own sales history",
      signals_used: [],
      facts_used: [],
    };
  },
  "campaign.linkedin.write": (vars: { prospect: string; kind: string }) => {
    const name = firstName(vars.prospect);
    return {
      text:
        vars.kind === "invite_note"
          ? `Hi ${name}, I work with operations leaders on demand planning and would be glad to connect.`
          : `Thanks for connecting, ${name}. Is reorder planning something your team is looking at this quarter?`,
      angle: "Operations planning",
      signals_used: [],
      facts_used: [],
    };
  },
  "campaign.email.fill_slots": (vars: { slots: Array<{ index: number }> }) => ({
    values: vars.slots.map((slot) => ({ index: slot.index, text: "your team", missing: false })),
    angle: "Template with light personalization",
    signals_used: [],
    facts_used: [],
  }),
  "campaign.email.check": () => ({ verdict: "pass", confidence: 0.92, issues: [] }),
  "campaign.teach": () => ({ rules: [] }),
  "inbox.reply.classify": (vars: { reply: string; subject: string | null }) => {
    const text = `${vars.subject ?? ""}\n${vars.reply}`;
    const result = classifyReplyText(text);
    return {
      category: result.category,
      confidence: result.confidence,
      sentiment: result.sentiment,
      summary: `The prospect's reply reads as ${result.category.replaceAll("_", " ")}.`,
      language: "en",
      return_date: null,
      follow_up_date: null,
      referral: null,
      question: result.category === "question" ? result.question : null,
      left_company: false,
      asks_if_bot: /\b(are you|is this) (a )?(bot|ai|robot)\b/i.test(text),
      suspicious: result.suspicious,
      proposed_time: null,
      privacy_kind: null,
      facts: [],
      company_hold: null,
    };
  },
  // A deterministic writer cannot follow instructions, so it echoes the agent's instruction
  // into the draft: checks can then see what the agent asked the engine to write.
  "inbox.reply.draft": (vars: {
    prospect: string;
    category: string;
    instruction: string | null;
  }) => {
    const instruction = vars.instruction?.trim().replace(/[.!\s]+$/, "") ?? "";
    const unsure = vars.category === "question" && !instruction;
    return {
      subject: null,
      body: instruction
        ? `Thanks for getting back to me, ${firstName(vars.prospect)}. ${instruction}.`
        : `Thanks for getting back to me, ${firstName(vars.prospect)}. Happy to help with that. Would a short call next week work for you?`,
      used_fact_ids: [],
      needs_human: unsure,
      needs_human_reason: unsure ? "The answer needs a human to confirm the details." : null,
    };
  },
  "inbox.reply.check": () => ({ verdict: "pass", confidence: 0.9, issues: [] }),
  "signals.custom.evaluate": (vars: {
    company: { name: string };
    definition: { name: string; keywords: string[] };
    sources: Array<{ url: string; text: string }>;
  }) => {
    const terms = (
      vars.definition.keywords.length > 0
        ? vars.definition.keywords
        : vars.definition.name.split(/\s+/).filter((word) => word.length > 4)
    ).map((term) => term.toLowerCase());
    for (const source of vars.sources) {
      const hit = sentences(source.text).find((sentence) =>
        terms.some((term) => sentence.toLowerCase().includes(term)),
      );
      if (hit) {
        return {
          matched: true,
          strength: 0.9,
          evidence_url: source.url,
          evidence_excerpt: hit.slice(0, 300),
          summary: `${vars.company.name}: ${hit}`.slice(0, 500),
        };
      }
    }
    return { matched: false, strength: 0, evidence_url: "", evidence_excerpt: "", summary: "" };
  },
};
