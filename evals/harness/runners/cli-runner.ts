/**
 * Shared driver for agent CLIs: runs a command spec, feeds every stdout line to a stream parser
 * and turns the parser state plus the exit status into a RunnerOutput. Parsers may ask to stop
 * the process (for example when a CLI has no turn limit of its own).
 */
import type { RunnerToolUse } from "../types.js";
import { type CommandResult, type CommandSpec, runCommand } from "./command.js";
import type { RunnerInput, RunnerOutput, RunnerUsage } from "./types.js";

/** What a stream parser collected from the CLI output. */
export interface StreamState {
  finalText: string;
  turns: number;
  usage: RunnerUsage | null;
  costUsd: number | null;
  toolUses: RunnerToolUse[];
  model: string | null;
  /** Set when the stream itself reported a failure (error result, failed turn, ...). */
  error: string | null;
  /** True once the stream reported its final result. */
  completed: boolean;
}

export interface StreamParser {
  push(line: string): void;
  state(): StreamState;
  /** A reason to stop the process now (checked after every line), or null. */
  stopReason(): string | null;
}

/** Parses one JSONL line; null for blank or non-JSON lines (CLIs sometimes print notices). */
export function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function lastLines(text: string, count: number): string {
  return text.trim().split(/\r?\n/).slice(-count).join("\n");
}

/** Combines the parsed stream with how the process ended. */
export function finishStream(
  label: string,
  state: StreamState,
  result: CommandResult,
  stopReason: string | null,
): RunnerOutput {
  let error = state.error;
  if (result.spawnError) {
    error = `could not start ${label}: ${result.spawnError}. Is it installed and on PATH?`;
  } else if (stopReason) {
    error = stopReason;
  } else if (result.timedOut) {
    error = `${label} timed out`;
  } else if (!state.completed && error === null) {
    const stderr = lastLines(result.stderr, 5);
    error = `${label} exited with code ${result.exitCode} before finishing${stderr ? `: ${stderr}` : ""}`;
  }
  return {
    finalText: state.finalText,
    turns: state.turns,
    usage: state.usage,
    costUsd: state.costUsd,
    toolUses: state.toolUses,
    model: state.model,
    error,
  };
}

/** Runs a CLI agent session: spawn, stream-parse, stop on timeout or parser request. */
export async function runCliSession(
  label: string,
  spec: CommandSpec,
  parser: StreamParser,
  input: Pick<RunnerInput, "signal">,
): Promise<RunnerOutput> {
  const controller = new AbortController();
  const forward = () => controller.abort();
  input.signal.addEventListener("abort", forward);
  if (input.signal.aborted) controller.abort();
  let stopReason: string | null = null;
  try {
    const result = await runCommand(spec, {
      signal: controller.signal,
      onLine(line) {
        parser.push(line);
        const reason = parser.stopReason();
        if (reason && !stopReason) {
          stopReason = reason;
          controller.abort();
        }
      },
    });
    return finishStream(label, parser.state(), result, stopReason);
  } finally {
    input.signal.removeEventListener("abort", forward);
  }
}
