/**
 * `tsx evals/run.ts [flags]`: runs scenarios with a runner and writes results.
 *
 *   --runner scripted|claude-cli|codex-cli|anthropic-api   (default scripted)
 *   --scenario <id|all|id,id>                              (default all)
 *   --model <name>        model for the runner (claude alias, codex model, API model id)
 *   --repeat <n>          runs per scenario (default 1)
 *   --toolsets <list>     override the scenario toolsets, e.g. core,leads
 *   --max-turns <n>       override the scenario turn budget
 *   --timeout <seconds>   per-session timeout (default 600, scripted 60)
 *   --out <dir>           results root (default evals/results)
 *   --keep                keep each run's temp directory (database, CLI configs)
 *   --list                list scenarios and exit
 */
import { resolve } from "node:path";
import { writeResults } from "./results.js";
import { runScenario, type ScenarioRunResult } from "./run-scenario.js";
import { createRunner } from "./runners/index.js";
import { RUNNER_NAMES, type RunnerName } from "./runners/types.js";
import type { Scenario } from "./types.js";

export interface CliOptions {
  runner: RunnerName;
  scenarios: string[];
  model: string | undefined;
  repeat: number;
  toolsets: string | undefined;
  maxTurns: number | undefined;
  timeoutMs: number | undefined;
  out: string;
  keep: boolean;
  list: boolean;
}

export class CliUsageError extends Error {}

function positiveInt(flag: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!value || !Number.isInteger(parsed) || parsed < 1) {
    throw new CliUsageError(`${flag} needs a positive whole number (got "${value ?? ""}").`);
  }
  return parsed;
}

/** Parses argv (without node and the script path). Accepts `--flag value` and `--flag=value`. */
export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    runner: "scripted",
    scenarios: ["all"],
    model: undefined,
    repeat: 1,
    toolsets: undefined,
    maxTurns: undefined,
    timeoutMs: undefined,
    out: "evals/results",
    keep: false,
    list: false,
  };
  const args = [...argv];
  while (args.length > 0) {
    const raw = args.shift() as string;
    const [flag, inline] = raw.includes("=") ? raw.split(/=(.*)/s, 2) : [raw, undefined];
    const value = () => {
      const next = inline ?? args.shift();
      if (next === undefined || (inline === undefined && next.startsWith("--"))) {
        throw new CliUsageError(`${flag} needs a value.`);
      }
      return next;
    };
    switch (flag) {
      case "--runner": {
        const runner = value();
        if (!(RUNNER_NAMES as readonly string[]).includes(runner)) {
          throw new CliUsageError(
            `Unknown runner "${runner}". Use one of: ${RUNNER_NAMES.join(", ")}.`,
          );
        }
        options.runner = runner as RunnerName;
        break;
      }
      case "--scenario":
      case "--scenarios":
        options.scenarios = value()
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean);
        break;
      case "--model":
        options.model = value();
        break;
      case "--repeat":
        options.repeat = positiveInt("--repeat", value());
        break;
      case "--toolsets":
        options.toolsets = value();
        break;
      case "--max-turns":
        options.maxTurns = positiveInt("--max-turns", value());
        break;
      case "--timeout":
        options.timeoutMs = positiveInt("--timeout", value()) * 1000;
        break;
      case "--out":
        options.out = value();
        break;
      case "--keep":
        options.keep = true;
        break;
      case "--list":
        options.list = true;
        break;
      case "--help":
      case "-h":
        options.list = true;
        break;
      default:
        throw new CliUsageError(`Unknown flag "${raw}". See evals/README.md for the flags.`);
    }
  }
  return options;
}

/** Scenarios selected by `--scenario` (ids in the given order; `all` = every scenario). */
export function selectScenarios<S extends Pick<Scenario, "id">>(
  all: readonly S[],
  ids: readonly string[],
): S[] {
  if (ids.length === 0 || ids.includes("all")) return [...all];
  return ids.map((id) => {
    const found = all.find((scenario) => scenario.id === id);
    if (!found) {
      throw new CliUsageError(
        `Unknown scenario "${id}". Known: ${all.map((scenario) => scenario.id).join(", ")}.`,
      );
    }
    return found;
  });
}

export async function main(argv: readonly string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
  const { SCENARIOS } = await import("../scenarios/index.js");
  if (options.list) {
    for (const scenario of SCENARIOS) console.log(`${scenario.id.padEnd(22)} ${scenario.title}`);
    return 0;
  }
  let selected: typeof SCENARIOS;
  try {
    selected = selectScenarios(SCENARIOS, options.scenarios);
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }
  const runner = createRunner(options.runner);
  const startedAt = new Date();
  const results: ScenarioRunResult[][] = [];
  for (const scenario of selected) {
    const runs: ScenarioRunResult[] = [];
    for (let attempt = 1; attempt <= options.repeat; attempt++) {
      const result = await runScenario(scenario, {
        runner,
        ...(options.model ? { model: options.model } : {}),
        ...(options.toolsets ? { toolsets: options.toolsets } : {}),
        ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        environment: { keepDir: options.keep },
      });
      runs.push(result);
      const failed = result.checks.filter((check) => !check.passed).map((check) => check.name);
      console.log(
        `${result.passed ? "PASS" : "FAIL"} ${scenario.id}${options.repeat > 1 ? ` #${attempt}` : ""} (${(result.duration_ms / 1000).toFixed(1)}s, ${result.tool_calls.length} tool calls)${failed.length > 0 ? ` failed: ${failed.join("; ")}` : ""}${result.error ? ` error: ${result.error.split("\n")[0]}` : ""}`,
      );
    }
    results.push(runs);
  }
  const { dir, summary } = writeResults(resolve(options.out), results, {
    runner: options.runner,
    model: options.model ?? null,
    startedAt,
  });
  console.log(`\n${summary.totals.passed}/${summary.totals.runs} runs passed. Results: ${dir}`);
  return summary.totals.passed === summary.totals.runs ? 0 : 1;
}
