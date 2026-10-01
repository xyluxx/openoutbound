import type { Report, ReportFormat, ReportOutput } from "../schemas.js";
import { renderCsv } from "./csv.js";
import { renderMarkdown } from "./markdown.js";

/** The reports.get output: report metadata plus the data in the requested format. */
export function toOutput(report: Report, format: ReportFormat): ReportOutput {
  const { data, ...meta } = report;
  if (format === "markdown") return { ...meta, format, markdown: renderMarkdown(report) };
  if (format === "csv") return { ...meta, format, csv: renderCsv(report) };
  return { ...meta, format, data };
}
