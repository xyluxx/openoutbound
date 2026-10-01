/**
 * Results on disk: `<out>/<timestamp>/<scenario>.json` (every repeat of that scenario) and
 * `summary.md` / `summary.json` with one row per scenario.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioRunResult } from "./run-scenario.js";

export interface ScenarioSummary {
  scenario: string;
  title: string;
  runs: number;
  passed: number;
  pass_rate: number;
  checks_passed: number;
  checks_total: number;
  avg_turns: number;
  avg_tool_calls: number;
  tool_errors: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  avg_duration_ms: number;
  /** Names of checks that failed at least once, with how often. */
  failed_checks: Record<string, number>;
}

export interface RunSummary {
  runner: string;
  model: string | null;
  started_at: string;
  scenarios: ScenarioSummary[];
  totals: { runs: number; passed: number; pass_rate: number; cost_usd: number | null };
}

/** Filesystem-safe UTC timestamp, e.g. 2026-09-27T14-05-09Z. */
export function timestampDirName(date: Date = new Date()): string {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replaceAll(":", "-");
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sumOrNull(values: Array<number | null | undefined>): number | null {
  const known = values.filter((value): value is number => typeof value === "number");
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0);
}

export function summarizeScenario(runs: ScenarioRunResult[]): ScenarioSummary {
  const first = runs[0];
  const failed: Record<string, number> = {};
  for (const run of runs) {
    for (const check of run.checks) {
      if (!check.passed) failed[check.name] = (failed[check.name] ?? 0) + 1;
    }
    if (run.error)
      failed["runner finished without error"] = (failed["runner finished without error"] ?? 0) + 1;
  }
  const passed = runs.filter((run) => run.passed).length;
  return {
    scenario: first?.scenario ?? "unknown",
    title: first?.title ?? "",
    runs: runs.length,
    passed,
    pass_rate: runs.length === 0 ? 0 : passed / runs.length,
    checks_passed: runs.reduce((sum, run) => sum + run.checks.filter((c) => c.passed).length, 0),
    checks_total: runs.reduce((sum, run) => sum + run.checks.length, 0),
    avg_turns: average(runs.map((run) => run.turns)),
    avg_tool_calls: average(runs.map((run) => run.tool_calls.length)),
    tool_errors: runs.reduce((sum, run) => sum + run.tool_errors, 0),
    input_tokens: sumOrNull(runs.map((run) => run.usage?.input_tokens)),
    output_tokens: sumOrNull(runs.map((run) => run.usage?.output_tokens)),
    cost_usd: sumOrNull(runs.map((run) => run.cost_usd)),
    avg_duration_ms: average(runs.map((run) => run.duration_ms)),
    failed_checks: failed,
  };
}

export function buildRunSummary(
  results: ScenarioRunResult[][],
  meta: { runner: string; model: string | null; startedAt: Date },
): RunSummary {
  const scenarios = results.map(summarizeScenario);
  const runs = scenarios.reduce((sum, scenario) => sum + scenario.runs, 0);
  const passed = scenarios.reduce((sum, scenario) => sum + scenario.passed, 0);
  return {
    runner: meta.runner,
    model: meta.model,
    started_at: meta.startedAt.toISOString(),
    scenarios,
    totals: {
      runs,
      passed,
      pass_rate: runs === 0 ? 0 : passed / runs,
      cost_usd: sumOrNull(scenarios.map((scenario) => scenario.cost_usd)),
    },
  };
}

function cell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\s+/g, " ");
}

function formatNumber(value: number | null, digits = 0): string {
  return value === null ? "-" : value.toFixed(digits);
}

/** Markdown summary table plus the failed checks per scenario. */
export function renderSummaryMarkdown(summary: RunSummary): string {
  const lines = [
    `# Eval run ${summary.started_at}`,
    "",
    `Runner: ${summary.runner}${summary.model ? `, model: ${summary.model}` : ""}. Passed ${summary.totals.passed}/${summary.totals.runs} runs (${Math.round(summary.totals.pass_rate * 100)}%)${summary.totals.cost_usd !== null ? `, cost $${summary.totals.cost_usd.toFixed(4)}` : ""}.`,
    "",
    "| Scenario | Passed | Checks | Avg turns | Avg tool calls | Tool errors | Tokens in/out | Cost USD | Avg duration s |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of summary.scenarios) {
    const tokens =
      row.input_tokens === null && row.output_tokens === null
        ? "-"
        : `${formatNumber(row.input_tokens)}/${formatNumber(row.output_tokens)}`;
    lines.push(
      `| ${cell(row.scenario)} | ${row.passed}/${row.runs} | ${row.checks_passed}/${row.checks_total} | ${formatNumber(row.avg_turns, 1)} | ${formatNumber(row.avg_tool_calls, 1)} | ${row.tool_errors} | ${tokens} | ${row.cost_usd === null ? "-" : row.cost_usd.toFixed(4)} | ${(row.avg_duration_ms / 1000).toFixed(1)} |`,
    );
  }
  const failures = summary.scenarios.filter((row) => Object.keys(row.failed_checks).length > 0);
  if (failures.length > 0) {
    lines.push("", "## Failed checks", "");
    for (const row of failures) {
      for (const [name, count] of Object.entries(row.failed_checks)) {
        lines.push(`- ${row.scenario}: ${name} (${count}x)`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Writes every scenario file plus the summaries; returns the run directory. */
export function writeResults(
  outDir: string,
  results: ScenarioRunResult[][],
  meta: { runner: string; model: string | null; startedAt: Date },
): { dir: string; summary: RunSummary } {
  const dir = join(outDir, timestampDirName(meta.startedAt));
  mkdirSync(dir, { recursive: true });
  for (const runs of results) {
    const first = runs[0];
    if (!first) continue;
    const summary = summarizeScenario(runs);
    writeFileSync(
      join(dir, `${first.scenario}.json`),
      `${JSON.stringify({ ...summary, runs }, null, 2)}\n`,
    );
  }
  const summary = buildRunSummary(results, meta);
  writeFileSync(join(dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(dir, "summary.md"), renderSummaryMarkdown(summary));
  return { dir, summary };
}
