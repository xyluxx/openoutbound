/**
 * Runs a local CLI (the user's own `claude` or `codex` binary) for the CLI brains: no shell,
 * prompt on stdin, a fresh empty working directory, capped output, abort and timeout handling.
 */
import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OpenOutboundError } from "../../core/errors.js";
import { type BrainErrorContext, brainError } from "./errors.js";

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface CliRunOptions {
  command: string;
  args: readonly string[];
  /** Written to stdin, which is then closed. */
  stdin?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Output cap per stream; the rest is dropped. Default 10 MB. */
  maxOutputBytes?: number;
  /** Wait after SIGTERM before SIGKILL, and after SIGKILL before giving up. Default 3 s. */
  killGraceMs?: number;
  /** Replaces child_process.spawn (tests). */
  spawn?: SpawnFn;
}

export interface CliRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Thrown when the CLI ran longer than `timeoutMs`. */
export class CliTimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(`${command} did not finish within ${Math.round(timeoutMs / 1000)} seconds`);
    this.name = "TimeoutError";
  }
}

/** Thrown when the caller aborted the run. */
export class CliAbortError extends Error {
  constructor(command: string) {
    super(`${command} was cancelled`);
    this.name = "AbortError";
  }
}

/** The brain error for a CLI run that hit its own `timeout_ms` (retryable, like API timeouts). */
export function cliTimeoutFailure(
  context: BrainErrorContext,
  error: CliTimeoutError,
): OpenOutboundError {
  return brainError(context, `${context.label} timed out: ${error.message}.`, {
    reason: "timeout",
    retryable: true,
    cause: error,
    hint: `Raise timeout_ms in the ${context.providerId} provider config (max 10 minutes), or pick a faster model for this task (workspace settings ai.task_models).`,
  });
}

const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 3_000;

/**
 * Spawns the command without a shell and collects its output. Rejects on spawn errors (ENOENT).
 * On timeout or abort the process is stopped (SIGTERM, then SIGKILL) and the promise settles
 * once it has exited, so the caller can remove its working directory safely.
 */
export function runCli(options: CliRunOptions): Promise<CliRunResult> {
  const spawnFn = options.spawn ?? (nodeSpawn as SpawnFn);
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const graceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  return new Promise<CliRunResult>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new CliAbortError(options.command));
      return;
    }
    let settled = false;
    let stopReason: Error | undefined;
    const timers: NodeJS.Timeout[] = [];
    let child: ChildProcess;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      settle();
    };
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    /** Stops the process; the run rejects with `reason` once the process is gone. */
    const stop = (reason: Error) => {
      if (settled || stopReason) return;
      stopReason = reason;
      if (exited()) {
        finish(() => reject(reason));
        return;
      }
      child.kill("SIGTERM");
      timers.push(
        setTimeout(() => {
          if (!exited()) child.kill("SIGKILL");
        }, graceMs),
        // A process that never reports its exit must not block the caller forever.
        setTimeout(() => finish(() => reject(reason)), graceMs * 2),
      );
    };
    const onAbort = () => stop(new CliAbortError(options.command));
    try {
      child = spawnFn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      reject(error);
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.timeoutMs) {
      const timeoutMs = options.timeoutMs;
      timers.push(
        setTimeout(() => stop(new CliTimeoutError(options.command, timeoutMs)), timeoutMs),
      );
    }
    const stdout = collector(maxBytes);
    const stderr = collector(maxBytes);
    child.stdout?.on("data", stdout.push);
    child.stderr?.on("data", stderr.push);
    child.on("error", (error) => finish(() => reject(stopReason ?? error)));
    child.on("exit", () => {
      if (stopReason) {
        const reason = stopReason;
        finish(() => reject(reason));
      }
    });
    child.on("close", (code, signal) =>
      finish(() => {
        if (stopReason) reject(stopReason);
        else resolve({ exitCode: code, signal, stdout: stdout.text(), stderr: stderr.text() });
      }),
    );
    // The process may exit before reading stdin (EPIPE); the exit code tells the story.
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.stdin ?? "");
  });
}

function collector(maxBytes: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  return {
    push: (chunk: Buffer | string) => {
      if (size >= maxBytes) return;
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      const room = maxBytes - size;
      chunks.push(buffer.length > room ? buffer.subarray(0, room) : buffer);
      size += Math.min(buffer.length, room);
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

/**
 * Runs `fn` with a fresh temp directory (`root`) and an empty working directory inside it
 * (`workDir`, the CLI's cwd, so it never sees a project). Removes everything afterwards.
 */
export async function withTempDir<T>(
  prefix: string,
  fn: (dirs: { root: string; workDir: string }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), `${prefix}-`));
  const workDir = path.join(root, "work");
  try {
    await mkdir(workDir);
    return await fn({ root, workDir });
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Env vars that hold OpenOutbound's own configuration and provider keys. They are removed from
 * the CLI's environment: the CLI brains use the user's own CLI login, never our secrets.
 */
export const ENGINE_SECRET_ENV = [
  "DATABASE_URL",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "APOLLO_API_KEY",
  "GOOGLE_MAPS_API_KEY",
  "PARALLEL_API_KEY",
  "EXA_API_KEY",
  "TAVILY_API_KEY",
  "FIRECRAWL_API_KEY",
  "PREDICTLEADS_API_KEY",
  "PREDICTLEADS_API_TOKEN",
  "CRUSTDATA_API_KEY",
  "ICYPEAS_API_KEY",
  "FINDYMAIL_API_KEY",
  "HUNTER_API_KEY",
  "PROSPEO_API_KEY",
  "MILLIONVERIFIER_API_KEY",
  "REOON_API_KEY",
  "UNIPILE_DSN",
  "UNIPILE_API_KEY",
  "LINKEDIN_CLIENT_ID",
  "LINKEDIN_CLIENT_SECRET",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "MICROSOFT_OAUTH_CLIENT_ID",
  "MICROSOFT_OAUTH_CLIENT_SECRET",
  "MICROSOFT_OAUTH_TENANT",
  "HUBSPOT_ACCESS_TOKEN",
  "PIPEDRIVE_API_TOKEN",
  "SLACK_WEBHOOK_URL",
] as const;

/**
 * The environment for a CLI brain: the parent environment (so the CLI finds its own install and
 * login) minus OpenOutbound settings, provider keys and the `remove` names, plus `extra`.
 */
export function cliEnv(
  extra: Record<string, string> = {},
  base: NodeJS.ProcessEnv = process.env,
  remove: readonly string[] = [],
): NodeJS.ProcessEnv {
  const blocked = new Set<string>(
    [...ENGINE_SECRET_ENV, ...remove].map((name) => name.toUpperCase()),
  );
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    const upper = name.toUpperCase();
    if (value === undefined || blocked.has(upper) || upper.startsWith("OPENOUTBOUND_")) continue;
    env[name] = value;
  }
  return { ...env, ...extra };
}

/** Model names and aliases passed on a command line: letters, digits and `._:/-` only. */
export const CLI_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

/** True when a spawn error means the command does not exist. */
export function isCommandNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "ENOENT" || code === "EINVAL" || code === "EACCES";
}
