import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { CliDeps } from "../../src/cli/context.js";
import type { CliIO } from "../../src/cli/io.js";
import { runCli } from "../../src/cli/program.js";
import { loadConfig } from "../../src/core/config.js";
import { createDb, type Db } from "../../src/db/client.js";
import { migrate } from "../../src/db/migrate.js";
import { secrets, workspaces } from "../../src/db/schema/index.js";
import { createHttpApp } from "../../src/http/app.js";
import { readServerLock, writeServerLock } from "../../src/http/lock-file.js";
import { createRuntimeVault } from "../../src/runtime/vault.js";
import { createCommandChecker, shellWords } from "../../src/testing/cli-commands.js";
import {
  createFakeEngine,
  demoModule,
  type FakeEngine,
  fakeWorkspacesModule,
  TEST_KEYS,
} from "./fake-engine.js";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "oo-cli-"));
  dirs.push(dir);
  return dir;
}

interface Captured {
  stdout: string;
  stderr: string;
  code: number;
}

function captureIO(tty = false): { io: CliIO; out: { stdout: string; stderr: string } } {
  const out = { stdout: "", stderr: "" };
  return {
    out,
    io: {
      stdout: (text) => {
        out.stdout += text;
      },
      stderr: (text) => {
        out.stderr += text;
      },
      stdoutIsTTY: tty,
      stderrIsTTY: tty,
    },
  };
}

async function cli(
  argv: string[],
  options: {
    engine?: FakeEngine;
    env?: Record<string, string>;
    cwd?: string;
    tty?: boolean;
    deps?: Partial<CliDeps>;
  } = {},
): Promise<Captured & { engine: FakeEngine }> {
  const engine = options.engine ?? createFakeEngine();
  const { io, out } = captureIO(options.tty);
  const cwd = options.cwd ?? tempDir();
  const code = await runCli(argv, {
    io,
    env: { DATABASE_URL: "memory://", ...options.env },
    cwd,
    chdir: () => {},
    // Never the checkout itself: a `.env` from the developer's own `init` there is not the test's.
    packageRoot: tempDir(),
    registry: engine.registry,
    createEngine: async () => engine,
    ...options.deps,
  });
  return { ...out, code, engine };
}

function routeTo(app: { fetch: (request: Request) => Response | Promise<Response> }) {
  return (async (input: string | URL | Request, init?: RequestInit) =>
    app.fetch(new Request(input, init))) as typeof fetch;
}

describe("generated operation commands", () => {
  it("builds flags from the input schema", async () => {
    const help = await cli(["demo", "list-items", "--help"]);
    expect(help.code).toBe(0);
    for (const flag of [
      "--status <value>",
      "--tags <value>",
      "--min-score <number>",
      "--limit <number>",
      "--cursor <value>",
      "--response-format <value>",
      "--workspace <id|slug>",
      "--input <json|@file>",
      "--json",
    ]) {
      expect(help.stdout).toContain(flag);
    }
    expect(help.stdout.replace(/\s+/g, " ")).toContain('(choices: "open", "done")');
    expect(help.stdout).not.toContain("--dry-run");
    expect(help.stdout).toContain("openoutbound demo list-items --status open --limit 10");
    const create = await cli(["demo", "create-item", "--help"]);
    expect(create.stdout).toContain("--urgent");
    expect(create.stdout).toContain("--no-urgent");
    expect(create.stdout).toContain("--dry-run");
    expect(create.stdout).toContain("--idempotency-key <key>");
    expect(create.stdout).toContain("(required)");
  });

  it("maps flags to typed input and call options", async () => {
    const result = await cli([
      "demo",
      "list-items",
      "--workspace",
      "acme",
      "--status",
      "done",
      "--tags",
      "a",
      "--tags",
      "b",
      "--min-score",
      "5",
      "--json",
    ]);
    expect(result.code).toBe(0);
    const call = result.engine.calls.at(-1);
    expect(call?.operationId).toBe("demo.list_items");
    expect(call?.input).toEqual({ status: "done", tags: ["a", "b"], min_score: 5 });
    expect(call?.options).toMatchObject({
      workspace: "acme",
      principal: { id: "local-admin", via: "cli" },
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ items: [{ id: "it_2" }] });
  });

  it("accepts comma lists, booleans, JSON objects and @files", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "meta.json"), JSON.stringify({ source: "file" }));
    const result = await cli(
      [
        "demo",
        "create-item",
        "--workspace",
        "acme",
        "--name",
        "Gamma",
        "--tags",
        "x,y",
        "--urgent",
        "--meta",
        "@meta.json",
        "--score",
        "7",
        "--json",
      ],
      { cwd },
    );
    expect(result.code).toBe(0);
    expect(result.engine.calls.at(-1)?.input).toEqual({
      name: "Gamma",
      tags: ["x", "y"],
      urgent: true,
      meta: { source: "file" },
      score: 7,
    });
    const negated = await cli([
      "demo",
      "create-item",
      "--workspace",
      "acme",
      "--name",
      "Delta",
      "--no-urgent",
      "--meta",
      '{"a":1}',
    ]);
    expect(negated.engine.calls.at(-1)?.input).toMatchObject({ urgent: false, meta: { a: 1 } });
  });

  it("merges --input (inline or @file) with flags winning", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "input.json"), JSON.stringify({ name: "From file", tags: ["f"] }));
    const inline = await cli([
      "demo",
      "create-item",
      "--workspace",
      "acme",
      "--input",
      '{"name":"Inline","tags":["i"]}',
      "--tags",
      "flag",
    ]);
    expect(inline.engine.calls.at(-1)?.input).toEqual({ name: "Inline", tags: ["flag"] });
    const file = await cli(
      ["demo", "create-item", "--workspace", "acme", "--input", "@input.json"],
      {
        cwd,
      },
    );
    expect(file.engine.calls.at(-1)?.input).toEqual({ name: "From file", tags: ["f"] });
    const bad = await cli(["demo", "create-item", "--input", "[1,2]"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("--input must be a JSON object");
  });

  it("uses global options placed before the command and env defaults", async () => {
    const global = await cli(["--workspace", "globex", "--json", "demo", "list-items"]);
    expect(global.engine.calls.at(-1)?.options.workspace).toBe("globex");
    expect(() => JSON.parse(global.stdout)).not.toThrow();
    const fromEnv = await cli(["demo", "list-items"], { env: { OPENOUTBOUND_WORKSPACE: "acme" } });
    expect(fromEnv.engine.calls.at(-1)?.options.workspace).toBe("acme");
  });

  it("exits 2 on validation and usage errors, 1 on other errors", async () => {
    const invalid = await cli(["demo", "create-item", "--workspace", "acme", "--name", ""]);
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain("Error (validation_failed)");
    expect(invalid.stderr).toContain("Hint:");
    expect(invalid.stdout).toBe("");

    const badNumber = await cli(["demo", "list-items", "--min-score", "lots"]);
    expect(badNumber.code).toBe(2);
    expect(badNumber.stderr).toContain("min_score");

    const badChoice = await cli(["demo", "list-items", "--status", "maybe"]);
    expect(badChoice.code).toBe(2);

    const unknownOption = await cli(["demo", "list-items", "--bogus"]);
    expect(unknownOption.code).toBe(2);

    const missing = await cli(["demo", "get-item", "--workspace", "acme", "--item-id", "it_404"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("Error (not_found): Item it_404 not found.");

    const json = await cli(["demo", "get-item", "--workspace", "acme", "--item-id", "x", "--json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({ error: { code: "not_found" } });
  });

  it("prints tables for lists and hints on stderr", async () => {
    const result = await cli(["demo", "list-items", "--workspace", "acme", "--limit", "1"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^ID\s+NAME\s+STATUS\s+SCORE/m);
    expect(result.stdout).toMatch(/^it_1\s+Alpha\s+open\s+10$/m);
    expect(result.stderr).toContain("Next page: add --cursor 1");
    const one = await cli(["demo", "get-item", "--workspace", "acme", "--item-id", "it_2"]);
    expect(one.stdout).toMatch(/^name\s+Beta$/m);
    expect(one.stdout).toMatch(/^tags\s+a, b$/m);
  });

  it("previews by default for dry-run-default operations", async () => {
    const preview = await cli(["demo", "send-item", "--workspace", "acme", "--item-id", "it_1"]);
    expect(preview.stdout).toContain("Dry run: nothing was written, sent or spent.");
    expect(preview.stderr).toContain("--no-dry-run");
    expect(preview.engine.store.sent).toEqual([]);
    const engine = preview.engine;
    const real = await cli(
      ["demo", "send-item", "--workspace", "acme", "--item-id", "it_1", "--no-dry-run"],
      { engine },
    );
    expect(real.code).toBe(0);
    expect(engine.store.sent).toEqual(["it_1"]);
    const gated = await cli(
      ["demo", "send-item", "--workspace", "acme", "--item-id", "it_big", "--no-dry-run"],
      { engine },
    );
    expect(gated.stdout).toContain("Awaiting approval apr_1");
    expect(gated.stderr).toContain("approvals list");
  });

  it("colors only on a TTY without NO_COLOR", async () => {
    const tty = await cli(["demo", "list-items", "--workspace", "acme"], { tty: true });
    expect(tty.stdout).toContain("\u001b[1m");
    const noColor = await cli(["demo", "list-items", "--workspace", "acme"], {
      tty: true,
      env: { NO_COLOR: "1" },
    });
    expect(noColor.stdout).not.toContain("\u001b[");
    const piped = await cli(["demo", "list-items", "--workspace", "acme"]);
    expect(piped.stdout).not.toContain("\u001b[");
  });

  it("calls a server in bridge mode with --url and --api-key", async () => {
    const server = createFakeEngine();
    const { app, close } = createHttpApp(server);
    closers.push(close);
    const local = createFakeEngine();
    const result = await cli(
      [
        "--url",
        "http://127.0.0.1:7331",
        "--api-key",
        TEST_KEYS.agent,
        "demo",
        "list-items",
        "--workspace",
        "acme",
        "--json",
      ],
      { engine: local, deps: { fetch: routeTo(app) } },
    );
    expect(result.code).toBe(0);
    expect(local.calls).toHaveLength(0);
    expect(server.calls.at(-1)?.options).toMatchObject({
      workspace: "acme",
      principal: { id: "key_agent", via: "http" },
    });
    const denied = await cli(
      ["--url", "http://127.0.0.1:7331", "--api-key", "oo_wrong", "demo", "list-items"],
      { engine: local, deps: { fetch: routeTo(app) } },
    );
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain("Error (unauthorized)");
  });
});

describe("built-in commands", () => {
  it("prints the version", async () => {
    const plain = await cli(["version"]);
    expect(plain.stdout).toMatch(/^openoutbound \d+\.\d+\.\d+/);
    const json = await cli(["--json", "version"]);
    expect(JSON.parse(json.stdout)).toHaveProperty("version");
    const after = await cli(["version", "--json"]);
    expect(JSON.parse(after.stdout)).toHaveProperty("version");
    const flag = await cli(["--version"]);
    expect(flag.code).toBe(0);
  });

  it("writes the OpenAPI document", async () => {
    const cwd = tempDir();
    const result = await cli(["openapi", "--out", "openapi.json"], { cwd });
    expect(result.code).toBe(0);
    const doc = JSON.parse(readFileSync(join(cwd, "openapi.json"), "utf8")) as { openapi: string };
    expect(doc.openapi).toBe("3.1.0");
  });

  it("init writes .env without overwriting and prints the agent commands", async () => {
    const cwd = tempDir();
    writeFileSync(
      join(cwd, ".env"),
      "OPENOUTBOUND_BASE_URL=https://outbound.example.com\nOPENOUTBOUND_SECRET_KEY=\n",
    );
    const result = await cli(["init"], {
      cwd,
      deps: { scriptPath: "/opt/openoutbound/dist/cli/main.js" },
    });
    expect(result.code).toBe(0);
    const env = readFileSync(join(cwd, ".env"), "utf8");
    expect(env).toContain("OPENOUTBOUND_BASE_URL=https://outbound.example.com");
    expect(env).toMatch(/^OPENOUTBOUND_SECRET_KEY=[A-Za-z0-9+/]{43}=$/m);
    expect(env).toContain("DATABASE_URL=pglite://.openoutbound/pglite");
    expect(result.stdout).toContain('Created workspace "default"');
    // The agent works in the sandbox: without --workspace its calls land in the empty default one.
    expect(result.stdout).toMatch(
      /claude mcp add openoutbound -- node \S*main\.js --home \S+ mcp --workspace northwind$/m,
    );
    expect(result.stdout).toMatch(
      /codex mcp add openoutbound -- node \S*main\.js --home \S+ mcp --workspace northwind$/m,
    );
    // Written so a POSIX shell (Git Bash on Windows) splits it into the same paths.
    const launch = /claude mcp add openoutbound -- (.+)$/m.exec(result.stdout)?.[1] ?? "";
    expect(launch).not.toContain("\\");
    const words = shellWords(launch);
    expect(resolve(words[words.indexOf("--home") + 1] ?? "")).toBe(resolve(cwd));
    const again = await cli(["init"], { cwd });
    expect(again.stdout).toContain("already has every setting");
    expect(readFileSync(join(cwd, ".env"), "utf8")).toBe(env);
  });

  it("init prints next steps in the form that works for how it was started", async () => {
    const nextSteps = (stdout: string) => stdout.slice(stdout.indexOf("Next steps"));
    const viaScript = await cli(["init"], {
      env: { npm_lifecycle_event: "openoutbound", npm_config_user_agent: "pnpm/11.8.0" },
      deps: { scriptPath: "/opt/openoutbound/src/cli/main.ts" },
    });
    expect(viaScript.code).toBe(0);
    const scriptSteps = nextSteps(viaScript.stdout);
    expect(scriptSteps).toMatch(/^ +pnpm openoutbound sandbox$/m);
    expect(scriptSteps).toContain("pnpm openoutbound keys create --name my-agent --kind agent");
    expect(scriptSteps).toContain("pnpm openoutbound serve");
    expect(scriptSteps).toContain("pnpm openoutbound doctor");
    // The order of the first hour: sandbox, serve (first, so the agent bridges to it), agent, doctor.
    const order = [
      "openoutbound sandbox",
      "openoutbound serve",
      "claude mcp add",
      "openoutbound doctor",
    ];
    const positions = order.map((words) => scriptSteps.indexOf(words));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(scriptSteps).toContain("docs/getting-started/first-hour.md");
    // No bare `openoutbound <command>`: a clone has no global binary.
    expect(scriptSteps).not.toMatch(/(?<!pnpm )\bopenoutbound (sandbox|keys|serve|doctor)/);

    const cwd = tempDir();
    const viaNode = await cli(["init", "--home", "engine"], {
      cwd,
      deps: { scriptPath: "/opt/openoutbound/dist/cli/main.js" },
    });
    expect(viaNode.code).toBe(0);
    const nodeSteps = nextSteps(viaNode.stdout).replaceAll("\\", "/");
    expect(nodeSteps).toMatch(
      /^ +node \S*\/opt\/openoutbound\/dist\/cli\/main\.js --home \S*\/engine sandbox$/m,
    );
    expect(nodeSteps).toMatch(/node \S*main\.js --home \S*\/engine doctor/);
    // The MCP launch lines stay as they were.
    expect(nodeSteps).toMatch(/claude mcp add openoutbound -- node \S*main\.js --home \S+ mcp/);

    const installed = await cli(["init"], {
      deps: { scriptPath: "/usr/local/bin/openoutbound" },
    });
    expect(nextSteps(installed.stdout)).toMatch(/^ +openoutbound sandbox$/m);
  });

  it("doctor reports checks with fixes and exit codes", async () => {
    const cwd = tempDir();
    const ok = await cli(["doctor", "--json"], { cwd });
    const report = JSON.parse(ok.stdout) as {
      ok: boolean;
      checks: Array<{ status: string; label: string; fix?: string }>;
    };
    expect(report.checks.find((c) => c.label.startsWith("Node.js"))?.status).toBe("ok");
    expect(report.checks.some((c) => c.label.includes("Engine home"))).toBe(true);
    expect(report.checks.find((c) => c.label.includes("No .env"))?.fix).toContain(
      "openoutbound init",
    );
    expect(ok.code).toBe(report.ok ? 0 : 1);

    const broken = await cli(["doctor"], { cwd, env: { DATABASE_URL: "mysql://nope" } });
    expect(broken.code).toBe(1);
    expect(broken.stdout).toContain("FAIL  Configuration invalid");
    expect(broken.stdout).toContain("Fix:");
  });

  it("doctor writes its fixes in the form that works for how it was started", async () => {
    const noEnvFix = (stdout: string) =>
      (
        (JSON.parse(stdout) as { checks: Array<{ label: string; fix?: string }> }).checks.find(
          (check) => check.label.includes("No .env"),
        )?.fix ?? ""
      ).replaceAll("\\", "/");

    const viaNode = await cli(["doctor", "--json"], {
      cwd: tempDir(),
      deps: { scriptPath: "/opt/openoutbound/dist/cli/main.js" },
    });
    expect(noEnvFix(viaNode.stdout)).toMatch(
      /`node \S*\/opt\/openoutbound\/dist\/cli\/main\.js (--home \S+ )?init`/,
    );

    const viaScript = await cli(["doctor", "--json"], {
      cwd: tempDir(),
      env: { npm_lifecycle_event: "openoutbound", npm_config_user_agent: "pnpm/11.8.0" },
      deps: { scriptPath: "/opt/openoutbound/src/cli/main.ts" },
    });
    expect(noEnvFix(viaScript.stdout)).toMatch(/`pnpm openoutbound (--home \S+ )?init`/);
    // A clone has no global binary, so no fix may start with a bare `openoutbound`.
    expect(viaNode.stdout).not.toMatch(/`openoutbound /);
    expect(viaScript.stdout).not.toMatch(/`openoutbound /);
  });

  it("rejects a --home that does not exist", async () => {
    const result = await cli(["--home", join(tempDir(), "missing"), "doctor"], {
      deps: { scriptPath: "/opt/openoutbound/dist/cli/main.js" },
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("does not exist");
    // The fix is written for how the CLI was started, with one --home only.
    expect(result.stderr).toMatch(/`node \S*main\.js init --home <dir>`/);
  });

  it("writes hints and errors in the command the person runs", async () => {
    const deps = { scriptPath: "/opt/openoutbound/dist/cli/main.js" };
    const held = await cli(
      ["demo", "send-item", "--workspace", "acme", "--item-id", "it_big", "--no-dry-run"],
      { deps },
    );
    expect(held.code).toBe(0);
    expect(held.stderr).toMatch(/`node \S*main\.js approvals list --workspace acme`/);
    expect(held.stderr).not.toContain("`openoutbound ");
    // --json output is data for scripts: never rewritten.
    const json = await cli(
      ["demo", "send-item", "--workspace", "acme", "--item-id", "it_big", "--no-dry-run", "--json"],
      { deps },
    );
    expect(JSON.parse(json.stdout)).toMatchObject({ status: "awaiting_approval" });
  });

  it("says which process holds the embedded database and to start serve first", async () => {
    const { acquirePgliteLock, pgliteLockPath } = await import("../../src/db/pglite-lock.js");
    const { spawn } = await import("node:child_process");
    const home = tempDir();
    const dataDir = join(home, ".openoutbound", "pglite");
    mkdirSync(join(home, ".openoutbound"), { recursive: true });
    const agent = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
    closers.push(async () => {
      agent.kill();
    });
    writeFileSync(
      pgliteLockPath(dataDir),
      JSON.stringify({
        pid: agent.pid,
        started_at: new Date().toISOString(),
        command: `--home ${home} mcp --workspace northwind`,
      }),
    );
    const result = await cli(["demo", "list-items", "--workspace", "acme"], {
      cwd: home,
      env: { DATABASE_URL: "pglite://.openoutbound/pglite" },
      deps: {
        scriptPath: join(home, "dist", "cli", "main.js"),
        createEngine: async () => {
          acquirePgliteLock(dataDir);
          throw new Error("the lock should have refused");
        },
      },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `Error (conflict): Your agent's OpenOutbound session (pid ${agent.pid}`,
    );
    expect(result.stderr).toContain("start `node dist/cli/main.js serve` in its own terminal");
    expect(result.stderr).not.toContain("DATABASE_URL");
  });

  it("accepts --home after the command too", async () => {
    const cwd = tempDir();
    const init = await cli(["init", "--home", "engine"], { cwd });
    expect(init.code).toBe(0);
    expect(existsSync(join(cwd, "engine", ".env"))).toBe(true);
    const doctor = await cli(["doctor", "--home", join(cwd, "engine"), "--json"], { cwd });
    const report = JSON.parse(doctor.stdout) as { checks: Array<{ label: string }> };
    expect(report.checks.find((c) => c.label.includes("Engine home"))?.label).toContain("engine");
    const op = await cli(
      ["demo", "list-items", "--home", join(cwd, "engine"), "--workspace", "acme", "--json"],
      { cwd },
    );
    expect(op.code).toBe(0);
    const migrate = await cli(["db", "migrate", "--home", join(cwd, "engine")], { cwd });
    expect(migrate.stderr).not.toContain("unknown option");
  });
});

describe("doctor", () => {
  interface Report {
    ok: boolean;
    checks: Array<{ status: string; label: string; fix?: string }>;
  }
  const report = (stdout: string) => JSON.parse(stdout) as Report;
  const find = (checks: Report["checks"], words: string) =>
    checks.find((check) => check.label.includes(words));

  /** A home whose PGlite database belongs to a running server (a real engine behind it). */
  async function homeWithServer() {
    const home = tempDir();
    mkdirSync(join(home, ".openoutbound"), { recursive: true });
    writeFileSync(join(home, ".env"), "DATABASE_URL=pglite://.openoutbound/pglite\n");
    const { createTestEngine } = await import("../../src/testing/engine.js");
    const engine = await createTestEngine();
    closers.push(() => engine.close());
    const localKeys = { admin: "oo_local_admin_doctor", agent: "oo_local_agent_doctor" };
    const { app, close } = createHttpApp(engine, { localKeys });
    closers.push(close);
    writeServerLock(join(home, ".openoutbound"), {
      url: "http://127.0.0.1:7997",
      pid: process.pid,
      started_at: new Date().toISOString(),
      local_keys: localKeys,
    });
    const deps = { fetch: routeTo(app), scriptPath: join(home, "dist", "cli", "main.js") };
    return { home, engine, deps };
  }

  it("warns that a localhost base URL cannot send real campaign email", async () => {
    const local = report((await cli(["doctor", "--json"])).stdout);
    const warning = find(local.checks, "Base URL http://localhost:7331");
    expect(warning?.status).toBe("warn");
    expect(warning?.label).toContain("not a public https address");
    expect(warning?.fix).toContain("OPENOUTBOUND_BASE_URL");
    const publicUrl = report(
      (
        await cli(["doctor", "--json"], {
          env: { OPENOUTBOUND_BASE_URL: "https://outbound.example.com" },
        })
      ).stdout,
    );
    expect(find(publicUrl.checks, "Base URL https://outbound.example.com")?.status).toBe("ok");
  });

  it("runs the database checks through a running server, with --workspace in every fix", async () => {
    const { home, engine, deps } = await homeWithServer();
    await engine.call("workspaces.create", { name: "Acme Example", slug: "acme" });
    await engine.call("workspaces.create", { name: "Birch Example", slug: "birch" });
    await engine.call("workspaces.pause", {}, { workspace: "birch" });
    const result = await cli(["doctor", "--json"], { cwd: home, env: { DATABASE_URL: "" }, deps });
    const checks = report(result.stdout).checks;
    expect(find(checks, "Server running at http://127.0.0.1:7997")?.status).toBe("ok");
    expect(checks.some((check) => check.label.includes("skipped"))).toBe(false);
    expect(find(checks, "workspace(s):")?.label).toContain("birch [paused]");
    expect(find(checks, "Workspace birch is paused")?.fix).toBe(
      "Resume it with `node dist/cli/main.js workspaces resume --workspace birch` once the reason for the pause is fixed.",
    );
    expect(find(checks, "brain:")?.status).toBe("warn");
    const acme = find(checks, "Sending, acme:");
    expect(acme?.label).toContain("Nothing can reach a real person yet.");
    expect(acme?.fix).toBe("See what is missing: `node dist/cli/main.js doctor --workspace acme`.");
  });

  it("prints one workspace's sending readiness in detail with --workspace", async () => {
    const { home, engine, deps } = await homeWithServer();
    await engine.call("workspaces.create", { name: "Acme Example", slug: "acme" });
    const result = await cli(["doctor", "--workspace", "acme"], {
      cwd: home,
      env: { DATABASE_URL: "" },
      deps,
    });
    expect(result.stdout).toContain("Sending, acme: Nothing can reach a real person yet.");
    expect(result.stdout).toContain("WARN  Email blocked: Mailbox connected:");
    expect(result.stdout).toContain(
      "Fix: Put MAILBOX_<NAME>_PASSWORD=<app password> in the engine's .env first and restart `node dist/cli/main.js serve`",
    );
    expect(result.stdout).toContain(
      "`node dist/cli/main.js mailboxes add --workspace acme --email <address>",
    );
    expect(result.stdout).toContain("WARN  LinkedIn blocked: LinkedIn account connected:");
    expect(result.stdout).toMatch(/INFO {2}Review \(first\): A person approves/);
    const unknown = await cli(["doctor", "--workspace", "nope", "--json"], {
      cwd: home,
      env: { DATABASE_URL: "" },
      deps,
    });
    const missing = find(report(unknown.stdout).checks, "Sending, nope:");
    expect(missing?.status).toBe("fail");

    // A mailbox that can send: campaign email still waits for the base URL, replies go out.
    const { seedMailbox } = await import("../../src/testing/factories.js");
    const [acme] = await engine.db.select().from(workspaces).where(eq(workspaces.slug, "acme"));
    await seedMailbox(
      { db: engine.db, workspace: { id: acme?.id ?? "" } },
      { email: "sam@acme.example.com", provider_label: "custom", auth_type: "password" },
    );
    const sendable = await cli(["doctor", "--workspace", "acme"], {
      cwd: home,
      env: { DATABASE_URL: "" },
      deps,
    });
    expect(sendable.stdout).toContain(
      "Sending, acme: No campaign message can reach a real person yet.",
    );
    expect(sendable.stdout).toContain(
      "INFO  Email replies: Replies to people who wrote to you go out once a person approves them (mailboxes that can send: sam@acme.example.com).",
    );
  });

  /** Problems with the backticked commands in the fixes: unknown commands, flags or choices. */
  function unparsedFixes(checks: Report["checks"]): string[] {
    const check = createCommandChecker();
    const failures: string[] = [];
    for (const entry of checks) {
      for (const span of (entry.fix ?? "").matchAll(/`(node dist\/cli\/main\.js [^`]+)`/g)) {
        const error = check(span[1] as string);
        if (error) failures.push(`${entry.label}: ${span[1]}: ${error}`);
      }
    }
    return failures;
  }

  it("writes mailbox fixes with the workspace and the mailbox id, through the server and without it", async () => {
    const seed = async (db: Db) => {
      const { seedMailbox } = await import("../../src/testing/factories.js");
      const [acme] = await db.select().from(workspaces).where(eq(workspaces.slug, "acme"));
      return seedMailbox(
        { db, workspace: { id: acme?.id ?? "" } },
        {
          email: "sam@acme.example.com",
          provider_label: "custom",
          auth_type: "password",
          status: "error",
          dns: null,
        },
      );
    };
    const expectFixes = (checks: Report["checks"], mailboxId: string) => {
      const target = `--workspace acme --mailbox-id ${mailboxId}`;
      expect(find(checks, "Mailbox sam@acme.example.com is error")?.fix).toBe(
        `Check it with \`node dist/cli/main.js mailboxes test ${target}\` and \`node dist/cli/main.js mailboxes check-dns ${target}\`.`,
      );
      expect(find(checks, "Mailbox sam@acme.example.com: DNS not checked yet")?.fix).toBe(
        `Check it with \`node dist/cli/main.js mailboxes check-dns ${target}\`.`,
      );
      expect(unparsedFixes(checks)).toEqual([]);
    };

    // Through the running server, with a second workspace (a fix without --workspace would fail).
    const server = await homeWithServer();
    await server.engine.call("workspaces.create", { name: "Acme Example", slug: "acme" });
    await server.engine.call("workspaces.create", { name: "Birch Example", slug: "birch" });
    const viaServer = await seed(server.engine.db);
    const served = await cli(["doctor", "--json"], {
      cwd: server.home,
      env: { DATABASE_URL: "" },
      deps: server.deps,
    });
    expectFixes(report(served.stdout).checks, viaServer.id);

    // Straight from the database when no server runs.
    const home = tempDir();
    const env = { DATABASE_URL: "" };
    expect((await cli(["init"], { cwd: home, env })).code).toBe(0);
    const { createEngine } = await import("../../src/index.js");
    const config = () => loadConfig({}, { cwd: home, envFile: join(home, ".env") });
    const engine = await createEngine({ config: config() });
    let mailboxId = "";
    try {
      await engine.call(
        "workspaces.create",
        { name: "Acme Example", slug: "acme" },
        { principal: engine.localPrincipal("admin", "cli") },
      );
      mailboxId = (await seed(engine.db)).id;
    } finally {
      await engine.close();
    }
    const local = await cli(["doctor", "--json"], {
      cwd: home,
      env,
      deps: {
        scriptPath: join(home, "dist", "cli", "main.js"),
        createEngine: (options) => createEngine({ ...options, config: config() }),
      },
    });
    expectFixes(report(local.stdout).checks, mailboxId);
  });

  it("checks sending readiness in process when no server runs", async () => {
    const home = tempDir();
    const env = { DATABASE_URL: "" };
    expect((await cli(["init"], { cwd: home, env })).code).toBe(0);
    const { createEngine } = await import("../../src/index.js");
    const result = await cli(["doctor", "--json"], {
      cwd: home,
      env,
      deps: {
        createEngine: (options) =>
          createEngine({
            ...options,
            config: loadConfig({}, { cwd: home, envFile: join(home, ".env") }),
          }),
      },
    });
    const checks = report(result.stdout).checks;
    expect(find(checks, "Migrations up to date")?.status).toBe("ok");
    expect(find(checks, "Sending, default:")?.label).toContain(
      "Nothing can reach a real person yet.",
    );
  });

  it("says background work waits for serve when no server runs, and warns while work waits", async () => {
    const home = tempDir();
    const env = { DATABASE_URL: "" };
    expect((await cli(["init"], { cwd: home, env })).code).toBe(0);
    const { createEngine } = await import("../../src/index.js");
    const config = () => loadConfig({}, { cwd: home, envFile: join(home, ".env") });
    const deps = {
      scriptPath: join(home, "dist", "cli", "main.js"),
      createEngine: (options?: Parameters<NonNullable<CliDeps["createEngine"]>>[0]) =>
        createEngine({ ...options, config: config() }),
    };
    const doctor = async () => {
      const result = await cli(["doctor", "--json"], { cwd: home, env, deps });
      return find(report(result.stdout).checks, "No server is running");
    };

    const idle = await doctor();
    expect(idle?.status).toBe("info");
    expect(idle?.label).toBe(
      "No server is running: campaigns, sends, reply sync and the sandbox simulator only run while serve (or an agent's embedded session) runs.",
    );
    expect(idle?.fix).toBe(
      "Start it in its own terminal and leave it running: `node dist/cli/main.js serve`.",
    );

    // A launched campaign waits for the worker: nothing is written or sent until serve runs.
    const engine = await createEngine({ config: config() });
    try {
      const { seedCampaign } = await import("../../src/testing/factories.js");
      const [row] = await engine.db.select().from(workspaces).where(eq(workspaces.slug, "default"));
      await seedCampaign({ db: engine.db, workspace: { id: row?.id ?? "" } }, { status: "active" });
    } finally {
      await engine.close();
    }
    const busy = await doctor();
    expect(busy?.status).toBe("warn");
    expect(busy?.label).toBe(
      "No server is running, and 1 active campaign waits for it: campaigns, sends, reply sync and the sandbox simulator only run while serve (or an agent's embedded session) runs.",
    );
    expect(busy?.fix).toBe(idle?.fix);
  });

  it("explains a database held by an agent's session instead of blaming DATABASE_URL", async () => {
    const { pgliteLockPath } = await import("../../src/db/pglite-lock.js");
    const { spawn } = await import("node:child_process");
    const home = tempDir();
    mkdirSync(join(home, ".openoutbound"), { recursive: true });
    writeFileSync(join(home, ".env"), "DATABASE_URL=pglite://.openoutbound/pglite\n");
    const agent = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
    closers.push(async () => {
      agent.kill();
    });
    writeFileSync(
      pgliteLockPath(join(home, ".openoutbound", "pglite")),
      JSON.stringify({ pid: agent.pid, started_at: new Date().toISOString(), command: "mcp" }),
    );
    const result = await cli(["doctor", "--json"], {
      cwd: home,
      env: { DATABASE_URL: "" },
      deps: { scriptPath: join(home, "dist", "cli", "main.js") },
    });
    const held = find(report(result.stdout).checks, "Your agent's OpenOutbound session");
    expect(held?.status).toBe("fail");
    expect(held?.fix).toContain("start `node dist/cli/main.js serve` in its own terminal");
    expect(result.stdout).not.toContain("Check DATABASE_URL");
    // Asked for one workspace's readiness, doctor says it could not check it instead of going quiet.
    const one = await cli(["doctor", "--workspace", "northwind"], {
      cwd: home,
      env: { DATABASE_URL: "" },
      deps: { scriptPath: join(home, "dist", "cli", "main.js") },
    });
    expect(one.stdout).toContain(
      "INFO  Sending, northwind: not checked until the database lines above pass",
    );
  });
});

describe("db reencrypt-secrets", () => {
  const DATABASE_URL = "pglite://.openoutbound/pglite";
  const oldKey = randomBytes(32).toString("base64");
  const newKey = randomBytes(32).toString("base64");
  const rotated = {
    DATABASE_URL,
    OPENOUTBOUND_SECRET_KEY: newKey,
    OPENOUTBOUND_SECRET_KEY_VERSION: "2",
    OPENOUTBOUND_PREVIOUS_SECRET_KEYS: `1:${oldKey}`,
  };

  /** A home whose database holds one secret stored with the old key (version 1). */
  async function homeWithOldSecret(): Promise<{ home: string; secretId: string }> {
    const home = tempDir();
    const config = loadConfig(
      { DATABASE_URL, OPENOUTBOUND_SECRET_KEY: oldKey, LOG_LEVEL: "silent" },
      { cwd: home, envFile: false },
    );
    const handle = await createDb(config);
    try {
      await migrate(handle);
      const vault = createRuntimeVault(handle.db, config);
      const secretId = await vault.putSecret(null, "provider:brain:anthropic:api_key", "sk-fake");
      return { home, secretId };
    } finally {
      await handle.close();
    }
  }

  it("rewrites secrets stored with an older key with the current key", async () => {
    const { home, secretId } = await homeWithOldSecret();
    const result = await cli(["db", "reencrypt-secrets"], { cwd: home, env: rotated });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Re-encrypted 1 secret with key version 2");

    // The new key alone now reads it: the old key is no longer needed for stored secrets.
    const config = loadConfig(
      {
        DATABASE_URL,
        OPENOUTBOUND_SECRET_KEY: newKey,
        OPENOUTBOUND_SECRET_KEY_VERSION: "2",
        LOG_LEVEL: "silent",
      },
      { cwd: home, envFile: false },
    );
    const handle = await createDb(config);
    try {
      expect((await handle.db.select().from(secrets)).map((row) => row.key_version)).toEqual([2]);
      expect(await createRuntimeVault(handle.db, config).getSecret(secretId)).toBe("sk-fake");
    } finally {
      await handle.close();
    }

    const again = await cli(["db", "reencrypt-secrets"], { cwd: home, env: rotated });
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("Every stored secret already uses key version 2");
  });

  it("names the missing old key and changes nothing when a secret cannot be read", async () => {
    const { home } = await homeWithOldSecret();
    const { OPENOUTBOUND_PREVIOUS_SECRET_KEYS: _previous, ...withoutOldKey } = rotated;
    const result = await cli(["db", "reencrypt-secrets"], { cwd: home, env: withoutOldKey });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("key version 1");
    expect(result.stderr).toContain('OPENOUTBOUND_PREVIOUS_SECRET_KEYS="1:<old key>"');

    const config = loadConfig(
      { DATABASE_URL, OPENOUTBOUND_SECRET_KEY: oldKey, LOG_LEVEL: "silent" },
      { cwd: home, envFile: false },
    );
    const handle = await createDb(config);
    try {
      expect((await handle.db.select().from(secrets)).map((row) => row.key_version)).toEqual([1]);
    } finally {
      await handle.close();
    }
  });
});

describe("long-running commands", () => {
  it("serve starts HTTP and the worker, writes and removes server.json", async () => {
    const home = tempDir();
    const engine = createFakeEngine({ cwd: home });
    const stateDir = join(home, ".openoutbound");
    let seen: { health?: unknown; lock?: ReturnType<typeof readServerLock> } = {};
    const result = await cli(["serve", "--port", "0"], {
      engine,
      cwd: home,
      deps: {
        waitForShutdown: async () => {
          const lock = readServerLock(stateDir);
          const health = await fetch(`${lock?.url}/health`).then((r) => r.json());
          seen = { health, lock };
          expect(engine.workerRunning).toBe(true);
        },
      },
    });
    expect(result.code).toBe(0);
    expect(seen.health).toMatchObject({ status: "ok", worker: true });
    expect(seen.lock?.pid).toBe(process.pid);
    expect(seen.lock?.local_keys?.admin).toMatch(/^oo_local_/);
    expect(existsSync(join(stateDir, "server.json"))).toBe(false);
    expect(engine.closed).toBe(true);
    expect(result.stderr).toContain("OpenOutbound is running");
  });

  it("serve rejects bad options before opening the engine", async () => {
    let created = false;
    const deps = {
      createEngine: async () => {
        created = true;
        return createFakeEngine();
      },
    };
    const port = await cli(["serve", "--port", "http"], { deps });
    expect(port.code).toBe(2);
    expect(port.stderr).toContain('Invalid --port "http"');
    const rate = await cli(["serve", "--rate-limit", "fast"], { deps });
    expect(rate.code).toBe(2);
    expect(rate.stderr).toContain("--rate-limit 600");
    expect(created).toBe(false);
  });

  it("mcp runs embedded with the worker for the session", async () => {
    const engine = createFakeEngine();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    let tools: string[] = [];
    const result = await cli(["mcp", "--workspace", "acme", "--toolsets", "core,campaigns"], {
      engine,
      deps: {
        mcpTransport: serverSide,
        waitForShutdown: async () => {
          const client = new Client({ name: "t", version: "1" });
          await client.connect(clientSide);
          tools = (await client.listTools()).tools.map((tool) => tool.name);
          await client.callTool({ name: "manage_items", arguments: { action: "list" } });
          expect(engine.workerRunning).toBe(true);
          await client.close();
        },
      },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(tools).toEqual(["manage_items", "send_item"]);
    expect(engine.calls.at(-1)?.options).toMatchObject({
      workspace: "acme",
      principal: { id: "local-agent", via: "mcp" },
    });
    expect(engine.closed).toBe(true);
  });

  it("mcp switches to bridge mode when a local server owns the PGlite database", async () => {
    const home = tempDir();
    mkdirSync(join(home, ".openoutbound"), { recursive: true });
    writeFileSync(join(home, ".env"), "DATABASE_URL=pglite://.openoutbound/pglite\n");
    const server = createFakeEngine();
    const localKeys = { admin: "oo_local_admin_x", agent: "oo_local_agent_x" };
    const { app, close } = createHttpApp(server, { localKeys });
    closers.push(close);
    writeServerLock(join(home, ".openoutbound"), {
      url: "http://127.0.0.1:7999",
      pid: process.pid,
      started_at: new Date().toISOString(),
      local_keys: localKeys,
    });
    const local = createFakeEngine();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const result = await cli(["mcp", "--workspace", "globex"], {
      engine: local,
      cwd: home,
      env: { DATABASE_URL: "" },
      deps: {
        fetch: routeTo(app),
        mcpTransport: serverSide,
        waitForShutdown: async () => {
          const client = new Client({ name: "t", version: "1" });
          await client.connect(clientSide);
          await client.callTool({ name: "manage_items", arguments: { action: "list" } });
          await client.close();
        },
      },
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("bridge mode");
    expect(local.calls).toHaveLength(0);
    expect(server.calls.at(-1)?.options).toMatchObject({
      workspace: "globex",
      principal: { id: "local-agent" },
    });
  });

  it("mcp --api-key runs the embedded session as that key and refuses an unknown key", async () => {
    const engine = createFakeEngine();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const result = await cli(["mcp", "--api-key", TEST_KEYS.reader, "--workspace", "acme"], {
      engine,
      env: { OPENOUTBOUND_API_KEY: TEST_KEYS.agent },
      deps: {
        mcpTransport: serverSide,
        waitForShutdown: async () => {
          const client = new Client({ name: "t", version: "1" });
          await client.connect(clientSide);
          await client.callTool({ name: "manage_items", arguments: { action: "list" } });
          await client.close();
        },
      },
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("embedded mode");
    expect(result.stderr).toContain("as Reader");
    expect(engine.calls.at(-1)?.options).toMatchObject({
      principal: { id: "key_reader", via: "mcp" },
    });

    const unknown = createFakeEngine();
    const denied = await cli(["mcp", "--api-key", "oo_wrong"], { engine: unknown });
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain("Error (unauthorized)");
    expect(denied.stderr).toContain("--api-key");
    expect(unknown.workerRunning).toBe(false);
    expect(unknown.closed).toBe(true);
  });

  it("mcp --workspace binds the embedded session; OPENOUTBOUND_WORKSPACE is only a default", async () => {
    const engine = createFakeEngine();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    let other: unknown = null;
    let instructions: string | undefined;
    const bound = await cli(["mcp", "--workspace", "acme"], {
      engine,
      deps: {
        mcpTransport: serverSide,
        waitForShutdown: async () => {
          const client = new Client({ name: "t", version: "1" });
          await client.connect(clientSide);
          instructions = client.getInstructions();
          other = await client.callTool({
            name: "manage_items",
            arguments: { action: "list", workspace: "globex" },
          });
          await client.close();
        },
      },
    });
    expect(bound.code).toBe(0);
    expect(bound.stderr).toContain("bound to workspace acme");
    expect(other).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "forbidden", details: { reason: "workspace_scope" } } },
    });
    // The refusal names the bound workspace, and the server instructions say it up front.
    expect(JSON.stringify(other)).toContain('bound to workspace \\"acme\\"');
    expect(instructions).toContain('This session is bound to workspace "acme"');
    expect(engine.calls.at(-1)?.options).toMatchObject({ boundWorkspace: "acme" });

    const unbound = createFakeEngine();
    const [freeClient, freeServer] = InMemoryTransport.createLinkedPair();
    let named: unknown = null;
    const free = await cli(["mcp"], {
      engine: unbound,
      env: { OPENOUTBOUND_WORKSPACE: "acme" },
      deps: {
        mcpTransport: freeServer,
        waitForShutdown: async () => {
          const client = new Client({ name: "t", version: "1" });
          await client.connect(freeClient);
          named = await client.callTool({
            name: "manage_items",
            arguments: { action: "list", workspace: "globex" },
          });
          await client.close();
        },
      },
    });
    expect(free.code).toBe(0);
    expect(free.stderr).not.toContain("bound to workspace");
    expect(named).not.toMatchObject({ isError: true });
    expect(unbound.calls.at(-1)?.options).toMatchObject({ workspace: "globex" });
  });

  it("mcp bridged to a local server acts as the local agent, not OPENOUTBOUND_API_KEY, and --workspace binds it", async () => {
    const home = tempDir();
    mkdirSync(join(home, ".openoutbound"), { recursive: true });
    writeFileSync(join(home, ".env"), "DATABASE_URL=pglite://.openoutbound/pglite\n");
    const server = createFakeEngine({ modules: [demoModule, fakeWorkspacesModule] });
    const localKeys = { admin: "oo_local_admin_y", agent: "oo_local_agent_y" };
    const { app, close } = createHttpApp(server, { localKeys });
    closers.push(close);
    writeServerLock(join(home, ".openoutbound"), {
      url: "http://127.0.0.1:7999",
      pid: process.pid,
      started_at: new Date().toISOString(),
      local_keys: localKeys,
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    let other: unknown = null;
    let sameById: unknown = null;
    const result = await cli(["mcp", "--workspace", "acme"], {
      engine: createFakeEngine(),
      cwd: home,
      env: { DATABASE_URL: "", OPENOUTBOUND_API_KEY: TEST_KEYS.agent },
      deps: {
        fetch: routeTo(app),
        mcpTransport: serverSide,
        waitForShutdown: async () => {
          const client = new Client({ name: "t", version: "1" });
          await client.connect(clientSide);
          await client.callTool({ name: "manage_items", arguments: { action: "list" } });
          other = await client.callTool({
            name: "manage_items",
            arguments: { action: "list", workspace: "globex" },
          });
          sameById = await client.callTool({
            name: "manage_items",
            arguments: { action: "list", workspace: "ws_1" },
          });
          await client.close();
        },
      },
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("bound to workspace acme");
    // The key a person keeps in .env never becomes the agent session's identity.
    expect(result.stderr).toContain(
      "OPENOUTBOUND_API_KEY is only used with --url (or OPENOUTBOUND_URL); running as the local agent",
    );
    const lists = server.calls.filter((call) => call.operationId === "demo.list_items");
    expect(lists.map((call) => call.options.workspace)).toEqual(["acme", "ws_1"]);
    expect(lists[0]?.options).toMatchObject({
      boundWorkspace: "acme",
      principal: { id: "local-agent" },
    });
    expect(other).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "forbidden", details: { reason: "workspace_scope" } } },
    });
    expect(JSON.stringify(other)).toContain('bound to workspace \\"acme\\"');
    expect(sameById).not.toMatchObject({ isError: true });

    // --api-key names the key to act as.
    const [keyClient, keyServer] = InMemoryTransport.createLinkedPair();
    const withKey = await cli(["mcp", "--api-key", TEST_KEYS.reader], {
      engine: createFakeEngine(),
      cwd: home,
      env: { DATABASE_URL: "", OPENOUTBOUND_API_KEY: TEST_KEYS.agent },
      deps: {
        fetch: routeTo(app),
        mcpTransport: keyServer,
        waitForShutdown: async () => {
          const client = new Client({ name: "t", version: "1" });
          await client.connect(keyClient);
          await client.callTool({ name: "manage_items", arguments: { action: "list" } });
          await client.close();
        },
      },
    });
    expect(withKey.code).toBe(0);
    expect(withKey.stderr).not.toContain("OPENOUTBOUND_API_KEY");
    expect(server.calls.at(-1)?.options).toMatchObject({ principal: { id: "key_reader" } });
  });

  it("mcp --url bridges with OPENOUTBOUND_API_KEY", async () => {
    const server = createFakeEngine();
    const { app, close } = createHttpApp(server);
    closers.push(close);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const result = await cli(["mcp", "--url", "http://127.0.0.1:7331", "--workspace", "acme"], {
      engine: createFakeEngine(),
      env: { OPENOUTBOUND_API_KEY: TEST_KEYS.agent },
      deps: {
        fetch: routeTo(app),
        mcpTransport: serverSide,
        waitForShutdown: async () => {
          const client = new Client({ name: "t", version: "1" });
          await client.connect(clientSide);
          await client.callTool({ name: "manage_items", arguments: { action: "list" } });
          await client.close();
        },
      },
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("bridge mode");
    expect(result.stderr).not.toContain("running as the local agent");
    expect(server.calls.at(-1)?.options).toMatchObject({
      workspace: "acme",
      principal: { id: "key_agent", via: "http" },
    });
  });
});

describe("mailbox login tests", () => {
  /** mailboxes.test and mailboxes.add as the engine answers them, with a login that fails or not. */
  async function mailboxEngine() {
    const { defineOperation } = await import("../../src/core/operation.js");
    const { z } = await import("zod");
    const failed = {
      smtp: "failed",
      imap: "ok",
      error: "SMTP: 535 5.7.8 Bad credentials",
      auth_failed: true,
    };
    const passed = { smtp: "ok", imap: "ok", error: null, auth_failed: false };
    const loginTest = defineOperation({
      id: "mailboxes.test",
      summary: "Test a mailbox's SMTP and IMAP login",
      description: "Logs in without sending.",
      effect: "write",
      input: z.object({ mailbox_id: z.string() }),
      output: z.record(z.string(), z.unknown()),
      dryRun: "none",
      idempotent: true,
      workspace: "required",
      examples: [],
      handler: async (_ctx, input) => ({
        ...(input.mailbox_id === "mbx_ok" ? passed : failed),
        mailbox_id: input.mailbox_id,
        email: "sam@acme.example.com",
        status: input.mailbox_id === "mbx_ok" ? "active" : "error",
        hint:
          input.mailbox_id === "mbx_ok"
            ? null
            : `Check the password or app password and set it with manage_mailboxes action update (mailbox_id ${input.mailbox_id}, password_env).`,
      }),
    });
    const add = defineOperation({
      id: "mailboxes.add",
      summary: "Add a sending mailbox",
      description: "Adds one mailbox.",
      effect: "write",
      input: z.object({ email: z.string(), test: z.boolean().default(false) }),
      output: z.record(z.string(), z.unknown()),
      dryRun: "none",
      idempotent: false,
      workspace: "required",
      examples: [],
      handler: async (_ctx, input) => ({
        mailbox: { id: "mbx_1", email: input.email, status: "warming" },
        warnings: [],
        test: input.test ? failed : null,
        next_steps: [
          "The login test failed: sending (SMTP) failed (SMTP: 535 5.7.8 Bad credentials).",
          "Check the domain: manage_mailboxes action check_dns (mailbox_id mbx_1).",
        ],
      }),
    });
    return createFakeEngine({
      modules: [demoModule, { name: "email", operations: [loginTest, add] }],
    });
  }

  it("exits 1 when a login test failed, prints the result and names the failed login", async () => {
    const engine = await mailboxEngine();
    const home = tempDir();
    const deps = { scriptPath: join(home, "dist", "cli", "main.js") };
    const target = ["--workspace", "acme", "--mailbox-id"];
    const failed = await cli(["mailboxes", "test", ...target, "mbx_1"], {
      engine,
      cwd: home,
      deps,
    });
    expect(failed.code).toBe(1);
    expect(failed.stdout).toMatch(/smtp\s+failed/);
    expect(failed.stderr).toContain(
      "Login test failed for sam@acme.example.com: sending (SMTP) failed (SMTP: 535 5.7.8 Bad credentials).",
    );
    expect(failed.stderr).toContain("Check the password or app password");
    expect(failed.stderr).toContain(
      "test it again: `node dist/cli/main.js mailboxes test --workspace acme --mailbox-id mbx_1`",
    );
    // JSON output is the same answer, with the same exit code.
    const json = await cli(["mailboxes", "test", ...target, "mbx_1", "--json"], {
      engine,
      cwd: home,
      deps,
    });
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({
      smtp: "failed",
      email: "sam@acme.example.com",
    });
    const passed = await cli(["mailboxes", "test", ...target, "mbx_ok"], {
      engine,
      cwd: home,
      deps,
    });
    expect(passed.code).toBe(0);
    expect(passed.stderr).not.toContain("Login test failed");
  });

  it("exits 1 when mailboxes add --test failed its login test, with the mailbox added", async () => {
    const engine = await mailboxEngine();
    const home = tempDir();
    const deps = { scriptPath: join(home, "dist", "cli", "main.js") };
    const add = ["mailboxes", "add", "--workspace", "acme", "--email", "sam@acme.example.com"];
    const tested = await cli([...add, "--test"], { engine, cwd: home, deps });
    expect(tested.code).toBe(1);
    expect(tested.stdout).toContain("The login test failed: sending (SMTP) failed");
    expect(tested.stderr).toContain(
      "The mailbox sam@acme.example.com was added, but its login test failed: sending (SMTP) failed (SMTP: 535 5.7.8 Bad credentials).",
    );
    expect(tested.stderr).toContain(
      "test it again: `node dist/cli/main.js mailboxes test --workspace acme --mailbox-id mbx_1`",
    );
    const untested = await cli(add, { engine, cwd: home, deps });
    expect(untested.code).toBe(0);
  });
});

describe("sandbox command", () => {
  it("runs sandbox.seed when the sandbox module provides it", async () => {
    const { defineOperation } = await import("../../src/core/operation.js");
    const { z } = await import("zod");
    const { demoModule } = await import("./fake-engine.js");
    const seed = defineOperation({
      id: "sandbox.seed",
      summary: "Seed the sandbox",
      description: "Creates or resets the sandbox workspace.",
      effect: "admin",
      input: z.object({ reset: z.boolean().optional() }),
      output: z.object({ workspace: z.string() }),
      dryRun: "none",
      idempotent: true,
      workspace: "none",
      boundPrincipals: "refuse",
      examples: [],
      handler: async () => ({ workspace: "sandbox" }),
    });
    const status = defineOperation({
      ...seed,
      id: "sandbox.status",
      summary: "Sandbox status",
      effect: "read",
      handler: async () => ({ workspace: "sandbox" }),
    });
    const engine = createFakeEngine({
      modules: [demoModule, { name: "sandbox", operations: [seed, status] }],
    });
    const result = await cli(["sandbox"], { engine });
    expect(result.code).toBe(0);
    expect(engine.calls.at(-1)?.operationId).toBe("sandbox.seed");
    expect(result.stdout).toMatch(/^workspace\s+sandbox$/m);
    await cli(["sandbox", "status"], { engine });
    expect(engine.calls.at(-1)?.operationId).toBe("sandbox.status");
  });
});
