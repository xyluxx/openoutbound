/**
 * `codex-cli` runner: `codex exec` against the eval MCP endpoint.
 *
 * The user's config.toml and exec rules are ignored, the shell tool and web search are off,
 * the sandbox is read-only, nothing is persisted, and the only MCP server is openoutbound (URL
 * and bearer key env var passed with `-c`, tools pre-approved so the engine, not Codex, decides
 * what needs a human). The prompt goes in on stdin; `--json` gives JSONL events with the tool
 * calls and token usage (no cost). Codex has no turn limit flag, so the runner stops the process
 * once the agent makes more tool calls than the scenario's turn budget.
 */
import { summarizeArgs } from "../mcp-client.js";
import type { RunnerToolUse } from "../types.js";
import { parseJsonLine, runCliSession, type StreamParser, type StreamState } from "./cli-runner.js";
import { type CommandSpec, errorCodeFromText } from "./command.js";
import { addUsage, type Runner, type RunnerInput } from "./types.js";

export const MCP_SERVER_NAME = "openoutbound";
/** Env var that carries the agent's API key to Codex (never written to disk). */
export const CODEX_API_KEY_ENV = "OPENOUTBOUND_EVAL_API_KEY";

export type CodexCommandInput = Pick<
  RunnerInput,
  "prompt" | "mcpUrl" | "apiKey" | "model" | "workDir"
>;

/** TOML string literal for a `-c key=value` override. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** The `codex exec` invocation for one session (pure: tests check it without spawning). */
export function buildCodexCommand(
  input: CodexCommandInput,
  options: { command?: string } = {},
): CommandSpec {
  const server = `mcp_servers.${MCP_SERVER_NAME}`;
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "read-only",
    "--cd",
    input.workDir,
    "-c",
    "features.shell_tool=false",
    "-c",
    `web_search=${tomlString("disabled")}`,
    "-c",
    `${server}.url=${tomlString(input.mcpUrl)}`,
    "-c",
    `${server}.bearer_token_env_var=${tomlString(CODEX_API_KEY_ENV)}`,
    "-c",
    `${server}.default_tools_approval_mode=${tomlString("approve")}`,
    "-c",
    `${server}.tool_timeout_sec=120`,
  ];
  if (input.model) args.push("--model", input.model);
  args.push("-");
  return {
    command: options.command ?? process.env.OO_EVAL_CODEX_BIN ?? "codex",
    args,
    env: { [CODEX_API_KEY_ENV]: input.apiKey },
    cwd: input.workDir,
    stdin: input.prompt,
    files: [],
  };
}

interface CodexItem {
  id?: string;
  type?: string;
  server?: string;
  tool?: string;
  arguments?: unknown;
  status?: string;
  text?: string;
  result?: {
    content?: Array<{ type?: string; text?: string }>;
    structured_content?: unknown;
  } | null;
  error?: { message?: string } | null;
}

function argumentsOf(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return { raw };
    }
  }
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function failureCode(item: CodexItem): string | null {
  const structured = item.result?.structured_content as { error?: { code?: unknown } } | undefined;
  if (typeof structured?.error?.code === "string") return structured.error.code;
  const text = (item.result?.content ?? []).map((block) => block.text ?? "").join("\n");
  return errorCodeFromText(text) ?? errorCodeFromText(item.error?.message ?? "");
}

/** Parser for `codex exec --json` events; asks to stop after `maxToolCalls` tool calls. */
export function createCodexStreamParser(options: {
  maxToolCalls: number;
  model?: string | undefined;
}): StreamParser {
  const state: StreamState = {
    finalText: "",
    turns: 0,
    usage: null,
    costUsd: null,
    toolUses: [],
    model: options.model ?? null,
    error: null,
    completed: false,
  };
  const byId = new Map<string, RunnerToolUse>();
  let stop: string | null = null;
  /** `error` events can be transient (reconnects); they count only if the turn never completes. */
  let lastError: string | null = null;

  return {
    push(line) {
      const event = parseJsonLine(line);
      if (!event) return;
      const type = event.type;
      if (type === "item.started" || type === "item.updated" || type === "item.completed") {
        const item = (event.item ?? {}) as CodexItem;
        if (item.type === "agent_message" && type === "item.completed") {
          state.finalText = item.text ?? state.finalText;
          return;
        }
        if (
          item.type !== "mcp_tool_call" &&
          item.type !== "command_execution" &&
          item.type !== "web_search"
        ) {
          return;
        }
        const key = item.id ?? `item-${byId.size}`;
        let use = byId.get(key);
        if (!use) {
          const name =
            item.type === "mcp_tool_call"
              ? item.server && item.server !== MCP_SERVER_NAME
                ? `${item.server}/${item.tool ?? "unknown"}`
                : (item.tool ?? "unknown")
              : item.type;
          use = {
            name,
            args_summary: summarizeArgs(argumentsOf(item.arguments)),
            is_error: false,
            error_code: null,
          };
          byId.set(key, use);
          state.toolUses.push(use);
          if (state.toolUses.length > options.maxToolCalls && !stop) {
            stop = `stopped after ${options.maxToolCalls} tool calls (turn budget)`;
          }
        }
        if (type === "item.completed") {
          use.is_error = item.status === "failed" || Boolean(item.error);
          use.error_code = use.is_error ? failureCode(item) : null;
        }
        return;
      }
      if (type === "turn.completed") {
        state.completed = true;
        const usage = (event.usage ?? {}) as Record<string, number | undefined>;
        const cached = usage.cached_input_tokens ?? 0;
        state.usage = addUsage(state.usage, {
          input_tokens: Math.max(0, (usage.input_tokens ?? 0) - cached),
          output_tokens: usage.output_tokens ?? 0,
          cache_read_tokens: cached,
        });
        return;
      }
      if (type === "turn.failed") {
        state.completed = true;
        const error = event.error as { message?: string } | undefined;
        state.error = `codex turn failed: ${error?.message ?? "unknown error"}`;
        return;
      }
      if (type === "error") {
        lastError = `codex error: ${String(event.message ?? "unknown error")}`;
      }
    },
    state() {
      return {
        ...state,
        turns: state.toolUses.length + (state.finalText ? 1 : 0),
        error: state.error ?? (state.completed ? null : lastError),
      };
    },
    stopReason() {
      return stop;
    },
  };
}

export const codexCliRunner: Runner = {
  name: "codex-cli",
  run(input) {
    return runCliSession(
      "codex",
      buildCodexCommand(input),
      createCodexStreamParser({ maxToolCalls: input.maxTurns, model: input.model }),
      input,
    );
  },
};
