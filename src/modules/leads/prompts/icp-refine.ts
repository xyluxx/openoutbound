import { z } from "zod";
import { definePrompt, UNTRUSTED_CONTENT_RULE, wrapUntrusted } from "../../../brain/prompt.js";

export interface IcpRefineVars {
  icpName: string;
  icpDescription: string | null;
  criteria: string;
  maxAdjust: number;
  candidates: Array<{ id: string; score: number; facts: string }>;
}

/**
 * Optional AI refinement of rule-based fit scores for the top candidates of a find preview.
 * The model may move a score by at most `maxAdjust` points and must say why.
 */
export const icpRefinePrompt = definePrompt({
  id: "leads.icp_refine",
  version: 1,
  tier: "fast",
  maxTokens: 1500,
  temperature: 0,
  system: (vars: IcpRefineVars) =>
    [
      "You review lead fit scores against an ideal customer profile (ICP).",
      "Each candidate already has a rule-based score from 0 to 100. Adjust it only when the facts clearly show a better or worse fit than the rules captured, for example a company that is an agency rather than a software vendor.",
      `Adjustments must stay between -${vars.maxAdjust} and ${vars.maxAdjust}. Use 0 when unsure. Give one short reason per candidate, based only on the facts provided.`,
      UNTRUSTED_CONTENT_RULE,
    ].join("\n"),
  user: (vars: IcpRefineVars) =>
    [
      `ICP: ${vars.icpName}`,
      vars.icpDescription ? `Description: ${vars.icpDescription}` : null,
      `Criteria:\n${vars.criteria || "(none)"}`,
      "",
      "Candidates:",
      ...vars.candidates.map((candidate) =>
        [
          `id: ${candidate.id} (score ${candidate.score})`,
          wrapUntrusted("lead_source", candidate.facts),
        ].join("\n"),
      ),
    ]
      .filter((line) => line !== null)
      .join("\n"),
  schema: z.object({
    adjustments: z.array(
      z.object({
        id: z.string(),
        delta: z.number().int().min(-30).max(30),
        reason: z.string().max(300),
      }),
    ),
  }),
});
