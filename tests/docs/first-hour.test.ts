/**
 * docs/getting-started/first-hour.md, followed as written. Every block marked `<!-- run -->`
 * runs in order with the in-process CLI in a temp engine home (and an empty package root):
 * `serve` starts first, in the background, the way the page says, so every later command and
 * the agent go through it. Each `<!-- agent: <step> -->` runs that prompt's MCP calls through
 * `openoutbound mcp --workspace northwind` (tests/e2e/tour-agent.ts). Every command must exit 0
 * and print each "You should see" line (`...` stands for any text, runs of spaces count as one).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CliDeps } from "../../src/cli/context.js";
import type { CliIO } from "../../src/cli/io.js";
import { runCli } from "../../src/cli/program.js";
import type { Engine } from "../../src/core/engine.js";
import { workspaces } from "../../src/db/schema/index.js";
import { readServerLock } from "../../src/http/lock-file.js";
import { cliArguments } from "../../src/testing/cli-commands.js";
import { createTestEngine, type TestEngine } from "../../src/testing/engine.js";
import { agentSession, TOUR_AGENT_STEPS, type TourState } from "../e2e/tour-agent.js";

const PAGE = fileURLToPath(new URL("../../docs/getting-started/first-hour.md", import.meta.url));
/** The address the page shows; the test's server listens on a free port instead. */
const PAGE_URL = "http://127.0.0.1:7331";

type Step =
  | { kind: "run"; line: number; commands: string[]; expected: string[] }
  | { kind: "agent"; line: number; step: string };

/** The page's marked command blocks and agent steps, in order, with their "You should see" lines. */
function pageSteps(text: string): Step[] {
  const lines = text.split("\n");
  const steps: Step[] = [];
  const fenceAt = (from: number) => lines.findIndex((line, i) => i >= from && /^```/.test(line));
  const blockAt = (open: number): { body: string[]; end: number } => {
    const end = lines.findIndex((line, i) => i > open && /^```\s*$/.test(line));
    return { body: lines.slice(open + 1, end), end };
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const agent = /^<!-- agent: ([a-z-]+) -->$/.exec(line.trim());
    if (agent) {
      steps.push({ kind: "agent", line: i + 1, step: agent[1] as string });
      continue;
    }
    if (line.trim() !== "<!-- run -->") continue;
    const open = fenceAt(i + 1);
    const { body, end } = blockAt(open);
    const commands = body
      .map((entry) => entry.trim())
      .filter((entry) => entry && !entry.startsWith("#"));
    // "You should see:" and a text block, before the next marker or heading.
    let expected: string[] = [];
    for (let j = end + 1; j < lines.length; j++) {
      const next = (lines[j] as string).trim();
      if (next.startsWith("<!--") || next.startsWith("#")) break;
      if (next.startsWith("You should see")) {
        const text = fenceAt(j + 1);
        expected = blockAt(text).body.filter((entry) => entry.trim() !== "");
        break;
      }
    }
    steps.push({ kind: "run", line: i + 1, commands, expected });
    i = end;
  }
  return steps;
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** Whether one output line holds the expected line's parts, in order (`...` is any text). */
function showsLine(output: string, expected: string): boolean {
  const parts = expected
    .split("...")
    .map(squash)
    .filter((part) => part !== "");
  return output.split("\n").some((raw) => {
    const line = squash(raw);
    let from = 0;
    for (const part of parts) {
      const at = line.indexOf(part, from);
      if (at === -1) return false;
      from = at + part.length;
    }
    return true;
  });
}

let engine: TestEngine;
let home = "";
let packageRoot = "";
const dirs: string[] = [];
let stopServe: (() => void) | null = null;
let serveDone: Promise<number> | null = null;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** One engine behind every command: closing it and starting or stopping its worker do nothing. */
function shared(target: TestEngine): Engine {
  return new Proxy(target, {
    get(object, property, receiver) {
      if (property === "close" || property === "startWorker" || property === "stopWorker") {
        return async () => {};
      }
      return Reflect.get(object, property, receiver);
    },
  });
}

function deps(io?: CliIO): CliDeps {
  return {
    ...(io ? { io } : {}),
    env: {},
    cwd: home,
    chdir: () => {},
    packageRoot,
    scriptPath: join(home, "dist", "cli", "main.js"),
    createEngine: async () => shared(engine),
  };
}

function captureIO(): { io: CliIO; out: { text: string } } {
  const out = { text: "" };
  const write = (text: string) => {
    out.text += text;
  };
  return {
    out,
    io: { stdout: write, stderr: write, stdoutIsTTY: false, stderrIsTTY: false },
  };
}

/** The worker's minute or two between two steps: campaign ticks, writing and sending. */
async function letTimePass(): Promise<void> {
  for (let i = 0; i < 2; i++) {
    engine.advance(61_000);
    await engine.runJobs({ max: 500 });
  }
}

/** `serve` as the page starts it, in the background until the test ends (on a free port). */
async function startServe(args: string[]): Promise<string> {
  const { io, out } = captureIO();
  const stopped = new Promise<void>((resolve) => {
    stopServe = resolve;
  });
  serveDone = runCli([...args, "--port", "0"], {
    ...deps(io),
    waitForShutdown: () => stopped,
  });
  const lockDir = join(home, ".openoutbound");
  for (let i = 0; i < 200 && !readServerLock(lockDir); i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const lock = readServerLock(lockDir);
  expect(lock, out.text).not.toBeNull();
  return out.text.replaceAll(lock?.url ?? PAGE_URL, PAGE_URL);
}

beforeAll(async () => {
  home = tempDir("oo-first-hour-");
  packageRoot = tempDir("oo-first-hour-pkg-");
  // A Tuesday afternoon in UTC: inside the send window of the leads the agent picks.
  engine = await createTestEngine({
    now: "2026-09-22T15:00:00Z",
    config: { stateDir: join(home, ".openoutbound") },
  });
});

afterAll(async () => {
  stopServe?.();
  if (serveDone) await serveDone;
  await engine?.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("docs/getting-started/first-hour.md", () => {
  const steps = pageSteps(readFileSync(PAGE, "utf8"));

  it("says why a lead gets no email and what else stops the agent's tools", () => {
    const page = readFileSync(PAGE, "utf8");
    // Leads without an email address skip the email steps (missing_data: skip_step).
    expect(page).toContain("A lead without one skips the email steps");
    expect(page).toContain(
      "`node dist/cli/main.js operating explain --workspace northwind --person-id <person id>`",
    );
    const noTools = page.split("\n").find((line) => line.startsWith("| The agent lists no"));
    expect(noTools).toContain("a second agent session or a CLI command holds the local database");
    expect(noTools).toContain("Start `node dist/cli/main.js serve` first");
  });

  it("marks the whole path: init, sandbox, serve, the agent, approvals, simulate, readiness", () => {
    const commands = steps.flatMap((step) => (step.kind === "run" ? step.commands : []));
    for (const words of [
      "init",
      "sandbox",
      "serve",
      "approvals list",
      "approvals decide",
      "sandbox simulate",
      "workspaces readiness",
      "doctor",
    ]) {
      expect(
        commands.some((command) => command.includes(`main.js ${words}`)),
        words,
      ).toBe(true);
    }
    const agentSteps = steps.flatMap((step) => (step.kind === "agent" ? [step.step] : []));
    expect(agentSteps).toEqual(Object.keys(TOUR_AGENT_STEPS));
    for (const step of steps) {
      if (step.kind === "run") expect(step.expected.length, `line ${step.line}`).toBeGreaterThan(0);
    }
  });

  it("works when followed in order", async () => {
    const state: TourState = { campaignId: "", launchApproval: "" };
    /** Approval ids of the last `approvals list`, for `<approval id>` and `<approval ids>`. */
    let listed: string[] = [];
    for (const step of steps) {
      if (step.kind === "agent") {
        const work = TOUR_AGENT_STEPS[step.step];
        expect(work, `line ${step.line}: unknown agent step ${step.step}`).toBeDefined();
        const stderr = await agentSession(deps(), async (call) => work?.(call, state));
        // `serve` runs, so the agent's session goes through it.
        expect(stderr, `line ${step.line}`).toContain("bridge mode");
        if (step.step === "propose-campaign") {
          // The page quotes the launch answer word for word.
          const quote = /instead of a launch: `([^`]+)`/.exec(readFileSync(PAGE, "utf8"))?.[1];
          expect(quote, "the launch answer quoted on the page").toBeDefined();
          expect(state.launchAnswer).toContain(quote);
        }
        await letTimePass();
        continue;
      }
      let output = "";
      for (const command of step.commands) {
        const args = (cliArguments(command) ?? []).flatMap((arg) =>
          arg === "<approval id>"
            ? [listed[0] ?? arg]
            : arg === "<approval ids>"
              ? [listed.join(",")]
              : [arg],
        );
        expect(args.length, `line ${step.line}: ${command}`).toBeGreaterThan(0);
        if (args[0] === "serve") {
          output += await startServe(args);
          continue;
        }
        const { io, out } = captureIO();
        const code = await runCli(args, deps(io));
        const lock = readServerLock(join(home, ".openoutbound"));
        const text = lock ? out.text.replaceAll(lock.url, PAGE_URL) : out.text;
        expect(code, `line ${step.line}: ${command}\n${text}`).toBe(0);
        output += text;
        if (args[0] === "init") {
          // `init` created "default" in its own database; the engine behind the rest is this one.
          await engine.db.insert(workspaces).values({ slug: "default", name: "Default" });
        }
        if (args[0] === "approvals" && args[1] === "list") {
          listed = [...new Set(text.match(/apr_[0-9a-z]+/g) ?? [])];
        }
        await letTimePass();
      }
      for (const expected of step.expected) {
        expect(
          showsLine(output, expected),
          `line ${step.line}: "${expected}" not in the output of ${step.commands.join(" && ")}:\n${output}`,
        ).toBe(true);
      }
    }
    stopServe?.();
    expect(await serveDone).toBe(0);
    expect(existsSync(join(home, ".openoutbound", "server.json"))).toBe(false);
  }, 120_000);
});

describe("the page checks", () => {
  it("match lines in order, with ... for any text", () => {
    expect(showsLine("OK    Wrote /x/.env (added A, B)\n", "OK Wrote ... .env (added A, B)")).toBe(
      true,
    );
    expect(showsLine("approved  1\n", "approved 1")).toBe(true);
    expect(showsLine("approved  2\n", "approved 1")).toBe(false);
    expect(showsLine("b then a\n", "a ... b")).toBe(false);
  });
});
