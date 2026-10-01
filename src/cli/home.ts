import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type HomeSource = "flag" | "env" | "cwd" | "package" | "default";

export interface ResolvedHome {
  dir: string;
  source: HomeSource;
}

/** Package root: two levels above `src/cli/*.ts` and `dist/cli/*.js`. */
export const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export interface ResolveHomeInput {
  flag?: string | null;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  packageRoot?: string;
  exists?: (path: string) => boolean;
}

function looksLikeHome(dir: string, exists: (path: string) => boolean): boolean {
  return exists(join(dir, ".env")) || exists(join(dir, ".openoutbound"));
}

/**
 * Where `.env` and `.openoutbound/` live: `--home` > OPENOUTBOUND_HOME > the current directory
 * when it has `.env` or `.openoutbound/` > the package root when it has them > the current
 * directory. This lets `claude mcp add openoutbound -- node /path/to/dist/cli/main.js mcp`
 * work from any project folder.
 */
export function resolveHome(input: ResolveHomeInput): ResolvedHome {
  const exists = input.exists ?? existsSync;
  const absolute = (dir: string) => resolve(input.cwd, dir);
  if (input.flag) return { dir: absolute(input.flag), source: "flag" };
  const fromEnv = input.env.OPENOUTBOUND_HOME?.trim();
  if (fromEnv) return { dir: absolute(fromEnv), source: "env" };
  if (looksLikeHome(input.cwd, exists)) return { dir: input.cwd, source: "cwd" };
  const packageRoot = input.packageRoot ?? PACKAGE_ROOT;
  if (looksLikeHome(packageRoot, exists)) return { dir: resolve(packageRoot), source: "package" };
  return { dir: input.cwd, source: "default" };
}

/** `--home <dir>` / `--home=<dir>` from raw argv (read before commander runs). */
export function homeFlag(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") break;
    if (arg === "--home") return argv[i + 1] ?? null;
    if (arg.startsWith("--home=")) return arg.slice("--home=".length);
  }
  return null;
}
