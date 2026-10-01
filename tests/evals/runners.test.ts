/**
 * Runner command construction and output parsing. Nothing here spawns a CLI or calls a model:
 * the command builders are pure and the parsers get recorded event lines.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_PRICES, estimateCost, toApiTool } from "../../evals/harness/runners/anthropic-api.js";
import {
  buildClaudeCommand,
  type ClaudeCommandInput,
  createClaudeStreamParser,
} from "../../evals/harness/runners/claude-cli.js";
import {
  finishStream,
  parseJsonLine,
  type StreamState,
} from "../../evals/harness/runners/cli-runner.js";
import {
  buildCodexCommand,
  CODEX_API_KEY_ENV,
  createCodexStreamParser,
} from "../../evals/harness/runners/codex-cli.js";
import { errorCodeFromText, quoteWindowsArg } from "../../evals/harness/runners/command.js";
import { createRunner } from "../../evals/harness/runners/index.js";
import { addUsage, RUNNER_NAMES } from "../../evals/harness/runners/types.js";

const WORK_DIR = join("tmp", "eval-run", "agent");
const INPUT: ClaudeCommandInput = {
  prompt: "Triage the inbox.",
  mcpUrl: "http://127.0.0.1:50123/mcp?toolsets=core%2Cinbox",
  apiKey: "oo_test_agent_key",
  model: "sonnet",
  maxTurns: 20,
  workDir: WORK_DIR,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

function lines(events: unknown[]): string[] {
  return events.map((event) => JSON.stringify(event));
}

describe("claude-cli command", () => {
  it("runs print mode with only the eval MCP server and no built-in tools", () => {
    const spec = buildClaudeCommand(INPUT, { command: "claude" });
    const configPath = join(WORK_DIR, "claude-mcp.json");
    expect(spec.command).toBe("claude");
    expect(spec.args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--mcp-config",
      configPath,
      "--strict-mcp-config",
      "--tools",
      "",
      "--allowedTools",
      "mcp__openoutbound",
      "--permission-mode",
      "dontAsk",
      "--setting-sources",
      "project,local",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--max-turns",
      "20",
      "--model",
      "sonnet",
    ]);
    expect(spec.cwd).toBe(WORK_DIR);
    expect(spec.stdin).toBe("Triage the inbox.");
    expect(spec.env).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
    expect(spec.files).toHaveLength(1);
    expect(spec.files[0]?.path).toBe(configPath);
    expect(JSON.parse(spec.files[0]?.content ?? "")).toEqual({
      mcpServers: {
        openoutbound: {
          type: "http",
          url: INPUT.mcpUrl,
          headers: { Authorization: "Bearer oo_test_agent_key" },
        },
      },
    });
  });

  it("keeps the agent key off the command line", () => {
    const spec = buildClaudeCommand(INPUT, { command: "claude" });
    expect(spec.args.join(" ")).not.toContain(INPUT.apiKey);
  });

  it("leaves the model to claude when none is given and honours OO_EVAL_CLAUDE_BIN", () => {
    vi.stubEnv("OO_EVAL_CLAUDE_BIN", "/opt/claude/bin/claude");
    const spec = buildClaudeCommand({ ...INPUT, model: undefined });
    expect(spec.command).toBe("/opt/claude/bin/claude");
    expect(spec.args).not.toContain("--model");
  });
});

describe("claude-cli stream parser", () => {
  const init = {
    type: "system",
    subtype: "init",
    model: "claude-sonnet-5",
    mcp_servers: [{ name: "openoutbound", status: "connected" }],
  };

  it("collects tool calls, error codes, turns, usage, cost and the final answer", () => {
    const parser = createClaudeStreamParser();
    for (const line of lines([
      init,
      {
        type: "assistant",
        message: {
          id: "msg_1",
          content: [
            { type: "text", text: "Checking the workspace." },
            { type: "tool_use", id: "tu_1", name: "mcp__openoutbound__get_status", input: {} },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "{}" }] },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          id: "msg_2",
          content: [
            {
              type: "tool_use",
              id: "tu_2",
              name: "mcp__openoutbound__find_leads",
              input: { action: "search", source: "apollo" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_2",
              is_error: true,
              content:
                "Error (budget_exceeded): The monthly data budget is used up.\nHint: raise it.",
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Nothing imported: the budget is used up.",
        num_turns: 3,
        total_cost_usd: 0.1234,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 200,
        },
      },
    ])) {
      parser.push(line);
    }
    const state = parser.state();
    expect(state).toMatchObject({
      finalText: "Nothing imported: the budget is used up.",
      turns: 3,
      costUsd: 0.1234,
      model: "claude-sonnet-5",
      error: null,
      completed: true,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 1000,
        cache_creation_tokens: 200,
      },
    });
    expect(state.toolUses).toEqual([
      { name: "get_status", args_summary: "{}", is_error: false, error_code: null },
      {
        name: "find_leads",
        args_summary: '{"action":"search","source":"apollo"}',
        is_error: true,
        error_code: "budget_exceeded",
      },
    ]);
    expect(parser.stopReason()).toBeNull();
  });

  it("reports a server that did not connect and a run that hit its turn limit", () => {
    const parser = createClaudeStreamParser();
    parser.push("not json: a notice from the CLI");
    parser.push(
      JSON.stringify({ ...init, mcp_servers: [{ name: "openoutbound", status: "failed" }] }),
    );
    expect(parser.state().error).toMatch(
      /openoutbound MCP server did not connect \(status failed\)/,
    );

    const limited = createClaudeStreamParser();
    limited.push(
      JSON.stringify({
        type: "assistant",
        message: { id: "msg_1", content: [{ type: "text", text: "Still working." }] },
      }),
    );
    limited.push(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true }));
    const state = limited.state();
    expect(state.error).toBe("claude ended with error_max_turns");
    expect(state.finalText).toBe("Still working.");
    expect(state.turns).toBe(1);
  });
});

describe("codex-cli command", () => {
  it("runs exec with only the eval MCP server, no shell and no web search", () => {
    const spec = buildCodexCommand(INPUT, { command: "codex" });
    expect(spec.command).toBe("codex");
    expect(spec.args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "read-only",
      "--cd",
      WORK_DIR,
      "-c",
      "features.shell_tool=false",
      "-c",
      'web_search="disabled"',
      "-c",
      `mcp_servers.openoutbound.url="${INPUT.mcpUrl}"`,
      "-c",
      `mcp_servers.openoutbound.bearer_token_env_var="${CODEX_API_KEY_ENV}"`,
      "-c",
      'mcp_servers.openoutbound.default_tools_approval_mode="approve"',
      "-c",
      "mcp_servers.openoutbound.tool_timeout_sec=120",
      "--model",
      "sonnet",
      "-",
    ]);
    expect(spec.stdin).toBe("Triage the inbox.");
    expect(spec.cwd).toBe(WORK_DIR);
    expect(spec.files).toEqual([]);
  });

  it("passes the agent key in an environment variable only", () => {
    const spec = buildCodexCommand(INPUT, { command: "codex" });
    expect(spec.env).toEqual({ [CODEX_API_KEY_ENV]: INPUT.apiKey });
    expect(spec.args.join(" ")).not.toContain(INPUT.apiKey);
  });

  it("honours OO_EVAL_CODEX_BIN and omits --model when none is given", () => {
    vi.stubEnv("OO_EVAL_CODEX_BIN", "/opt/codex/bin/codex");
    const spec = buildCodexCommand({ ...INPUT, model: undefined });
    expect(spec.command).toBe("/opt/codex/bin/codex");
    expect(spec.args).not.toContain("--model");
    expect(spec.args.at(-1)).toBe("-");
  });
});

describe("codex-cli stream parser", () => {
  const toolCall = (id: string, tool: string, extra: Record<string, unknown> = {}) => ({
    id,
    type: "mcp_tool_call",
    server: "openoutbound",
    tool,
    arguments: {},
    status: "completed",
    ...extra,
  });

  it("collects tool calls, error codes, usage and the final answer", () => {
    const parser = createCodexStreamParser({ maxToolCalls: 10, model: "gpt-5-codex" });
    for (const line of lines([
      { type: "thread.started", thread_id: "thread_1" },
      { type: "turn.started" },
      { type: "item.started", item: toolCall("item_1", "get_status", { status: "in_progress" }) },
      { type: "item.completed", item: toolCall("item_1", "get_status") },
      {
        type: "item.completed",
        item: toolCall("item_2", "find_leads", {
          arguments: '{"action":"search"}',
          status: "failed",
          result: {
            content: [{ type: "text", text: "Error (validation_failed): Say what to look for." }],
            structured_content: { error: { code: "validation_failed" } },
          },
        }),
      },
      { type: "error", message: "stream disconnected, retrying" },
      { type: "item.completed", item: { id: "item_3", type: "agent_message", text: "Done." } },
      {
        type: "turn.completed",
        usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 80 },
      },
    ])) {
      parser.push(line);
    }
    const state = parser.state();
    expect(state).toMatchObject({
      finalText: "Done.",
      turns: 3,
      model: "gpt-5-codex",
      costUsd: null,
      error: null,
      completed: true,
      usage: {
        input_tokens: 200,
        output_tokens: 80,
        cache_read_tokens: 1000,
        cache_creation_tokens: 0,
      },
    });
    expect(state.toolUses).toEqual([
      { name: "get_status", args_summary: "{}", is_error: false, error_code: null },
      {
        name: "find_leads",
        args_summary: '{"action":"search"}',
        is_error: true,
        error_code: "validation_failed",
      },
    ]);
  });

  it("asks to stop once the agent goes past the turn budget", () => {
    const parser = createCodexStreamParser({ maxToolCalls: 1 });
    parser.push(JSON.stringify({ type: "item.started", item: toolCall("a", "get_status") }));
    expect(parser.stopReason()).toBeNull();
    parser.push(JSON.stringify({ type: "item.started", item: toolCall("b", "list_campaigns") }));
    expect(parser.stopReason()).toBe("stopped after 1 tool calls (turn budget)");
  });

  it("marks shell and other servers' tools, and reports failed turns and lost streams", () => {
    const parser = createCodexStreamParser({ maxToolCalls: 10 });
    parser.push(
      JSON.stringify({
        type: "item.completed",
        item: { id: "c1", type: "command_execution", command: "ls", status: "failed" },
      }),
    );
    parser.push(
      JSON.stringify({
        type: "item.completed",
        item: toolCall("c2", "search", { server: "other" }),
      }),
    );
    parser.push(JSON.stringify({ type: "turn.failed", error: { message: "usage limit reached" } }));
    const state = parser.state();
    expect(state.toolUses.map((use) => [use.name, use.is_error])).toEqual([
      ["command_execution", true],
      ["other/search", false],
    ]);
    expect(state.error).toBe("codex turn failed: usage limit reached");

    const lost = createCodexStreamParser({ maxToolCalls: 10 });
    lost.push(JSON.stringify({ type: "error", message: "stream disconnected" }));
    expect(lost.state().error).toBe("codex error: stream disconnected");
  });
});

describe("CLI session results", () => {
  const state: StreamState = {
    finalText: "Done.",
    turns: 2,
    usage: null,
    costUsd: null,
    toolUses: [],
    model: null,
    error: null,
    completed: false,
  };
  const ended = { exitCode: 1, stderr: "", timedOut: false, spawnError: null };

  it("explains how the process ended", () => {
    expect(
      finishStream("claude", { ...state, completed: true }, { ...ended, exitCode: 0 }, null).error,
    ).toBeNull();
    expect(
      finishStream("claude", state, { ...ended, spawnError: "spawn claude ENOENT" }, null).error,
    ).toBe("could not start claude: spawn claude ENOENT. Is it installed and on PATH?");
    expect(
      finishStream("codex", state, ended, "stopped after 5 tool calls (turn budget)").error,
    ).toBe("stopped after 5 tool calls (turn budget)");
    expect(finishStream("codex", state, { ...ended, timedOut: true }, null).error).toBe(
      "codex timed out",
    );
    expect(
      finishStream("claude", state, { ...ended, stderr: "line 1\nline 2\nNot logged in\n" }, null)
        .error,
    ).toBe("claude exited with code 1 before finishing: line 1\nline 2\nNot logged in");
  });

  it("keeps an error the stream reported", () => {
    const output = finishStream(
      "claude",
      { ...state, completed: true, error: "claude ended with error_max_turns" },
      { ...ended, exitCode: 0 },
      null,
    );
    expect(output).toMatchObject({
      finalText: "Done.",
      turns: 2,
      error: "claude ended with error_max_turns",
    });
  });

  it("parses JSON lines and skips everything else", () => {
    expect(parseJsonLine('  {"type":"result"}  ')).toEqual({ type: "result" });
    expect(parseJsonLine("")).toBeNull();
    expect(parseJsonLine("Warning: something")).toBeNull();
    expect(parseJsonLine("{broken")).toBeNull();
    expect(parseJsonLine("[1, 2]")).toBeNull();
  });
});

describe("command helpers", () => {
  it("quotes Windows arguments only when needed", () => {
    expect(quoteWindowsArg("stream-json")).toBe("stream-json");
    expect(quoteWindowsArg("")).toBe('""');
    expect(quoteWindowsArg("two words")).toBe('"two words"');
    expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteWindowsArg("C:\\dir with space\\")).toBe('"C:\\dir with space\\\\"');
    expect(quoteWindowsArg("a&b")).toBe('"a&b"');
    expect(quoteWindowsArg("100%")).toBe('"100%"');
  });

  it("reads the OpenOutbound error code from tool error text", () => {
    expect(errorCodeFromText("Error (not_contactable): Elna is suppressed.")).toBe(
      "not_contactable",
    );
    expect(errorCodeFromText("Something else went wrong")).toBeNull();
  });
});

describe("anthropic-api helpers", () => {
  it("estimates cost from token usage, with cache writes at 1.25x input", () => {
    const million = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_tokens: 1_000_000,
      cache_creation_tokens: 1_000_000,
    };
    const price = API_PRICES["claude-opus-5"];
    expect(price).toBeDefined();
    expect(estimateCost("claude-opus-5", million)).toBe(5 + 25 + 0.5 + 6.25);
    expect(estimateCost("claude-haiku-4-5-20261001", million)).toBe(1 + 5 + 0.1 + 1.25);
    expect(estimateCost("some-unknown-model", million)).toBeNull();
  });

  it("turns MCP tools into Messages API tools", () => {
    expect(
      toApiTool({
        name: "get_status",
        description: "Start here.",
        inputSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { workspace: { type: "string" } },
        },
      }),
    ).toEqual({
      name: "get_status",
      description: "Start here.",
      input_schema: { type: "object", properties: { workspace: { type: "string" } } },
      eager_input_streaming: true,
    });
    expect(toApiTool({ name: "ping", inputSchema: {} })).toEqual({
      name: "ping",
      input_schema: { type: "object" },
      eager_input_streaming: true,
    });
  });
});

describe("runner registry", () => {
  it("builds every runner by name", () => {
    for (const name of RUNNER_NAMES) expect(createRunner(name).name).toBe(name);
  });

  it("adds token usage across turns", () => {
    const first = addUsage(null, { input_tokens: 10, output_tokens: 5 });
    expect(addUsage(first, { input_tokens: 1, cache_read_tokens: 7 })).toEqual({
      input_tokens: 11,
      output_tokens: 5,
      cache_read_tokens: 7,
      cache_creation_tokens: 0,
    });
  });
});
