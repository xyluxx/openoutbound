import { z } from "zod";
import { definePrompt, UNTRUSTED_CONTENT_RULE, wrapUntrusted } from "../../../brain/prompt.js";
import { BUILTIN_SIGNALS } from "../signal-catalog.js";

/**
 * `knowledge.bootstrap`: drafts a first knowledge base from the user's own website. The
 * schema avoids optional fields and size keywords so every brain provider can enforce it;
 * limits are applied in code after parsing.
 */

const itemSchema = z.object({
  title: z.string().describe("Short title (max 10 words)"),
  body: z.string().describe("1-4 plain sentences, only what the pages support"),
  source_url: z.string().describe("URL of the page this comes from, exactly as listed"),
});

/**
 * manage_icp's seniority vocabulary, written out so this module loads without the leads
 * module (bootstrap.test.ts checks it matches SENIORITIES).
 */
export const SENIORITY_HINT =
  "owner, founder, c_suite, partner, vp, head, director, manager, senior, entry, intern";

/**
 * ICP criteria as the brain drafts them. bootstrap.ts turns them into manage_icp create input
 * (exclusions become criteria.exclude, seniorities map to its vocabulary, limits applied).
 */
export const icpCriteriaSchema = z.object({
  industries: z.array(z.string()),
  keywords: z.array(z.string()),
  employee_range: z.object({ min: z.number().int().nullable(), max: z.number().int().nullable() }),
  countries: z.array(z.string()).describe("ISO 3166-1 alpha-2 codes, e.g. US, DE"),
  regions: z.array(z.string()),
  titles: z.array(z.string()),
  seniorities: z.array(z.string()).describe(`Decision levels, from: ${SENIORITY_HINT}`),
  departments: z.array(z.string()),
  technologies: z.array(z.string()),
  exclusions: z.object({
    industries: z.array(z.string()),
    keywords: z.array(z.string()),
    titles: z.array(z.string()),
  }),
});

export const bootstrapOutputSchema = z.object({
  company_name: z.string().nullable(),
  about: itemSchema.nullable(),
  products: z.array(itemSchema).describe("Products or services, one item each (max 6)"),
  proof: z
    .array(itemSchema.extend({ kind: z.enum(["proof", "case_study"]) }))
    .describe("Customer results, logos, numbers, awards, case studies (max 8)"),
  objections: z
    .array(
      z.object({
        objection: z.string(),
        answer: z.string().describe("Honest answer using only what the pages say"),
        source_url: z.string().nullable(),
      }),
    )
    .describe("Likely objections of buyers with answers (max 6)"),
  voice: z.object({
    notes: z.array(z.string()).describe("How the company writes: tone, sentence length, words"),
    samples: z.array(z.string()).describe("1-3 short verbatim excerpts that show the voice"),
  }),
  offers: z
    .array(
      z.object({
        name: z.string(),
        summary: z.string().describe("One sentence: what the buyer gets"),
        details: z.string(),
        value_props: z.array(z.string()),
        cta: z.string().nullable().describe("Low-friction next step, e.g. a 20 minute call"),
        proof_titles: z.array(z.string()).describe("Titles of proof items that back this offer"),
      }),
    )
    .describe("1-3 offers for cold outreach"),
  icp_suggestions: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        criteria: icpCriteriaSchema,
        signal_keys: z.array(z.string()),
      }),
    )
    .describe("1-2 ideal customer profiles"),
  signal_suggestions: z
    .array(
      z.object({
        key: z.string().describe("A catalog key, or a new snake_case key for a custom signal"),
        name: z.string(),
        why: z.string().describe("Why this signal means the buyer may need us now"),
        custom_rule: z
          .string()
          .nullable()
          .describe("For custom signals: the rule in plain English; null for catalog keys"),
      }),
    )
    .describe("Buying signals worth watching (max 10)"),
});

export type BootstrapOutput = z.infer<typeof bootstrapOutputSchema>;

export interface BootstrapPage {
  url: string;
  category: string;
  title: string | null;
  text: string;
}

export interface BootstrapVars {
  domain: string;
  language: string;
  pages: BootstrapPage[];
}

const catalog = Object.entries(BUILTIN_SIGNALS)
  .map(([key, meaning]) => `- ${key}: ${meaning}`)
  .join("\n");

export const bootstrapPrompt = definePrompt({
  id: "knowledge.bootstrap",
  version: 1,
  tier: "standard",
  maxTokens: 6_000,
  temperature: 0.2,
  system: (vars: BootstrapVars) =>
    [
      "You draft the starting knowledge base of a B2B outbound team from the pages of their own website.",
      "Everything you write is saved as a suggestion that a human reviews before it is used in emails.",
      "",
      "Rules:",
      "- Only state what the pages support. Never invent customers, numbers, awards or features.",
      "- Every item names the page it comes from in source_url, copied exactly from the page list.",
      "- Write plainly: short sentences, no hype, no marketing superlatives.",
      "- Objections: the doubts a busy buyer would have, each with an honest answer from the pages.",
      "- Offers: 1-3 concrete offers suited to cold outreach, each with a low-friction call to action.",
      "- ICP suggestions: 1-2 profiles of companies and people most likely to buy, as criteria.",
      "- Signal suggestions: prefer keys from the catalog below; add custom signals (new snake_case key,",
      "  custom_rule in plain English) only when a catalog key does not fit.",
      `- Write in the language with code "${vars.language}".`,
      "",
      "Signal catalog:",
      catalog,
      "",
      UNTRUSTED_CONTENT_RULE,
    ].join("\n"),
  user: (vars: BootstrapVars) =>
    [
      `Website: ${vars.domain}`,
      `Pages (${vars.pages.length}):`,
      ...vars.pages.map((page) =>
        wrapUntrusted(
          page.url,
          `Page type: ${page.category}\nTitle: ${page.title ?? "(none)"}\n\n${page.text}`,
        ),
      ),
      "",
      "Draft the knowledge base now.",
    ].join("\n"),
  schema: bootstrapOutputSchema,
});
