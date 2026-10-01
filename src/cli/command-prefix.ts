/**
 * Commands in hints, written the way the person started this CLI: `openoutbound` from an
 * installed binary, `pnpm openoutbound` through the package script, or `node dist/cli/main.js`
 * from a clone (with `--home` when the engine home is not the current folder). The engine writes
 * `openoutbound ...`; the CLI rewrites it before printing. JSON output is never rewritten.
 */
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { CliContext } from "./context.js";

/** The path functions of the platform the command is printed for. */
function pathsOf(platform: NodeJS.Platform) {
  return platform === "win32" ? win32 : posix;
}

/**
 * A path as written in a printed command. On Windows with forward slashes: bash (Git Bash, the
 * shell Claude Code uses there) drops the backslashes of a bare `C:\Users\...`, while
 * `C:/Users/...` works in Git Bash, PowerShell, cmd and node. Quoted when it has spaces or quotes.
 */
function quotePath(path: string, platform: NodeJS.Platform): string {
  const printed = platform === "win32" ? path.replaceAll("\\", "/") : path;
  return /[\s"'&()]/.test(printed) ? `"${printed}"` : printed;
}

/**
 * `node <entry point>` for a script path, preferring the build when the script is the
 * TypeScript source (`npx tsx` started from another folder may not find tsx and try to
 * download it), else `npx tsx <source>`.
 */
function entryPointCommand(
  scriptPath: string,
  exists: (path: string) => boolean,
  platform: NodeJS.Platform,
  cwd?: string,
): string {
  const paths = pathsOf(platform);
  let script = scriptPath;
  if (script.endsWith(".ts")) {
    const built = paths.resolve(paths.dirname(script), "..", "..", "dist", "cli", "main.js");
    if (exists(built)) script = built;
  }
  const runner = script.endsWith(".ts") ? "npx tsx" : "node";
  return `${runner} ${quotePath(cwd ? pathFrom(cwd, script, platform) : script, platform)}`;
}

/**
 * The path relative to `cwd` when it lies inside it, with forward slashes (they work in every
 * shell, backslashes do not in bash), else the path as it is.
 */
function pathFrom(cwd: string, path: string, platform: NodeJS.Platform): string {
  const paths = pathsOf(platform);
  const rel = paths.relative(paths.resolve(cwd), paths.resolve(path));
  if (rel === "" || rel.startsWith("..") || paths.isAbsolute(rel)) return path;
  return rel.split(paths.sep).join("/");
}

/**
 * The command an agent host runs to start the stdio MCP server for this home. When init runs
 * from source (`pnpm openoutbound init`) and the build exists, it prints the built entry point.
 */
export function mcpLaunchCommand(
  scriptPath: string,
  home: string,
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): string {
  return `${entryPointCommand(scriptPath, exists, platform)} --home ${quotePath(home, platform)} mcp`;
}

export interface CliCommandPrefixInput {
  /** The running CLI script (process.argv[1]). */
  scriptPath: string;
  /** The engine home. */
  home: string;
  /** The directory the command ran in. */
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  exists?: (path: string) => boolean;
  /** The platform the command is printed for (default: this one). */
  platform?: NodeJS.Platform;
}

/**
 * How to write CLI commands so they work the way this CLI was started (a clone has no global
 * `openoutbound` binary): `pnpm openoutbound` through the package script, `node <entry point>`
 * when node (or tsx) ran the entry point, plain `openoutbound` only from an installed binary.
 * Adds `--home <dir>` when the home is not the current directory.
 */
export function cliCommandPrefix(input: CliCommandPrefixInput): string {
  const exists = input.exists ?? existsSync;
  const platform = input.platform ?? process.platform;
  const { basename, resolve } = pathsOf(platform);
  let prefix: string;
  if (input.env.npm_lifecycle_event === "openoutbound") {
    const agent = input.env.npm_config_user_agent ?? "";
    prefix = agent.startsWith("npm/")
      ? "npm run openoutbound --"
      : agent.startsWith("yarn/")
        ? "yarn openoutbound"
        : "pnpm openoutbound";
  } else {
    const script = resolve(input.scriptPath);
    const installed =
      /[\\/]node_modules[\\/]/.test(script) ||
      basename(script).replace(/\.(cmd|exe|ps1)$/i, "") === "openoutbound";
    prefix = installed ? "openoutbound" : entryPointCommand(script, exists, platform, input.cwd);
  }
  const home = resolve(input.home);
  return home === resolve(input.cwd) ? prefix : `${prefix} --home ${quotePath(home, platform)}`;
}

/** The command prefix for this run, from the script path the CLI was started with. */
export function commandPrefix(ctx: Pick<CliContext, "deps" | "home" | "cwd" | "env">): string {
  const script = ctx.deps.scriptPath ?? process.argv[1];
  if (!script) return "openoutbound";
  return cliCommandPrefix({ scriptPath: script, home: ctx.home.dir, cwd: ctx.cwd, env: ctx.env });
}

/**
 * Rewrites the `openoutbound <command>` code spans (and "(openoutbound <command>)" or
 * "CLI: openoutbound <command>") in a hint to the command the person runs.
 */
export function withCommandPrefix(text: string, prefix: string): string {
  if (prefix === "openoutbound") return text;
  return text.replace(
    /([`(]|CLI: )openoutbound(?= [a-z-])/g,
    (_match, open: string) => `${open}${prefix}`,
  );
}
