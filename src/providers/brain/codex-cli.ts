import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isUnsupportedSchemaError, withSchemaInstruction } from "../../brain/json-schema.js";
import { parseJsonReply } from "../../brain/output.js";
import { renderTranscript, requestExtras } from "../../brain/request.js";
import { toStrictJsonSchema } from "../../brain/strict-schema.js";
import type { ModelTier } from "../../core/enums.js";
import { type Logger, silentLogger } from "../../core/logger.js";
import {
  type BrainRequest,
  type BrainResponse,
  type BrainUsage,
  defineProvider,
} from "../types.js";
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

/** Model placeholder meaning "Codex's own default model" (no `-m` flag). */
export const CODEX_DEFAULT_MODEL = "codex-default";
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** Longer system prompts go to stdin instead of a command-line config value. */
const MAX_INLINE_INSTRUCTIONS = 24_000;

export const CODEX_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export type CodexEffort = (typeof CODEX_EFFORTS)[number];
const effortSchema = z.enum(CODEX_EFFORTS);

export const codexCliConfigSchema = z.object({
  command: z
    .string()
    .min(1)
    .optional()
    .describe("Path to the codex executable (default: codex on PATH)"),
  models: brainModelsSchema
    .optional()
    .describe("Codex model per tier (default: the Codex default model)"),
  reasoning_effort: z
    .object({
      fast: effortSchema.optional(),
      standard: effortSchema.optional(),
      deep: effortSchema.optional(),
    })
    .optional()
    .describe("model_reasoning_effort per tier (default: low for fast)"),
  timeout_ms: z
    .number()
    .int()
    .min(10_000)
    .max(600_000)
    .optional()
    .describe("Kill the CLI after this long (default and max 10 minutes)"),
});
export type CodexCliConfig = z.infer<typeof codexCliConfigSchema>;

const DEFAULT_EFFORT: Partial<Record<ModelTier, CodexEffort>> = { fast: "low" };

/** A TOML basic string for `-c key=value` (JSON string escapes are valid TOML escapes). */
export function tomlString(value: string): string {
  const wellFormed = Buffer.from(value, "utf8").toString("utf8");
  return JSON.stringify(wellFormed).split(String.fromCharCode(0x7f)).join("\\u007f");
}

/**
 * Arguments for one `codex exec` run: prompt from stdin, no git check, no saved session, user
 * config ignored, read-only sandbox, shell tool and web search off, our system prompt as
 * developer instructions, the strict output schema from a file and the final message to a file.
 */
export function buildCodexArgs(input: {
  model: string;
  outputFile: string;
  schemaFile?: string;
  developerInstructions?: string;
  reasoningEffort?: CodexEffort;
}): string[] {
  const args = [
    "exec",
    "-",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--sandbox",
    "read-only",
  ];
  if (input.model !== CODEX_DEFAULT_MODEL) args.push("-m", input.model);
  args.push("-c", "features.shell_tool=false", "-c", 'web_search="disabled"');
  if (input.developerInstructions) {
    args.push("-c", `developer_instructions=${tomlString(input.developerInstructions)}`);
  }
  if (input.reasoningEffort) args.push("-c", `model_reasoning_effort="${input.reasoningEffort}"`);
  if (input.schemaFile) args.push("--output-schema", input.schemaFile);
  args.push("-o", input.outputFile, "--json");
  return args;
}

export interface CodexEvents {
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
  /** Last agent message text. */
  lastMessage?: string;
  errors: string[];
}

/** Reads the `--json` event stream (JSON Lines): usage, the last agent message and errors. */
export function parseCodexEvents(stdout: string): CodexEvents {
  const events: CodexEvents = { errors: [] };
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = event.type;
    if (type === "turn.completed" && typeof event.usage === "object" && event.usage) {
      events.usage = event.usage as CodexEvents["usage"];
    } else if (type === "turn.failed") {
      const message = (event.error as { message?: unknown } | undefined)?.message;
      if (typeof message === "string") events.errors.push(message);
    } else if (type === "error" && typeof event.message === "string") {
      events.errors.push(event.message);
    } else if (type === "item.completed") {
      const item = event.item as { type?: unknown; text?: unknown } | undefined;
      if (item?.type === "agent_message" && typeof item.text === "string") {
        events.lastMessage = item.text;
      }
    }
  }
  return events;
}

function codexUsage(events: CodexEvents): BrainUsage {
  return {
    inputTokens: events.usage?.input_tokens ?? 0,
    outputTokens: events.usage?.output_tokens ?? 0,
    cachedTokens: events.usage?.cached_input_tokens ?? 0,
    costUsd: null,
  };
}

const SECONDS_PER_UNIT: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 };

/** Seconds until a usage limit resets, from "try again in 3 hours" or "in 2h 30m" style text. */
export function codexResetSeconds(detail: string): number | undefined {
  const phrase = /try again in ([^.;]+)/i.exec(detail)?.[1];
  if (!phrase) return undefined;
  let total = 0;
  for (const match of phrase.matchAll(/(\d+(?:\.\d+)?)\s*(d|h|m|s)[a-z]*/gi)) {
    total += Number(match[1]) * (SECONDS_PER_UNIT[(match[2] ?? "").toLowerCase()] ?? 0);
  }
  return total > 0 ? Math.ceil(total) : undefined;
}

/** Classifies a failed run from its error messages. */
export function codexFailure(
  context: BrainErrorContext,
  detail: string,
  usage: BrainUsage,
  exitCode: number | null,
) {
  const fail = (
    reason: BrainFailureReason,
    retryable: boolean,
    message: string,
    hint: string,
    retryAfterSeconds?: number,
  ) =>
    brainError(context, message, {
      reason,
      retryable,
      usage,
      hint,
      extra: { exit_code: exitCode },
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    });
  if (/usage limit|hit your limit|quota/i.test(detail)) {
    // Retryable once the limit resets: background jobs try again then.
    return fail(
      "usage_limit",
      true,
      `Your Codex usage limit is reached: ${detail}`,
      "Wait for the limit to reset, or switch the brain provider (manage_providers) to openai with an API key.",
      codexResetSeconds(detail) ?? USAGE_LIMIT_RETRY_SECONDS,
    );
  }
  if (/401|unauthori[sz]ed|not logged in|log ?in|authenticat|api key/i.test(detail)) {
    return fail(
      "auth",
      false,
      `Codex is not signed in: ${detail}`,
      "Open a terminal and run `codex login` (OpenOutbound never reads your Codex credentials), then retry.",
    );
  }
  if (/rate limit|429|too many requests|overloaded|503|502|timed? ?out/i.test(detail)) {
    return fail(
      "rate_limited",
      true,
      `Codex is busy right now: ${detail}`,
      "OpenOutbound retries automatically.",
    );
  }
  if (/model/i.test(detail) && /not (found|supported|exist)|does not exist|unknown/i.test(detail)) {
    return fail(
      "model_not_found",
      false,
      `Codex does not accept this model: ${detail}`,
      "Check config models of the codex_cli provider (or remove them to use the Codex default).",
    );
  }
  return fail(
    "cli_error",
    false,
    `Codex failed${exitCode !== null ? ` (exit code ${exitCode})` : ""}${detail ? `: ${detail}` : "."}`,
    'Run `codex exec "hello"` in a terminal to check the installation and login.',
  );
}

export interface CreateCodexCliBrainOptions {
  config?: CodexCliConfig;
  log?: Logger;
  spawn?: SpawnFn;
  env?: NodeJS.ProcessEnv;
}

/**
 * The user's own Codex login (ChatGPT plan or CODEX_API_KEY) through the official `codex` CLI
 * (personal use). Each call runs `codex exec` in a fresh empty temp directory, read-only, with
 * the shell tool and web search off. OpenOutbound never reads Codex credentials.
 */
export function createCodexCliBrain(
  options: CreateCodexCliBrainOptions = {},
): CheckableBrainProvider {
  const config = options.config ?? {};
  const log = options.log ?? silentLogger();
  const command = config.command ?? "codex";
  const effortByTier = { ...DEFAULT_EFFORT, ...config.reasoning_effort };
  const context = (model?: string): BrainErrorContext => ({
    label: "Codex",
    providerId: "codex_cli",
    ...(model ? { model } : {}),
  });
  const notFound = (error: unknown) =>
    brainError(context(), `Could not start the Codex CLI (${command}).`, {
      reason: "cli_not_found",
      retryable: false,
      cause: error,
      hint: "Install the Codex CLI, run `codex login`, and make sure `codex` is on PATH (or set config command to the full path of the codex executable).",
    });
  const env = () => cliEnv({}, options.env ?? process.env);

  async function run(request: BrainRequest): Promise<BrainResponse> {
    if (request.model !== CODEX_DEFAULT_MODEL && !CLI_MODEL_PATTERN.test(request.model)) {
      throw brainError(
        context(request.model),
        `"${request.model}" is not a valid Codex model name.`,
        {
          reason: "bad_request",
          retryable: false,
          hint: "Use a model id in the codex_cli config models.",
        },
      );
    }
    return withTempDir("oo-codex", async ({ root, workDir }) => {
      let system = request.system;
      let schemaFile: string | undefined;
      if (request.jsonSchema) {
        try {
          const strict = toStrictJsonSchema(request.jsonSchema);
          schemaFile = path.join(root, "output-schema.json");
          await writeFile(schemaFile, JSON.stringify(strict), "utf8");
        } catch (error) {
          if (!isUnsupportedSchemaError(error)) throw error;
          system = withSchemaInstruction(system, request.jsonSchema);
        }
      }
      const inline = system.length <= MAX_INLINE_INSTRUCTIONS;
      const transcript = renderTranscript(request);
      const stdin =
        inline || !system.trim()
          ? transcript
          : `<instructions>\n${system}\n</instructions>\n\n${transcript}`;
      const outputFile = path.join(root, "last-message.txt");
      const tier = requestExtras(request).tier;
      const reasoningEffort = tier ? effortByTier[tier] : undefined;
      const args = buildCodexArgs({
        model: request.model,
        outputFile,
        ...(schemaFile ? { schemaFile } : {}),
        ...(inline && system.trim() ? { developerInstructions: system } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
      });
      let result: Awaited<ReturnType<typeof runCli>>;
      try {
        result = await runCli({
          command,
          args,
          stdin,
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
      const events = parseCodexEvents(result.stdout);
      const usage = codexUsage(events);
      const output = await readFile(outputFile, "utf8").catch(() => undefined);
      const text = (output ?? events.lastMessage ?? "").trim();
      if (result.exitCode !== 0 || events.errors.length > 0 || !text) {
        const detail = [...events.errors, result.stderr]
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 300);
        if (result.exitCode === 0 && text && events.errors.length > 0) {
          log.warn({ errors: events.errors }, "codex reported errors but produced an answer");
        } else {
          throw codexFailure(context(request.model), detail, usage, result.exitCode);
        }
      }
      const json = parseJsonReply(text);
      return { text, ...(json !== undefined ? { json } : {}), model: request.model, usage };
    });
  }

  return {
    id: "codex_cli",
    capabilities: { structuredOutput: "native", maxConcurrency: 1, caching: false },
    defaultModels: mergeModels(
      { fast: CODEX_DEFAULT_MODEL, standard: CODEX_DEFAULT_MODEL, deep: CODEX_DEFAULT_MODEL },
      config.models,
    ),
    generate: run,
    async check() {
      try {
        const result = await runCli({
          command,
          args: ["--version"],
          cwd: process.cwd(),
          env: env(),
          timeoutMs: 30_000,
          ...(options.spawn ? { spawn: options.spawn } : {}),
        });
        const version = result.stdout.trim();
        if (result.exitCode !== 0 || !version) {
          return {
            ok: false,
            message: `\`${command} --version\` failed (exit code ${result.exitCode}).`,
          };
        }
        return {
          ok: true,
          message: `Found ${version}. It uses your own Codex login (personal use); run \`codex login\` if calls fail.`,
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

export const codexCliBrainProvider = defineProvider({
  slot: "brain",
  id: "codex_cli",
  name: "Codex (CLI, personal use)",
  description:
    "Uses your own Codex login (ChatGPT plan) through the official codex CLI; personal use. Runs `codex exec` locally, read-only, with the shell and web search off; OpenOutbound never reads your credentials. One call at a time; cost is not reported.",
  docsUrl: "https://developers.openai.com/codex/noninteractive",
  configSchema: codexCliConfigSchema,
  secrets: [],
  create: ({ config, ctx }) => createCodexCliBrain({ config, log: ctx.log }),
  test: testBrainProvider,
});
