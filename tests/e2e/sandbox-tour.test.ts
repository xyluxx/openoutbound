/**
 * The first-hour tour, end to end: the agent works in the sandbox through embedded MCP with
 * `--workspace northwind`, its launch waits for a person, the person approves from the CLI,
 * `sandbox simulate` reports what was sent (to the simulator) and readiness says the sandbox never
 * sends for real.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CliDeps } from "../../src/cli/context.js";
import type { CliIO } from "../../src/cli/io.js";
import { runCli } from "../../src/cli/program.js";
import type { Engine } from "../../src/core/engine.js";
import { createTestEngine, type TestEngine } from "../../src/testing/engine.js";
import { agentSession, TOUR_AGENT_STEPS, type TourState } from "./tour-agent.js";

let engine: TestEngine;
let home = "";
const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** The test engine for every command: closing it and starting or stopping its worker do nothing. */
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

function deps(): CliDeps {
  return {
    env: { DATABASE_URL: "memory://" },
    cwd: home,
    chdir: () => {},
    packageRoot: tempDir("oo-tour-pkg-"),
    scriptPath: join(home, "dist", "cli", "main.js"),
    createEngine: async () => shared(engine),
  };
}

/** One CLI command as the person runs it; then a minute passes (campaign tick, sends). */
async function person(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = { stdout: "", stderr: "" };
  const io: CliIO = {
    stdout: (text) => {
      out.stdout += text;
    },
    stderr: (text) => {
      out.stderr += text;
    },
    stdoutIsTTY: false,
    stderrIsTTY: false,
  };
  const code = await runCli(argv, { ...deps(), io });
  engine.advance(61_000);
  await engine.runJobs({ max: 500 });
  return { code, ...out };
}

beforeAll(async () => {
  home = tempDir("oo-tour-");
  // A Tuesday afternoon in UTC: inside the send window of the leads the agent picks.
  engine = await createTestEngine({ now: "2026-09-22T15:00:00Z" });
});

afterAll(async () => {
  await engine?.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("the first-hour sandbox tour", () => {
  it("goes from the agent's proposal to the person's decision to simulated sends", async () => {
    const seeded = await person(["sandbox"]);
    expect(seeded.code, seeded.stderr).toBe(0);
    expect(seeded.stdout).toContain("Northwind Analytics (sandbox)  slug northwind, new");

    // The agent (embedded MCP, no server running): read the state, enroll leads, ask to launch.
    const state: TourState = { campaignId: "", launchApproval: "" };
    const session = await agentSession(deps(), async (call) => {
      for (const step of ["operating-state", "propose-campaign", "list-approvals"]) {
        await TOUR_AGENT_STEPS[step]?.(call, state);
      }
    });
    expect(session).toContain("embedded mode");

    // The person: see what the agent asked for and approve it from the CLI.
    const list = await person(["approvals", "list", "--workspace", "northwind"]);
    expect(list.stdout).toContain(state.launchApproval);
    expect(list.stdout).toContain('Launch campaign "Signal-triggered ops outreach"');
    expect(list.stdout).toContain("Local agent (agent)");
    const decided = await person([
      "approvals",
      "decide",
      "--workspace",
      "northwind",
      "--approval-id",
      state.launchApproval,
      "--decision",
      "approve",
    ]);
    expect(decided.code, decided.stderr).toBe(0);
    expect(decided.stdout).toMatch(/^approved\s+1$/m);

    // Review level first: the first email of each lead waits for the person.
    await person([
      "campaigns",
      "get",
      "--workspace",
      "northwind",
      "--campaign-id",
      state.campaignId,
    ]);
    const messages = await person([
      "approvals",
      "list",
      "--workspace",
      "northwind",
      "--kind",
      "message",
      "--json",
    ]);
    const pending = (JSON.parse(messages.stdout) as { items: Array<{ id: string }> }).items;
    expect(pending.length).toBeGreaterThan(0);
    const approved = await person([
      "approvals",
      "decide",
      "--workspace",
      "northwind",
      "--approval-ids",
      pending.map((item) => item.id).join(","),
      "--decision",
      "approve",
    ]);
    expect(approved.stdout).toMatch(new RegExp(`^approved\\s+${pending.length}$`, "m"));

    // What went out, to the simulator only.
    const simulated = await person(["sandbox", "simulate", "--workspace", "northwind"]);
    expect(simulated.code, simulated.stderr).toBe(0);
    expect(simulated.stdout).toContain("Sent so far, to the simulator (never to a real person):");
    expect(simulated.stderr).toContain(
      "`node dist/cli/main.js messages list --workspace northwind --status sent`",
    );
    const sent = await person([
      "messages",
      "list",
      "--workspace",
      "northwind",
      "--campaign-id",
      state.campaignId,
      "--status",
      "sent",
      "--json",
    ]);
    expect((JSON.parse(sent.stdout) as { items: unknown[] }).items).toHaveLength(pending.length);

    // And nothing in a sandbox ever reaches a real person.
    const readiness = await person(["workspaces", "readiness", "--workspace", "northwind"]);
    expect(readiness.stdout).toContain(
      "Sandbox workspace: nothing it does ever reaches a real person.",
    );
    const json = await person(["workspaces", "readiness", "--workspace", "northwind", "--json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({
      sandbox: true,
      email: { ready: false },
      linkedin: { ready: false },
    });
  });
});
