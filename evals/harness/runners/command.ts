/**
 * Spawning agent CLIs: a pure command description (so tests can check it without running
 * anything) and a runner that writes the config files, pipes the prompt on stdin, streams
 * stdout lines to a parser and stops the process tree on timeout.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface CommandSpec {
  command: string;
  args: string[];
  /** Added to the current environment. */
  env: Record<string, string>;
  cwd: string;
  stdin: string;
  /** Written before the process starts (MCP config and the like). */
  files: Array<{ path: string; content: string }>;
}

export interface CommandResult {
  exitCode: number | null;
  stderr: string;
  timedOut: boolean;
  /** Spawn failure (binary not found, ...). */
  spawnError: string | null;
}

/** Quotes one argument for cmd.exe + the MSVCRT argv parser (Windows only). */
export function quoteWindowsArg(value: string): string {
  if (value !== "" && !/[\s"^&|<>()%!]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => {});
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

export async function runCommand(
  spec: CommandSpec,
  options: { signal: AbortSignal; onLine: (line: string) => void },
): Promise<CommandResult> {
  for (const file of spec.files) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content, { mode: 0o600 });
  }
  const windows = process.platform === "win32";
  return new Promise<CommandResult>((resolve) => {
    let stderr = "";
    let buffer = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const child = windows
      ? spawn([spec.command, ...spec.args].map(quoteWindowsArg).join(" "), {
          cwd: spec.cwd,
          env: { ...process.env, ...spec.env },
          shell: true,
          windowsHide: true,
        })
      : spawn(spec.command, spec.args, {
          cwd: spec.cwd,
          env: { ...process.env, ...spec.env },
          detached: true,
        });
    const onAbort = () => {
      timedOut = true;
      killTree(child.pid);
    };
    options.signal.addEventListener("abort", onAbort);
    child.on("error", (error) =>
      finish({ exitCode: null, stderr, timedOut, spawnError: error.message }),
    );
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) options.onLine(line);
        index = buffer.indexOf("\n");
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    child.on("close", (code) => {
      if (buffer.trim()) options.onLine(buffer.trim());
      finish({ exitCode: code, stderr, timedOut, spawnError: null });
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(spec.stdin);
    if (options.signal.aborted) onAbort();
  });
}

/** Error code from an OpenOutbound tool error text ("Error (code): message"). */
export function errorCodeFromText(text: string): string | null {
  return /Error \(([a-z_]+)\)/.exec(text)?.[1] ?? null;
}
