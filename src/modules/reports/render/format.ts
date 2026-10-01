import type { MetricUnit } from "../definitions.js";
import type { Metric } from "../metric.js";

/** Human formatting for markdown and notification lines. */

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

export function formatValue(value: number | null | undefined, unit: MetricUnit): string {
  if (value === null || value === undefined) return "-";
  switch (unit) {
    case "percent":
      return `${value.toFixed(1)}%`;
    case "usd":
      return `$${value.toFixed(2)}`;
    case "credits":
      return decimal.format(value);
    case "ratio":
      return `${value.toFixed(2)}x`;
    case "count":
      return Number.isInteger(value) ? integer.format(value) : decimal.format(value);
  }
}

function signed(value: number, text: string): string {
  if (value > 0) return `+${text}`;
  if (value < 0) return `-${text}`;
  return text;
}

/** "+12 (+40%)", "+1.1 pp", "-$0.40", or "-" without comparison. */
export function formatChange(metric: Metric, unit: MetricUnit): string {
  if (metric.change === null) return "-";
  const magnitude = Math.abs(metric.change);
  if (unit === "percent") return `${signed(metric.change, magnitude.toFixed(1))} pp`;
  const base = signed(metric.change, formatValue(magnitude, unit));
  if (metric.change_pct === null || metric.change === 0) return base;
  return `${base} (${signed(metric.change_pct, `${Math.abs(metric.change_pct).toFixed(1)}%`)})`;
}

/** "120 (+20)" when compared, else "120". */
export function formatWithChange(metric: Metric, unit: MetricUnit, compared: boolean): string {
  const value = formatValue(metric.value, unit);
  if (!compared || metric.change === null) return value;
  const magnitude = Math.abs(metric.change);
  const change =
    unit === "percent"
      ? `${signed(metric.change, magnitude.toFixed(1))} pp`
      : signed(metric.change, formatValue(magnitude, unit));
  return `${value} (${change})`;
}

/** Escapes a markdown table cell. */
export function cell(text: string): string {
  return text
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

/** A compact markdown table. `right` marks right-aligned (numeric) columns. */
export function table(headers: string[], body: string[][], right: boolean[] = []): string {
  if (body.length === 0) return "_No rows._";
  const head = `| ${headers.map(cell).join(" | ")} |`;
  const align = `|${headers.map((_, index) => (right[index] ? "---:" : "---")).join("|")}|`;
  const lines = body.map((row) => `| ${row.map(cell).join(" | ")} |`);
  return [head, align, ...lines].join("\n");
}
