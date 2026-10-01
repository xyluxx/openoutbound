import type { OpContext } from "../../core/context.js";
import { isJobWaitError, isOpenOutboundError } from "../../core/errors.js";
import { reportSummaryPrompt } from "./prompts/summary.js";
import type { Report } from "./schemas.js";
import { unsupportedNumbers } from "./summary-check.js";

export type SummaryResult =
  | { ok: true; summary: string; highlights: string[]; model: string }
  | { ok: false; reason: string };

/** Largest report JSON sent to the model; bigger campaign reports drop their step detail. */
const MAX_REPORT_CHARS = 24_000;
const EM_DASH = String.fromCharCode(0x2014);

/** The facts the model may use: period, data, notes and the metric definitions. */
export function summaryPayload(report: Report): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    type: report.type,
    period: report.period,
    previous_period: report.previous_period,
    data: report.data,
    notes: report.notes,
    definitions: report.definitions,
  };
  if (JSON.stringify(payload).length > MAX_REPORT_CHARS && report.data.type === "campaign") {
    payload.data = {
      ...report.data,
      campaigns: report.data.campaigns.map(({ steps: _steps, ...campaign }) => campaign),
    };
  }
  return payload;
}

/**
 * AI summary for a report (prompt `reports.summary`, fast tier). Never fails the caller: budget,
 * provider and validation problems return `{ ok: false, reason }`, and summaries citing numbers
 * that are not in the report are dropped. Agent-brain waits (JobWaitError) propagate so the job
 * parks until the agent answers.
 */
export async function summarizeReport(
  ctx: OpContext,
  report: Report,
  options: { workspaceName: string; jobId?: string },
): Promise<SummaryResult> {
  const payload = summaryPayload(report);
  try {
    const result = await ctx.brain.run(
      reportSummaryPrompt,
      {
        workspace: options.workspaceName,
        report_type: report.type,
        period: `${report.period.label} (${report.period.start_date} to ${report.period.end_date}, ${report.period.timezone})`,
        report_json: JSON.stringify(payload),
      },
      options.jobId
        ? { jobId: options.jobId, taskKey: `reports.summary:${options.jobId}` }
        : undefined,
    );
    const summary = clean(result.output.summary);
    const highlights = result.output.highlights.map(clean).filter(Boolean);
    const bad = unsupportedNumbers([summary, ...highlights].join(" "), payload);
    if (bad.length > 0) {
      return {
        ok: false,
        reason: `the AI summary cited numbers that are not in the report (${bad.slice(0, 5).join(", ")})`,
      };
    }
    return { ok: true, summary, highlights, model: result.model };
  } catch (error) {
    if (isJobWaitError(error)) throw error;
    const reason = isOpenOutboundError(error) ? error.message : "the AI call failed";
    ctx.log.warn({ err: error }, "reports: AI summary skipped");
    return { ok: false, reason };
  }
}

function clean(text: string): string {
  return text.replaceAll(EM_DASH, ", ").replace(/\s+/g, " ").trim();
}
