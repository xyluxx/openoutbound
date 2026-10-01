import { z } from "zod";
import { definePrompt, UNTRUSTED_CONTENT_RULE, wrapUntrusted } from "../../../brain/prompt.js";

/**
 * `research.brief`: one call per company or person. The schema mirrors `ResearchBrief`
 * (db/schema/research.ts) with optional fields as required-nullable so every provider can
 * enforce it; sizes are limited in code (validate.ts), not in the schema.
 */
export const briefOutputSchema = z.object({
  who: z.object({
    summary: z.string().describe("Person: who they are and what they care about in their role"),
    role: z.string().nullable(),
  }),
  company: z.object({ summary: z.string().describe("What the company does, for whom") }),
  now: z
    .array(
      z.object({
        fact: z.string().describe("One dated, specific fact"),
        source_url: z.string().describe("Exactly one of the source URLs listed"),
        date: z.string().nullable().describe("YYYY-MM-DD of the event or publication, or null"),
      }),
    )
    .describe("What is happening now, newest first (max 8)"),
  pains: z
    .array(
      z.object({
        hypothesis: z.string(),
        evidence_urls: z.array(z.string()).describe("Source URLs that support it"),
      }),
    )
    .describe("Likely problems, as hypotheses (max 5)"),
  angles: z
    .array(
      z.object({
        angle: z.string().describe("The outreach angle in one sentence"),
        why: z.string(),
        offer_id: z.string().nullable().describe("Id of one of our offers, or null"),
        evidence_urls: z.array(z.string()),
      }),
    )
    .describe("Outreach angles tied to our offers (max 4)"),
  recommended_angle: z.string().nullable().describe("The angle text of the best angle"),
  confidence: z.enum(["low", "medium", "high"]),
});
export type BriefOutput = z.infer<typeof briefOutputSchema>;

export interface BriefSource {
  n: number;
  url: string;
  title: string | null;
  published_at: string | null;
  kind: "website" | "search" | "signal" | "lead_record" | "company_brief";
  text: string;
}

export interface BriefVars {
  target: "company" | "person";
  today: string;
  language: string;
  /** Our CRM data about the company and person (imported, so untrusted). */
  record: string;
  /** Existing company brief (person briefs only), as JSON. */
  companyBrief: string | null;
  offers: Array<{ id: string; name: string; summary: string; value_props: string[] }>;
  sources: BriefSource[];
}

export const briefPrompt = definePrompt({
  id: "research.brief",
  version: 1,
  tier: "standard",
  maxTokens: 3_000,
  temperature: 0.2,
  system: (vars: BriefVars) =>
    [
      `You research a ${vars.target === "person" ? "person and their company" : "company"} for a B2B outbound team and write a short, evidence-first brief.`,
      "",
      "Rules:",
      "- Every item in `now` must cite a source_url copied exactly from the numbered sources. Facts without a listed source are removed, so do not add them.",
      "- Only use the sources and the lead record. Never guess numbers, names, dates or events.",
      "- `now`: specific recent events (funding, hires, launches, expansion, hiring, press), newest first, with the date when the source gives one.",
      "- `pains`: hypotheses about problems our offers solve, each backed by source URLs when possible.",
      "- `angles`: 1-4 outreach angles; offer_id must be one of our offer ids or null. recommended_angle repeats the best angle's text.",
      vars.target === "person"
        ? "- `who`: the person, their role and what they likely care about. Reuse facts from the company brief when they still matter."
        : "- `who`: the likely buyers at this company (roles), with role null.",
      "- confidence: high = several recent, specific sources; medium = some; low = little or old evidence.",
      `- Today is ${vars.today}. Write in the language with code "${vars.language}". Plain, short sentences.`,
      "",
      UNTRUSTED_CONTENT_RULE,
    ].join("\n"),
  user: (vars: BriefVars) => {
    const offers =
      vars.offers.length === 0
        ? "(no active offers: use offer_id null)"
        : vars.offers
            .map(
              (offer) =>
                `- ${offer.id}: ${offer.name}. ${offer.summary}${offer.value_props.length ? ` Value: ${offer.value_props.join("; ")}` : ""}`,
            )
            .join("\n");
    const sources =
      vars.sources.length === 0
        ? "(no sources found: keep `now` empty and confidence low)"
        : vars.sources
            .map((source) =>
              wrapUntrusted(
                source.url,
                [
                  `[${source.n}] ${source.kind}: ${source.title ?? "(untitled)"}`,
                  `URL: ${source.url}`,
                  source.published_at ? `Published: ${source.published_at}` : null,
                  "",
                  source.text,
                ]
                  .filter((line) => line !== null)
                  .join("\n"),
              ),
            )
            .join("\n\n");
    return [
      "Our offers:",
      offers,
      "",
      "Lead record:",
      wrapUntrusted("lead_record", vars.record),
      ...(vars.companyBrief
        ? [
            "",
            "Company brief (from earlier research):",
            wrapUntrusted("company_brief", vars.companyBrief),
          ]
        : []),
      "",
      `Sources (${vars.sources.length}):`,
      sources,
      "",
      "Write the brief now.",
    ].join("\n");
  },
  schema: briefOutputSchema,
});
