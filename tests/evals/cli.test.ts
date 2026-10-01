import { afterEach, describe, expect, it, vi } from "vitest";
import { CliUsageError, main, parseArgs, selectScenarios } from "../../evals/harness/cli.js";
import { SCENARIOS } from "../../evals/scenarios/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseArgs", () => {
  it("defaults to every scenario once with the scripted runner", () => {
    expect(parseArgs([])).toEqual({
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
    });
  });

  it("reads every flag, as --flag value and --flag=value", () => {
    expect(
      parseArgs([
        "--runner",
        "claude-cli",
        "--scenario=inbox-triage, weekly-report",
        "--model",
        "sonnet",
        "--repeat",
        "3",
        "--toolsets=core,leads",
        "--max-turns",
        "12",
        "--timeout=90",
        "--out",
        "tmp/evals",
        "--keep",
      ]),
    ).toEqual({
      runner: "claude-cli",
      scenarios: ["inbox-triage", "weekly-report"],
      model: "sonnet",
      repeat: 3,
      toolsets: "core,leads",
      maxTurns: 12,
      timeoutMs: 90_000,
      out: "tmp/evals",
      keep: true,
      list: false,
    });
    expect(parseArgs(["--list"]).list).toBe(true);
    expect(parseArgs(["-h"]).list).toBe(true);
    expect(parseArgs(["--runner=codex-cli"]).runner).toBe("codex-cli");
    expect(parseArgs(["--runner", "anthropic-api"]).runner).toBe("anthropic-api");
  });

  it("rejects unknown runners, flags and bad numbers with a usage error", () => {
    expect(() => parseArgs(["--runner", "gpt"])).toThrow(CliUsageError);
    expect(() => parseArgs(["--runner", "gpt"])).toThrow(/Unknown runner "gpt"/);
    expect(() => parseArgs(["--verbose"])).toThrow(/Unknown flag "--verbose"/);
    expect(() => parseArgs(["--repeat", "0"])).toThrow(/positive whole number/);
    expect(() => parseArgs(["--repeat", "1.5"])).toThrow(/positive whole number/);
    expect(() => parseArgs(["--model"])).toThrow(/--model needs a value/);
    expect(() => parseArgs(["--model", "--keep"])).toThrow(/--model needs a value/);
  });
});

describe("selectScenarios", () => {
  const all = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("returns every scenario for all or an empty list", () => {
    expect(selectScenarios(all, ["all"])).toEqual(all);
    expect(selectScenarios(all, [])).toEqual(all);
  });

  it("keeps the requested order and rejects unknown ids", () => {
    expect(selectScenarios(all, ["c", "a"]).map((s) => s.id)).toEqual(["c", "a"]);
    expect(() => selectScenarios(all, ["d"])).toThrow(/Unknown scenario "d". Known: a, b, c./);
  });
});

describe("main", () => {
  it("lists the scenarios", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["--list"])).toBe(0);
    const lines = log.mock.calls.map((args) => String(args[0]));
    expect(lines).toHaveLength(SCENARIOS.length);
    expect(lines[0]).toBe(`${"setup-from-website".padEnd(22)} ${SCENARIOS[0]?.title}`);
  });

  it("exits 2 on usage errors without running anything", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["--runner", "nope"])).toBe(2);
    expect(await main(["--scenario", "nope"])).toBe(2);
    expect(error.mock.calls.map((args) => String(args[0]))).toEqual([
      expect.stringContaining('Unknown runner "nope"'),
      expect.stringContaining('Unknown scenario "nope"'),
    ]);
  });
});
