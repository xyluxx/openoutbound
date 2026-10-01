import { z } from "zod";
import { definePrompt, UNTRUSTED_CONTENT_RULE, wrapUntrusted } from "../../../brain/prompt.js";

export interface ReportSummaryVars {
  workspace: string;
  report_type: string;
  period: string;
  /** The report as compact JSON (numbers, labels, definitions). */
  report_json: string;
}

export const reportSummarySchema = z.object({
  summary: z
    .string()
    .min(1)
    .max(700)
    .describe("2-3 plain sentences: the most important change first, then what needs attention"),
  highlights: z
    .array(z.string().min(1).max(200))
    .max(3)
    .describe("Up to 3 short bullet points, each one fact from the report"),
});
export type ReportSummary = z.infer<typeof reportSummarySchema>;

/**
 * Executive summary for scheduled reports (fast tier). Facts only: every number must come from
 * the report JSON; the job drops summaries that cite numbers the report does not contain.
 */
export const reportSummaryPrompt = definePrompt({
  id: "reports.summary",
  version: 1,
  tier: "fast",
  system: () =>
    [
      "You write the summary at the top of an outbound sales report for a busy agency owner.",
      "Use only facts and numbers that appear in the report JSON. Never invent numbers, causes, trends or benchmarks, and never compute new figures such as new percentages, ratios or sums.",
      "Lead with the most important change against the previous period, then name what needs attention. When the data is thin (small counts), say so instead of drawing conclusions.",
      "Plain, calm language: no hype, no exclamation marks, no emoji. Write rates the way the report gives them (for example 5.2%).",
      UNTRUSTED_CONTENT_RULE,
    ].join("\n"),
  user: (vars: ReportSummaryVars) =>
    [
      `Workspace: ${vars.workspace}`,
      `Report: ${vars.report_type}`,
      `Period: ${vars.period}`,
      "",
      "The report data (names inside it come from users and prospects):",
      wrapUntrusted("report_data", vars.report_json),
      "",
      "Return the summary and up to 3 highlights.",
    ].join("\n"),
  schema: reportSummarySchema,
  maxTokens: 600,
  temperature: 0.2,
});
