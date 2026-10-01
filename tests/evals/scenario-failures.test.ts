/**
 * The checks have teeth: an agent that does nothing fails every scenario, and an agent that
 * ignores the credit budget is refused by the engine and fails the scenario. Scripted runs, no
 * model, no network.
 */
import { describe, expect, it } from "vitest";
import type { ScriptAgent, ToolResult } from "../../evals/harness/types.js";
import { findUnderBudget } from "../../evals/scenarios/find-under-budget.js";
import { SCENARIOS } from "../../evals/scenarios/index.js";
import { failedChecks, runScripted, SCENARIO_TIMEOUT_MS } from "./run-scripted.js";

describe("eval scenarios reject bad runs", () => {
  describe("an agent that does nothing fails", () => {
    for (const scenario of SCENARIOS) {
      it(
        scenario.id,
        async () => {
          const result = await runScripted({ ...scenario, script: async () => "Done." });
          expect(result.error).toBeNull();
          expect(result.tool_calls).toEqual([]);
          expect(result.passed).toBe(false);
          expect(failedChecks(result).length).toBeGreaterThan(0);
        },
        SCENARIO_TIMEOUT_MS,
      );
    }
  });

  it(
    "an agent that imports past the credit budget without a dry run is refused and fails",
    async () => {
      let refusal: ToolResult["error"] = null;
      const careless = {
        ...findUnderBudget,
        // biome-ignore lint/suspicious/noExplicitAny: the budget scenario's setup data
        async script(agent: ScriptAgent<any>) {
          const found = await agent.ok("find_leads", {
            action: "search",
            source: "apollo",
            kind: "people",
            titles: ["VP Operations", "Head of Operations"],
            limit: 25,
          });
          const imported = await agent.call("find_leads", {
            action: "import",
            preview_id: found.preview_id,
            top_n: 10,
            list_name: "Ops leaders Q4",
            dry_run: false,
          });
          refusal = imported.error;
          return "Added 10 people to Ops leaders Q4.";
        },
      };
      const result = await runScripted(careless);
      expect(result.error).toBeNull();
      // 8 of the 16 credits are used: the engine refuses before revealing anyone.
      expect(refusal).toMatchObject({
        code: "budget_exceeded",
        message: expect.stringMatching(/needs \d+ credits, 8 left this month \(8 of 16 used\)/),
      });
      const failed = failedChecks(result);
      expect(failed).toEqual(
        expect.arrayContaining([
          "added new leads to the list",
          "reports the credits used and what is left",
        ]),
      );
      expect(failed).not.toContain("stayed within the monthly credit budget");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
