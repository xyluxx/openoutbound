import { z } from "zod";
import { definePrompt, UNTRUSTED_CONTENT_RULE, wrapUntrusted } from "../../../brain/prompt.js";
import {
  type PromptCompany,
  type PromptDefinition,
  renderCompany,
  renderDefinitions,
} from "./classify-website-change.js";

export interface ClassifyItemsVars {
  company: PromptCompany;
  /** "news" = articles found by searching the company name; "feed" = the company's own feed. */
  source: "news" | "feed";
  items: Array<{
    id: string;
    url: string;
    title: string;
    date: string | null;
    snippet: string | null;
    author: string | null;
  }>;
  definitions: PromptDefinition[];
  /** Known people at the company (name and title), to recognize leaders. */
  people: Array<{ name: string; title: string | null }>;
}

/** Picks news or feed items that are about the company and show a buying signal. */
export const classifyItems = definePrompt({
  id: "signals.items.classify",
  version: 1,
  tier: "fast",
  system: () =>
    [
      "You pick news articles or feed items that show a buying signal at one specific company, for B2B outreach.",
      "First decide whether an item is about this exact company: skip items about other organizations with a similar name, stock listings, directories and job aggregators.",
      "Then match relevant items to one of the signal definitions. Most items match nothing: return an empty list then.",
      "One real event counts once: pick its most specific definition (a funding announcement is funding_round, not also news_mention).",
      "strength is 0-1: 1.0 unambiguous and specific, 0.6 likely, 0.3 weak.",
      "title: one line stating the fact. summary: one or two sentences on why it matters for outreach.",
      "evidence_excerpt: the headline or the sentence that proves it (max 300 characters). Never invent facts.",
      "item_id: the id of the item. definition_key: one of the listed keys.",
      UNTRUSTED_CONTENT_RULE,
    ].join("\n"),
  user: (vars: ClassifyItemsVars) =>
    [
      renderCompany(vars.company),
      vars.people.length > 0
        ? `Known people: ${vars.people.map((p) => (p.title ? `${p.name} (${p.title})` : p.name)).join("; ")}`
        : null,
      "",
      "Signal definitions:",
      renderDefinitions(vars.definitions),
      "",
      vars.source === "news"
        ? "News articles found by searching the company name:"
        : "New items from the company's own feed:",
      wrapUntrusted(
        vars.source === "news" ? "news_search" : "company_feed",
        vars.items
          .map((item) =>
            [
              `[${item.id}] ${item.title}`,
              `url: ${item.url}`,
              item.date ? `date: ${item.date}` : null,
              item.author ? `author: ${item.author}` : null,
              item.snippet ? `snippet: ${item.snippet}` : null,
            ]
              .filter(Boolean)
              .join("\n"),
          )
          .join("\n\n"),
      ),
    ]
      .filter((line) => line !== null)
      .join("\n"),
  schema: z.object({
    matches: z
      .array(
        z.object({
          item_id: z.string(),
          definition_key: z.string(),
          strength: z.number().min(0).max(1),
          title: z.string(),
          summary: z.string(),
          evidence_excerpt: z.string(),
        }),
      )
      .max(25),
  }),
  maxTokens: 2000,
  temperature: 0,
});
