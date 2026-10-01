/** Tests for the CLI brains (claude_cli, codex_cli) and the process helper, with a fake spawn. */
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { outputJsonSchema } from "../../brain/json-schema.js";
import type { ServiceBrainRequest } from "../../brain/request.js";
import { isOpenOutboundError, type OpenOutboundError } from "../../core/errors.js";
import {
  buildClaudeCliArgs,
  CLAUDE_CLI_DEFAULT_MODELS,
  type ClaudeCliResult,
  createClaudeCliBrain,
  mapClaudeCliResult,
  parseClaudeCliOutput,
} from "./claude-cli.js";
import { cliEnv, runCli, type SpawnFn } from "./cli-process.js";
import {
  buildCodexArgs,
  CODEX_DEFAULT_MODEL,
  codexResetSeconds,
  createCodexCliBrain,
  tomlString,
} from "./codex-cli.js";
import { USAGE_LIMIT_RETRY_SECONDS } from "./errors.js";

const fixtureText = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

interface SpawnCall {
  command: string;
  args: string[];
  options: SpawnOptions;
  stdin: string;
  /** Files that existed when the process started (path -> content). */
  files: Record<string, string>;
}

interface Outcome {
  stdout?: string;
  stderr?: string;
  code?: number;
  /** Emitted as a spawn error instead of running (e.g. ENOENT). */
  error?: NodeJS.ErrnoException;
  /** Never exits (for abort tests). */
  hang?: boolean;
}

/** A fake child_process.spawn: records the call, then runs `behavior` once stdin closes. */
function fakeSpawn(behavior: (call: SpawnCall) => Outcome | Promise<Outcome>) {
  const calls: SpawnCall[] = [];
  const killed: string[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: Writable;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      kill: (signal?: NodeJS.Signals) => boolean;
    };
    const call: SpawnCall = { command, args: [...args], options, stdin: "", files: {} };
    for (const [index, arg] of args.entries()) {
      const previous = args[index - 1];
      if (
        (previous === "--system-prompt-file" || previous === "--output-schema") &&
        existsSync(arg)
      ) {
        call.files[arg] = readFileSync(arg, "utf8");
      }
    }
    calls.push(call);
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal = "SIGTERM") => {
      killed.push(signal);
      child.signalCode = signal;
      setImmediate(() => child.emit("close", null, signal));
      return true;
    };
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        call.stdin += chunk.toString();
        callback();
      },
      final(callback) {
        callback();
        void Promise.resolve(behavior(call)).then(async (outcome) => {
          if (outcome.error) {
            child.emit("error", outcome.error);
            return;
          }
          if (outcome.hang) return;
          const ended = Promise.all([once(child.stdout, "end"), once(child.stderr, "end")]);
          child.stdout.end(outcome.stdout ?? "");
          child.stderr.end(outcome.stderr ?? "");
          await ended;
          child.exitCode = outcome.code ?? 0;
          child.emit("close", child.exitCode, null);
        });
      },
    });
    return child as unknown as ChildProcess;
  };
  return { spawn, calls, killed };
}

const draftSchema = z.object({
  subject: z.string(),
  body: z.string(),
  angle: z.enum(["signal", "pain", "peer"]),
  ps: z.string().optional(),
});

function request(overrides: Partial<ServiceBrainRequest> = {}): ServiceBrainRequest {
  return {
    system: "You write short cold emails.\nNever invent facts.",
    messages: [{ role: "user", content: "Write to Dana at Harbor Dental." }],
    jsonSchema: outputJsonSchema(draftSchema),
    model: "sonnet",
    maxTokens: 800,
    metadata: { promptId: "email.draft" },
    tier: "standard",
    ...overrides,
  };
}

async function failure(promise: Promise<unknown>): Promise<OpenOutboundError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!isOpenOutboundError(error)) throw new Error(`expected an OpenOutboundError, got ${error}`);
  return error;
}

function mapClaudeCliFailure(result: ClaudeCliResult): OpenOutboundError {
  try {
    mapClaudeCliResult(result, { label: "Claude Code", providerId: "claude_cli" });
  } catch (error) {
    if (isOpenOutboundError(error)) return error;
    throw error;
  }
  throw new Error("expected the result to fail");
}

const HOME_ENV = {
  PATH: "/usr/bin",
  HOME: "/home/dana",
  ANTHROPIC_API_KEY: "test-key-not-real",
  OPENOUTBOUND_SECRET_KEY: "test-secret-not-real",
  DATABASE_URL: "postgres://example.org/db",
  CODEX_API_KEY: "codex-test-key-not-real",
};

describe("cli process helper", () => {
  it("removes engine secrets from the environment and keeps the rest", () => {
    const env = cliEnv({ EXTRA: "1" }, HOME_ENV);
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/dana",
      CODEX_API_KEY: "codex-test-key-not-real",
      EXTRA: "1",
    });
  });

  it("kills the process when the caller aborts", async () => {
    const fake = fakeSpawn(() => ({ hang: true }));
    const controller = new AbortController();
    const running = runCli({
      command: "claude",
      args: [],
      cwd: ".",
      env: {},
      signal: controller.signal,
      spawn: fake.spawn,
    });
    setTimeout(() => controller.abort(), 10);
    await expect(running).rejects.toThrow(/cancelled/);
    expect(fake.killed).toEqual(["SIGTERM"]);
  });

  it("settles a stopped run only after the process has exited", async () => {
    const events: string[] = [];
    const spawn: SpawnFn = () => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new Writable({ write: (_chunk, _encoding, callback) => callback() }),
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill: (signal: NodeJS.Signals = "SIGTERM") => {
          events.push(`kill ${signal}`);
          setTimeout(() => {
            child.signalCode = signal;
            events.push("exit");
            child.emit("exit", null, signal);
          }, 30);
          return true;
        },
      });
      return child as unknown as ChildProcess;
    };
    const running = runCli({
      command: "claude",
      args: [],
      cwd: ".",
      env: {},
      timeoutMs: 10,
      spawn,
    });
    await expect(running).rejects.toThrow(/did not finish/);
    events.push("settled");
    expect(events).toEqual(["kill SIGTERM", "exit", "settled"]);
  });

  it("escalates to SIGKILL and gives up on a process that never exits", async () => {
    const killed: string[] = [];
    const spawn: SpawnFn = () =>
      Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new Writable({ write: (_chunk, _encoding, callback) => callback() }),
        exitCode: null,
        signalCode: null,
        kill: (signal: NodeJS.Signals = "SIGTERM") => {
          killed.push(signal);
          return true;
        },
      }) as unknown as ChildProcess;
    const running = runCli({
      command: "codex",
      args: [],
      cwd: ".",
      env: {},
      timeoutMs: 10,
      killGraceMs: 10,
      spawn,
    });
    await expect(running).rejects.toThrow(/did not finish/);
    expect(killed).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("times out", async () => {
    const fake = fakeSpawn(() => ({ hang: true }));
    await expect(
      runCli({ command: "codex", args: [], cwd: ".", env: {}, timeoutMs: 20, spawn: fake.spawn }),
    ).rejects.toThrow(/did not finish/);
  });

  it("writes TOML strings that survive quotes, newlines and control characters", () => {
    const value = `Say "hi"\nthen stop${String.fromCharCode(0x7f)}`;
    const encoded = tomlString(value);
    expect(encoded.startsWith('"')).toBe(true);
    expect(encoded).not.toContain("\n");
    expect(encoded).toContain("\\u007f");
    expect(JSON.parse(encoded)).toBe(value);
  });
});

describe("claude_cli brain", () => {
  it("builds the headless flags from the research digest", () => {
    const args = buildClaudeCliArgs({
      model: "haiku",
      systemPromptFile: "/tmp/x/system-prompt.md",
      jsonSchema: { type: "object" },
    });
    expect(args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--system-prompt-file",
      "/tmp/x/system-prompt.md",
      "--tools",
      "",
      "--disallowedTools",
      "mcp__*",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--max-turns",
      "3",
      "--model",
      "haiku",
      "--json-schema",
      '{"type":"object"}',
    ]);
  });

  it("runs claude in an empty temp dir with the prompt on stdin and returns structured output", async () => {
    const fake = fakeSpawn(() => ({ stdout: fixtureText("claude-cli-success.json") }));
    // The engine may itself run under Claude Code (as its MCP server): that session's variables
    // must not reach the fresh `claude -p` session.
    const hostedEnv = {
      ...HOME_ENV,
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "session_parent_example",
      CLAUDE_PROJECT_DIR: "/home/dana/projects/example",
      CLAUDE_EFFORT: "max",
    };
    const brain = createClaudeCliBrain({ spawn: fake.spawn, env: hostedEnv });
    expect(brain.capabilities).toEqual({
      structuredOutput: "native",
      maxConcurrency: 1,
      caching: false,
    });
    expect(brain.defaultModels).toEqual(CLAUDE_CLI_DEFAULT_MODELS);
    const response = await brain.generate(request());
    expect(response.json).toEqual({
      subject: "Quick idea for Harbor Dental",
      body: "Hi Dana, congrats on the Lakeside clinic.",
      angle: "signal",
    });
    expect(response.model).toBe("claude-sonnet-5");
    expect(response.usage).toEqual({
      inputTokens: 13840,
      outputTokens: 350,
      cachedTokens: 12000,
      costUsd: null,
    });
    const call = fake.calls[0] as SpawnCall;
    expect(call.command).toBe("claude");
    expect(call.stdin).toBe("Write to Dana at Harbor Dental.");
    expect(call.options.shell).toBe(false);
    expect(String(call.options.cwd)).toMatch(/oo-claude-[^/\\]+[/\\]work$/);
    expect(call.options.env).toMatchObject({
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      HOME: "/home/dana",
    });
    expect(call.options.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(call.options.env?.OPENOUTBOUND_SECRET_KEY).toBeUndefined();
    for (const name of [
      "CLAUDECODE",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_PROJECT_DIR",
      "CLAUDE_EFFORT",
    ]) {
      expect(call.options.env?.[name], name).toBeUndefined();
    }
    expect(Object.values(call.files)).toEqual([
      "You write short cold emails.\nNever invent facts.",
    ]);
    // The temp dir is gone afterwards.
    expect(existsSync(String(call.options.cwd))).toBe(false);
    const schemaArg = call.args[call.args.indexOf("--json-schema") + 1];
    expect(JSON.parse(String(schemaArg))).toMatchObject({ type: "object" });
  });

  it("sends repair calls as a transcript", async () => {
    const fake = fakeSpawn(() => ({ stdout: fixtureText("claude-cli-success.json") }));
    const brain = createClaudeCliBrain({ spawn: fake.spawn, env: HOME_ENV });
    await brain.generate(
      request({
        messages: [
          { role: "user", content: "Write to Dana." },
          { role: "assistant", content: '{"subject": 1}' },
          { role: "user", content: "Fix the subject." },
        ],
      }),
    );
    expect(fake.calls[0]?.stdin).toContain("<your_previous_reply>");
    expect(fake.calls[0]?.stdin).toContain("Fix the subject.");
  });

  it("treats success without structured output as a failure", async () => {
    const fake = fakeSpawn(() => ({ stdout: fixtureText("claude-cli-no-structured-output.json") }));
    const brain = createClaudeCliBrain({ spawn: fake.spawn, env: HOME_ENV });
    const error = await failure(brain.generate(request()));
    expect(error.details).toMatchObject({ provider: "claude_cli", reason: "invalid_output" });
  });

  it("maps error subtypes, login problems and usage limits", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      [
        "claude-cli-max-turns.json",
        { reason: "cli_error", retryable: false, subtype: "error_max_turns" },
      ],
      [
        "claude-cli-structured-retries.json",
        {
          reason: "invalid_output",
          retryable: false,
          subtype: "error_max_structured_output_retries",
        },
      ],
      ["claude-cli-not-logged-in.json", { reason: "auth", retryable: false, upstream_status: 401 }],
      ["claude-cli-during-execution.json", { reason: "cli_error", retryable: true }],
    ];
    for (const [name, expected] of cases) {
      const fake = fakeSpawn(() => ({ stdout: fixtureText(name), code: 1 }));
      const brain = createClaudeCliBrain({ spawn: fake.spawn, env: HOME_ENV });
      const error = await failure(brain.generate(request()));
      expect(error.details, name).toMatchObject(expected);
    }
    const maxTurns = mapClaudeCliFailure({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      num_turns: 3,
      errors: ["Turn limit reached"],
    });
    expect(maxTurns.details).toMatchObject({ reason: "cli_error", subtype: "error_max_turns" });
    const limited = fakeSpawn(() => ({
      stdout: fixtureText("claude-cli-usage-limit.json"),
      code: 1,
    }));
    const brain = createClaudeCliBrain({
      spawn: limited.spawn,
      env: HOME_ENV,
      now: () => new Date(1_790_000_000_000),
    });
    const error = await failure(brain.generate(request()));
    expect(error.details).toMatchObject({ reason: "usage_limit", retryable: true });
    expect(error.retryAfterSeconds).toBe(3600);

    // No reset time in the message: jobs still wait instead of burning their retries in minutes.
    const noReset = fakeSpawn(() => ({
      stdout: fixtureText("claude-cli-usage-limit.json").replace("|1790003600", ""),
      code: 1,
    }));
    const unknown = await failure(
      createClaudeCliBrain({ spawn: noReset.spawn, env: HOME_ENV }).generate(request()),
    );
    expect(unknown.details).toMatchObject({ reason: "usage_limit", retryable: true });
    expect(unknown.retryAfterSeconds).toBe(USAGE_LIMIT_RETRY_SECONDS);
  });

  it("maps its own timeout to a retryable timeout error", async () => {
    const fake = fakeSpawn(() => ({ hang: true }));
    const brain = createClaudeCliBrain({
      spawn: fake.spawn,
      env: HOME_ENV,
      config: { timeout_ms: 20 },
    });
    const error = await failure(brain.generate(request()));
    expect(error.details).toMatchObject({ reason: "timeout", retryable: true });
    expect(error.hint).toContain("timeout_ms");
    expect(fake.killed).toEqual(["SIGTERM"]);
  });

  it("explains a missing binary and garbage output", async () => {
    const missing = fakeSpawn(() => ({
      error: Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }),
    }));
    const notFound = await failure(
      createClaudeCliBrain({ spawn: missing.spawn, env: HOME_ENV }).generate(request()),
    );
    expect(notFound.details).toMatchObject({ reason: "cli_not_found", retryable: false });
    expect(notFound.hint).toContain("claude.exe");

    const garbage = fakeSpawn(() => ({ stdout: "Segmentation fault", stderr: "boom", code: 139 }));
    const broken = await failure(
      createClaudeCliBrain({ spawn: garbage.spawn, env: HOME_ENV }).generate(request()),
    );
    expect(broken.details).toMatchObject({ reason: "cli_error" });
    expect(broken.message).toContain("139");
  });

  it("rejects model names that could smuggle flags", async () => {
    const fake = fakeSpawn(() => ({ stdout: "" }));
    const brain = createClaudeCliBrain({ spawn: fake.spawn, env: HOME_ENV });
    const error = await failure(
      brain.generate(request({ model: "--dangerously-skip-permissions" })),
    );
    expect(error.details).toMatchObject({ reason: "bad_request" });
    expect(fake.calls).toHaveLength(0);
  });

  it("parses result JSON printed as an array or after log lines", () => {
    const result = { type: "result", subtype: "success", structured_output: { a: 1 } };
    expect(parseClaudeCliOutput(JSON.stringify([{ type: "system" }, result]))).toEqual(result);
    expect(parseClaudeCliOutput(`warning: something\n${JSON.stringify(result)}`)).toEqual(result);
    expect(parseClaudeCliOutput("not json")).toBeUndefined();
  });

  it("checks the installation with --version", async () => {
    const fake = fakeSpawn(() => ({ stdout: "2.1.283 (Claude Code)\n" }));
    const result = await createClaudeCliBrain({ spawn: fake.spawn, env: HOME_ENV }).check?.();
    expect(result?.ok).toBe(true);
    expect(result?.message).toContain("2.1.283");
    expect(fake.calls[0]?.args).toEqual(["--version"]);
  });
});

describe("codex_cli brain", () => {
  it("builds the exec flags from the research digest", () => {
    expect(
      buildCodexArgs({
        model: "gpt-5-codex",
        outputFile: "/tmp/x/last-message.txt",
        schemaFile: "/tmp/x/output-schema.json",
        developerInstructions: 'Say "hi"',
        reasoningEffort: "low",
      }),
    ).toEqual([
      "exec",
      "-",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-user-config",
      "--sandbox",
      "read-only",
      "-m",
      "gpt-5-codex",
      "-c",
      "features.shell_tool=false",
      "-c",
      'web_search="disabled"',
      "-c",
      'developer_instructions="Say \\"hi\\""',
      "-c",
      'model_reasoning_effort="low"',
      "--output-schema",
      "/tmp/x/output-schema.json",
      "-o",
      "/tmp/x/last-message.txt",
      "--json",
    ]);
    const plain = buildCodexArgs({ model: CODEX_DEFAULT_MODEL, outputFile: "/tmp/o.txt" });
    expect(plain).not.toContain("-m");
  });

  function codexWritingOutput(output: string | null, events: string, code = 0) {
    return fakeSpawn((call) => {
      const outputFile = call.args[call.args.indexOf("-o") + 1];
      if (output !== null && outputFile) writeFileSync(outputFile, output, "utf8");
      return { stdout: events, code };
    });
  }

  it("reads the output file, the strict schema and usage from the JSON events", async () => {
    const answer = '{"subject":"Quick idea","body":"Hi Dana.","angle":"signal","ps":null}';
    const fake = codexWritingOutput(answer, fixtureText("codex-success.jsonl"));
    const brain = createCodexCliBrain({ spawn: fake.spawn, env: HOME_ENV });
    expect(brain.defaultModels.standard).toBe(CODEX_DEFAULT_MODEL);
    const response = await brain.generate(request({ model: CODEX_DEFAULT_MODEL, tier: "fast" }));
    expect(response.json).toEqual({
      subject: "Quick idea",
      body: "Hi Dana.",
      angle: "signal",
      ps: null,
    });
    expect(response.usage).toEqual({
      inputTokens: 5200,
      outputTokens: 180,
      cachedTokens: 4096,
      costUsd: null,
    });
    const call = fake.calls[0] as SpawnCall;
    expect(call.command).toBe("codex");
    expect(call.stdin).toBe("Write to Dana at Harbor Dental.");
    expect(call.args).toContain('model_reasoning_effort="low"');
    expect(call.args.some((arg) => arg.startsWith("developer_instructions="))).toBe(true);
    const schema = JSON.parse(Object.values(call.files)[0] ?? "{}") as Record<string, unknown>;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["subject", "body", "angle", "ps"]);
    expect(call.options.env?.CODEX_API_KEY).toBe("codex-test-key-not-real");
    expect(call.options.env?.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("falls back to the last agent message when the output file is missing", async () => {
    const fake = codexWritingOutput(null, fixtureText("codex-success.jsonl"));
    const brain = createCodexCliBrain({ spawn: fake.spawn, env: HOME_ENV });
    const response = await brain.generate(request({ model: CODEX_DEFAULT_MODEL }));
    expect(response.json).toMatchObject({ subject: "Quick idea for Harbor Dental" });
  });

  it("maps usage limits and login problems", async () => {
    const limited = codexWritingOutput(null, fixtureText("codex-usage-limit.jsonl"), 1);
    const limit = await failure(
      createCodexCliBrain({ spawn: limited.spawn, env: HOME_ENV }).generate(
        request({ model: CODEX_DEFAULT_MODEL }),
      ),
    );
    // Retried later by the job, when the limit resets ("Try again in 3 hours").
    expect(limit.details).toMatchObject({ reason: "usage_limit", retryable: true, exit_code: 1 });
    expect(limit.retryAfterSeconds).toBe(3 * 3600);
    expect(codexResetSeconds("You've hit your usage limit. Try again in 2h 30m.")).toBe(9000);
    expect(codexResetSeconds("try again in 45 minutes")).toBe(2700);
    expect(codexResetSeconds("You've hit your usage limit.")).toBeUndefined();
    const noReset = codexWritingOutput(
      null,
      fixtureText("codex-usage-limit.jsonl").replaceAll(" Try again in 3 hours.", ""),
      1,
    );
    const unknown = await failure(
      createCodexCliBrain({ spawn: noReset.spawn, env: HOME_ENV }).generate(
        request({ model: CODEX_DEFAULT_MODEL }),
      ),
    );
    expect(unknown.details).toMatchObject({ reason: "usage_limit", retryable: true });
    expect(unknown.retryAfterSeconds).toBe(USAGE_LIMIT_RETRY_SECONDS);

    const auth = codexWritingOutput(null, fixtureText("codex-auth-error.jsonl"), 1);
    const denied = await failure(
      createCodexCliBrain({ spawn: auth.spawn, env: HOME_ENV }).generate(
        request({ model: CODEX_DEFAULT_MODEL }),
      ),
    );
    expect(denied.details).toMatchObject({ reason: "auth", retryable: false });
    expect(denied.hint).toContain("codex login");
  });

  it("puts very long system prompts on stdin and uses prompt instructions for loose schemas", async () => {
    const answer = '{"meta":{"a":"b"}}';
    const fake = codexWritingOutput(answer, fixtureText("codex-success.jsonl"));
    const brain = createCodexCliBrain({ spawn: fake.spawn, env: HOME_ENV });
    await brain.generate(
      request({
        model: CODEX_DEFAULT_MODEL,
        system: "x".repeat(30_000),
        jsonSchema: outputJsonSchema(z.object({ meta: z.record(z.string(), z.string()) })),
      }),
    );
    const call = fake.calls[0] as SpawnCall;
    expect(call.args).not.toContain("--output-schema");
    expect(call.args.some((arg) => arg.startsWith("developer_instructions="))).toBe(false);
    expect(call.stdin.startsWith("<instructions>\n")).toBe(true);
    expect(call.stdin).toContain("JSON");
  });

  it("reports a missing binary", async () => {
    const missing = fakeSpawn(() => ({
      error: Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }),
    }));
    const result = await createCodexCliBrain({ spawn: missing.spawn, env: HOME_ENV }).check?.();
    expect(result?.ok).toBe(false);
    expect(result?.message).toContain("codex login");
  });
});
