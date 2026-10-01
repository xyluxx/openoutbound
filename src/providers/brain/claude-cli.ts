import { writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { JsonSchema } from "../../brain/json-schema.js";
import { renderTranscript } from "../../brain/request.js";
import type { ModelTier } from "../../core/enums.js";
import { type Logger, silentLogger } from "../../core/logger.js";
import { type BrainResponse, type BrainUsage, defineProvider } from "../types.js";
import {
  CLI_MODEL_PATTERN,
  CliTimeoutError,
  cliEnv,
  cliTimeoutFailure,
  isCommandNotFound,
  runCli,
  type SpawnFn,
  withTempDir,
} from "./cli-process.js";
import {
  type BrainErrorContext,
  type BrainFailureReason,
  brainError,
  USAGE_LIMIT_RETRY_SECONDS,
} from "./errors.js";
import {
  brainModelsSchema,
  type CheckableBrainProvider,
  mergeModels,
  testBrainProvider,
} from "./shared.js";

/** Tier defaults: Claude Code model aliases (spec section 10). */
export const CLAUDE_CLI_DEFAULT_MODELS: Readonly<Record<ModelTier, string>> = {
  fast: "haiku",
  standard: "sonnet",
  deep: "opus",
};
const DEFAULT_MAX_TURNS = 3;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/**
 * Session variables Claude Code sets for the processes it starts (MCP servers such as
 * OpenOutbound, shell commands). A CLI brain call is a fresh, independent session, so they are
 * removed, as Claude Code does itself when it starts a new session; otherwise `claude -p` would
 * link to the session that launched the engine.
 */
export const CLAUDE_SESSION_ENV = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_BG_AUTH_SNAPSHOT_PATH",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_EFFORT",
  "AI_AGENT",
  "TRACEPARENT",
] as const;

export const claudeCliConfigSchema = z.object({
  command: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Path to the claude executable (default: claude on PATH; on Windows the native claude.exe)",
    ),
  models: brainModelsSchema
    .optional()
    .describe("Model alias or id per tier (default haiku, sonnet, opus)"),
  max_turns: z.number().int().min(1).max(10).optional().describe("--max-turns (default 3)"),
  timeout_ms: z
    .number()
    .int()
    .min(10_000)
    .max(600_000)
    .optional()
    .describe("Kill the CLI after this long (default and max 10 minutes)"),
});
export type ClaudeCliConfig = z.infer<typeof claudeCliConfigSchema>;

/**
 * Arguments for one headless Claude Code run: print mode with JSON output, the output schema,
 * our system prompt from a file (it replaces Claude Code's own), no built-in or MCP tools, no
 * saved session and a small turn cap. The prompt itself goes to stdin.
 */
export function buildClaudeCliArgs(input: {
  model: string;
  systemPromptFile: string;
  jsonSchema?: JsonSchema;
  maxTurns?: number;
}): string[] {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--system-prompt-file",
    input.systemPromptFile,
    "--tools",
    "",
    "--disallowedTools",
    "mcp__*",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--max-turns",
    String(input.maxTurns ?? DEFAULT_MAX_TURNS),
    "--model",
    input.model,
  ];
  if (input.jsonSchema) args.push("--json-schema", JSON.stringify(input.jsonSchema));
  return args;
}

/** The result message printed by `claude -p --output-format json`. */
export interface ClaudeCliResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  errors?: string[];
  api_error_status?: number | null;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number }>;
}

/** Finds the result message in stdout (one JSON object, an array of messages, or JSON lines). */
export function parseClaudeCliOutput(stdout: string): ClaudeCliResult | undefined {
  const text = stdout.trim();
  if (!text) return undefined;
  const candidates: unknown[] = [];
  try {
    candidates.push(JSON.parse(text));
  } catch {
    for (const line of text.split(/\r?\n/).reverse()) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        candidates.push(JSON.parse(trimmed));
        break;
      } catch {
        // not a JSON line
      }
    }
  }
  for (const candidate of candidates) {
    const list = Array.isArray(candidate) ? [...candidate].reverse() : [candidate];
    const found = list.find(
      (item) =>
        typeof item === "object" && item !== null && (item as ClaudeCliResult).type === "result",
    );
    if (found) return found as ClaudeCliResult;
  }
  return undefined;
}

function claudeUsage(result: ClaudeCliResult): BrainUsage {
  const usage = result.usage ?? {};
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  return {
    inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + cacheRead,
    outputTokens: usage.output_tokens ?? 0,
    cachedTokens: cacheRead,
    // Subscription usage has no per-call price; total_cost_usd is only a client-side estimate.
    costUsd: null,
  };
}

function reportedModel(result: ClaudeCliResult, fallback: string): string {
  const entries = Object.entries(result.modelUsage ?? {});
  if (entries.length === 0) return fallback;
  entries.sort((a, b) => (b[1].outputTokens ?? 0) - (a[1].outputTokens ?? 0));
  return entries[0]?.[0] ?? fallback;
}

const LOGIN_HINT =
  "Open a terminal, run `claude` and sign in with /login (OpenOutbound never reads your Claude credentials), then retry.";

/** Maps a Claude Code result message to a brain response or an actionable error. */
export function mapClaudeCliResult(
  result: ClaudeCliResult,
  context: BrainErrorContext,
  now: Date = new Date(),
): BrainResponse {
  const model = reportedModel(result, context.model ?? "claude");
  const usage = claudeUsage(result);
  const errorContext = { ...context, model };
  const failed = result.is_error === true || (result.subtype ?? "success") !== "success";
  if (failed) {
    const detail = [result.result, ...(result.errors ?? [])]
      .filter((part): part is string => typeof part === "string" && part.trim() !== "")
      .join(" ")
      .replace(/\s+/g, " ")
      .slice(0, 300);
    const status = result.api_error_status ?? undefined;
    const fail = (
      reason: BrainFailureReason,
      retryable: boolean,
      message: string,
      hint: string,
      retryAfterSeconds?: number,
    ) =>
      brainError(errorContext, message, {
        reason,
        retryable,
        usage,
        hint,
        extra: { subtype: result.subtype ?? null },
        ...(status ? { status } : {}),
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      });
    // Subtypes are definitive; the text checks below only classify generic failures.
    if (result.subtype === "error_max_structured_output_retries") {
      throw fail(
        "invalid_output",
        false,
        "Claude Code could not produce output that matches the schema.",
        "Retry later, or route this task to a stronger model (workspace settings ai.task_models).",
      );
    }
    if (result.subtype === "error_max_turns") {
      throw fail(
        "cli_error",
        false,
        `Claude Code stopped after ${result.num_turns ?? "the maximum"} turns without an answer.`,
        "Raise max_turns in the claude_cli provider config, or use the anthropic provider.",
      );
    }
    if (/usage limit|limit reached|out of (extra )?usage/i.test(detail)) {
      const reset = /\|(\d{9,11})\b/.exec(detail);
      const seconds = reset
        ? Math.max(0, Math.round(Number(reset[1]) - now.getTime() / 1000))
        : USAGE_LIMIT_RETRY_SECONDS;
      throw fail(
        "usage_limit",
        true,
        "Your Claude plan's usage limit is reached.",
        "Wait for the limit to reset, or switch the brain provider (manage_providers) to anthropic with an API key.",
        seconds,
      );
    }
    if (
      status === 401 ||
      /log ?in|logged out|authenticat|oauth|invalid api key|credential/i.test(detail)
    ) {
      throw fail(
        "auth",
        false,
        `Claude Code is not signed in: ${detail || "authentication failed"}`,
        LOGIN_HINT,
      );
    }
    if (status === 429 || status === 529 || /rate limit|overloaded/i.test(detail)) {
      throw fail(
        status === 529 || /overloaded/i.test(detail) ? "overloaded" : "rate_limited",
        true,
        `Claude is busy right now: ${detail || `status ${status}`}`,
        "OpenOutbound retries automatically.",
      );
    }
    throw fail(
      "cli_error",
      result.subtype === "error_during_execution",
      `Claude Code failed${result.subtype ? ` (${result.subtype})` : ""}${detail ? `: ${detail}` : "."}`,
      'Run `claude -p "hello"` in a terminal to check the installation and login.',
    );
  }
  if (result.structured_output === undefined || result.structured_output === null) {
    throw brainError(errorContext, "Claude Code finished without structured output.", {
      reason: "invalid_output",
      retryable: false,
      usage,
      hint: "Retry later, or route this task to another provider (workspace settings ai.task_models).",
    });
  }
  return {
    text: JSON.stringify(result.structured_output),
    json: result.structured_output,
    model,
    usage,
  };
}

export interface CreateClaudeCliBrainOptions {
  config?: ClaudeCliConfig;
  log?: Logger;
  /** Replaces child_process.spawn (tests). */
  spawn?: SpawnFn;
  /** Base environment (tests); default process.env. */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/**
 * The user's own Claude subscription through the official `claude` CLI (personal use). Every
 * call runs `claude -p` in a fresh empty temp directory with tools and MCP servers disabled.
 * OpenOutbound never reads, copies or stores Claude credentials: the CLI signs in by itself.
 */
export function createClaudeCliBrain(
  options: CreateClaudeCliBrainOptions = {},
): CheckableBrainProvider {
  const config = options.config ?? {};
  const log = options.log ?? silentLogger();
  const command = config.command ?? "claude";
  const now = options.now ?? (() => new Date());
  const context = (model?: string): BrainErrorContext => ({
    label: "Claude Code",
    providerId: "claude_cli",
    ...(model ? { model } : {}),
  });
  const notFound = (error: unknown) =>
    brainError(context(), `Could not start the Claude Code CLI (${command}).`, {
      reason: "cli_not_found",
      retryable: false,
      cause: error,
      hint: "Install Claude Code, run `claude` once to sign in, and make sure it is on PATH (or set config command to its full path; on Windows use the native claude.exe).",
    });
  const env = () =>
    cliEnv(
      { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
      options.env ?? process.env,
      CLAUDE_SESSION_ENV,
    );

  return {
    id: "claude_cli",
    capabilities: { structuredOutput: "native", maxConcurrency: 1, caching: false },
    defaultModels: mergeModels(CLAUDE_CLI_DEFAULT_MODELS, config.models),
    async generate(request) {
      if (!CLI_MODEL_PATTERN.test(request.model)) {
        throw brainError(
          context(request.model),
          `"${request.model}" is not a valid Claude model name.`,
          {
            reason: "bad_request",
            retryable: false,
            hint: "Use an alias (haiku, sonnet, opus) or a model id in the claude_cli config models.",
          },
        );
      }
      return withTempDir("oo-claude", async ({ root, workDir }) => {
        const systemPromptFile = path.join(root, "system-prompt.md");
        await writeFile(systemPromptFile, request.system, "utf8");
        const args = buildClaudeCliArgs({
          model: request.model,
          systemPromptFile,
          ...(request.jsonSchema ? { jsonSchema: request.jsonSchema } : {}),
          maxTurns: config.max_turns ?? DEFAULT_MAX_TURNS,
        });
        let run: Awaited<ReturnType<typeof runCli>>;
        try {
          run = await runCli({
            command,
            args,
            stdin: renderTranscript(request),
            cwd: workDir,
            env: env(),
            timeoutMs: config.timeout_ms ?? DEFAULT_TIMEOUT_MS,
            ...(request.signal ? { signal: request.signal } : {}),
            ...(options.spawn ? { spawn: options.spawn } : {}),
          });
        } catch (error) {
          if (isCommandNotFound(error)) throw notFound(error);
          if (error instanceof CliTimeoutError) {
            throw cliTimeoutFailure(context(request.model), error);
          }
          throw error;
        }
        const result = parseClaudeCliOutput(run.stdout);
        if (!result) {
          const detail = (run.stderr || run.stdout).replace(/\s+/g, " ").trim().slice(0, 300);
          log.warn({ exit_code: run.exitCode, stderr: detail }, "claude CLI printed no result");
          throw brainError(
            context(request.model),
            `Claude Code exited with code ${run.exitCode ?? run.signal ?? "unknown"} without a result${detail ? `: ${detail}` : "."}`,
            {
              reason: "cli_error",
              retryable: false,
              hint: 'Run `claude -p "hello"` in a terminal to check the installation and login.',
            },
          );
        }
        return mapClaudeCliResult(result, context(request.model), now());
      });
    },
    async check() {
      try {
        const run = await runCli({
          command,
          args: ["--version"],
          cwd: process.cwd(),
          env: env(),
          timeoutMs: 30_000,
          ...(options.spawn ? { spawn: options.spawn } : {}),
        });
        const version = run.stdout.trim().split(/\s+/)[0] ?? "";
        if (run.exitCode !== 0 || !version) {
          return {
            ok: false,
            message: `\`${command} --version\` failed (exit code ${run.exitCode}).`,
          };
        }
        return {
          ok: true,
          message: `Found Claude Code ${version}. It uses your own Claude login (personal use); sign in by running \`claude\` if calls fail.`,
          details: { version },
        };
      } catch (error) {
        const failure = isCommandNotFound(error) ? notFound(error) : null;
        return {
          ok: false,
          message: failure ? `${failure.message} ${failure.hint}` : (error as Error).message,
        };
      }
    },
  };
}

export const claudeCliBrainProvider = defineProvider({
  slot: "brain",
  id: "claude_cli",
  name: "Claude subscription (CLI, personal use)",
  description:
    "Uses your own Claude subscription through the official CLI; personal use. Runs `claude -p` locally with tools disabled; OpenOutbound never reads your credentials. One call at a time; cost is not reported.",
  docsUrl: "https://code.claude.com/docs/en/headless",
  configSchema: claudeCliConfigSchema,
  secrets: [],
  create: ({ config, ctx }) => createClaudeCliBrain({ config, log: ctx.log }),
  test: testBrainProvider,
});
