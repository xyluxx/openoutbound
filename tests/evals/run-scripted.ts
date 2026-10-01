/** Shared helper for scenario tests: one scripted run on a fresh in-memory database clone. */
import { runScenario, type ScenarioRunResult } from "../../evals/harness/run-scenario.js";
import { scriptedRunner } from "../../evals/harness/runners/scripted.js";
import type { Scenario } from "../../evals/harness/types.js";
import { createTestDb } from "../../src/testing/db.js";

/** Generous per-test timeout: a scripted run takes about two seconds. */
export const SCENARIO_TIMEOUT_MS = 120_000;

// biome-ignore lint/suspicious/noExplicitAny: scenarios carry different setup data shapes
export async function runScripted(scenario: Scenario<any>): Promise<ScenarioRunResult> {
  return runScenario(scenario, {
    runner: scriptedRunner,
    environment: { db: await createTestDb() },
  });
}

export function failedChecks(result: ScenarioRunResult): string[] {
  return result.checks.filter((check) => !check.passed).map((check) => check.name);
}
