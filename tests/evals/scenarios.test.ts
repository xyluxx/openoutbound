/**
 * Every eval scenario in scripted mode: the known-good script passes through the real MCP HTTP
 * endpoint with an agent key, on a fresh in-memory database. No model and no network.
 */
import { describe, expect, it } from "vitest";
import { findScenario, SCENARIOS } from "../../evals/scenarios/index.js";
import { failedChecks, runScripted, SCENARIO_TIMEOUT_MS } from "./run-scripted.js";

describe("eval scenarios", () => {
  it("has the twelve scenarios from the briefs, with unique kebab-case ids", () => {
    expect(SCENARIOS.map((scenario) => scenario.id)).toEqual([
      "setup-from-website",
      "import-and-score",
      "find-under-budget",
      "campaign-approval",
      "inbox-triage",
      "weekly-report",
      "custom-signal",
      "limits-and-safety",
      "next-actions-and-proposals",
      "book-after-proposed-time",
      "crm-door",
      "privacy-request",
    ]);
    for (const scenario of SCENARIOS) {
      expect(scenario.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(scenario.assertions.length).toBeGreaterThan(0);
      expect(scenario.rubric.length).toBeGreaterThan(0);
      expect(scenario.maxTurns).toBeGreaterThan(0);
      expect(scenario.toolsets).toMatch(/^[a-z]+(,[a-z]+)*$/);
      expect(findScenario(scenario.id)).toBe(scenario);
    }
    expect(findScenario("no-such-scenario")).toBeUndefined();
  });

  describe("known-good scripts pass", () => {
    for (const scenario of SCENARIOS) {
      it(
        scenario.id,
        async () => {
          const result = await runScripted(scenario);
          expect(result.error).toBeNull();
          expect(failedChecks(result)).toEqual([]);
          expect(result.passed).toBe(true);
          expect(result.checks).toHaveLength(scenario.assertions.length);
          expect(result.tool_calls.length).toBeGreaterThan(0);
          expect(result.final_text.length).toBeGreaterThan(0);
        },
        SCENARIO_TIMEOUT_MS,
      );
    }
  });
});
