import { z } from "zod";
import { definePrompt, UNTRUSTED_CONTENT_RULE, wrapUntrusted } from "../../../brain/prompt.js";
import {
  type PromptCompany,
  type PromptDefinition,
  renderCompany,
  renderDefinitions,
} from "./classify-website-change.js";

export interface EvaluateCustomVars {
  company: PromptCompany;
  definition: PromptDefinition;
  /** Today as YYYY-MM-DD, for time-bound rules ("in the last 60 days"). */
  today: string;
  sources: Array<{
    url: string;
    title: string | null;
    text: string;
    published_at: string | null;
    collector: string;
  }>;
}

/** Decides whether a custom plain-English signal matches, citing one of the given sources. */
export const evaluateCustomSignal = definePrompt({
  id: "signals.custom.evaluate",
  version: 1,
  tier: "fast",
  system: () =>
    [
      "You check one custom buying signal, written in plain English, against evidence collected about one company.",
      "matched is true only when a source clearly shows what the rule describes, respecting its time window and exclusions. When in doubt, matched is false.",
      "evidence_url must be copied exactly from one of the sources. evidence_excerpt: the line from that source that proves it (max 300 characters).",
      "strength is 0-1: 1.0 unambiguous and specific, 0.6 likely, 0.3 weak. summary: one or two sentences for a salesperson.",
      "Never invent facts. Never use sensitive traits (health, religion, politics, union membership, sexuality, family life).",
      "When matched is false, return strength 0 and empty strings.",
      UNTRUSTED_CONTENT_RULE,
    ].join("\n"),
  user: (vars: EvaluateCustomVars) =>
    [
      renderCompany(vars.company),
      `Today: ${vars.today}`,
      "",
      "Custom signal:",
      renderDefinitions([vars.definition]),
      "",
      "Sources:",
      ...vars.sources.map((source, index) =>
        [
          `Source ${index + 1} (${source.collector}): ${source.url}`,
          source.published_at ? `date: ${source.published_at}` : null,
          wrapUntrusted(source.url, source.title ? `${source.title}\n${source.text}` : source.text),
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    ].join("\n"),
  schema: z.object({
    matched: z.boolean(),
    strength: z.number().min(0).max(1),
    evidence_url: z.string(),
    evidence_excerpt: z.string(),
    summary: z.string(),
  }),
  maxTokens: 800,
  temperature: 0,
});
