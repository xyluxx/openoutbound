/**
 * Metric values with previous-period comparison. Counts compare as absolute and relative
 * change; rates (percentages) compare in percentage points; amounts (USD, credits) keep two decimals.
 */
export type MetricKind = "count" | "rate" | "amount";

export interface Metric {
  value: number | null;
  previous: number | null;
  /** value - previous (percentage points for rates). */
  change: number | null;
  /** Relative change in percent; null for rates and when previous is 0. */
  change_pct: number | null;
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Percentage 0-100 with one decimal, or null when there is no denominator. */
export function rate(numerator: number, denominator: number): number | null {
  if (!denominator) return null;
  return round1((numerator / denominator) * 100);
}

/** Builds a metric. Pass `previous: undefined` when the report has no comparison. */
export function metric(
  value: number | null,
  previous: number | null | undefined,
  kind: MetricKind = "count",
): Metric {
  const rounded = value === null ? null : roundFor(kind, value);
  if (previous === undefined) {
    return { value: rounded, previous: null, change: null, change_pct: null };
  }
  const before = previous === null ? null : roundFor(kind, previous);
  if (rounded === null || before === null) {
    return { value: rounded, previous: before, change: null, change_pct: null };
  }
  const change = roundFor(kind, rounded - before);
  const changePct = kind === "rate" || before === 0 ? null : round1((change / before) * 100);
  return { value: rounded, previous: before, change, change_pct: changePct };
}

function roundFor(kind: MetricKind, value: number): number {
  if (kind === "amount") return round2(value);
  if (kind === "rate") return round1(value);
  return value;
}
