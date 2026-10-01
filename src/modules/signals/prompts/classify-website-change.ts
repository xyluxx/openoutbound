import { z } from "zod";
import { definePrompt, UNTRUSTED_CONTENT_RULE, wrapUntrusted } from "../../../brain/prompt.js";

export interface PromptCompany {
  name: string;
  domain: string | null;
  industry: string | null;
}

export interface PromptDefinition {
  key: string;
  name: string;
  description: string;
  instructions: string;
  keywords: string[];
}

export interface WebsiteChangeVars {
  company: PromptCompany;
  changes: Array<{ index: number; url: string; kind: string; added: string[]; removed: string[] }>;
  definitions: PromptDefinition[];
}

export function renderDefinitions(definitions: readonly PromptDefinition[]): string {
  return definitions
    .map((definition) => {
      const parts = [`- ${definition.key}: ${definition.name}. ${definition.description}`];
      if (definition.instructions) parts.push(`  Rule: ${definition.instructions}`);
      if (definition.keywords.length > 0)
        parts.push(`  Keywords: ${definition.keywords.join(", ")}`);
      return parts.join("\n");
    })
    .join("\n");
}

export function renderCompany(company: PromptCompany): string {
  return [
    `Company: ${company.name}`,
    company.domain ? `Domain: ${company.domain}` : null,
    company.industry ? `Industry: ${company.industry}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Classifies text changes on a company's key pages against enabled signal definitions. */
export const classifyWebsiteChange = definePrompt({
  id: "signals.website_change.classify",
  version: 1,
  tier: "fast",
  system: () =>
    [
      "You turn changes on a company's website into buying signals for B2B outreach.",
      "You get the lines added and removed on some pages of one company, and a list of signal definitions.",
      "Return a match only when a change clearly shows what a definition describes. Return an empty list when nothing is meaningful.",
      "Ignore noise: dates, copyright lines, cookie banners, reordered content, typo fixes, rotating testimonials, blog teasers, prices that only changed format.",
      "strength is 0-1: 1.0 unambiguous and specific, 0.6 likely, 0.3 weak.",
      "title: one line stating the fact, e.g. 'Published pricing: Pro plan at $49 per month'.",
      "summary: one or two sentences on what changed and why it matters for outreach.",
      "evidence_excerpt: copy the added or removed line that proves it (max 300 characters). Never invent facts that are not in the lines.",
      "change: the number of the change the match is about. definition_key: one of the listed keys.",
      UNTRUSTED_CONTENT_RULE,
    ].join("\n"),
  user: (vars: WebsiteChangeVars) =>
    [
      renderCompany(vars.company),
      "",
      "Signal definitions:",
      renderDefinitions(vars.definitions),
      "",
      ...vars.changes.map((change) =>
        [
          `Change ${change.index} (${change.kind} page, ${change.url}):`,
          wrapUntrusted(
            change.url,
            [
              "Added lines:",
              ...(change.added.length > 0 ? change.added : ["(none)"]),
              "Removed lines:",
              ...(change.removed.length > 0 ? change.removed : ["(none)"]),
            ].join("\n"),
          ),
        ].join("\n"),
      ),
    ].join("\n"),
  schema: z.object({
    matches: z
      .array(
        z.object({
          change: z.number().int().min(0),
          definition_key: z.string(),
          strength: z.number().min(0).max(1),
          title: z.string(),
          summary: z.string(),
          evidence_excerpt: z.string(),
        }),
      )
      .max(20),
  }),
  maxTokens: 1500,
  temperature: 0,
});
