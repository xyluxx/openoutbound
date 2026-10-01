/**
 * `claude-cli` runner: Claude Code in print mode against the eval MCP endpoint.
 *
 * Built-in tools are off (`--tools ""`), only the openoutbound server from our config is loaded
 * (`--strict-mcp-config`) and allowed, permission prompts are denied instead of asked, user
 * settings, plugins, hooks and skills are skipped, and nothing is saved to the session history.
 * The prompt goes in on stdin; `--output-format stream-json` gives the tool calls, turns, tokens
 * and cost. Authentication is whatever the local `claude` already uses (login or
 * ANTHROPIC_API_KEY); the harness never reads or passes credentials.
 */
import { join } from "node:path";
import { summarizeArgs } from "../mcp-client.js";
import type { RunnerToolUse } from "../types.js";
import { parseJsonLine, runCliSession, type StreamParser, type StreamState } from "./cli-runner.js";
import { type CommandSpec, errorCodeFromText } from "./command.js";
import type { Runner, RunnerInput, RunnerUsage } from "./types.js";

/** MCP server name the agent sees (tool names become `mcp__openoutbound__<tool>`). */
export const MCP_SERVER_NAME = "openoutbound";
const TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
/** Init statuses that mean the agent has no OpenOutbound tools (pending still connects). */
const FAILED_SERVER_STATUSES = new Set(["failed", "needs-auth", "disabled"]);

export type ClaudeCommandInput = Pick<
  RunnerInput,
  "prompt" | "mcpUrl" | "apiKey" | "model" | "maxTurns" | "workDir"
>;

/** The `claude` invocation for one session (pure: tests check it without spawning). */
export function buildClaudeCommand(
  input: ClaudeCommandInput,
  options: { command?: string } = {},
): CommandSpec {
  const configPath = join(input.workDir, "claude-mcp.json");
  const config = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: "http",
        url: input.mcpUrl,
        headers: { Authorization: `Bearer ${input.apiKey}` },
      },
    },
  };
  const args = [
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
    `mcp__${MCP_SERVER_NAME}`,
    "--permission-mode",
    "dontAsk",
    "--setting-sources",
    "project,local",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--max-turns",
    String(input.maxTurns),
  ];
  if (input.model) args.push("--model", input.model);
  return {
    command: options.command ?? process.env.OO_EVAL_CLAUDE_BIN ?? "claude",
    args,
    env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
    cwd: input.workDir,
    stdin: input.prompt,
    files: [{ path: configPath, content: `${JSON.stringify(config, null, 2)}\n` }],
  };
}

interface ContentBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

function blocksOf(event: Record<string, unknown>): ContentBlock[] {
  const message = event.message as { content?: unknown } | undefined;
  return Array.isArray(message?.content) ? (message.content as ContentBlock[]) : [];
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && "text" in block ? String(block.text) : "",
    )
    .join("\n");
}

function toolName(name: string): string {
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

function usageOf(raw: unknown): RunnerUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const usage = raw as Record<string, unknown>;
  const number = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
  return {
    input_tokens: number("input_tokens"),
    output_tokens: number("output_tokens"),
    cache_read_tokens: number("cache_read_input_tokens"),
    cache_creation_tokens: number("cache_creation_input_tokens"),
  };
}

/** Parser for `claude -p --output-format stream-json --verbose` output. */
export function createClaudeStreamParser(): StreamParser {
  const state: StreamState = {
    finalText: "",
    turns: 0,
    usage: null,
    costUsd: null,
    toolUses: [],
    model: null,
    error: null,
    completed: false,
  };
  const pending = new Map<string, RunnerToolUse>();
  const messageIds = new Set<string>();
  let lastAssistantText = "";

  return {
    push(line) {
      const event = parseJsonLine(line);
      if (!event) return;
      if (event.type === "system" && event.subtype === "init") {
        if (typeof event.model === "string") state.model = event.model;
        const servers = Array.isArray(event.mcp_servers)
          ? (event.mcp_servers as Array<{ name?: string; status?: string }>)
          : [];
        const server = servers.find((entry) => entry.name === MCP_SERVER_NAME);
        if (server?.status && FAILED_SERVER_STATUSES.has(server.status)) {
          state.error = `the ${MCP_SERVER_NAME} MCP server did not connect (status ${server.status})`;
        }
        return;
      }
      if (event.type === "assistant") {
        const message = event.message as { id?: string; model?: string } | undefined;
        if (message?.id) messageIds.add(message.id);
        if (!state.model && message?.model) state.model = message.model;
        state.turns = Math.max(state.turns, messageIds.size);
        const texts: string[] = [];
        for (const block of blocksOf(event)) {
          if (block.type === "text" && block.text) texts.push(block.text);
          if (block.type === "tool_use" && block.id && block.name) {
            const use: RunnerToolUse = {
              name: toolName(block.name),
              args_summary: summarizeArgs(
                block.input && typeof block.input === "object"
                  ? (block.input as Record<string, unknown>)
                  : {},
              ),
              is_error: false,
              error_code: null,
            };
            pending.set(block.id, use);
            state.toolUses.push(use);
          }
        }
        if (texts.length > 0) lastAssistantText = texts.join("\n");
        return;
      }
      if (event.type === "user") {
        for (const block of blocksOf(event)) {
          if (block.type !== "tool_result" || !block.tool_use_id) continue;
          const use = pending.get(block.tool_use_id);
          if (!use) continue;
          use.is_error = block.is_error === true;
          use.error_code = use.is_error ? errorCodeFromText(resultText(block.content)) : null;
        }
        return;
      }
      if (event.type === "result") {
        state.completed = true;
        if (typeof event.result === "string") state.finalText = event.result;
        if (typeof event.num_turns === "number") state.turns = event.num_turns;
        if (typeof event.total_cost_usd === "number") state.costUsd = event.total_cost_usd;
        state.usage = usageOf(event.usage) ?? state.usage;
        if (event.subtype !== "success" || event.is_error === true) {
          const detail =
            typeof event.result === "string" && event.result ? `: ${event.result}` : "";
          state.error = `claude ended with ${String(event.subtype ?? "an error")}${detail}`;
        }
      }
    },
    state() {
      return {
        ...state,
        finalText: state.finalText || lastAssistantText,
        turns: state.turns || messageIds.size,
      };
    },
    stopReason() {
      return null;
    },
  };
}

export const claudeCliRunner: Runner = {
  name: "claude-cli",
  run(input) {
    return runCliSession("claude", buildClaudeCommand(input), createClaudeStreamParser(), input);
  },
};
