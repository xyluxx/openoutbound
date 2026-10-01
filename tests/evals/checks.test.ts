import { describe, expect, it } from "vitest";
import {
  callsOf,
  describeCalls,
  failedCalls,
  firstCall,
  isDryRunCall,
  looksLikeMarkdown,
  mentionsAny,
  mentionsNumber,
  mentionsPercent,
  outcome,
  writeCalls,
} from "../../evals/harness/checks.js";
import type { OperationCall } from "../../evals/harness/types.js";
import { check, defineScenario } from "../../evals/harness/types.js";

function call(seq: number, operation: string, extra: Partial<OperationCall> = {}): OperationCall {
  return {
    seq,
    operation,
    tool: null,
    action: null,
    input: {},
    dry_run: undefined,
    reason: undefined,
    outcome: "ok",
    error_code: null,
    error_message: null,
    output: null,
    started_at: "2026-09-27T10:00:00.000Z",
    duration_ms: 1,
    ...extra,
  };
}

const CALLS: OperationCall[] = [
  call(1, "workspaces.status"),
  call(2, "leads.import", { dry_run: true, outcome: "dry_run" }),
  call(3, "leads.import", { outcome: "ok" }),
  call(4, "campaigns.launch", { outcome: "awaiting_approval" }),
  call(5, "campaigns.enroll", { outcome: "error", error_code: "not_contactable" }),
  call(6, "mailboxes.update", { outcome: "error", error_code: "forbidden" }),
  call(7, "leads.find_import", { outcome: "dry_run" }),
];

describe("call helpers", () => {
  it("filters calls by operation and predicate", () => {
    expect(callsOf(CALLS, "leads.import").map((c) => c.seq)).toEqual([2, 3]);
    expect(callsOf(CALLS, "leads.import", (c) => c.outcome === "ok").map((c) => c.seq)).toEqual([
      3,
    ]);
    expect(firstCall(CALLS, "leads.import")?.seq).toBe(2);
    expect(firstCall(CALLS, "leads.import", (c) => !isDryRunCall(c))?.seq).toBe(3);
    expect(firstCall(CALLS, "campaigns.delete")).toBeUndefined();
  });

  it("treats a sent dry_run flag or a dry-run preview as a dry run", () => {
    expect(isDryRunCall(CALLS[1] as OperationCall)).toBe(true);
    expect(isDryRunCall(CALLS[2] as OperationCall)).toBe(false);
    // find_leads import is a dry run by default: no flag sent, preview returned.
    expect(isDryRunCall(CALLS[6] as OperationCall)).toBe(true);
    expect(isDryRunCall(call(9, "leads.import", { dry_run: true, outcome: "error" }))).toBe(true);
  });

  it("finds failed calls, optionally by error code", () => {
    expect(failedCalls(CALLS).map((c) => c.seq)).toEqual([5, 6]);
    expect(failedCalls(CALLS, ["forbidden"]).map((c) => c.seq)).toEqual([6]);
    expect(failedCalls(CALLS, ["budget_exceeded"])).toEqual([]);
  });

  it("keeps the calls whose operation is not read-only", () => {
    const effects: Record<string, string> = {
      "workspaces.status": "read",
      "leads.import": "write",
      "campaigns.launch": "write",
    };
    const engine = {
      registry: {
        operation: (id: string) => (effects[id] ? { effect: effects[id] } : undefined),
      },
    } as never;
    // Unknown operations count as writes (safer for "did not change anything" checks).
    expect(writeCalls(engine, CALLS).map((c) => c.seq)).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it("describes calls for failure messages", () => {
    expect(describeCalls([])).toBe("no calls");
    expect(describeCalls(CALLS.slice(1, 3))).toBe(
      "leads.import (dry run) -> dry_run; leads.import -> ok",
    );
    expect(describeCalls([CALLS[4] as OperationCall])).toBe(
      "campaigns.enroll -> error not_contactable",
    );
  });
});

describe("text helpers", () => {
  it("matches words case-insensitively and regular expressions as given", () => {
    const text = "The launch is Awaiting Approval.\nNothing was sent.";
    expect(mentionsAny(text, ["awaiting approval"])).toBe(true);
    expect(mentionsAny(text, ["approved", "rejected"])).toBe(false);
    expect(mentionsAny(text, [/nothing was sent/i])).toBe(true);
    expect(mentionsAny("It isn’t sent", ["isn't"])).toBe(true);
    expect(mentionsAny("two\n  spaces", ["two spaces"])).toBe(true);
  });

  it("finds whole numbers, with or without thousands separators", () => {
    expect(mentionsNumber("Sent 1,234 emails", 1234)).toBe(true);
    expect(mentionsNumber("Sent 1234 emails", 1234)).toBe(true);
    expect(mentionsNumber("Sent 12345 emails", 1234)).toBe(false);
    expect(mentionsNumber("Reply rate 4.5 percent", 4)).toBe(false);
    expect(mentionsNumber("8 of 16 credits", 16)).toBe(true);
    expect(mentionsNumber("0 left", 0)).toBe(true);
    expect(mentionsNumber("Reply rate 4.5", 4.5)).toBe(true);
  });

  it("finds percentages with one decimal", () => {
    expect(mentionsPercent("Reply rate: 25%", 25)).toBe(true);
    expect(mentionsPercent("Reply rate: 25.0 %", 25)).toBe(true);
    expect(mentionsPercent("Reply rate: 12.5 percent", 12.49)).toBe(true);
    expect(mentionsPercent("Reply rate: 125%", 25)).toBe(false);
    expect(mentionsPercent("25 replies", 25)).toBe(false);
  });

  it("recognizes markdown by headings, tables or lists", () => {
    expect(looksLikeMarkdown("# Weekly report\nAll good")).toBe(true);
    expect(looksLikeMarkdown("| a | b |\n| --- | --- |")).toBe(true);
    expect(looksLikeMarkdown("- one\n- two")).toBe(true);
    expect(looksLikeMarkdown("1. one\n2. two")).toBe(true);
    expect(looksLikeMarkdown("Just a sentence.\n- one item")).toBe(false);
  });

  it("builds check outcomes with a detail only on failure", () => {
    expect(outcome(true, "unused")).toEqual({ passed: true });
    expect(outcome(false, "why")).toEqual({ passed: false, detail: "why" });
  });
});

describe("scenario helpers", () => {
  it("defineScenario and check are typed identities", async () => {
    const named = check<{ n: number }>("has n", ({ data }) => data.n > 0);
    const scenario = defineScenario<{ n: number }>({
      id: "example",
      title: "Example",
      prompt: (data) => `n is ${data.n}`,
      toolsets: "core",
      maxTurns: 3,
      rubric: ["Says n."],
      setup: async () => ({ workspace: "northwind", data: { n: 1 } }),
      script: async () => "n is 1",
      assertions: [named],
    });
    expect(scenario.assertions[0]).toBe(named);
    expect(typeof scenario.prompt === "function" && scenario.prompt({ n: 2 })).toBe("n is 2");
    expect(await named.run({ data: { n: 1 } } as never)).toBe(true);
  });
});
