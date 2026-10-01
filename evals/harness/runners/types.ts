import type { RunnerToolUse, Scenario } from "../types.js";

/** Everything a runner needs to drive one agent session. */
export interface RunnerInput {
  // biome-ignore lint/suspicious/noExplicitAny: runners accept scenarios of any data shape
  scenario: Scenario<any>;
  /** Setup data (scripted runner hands it to the script). */
  data: Record<string, unknown>;
  /** Full task text for model runners (harness preamble + scenario prompt). */
  prompt: string;
  /** MCP endpoint with `?toolsets=` and the agent's bearer key. */
  mcpUrl: string;
  apiKey: string;
  model: string | undefined;
  maxTurns: number;
  /** Private scratch directory for config files and the working directory of CLIs. */
  workDir: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface RunnerUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

export interface RunnerOutput {
  /** The agent's final answer to the user. */
  finalText: string;
  turns: number;
  usage: RunnerUsage | null;
  /** USD when the runner reports or can compute it. */
  costUsd: number | null;
  toolUses: RunnerToolUse[];
  /** Model actually used, when reported. */
  model: string | null;
  /** Set when the session ended abnormally (timeout, CLI error, max turns). */
  error: string | null;
}

export interface Runner {
  name: RunnerName;
  run(input: RunnerInput): Promise<RunnerOutput>;
}

export const RUNNER_NAMES = ["scripted", "claude-cli", "codex-cli", "anthropic-api"] as const;
export type RunnerName = (typeof RUNNER_NAMES)[number];

/** Sums token usage across turns. */
export function addUsage(total: RunnerUsage | null, next: Partial<RunnerUsage>): RunnerUsage {
  return {
    input_tokens: (total?.input_tokens ?? 0) + (next.input_tokens ?? 0),
    output_tokens: (total?.output_tokens ?? 0) + (next.output_tokens ?? 0),
    cache_read_tokens: (total?.cache_read_tokens ?? 0) + (next.cache_read_tokens ?? 0),
    cache_creation_tokens: (total?.cache_creation_tokens ?? 0) + (next.cache_creation_tokens ?? 0),
  };
}
