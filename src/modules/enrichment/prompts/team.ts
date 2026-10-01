import { z } from "zod";
import { definePrompt, UNTRUSTED_CONTENT_RULE, wrapUntrusted } from "../../../brain/prompt.js";

export interface TeamExtractionVars {
  company: string;
  domain: string;
  /** Team, about, imprint or home page texts (untrusted). */
  pages: Array<{ url: string; kind: string; text: string }>;
}

export const teamMemberSchema = z.object({
  full_name: z.string().min(2).max(120),
  title: z.string().max(160).nullable(),
  /** Only an address printed next to this person on the page. */
  email: z.string().max(200).nullable(),
  decision_maker: z.boolean(),
});

/**
 * Finds the people named on a company's own pages and marks decision makers (fast tier, one
 * call per company). Page text is untrusted and wrapped; the model must not invent people or
 * addresses.
 */
export const teamExtractionPrompt = definePrompt({
  id: "enrichment.extract_team",
  version: 1,
  tier: "fast",
  maxTokens: 1500,
  temperature: 0,
  system: () =>
    [
      "You read pages from a company's own website and list the people who work there.",
      "Only list people explicitly named on the pages as working at this company (owners, founders, managing directors, partners, practice owners, doctors, heads of departments, staff). Skip customers, testimonials, authors of quoted articles and web agencies.",
      "decision_maker is true for owners, founders, managing directors (Geschaeftsfuehrer), CEOs, partners, practice owners and heads of a department; false otherwise.",
      "Copy an email only when it is printed next to that person; never guess or construct addresses. Use null when unsure.",
      "Keep titles short and in the page's wording. At most 15 people, decision makers first.",
      UNTRUSTED_CONTENT_RULE,
    ].join("\n"),
  user: (vars: TeamExtractionVars) =>
    [
      `Company: ${vars.company} (${vars.domain})`,
      "",
      ...vars.pages.map((page) =>
        wrapUntrusted(`website:${page.kind}`, `URL: ${page.url}\n${page.text}`),
      ),
    ].join("\n"),
  schema: z.object({ people: z.array(teamMemberSchema).max(15) }),
});
