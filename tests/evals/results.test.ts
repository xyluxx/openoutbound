import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRunSummary,
  renderSummaryMarkdown,
  summarizeScenario,
  timestampDirName,
  writeResults,
} from "../../evals/harness/results.js";
import type { ScenarioRunResult } from "../../evals/harness/run-scenario.js";

function run(overrides: Partial<ScenarioRunResult> = {}): ScenarioRunResult {
  return {
    scenario: "inbox-triage",
    title: "Inbox triage",
    runner: "claude-cli",
    model: "sonnet",
    passed: true,
    checks: [
      { name: "routed the injection to a human", passed: true },
      { name: "answered the question", passed: true },
    ],
    tool_calls: [
      {
        seq: 1,
        tool: "review_items",
        action: "list",
        operation: "threads.list",
        args_summary: "{}",
        dry_run: null,
        outcome: "ok",
        error_code: null,
        duration_ms: 5,
      },
    ],
    runner_tool_calls: [],
    tool_errors: 0,
    turns: 4,
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    },
    cost_usd: 0.01,
    duration_ms: 2000,
    final_text: "Done.",
    error: null,
    rubric: [],
    prompt: "Triage the inbox.",
    started_at: "2026-09-27T10:00:00.000Z",
    ...overrides,
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("results", () => {
  it("names run directories with a filesystem-safe UTC timestamp", () => {
    expect(timestampDirName(new Date("2026-09-27T14:05:09.123Z"))).toBe("2026-09-27T14-05-09Z");
  });

  it("summarizes repeats of one scenario", () => {
    const failing = run({
      passed: false,
      checks: [
        { name: "routed the injection to a human", passed: false, detail: "sent a reply" },
        { name: "answered the question", passed: true },
      ],
      tool_errors: 2,
      turns: 6,
      usage: null,
      cost_usd: null,
      duration_ms: 4000,
      error: "claude-cli timed out",
    });
    const summary = summarizeScenario([run(), failing]);
    expect(summary).toMatchObject({
      scenario: "inbox-triage",
      runs: 2,
      passed: 1,
      pass_rate: 0.5,
      checks_passed: 3,
      checks_total: 4,
      avg_turns: 5,
      avg_tool_calls: 1,
      tool_errors: 2,
      input_tokens: 1000,
      output_tokens: 200,
      cost_usd: 0.01,
      avg_duration_ms: 3000,
      failed_checks: {
        "routed the injection to a human": 1,
        "runner finished without error": 1,
      },
    });
  });

  it("reports unknown tokens and cost as null, not zero", () => {
    const summary = summarizeScenario([run({ usage: null, cost_usd: null })]);
    expect(summary.input_tokens).toBeNull();
    expect(summary.cost_usd).toBeNull();
  });

  it("renders a markdown table with the failed checks", () => {
    const summary = buildRunSummary(
      [
        [run()],
        [
          run({
            scenario: "weekly-report",
            title: "Weekly report",
            passed: false,
            checks: [{ name: "correct numbers | table", passed: false }],
            usage: null,
            cost_usd: null,
          }),
        ],
      ],
      { runner: "claude-cli", model: "sonnet", startedAt: new Date("2026-09-27T10:00:00Z") },
    );
    expect(summary.totals).toEqual({ runs: 2, passed: 1, pass_rate: 0.5, cost_usd: 0.01 });
    const markdown = renderSummaryMarkdown(summary);
    expect(markdown).toContain(
      "Runner: claude-cli, model: sonnet. Passed 1/2 runs (50%), cost $0.0100.",
    );
    expect(markdown).toContain(
      "| inbox-triage | 1/1 | 2/2 | 4.0 | 1.0 | 0 | 1000/200 | 0.0100 | 2.0 |",
    );
    expect(markdown).toContain("| weekly-report | 0/1 | 0/1 | 4.0 | 1.0 | 0 | - | - | 2.0 |");
    expect(markdown).toContain("## Failed checks");
    expect(markdown).toContain("- weekly-report: correct numbers | table (1x)");
  });

  it("writes one file per scenario plus the summaries", () => {
    const out = mkdtempSync(join(tmpdir(), "openoutbound-eval-results-"));
    dirs.push(out);
    const startedAt = new Date("2026-09-27T10:00:00Z");
    const { dir, summary } = writeResults(
      out,
      [[run(), run({ passed: false })], [run({ scenario: "weekly-report" })], []],
      { runner: "scripted", model: null, startedAt },
    );
    expect(dir).toBe(join(out, "2026-09-27T10-00-00Z"));
    expect(readdirSync(dir).sort()).toEqual([
      "inbox-triage.json",
      "summary.json",
      "summary.md",
      "weekly-report.json",
    ]);
    const scenario = JSON.parse(readFileSync(join(dir, "inbox-triage.json"), "utf8"));
    expect(scenario.runs).toHaveLength(2);
    expect(scenario.passed).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"))).toEqual(summary);
    expect(readFileSync(join(dir, "summary.md"), "utf8")).toBe(renderSummaryMarkdown(summary));
  });
});
