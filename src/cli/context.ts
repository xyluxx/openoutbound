import { join } from "node:path";
import type { Transport } from "@modelcontextprotocol/server";
import { type EngineConfig, loadConfig } from "../core/config.js";
import type { CreateEngineOptions, Engine, Registry } from "../core/engine.js";
import { createRemoteClient, type RemoteClient } from "../http/client.js";
import { detectRunningServer, type ServerLock } from "../http/lock-file.js";
import type { ResolvedHome } from "./home.js";
import { type CliIO, colorEnabled, type Palette, palette } from "./io.js";

/** Injection points for tests; the real process uses the defaults. */
export interface CliDeps {
  io?: CliIO;
  env?: Record<string, string | undefined>;
  /** Directory the user ran the command from. Default process.cwd(). */
  cwd?: string;
  /** Default process.chdir. */
  chdir?: (dir: string) => void;
  /** Default: lazy import of `createEngine` from src/index. */
  createEngine?: (options?: CreateEngineOptions) => Promise<Engine>;
  /** Registry for command generation. Default: static registry of the built-in modules. */
  registry?: Registry;
  fetch?: typeof globalThis.fetch;
  /** Resolves when a long-running command (serve, worker, mcp) should stop. */
  waitForShutdown?: (reason: "serve" | "worker" | "mcp") => Promise<void>;
  /** MCP stdio transport override (tests). */
  mcpTransport?: Transport;
  packageRoot?: string;
  /** Script used in printed `claude mcp add` commands. Default process.argv[1]. */
  scriptPath?: string;
}

/** Everything a command needs, resolved once per run. */
export interface CliContext {
  io: CliIO;
  env: Record<string, string | undefined>;
  /** Directory the user ran the command from (for relative @file paths). */
  cwd: string;
  home: ResolvedHome;
  deps: CliDeps;
  out: Palette;
  err: Palette;
  /** Loads config from the engine home (.env included). Throws actionable errors. */
  config(): EngineConfig;
  /** An env setting from the process or the home's .env (never throws). */
  setting(name: string): string | undefined;
  createEngine(options?: CreateEngineOptions): Promise<Engine>;
  fetch: typeof globalThis.fetch;
}

export function createCliContext(
  deps: CliDeps,
  io: CliIO,
  env: Record<string, string | undefined>,
  cwd: string,
  home: ResolvedHome,
): CliContext {
  let config: EngineConfig | undefined;
  return {
    io,
    env,
    cwd,
    home,
    deps,
    out: palette(colorEnabled(io.stdoutIsTTY, env)),
    err: palette(colorEnabled(io.stderrIsTTY, env)),
    config() {
      config ??= loadConfig(env, { cwd: home.dir, envFile: join(home.dir, ".env") });
      return config;
    },
    setting(name) {
      const direct = env[name]?.trim();
      if (direct) return direct;
      try {
        return this.config().env[name]?.trim() || undefined;
      } catch {
        return undefined;
      }
    },
    async createEngine(options) {
      if (deps.createEngine) return deps.createEngine(options);
      const { createEngine } = await import("../index.js");
      return createEngine(options);
    },
    fetch: deps.fetch ?? globalThis.fetch,
  };
}

export interface BridgeTarget {
  client: RemoteClient;
  /** The key the bridge uses (see resolveBridge). */
  apiKey: string | null;
  /** Why bridge mode was chosen, for messages. */
  source: "flag" | "env" | "local-server";
  lock?: ServerLock;
  /** OPENOUTBOUND_API_KEY is set but not used: an MCP session on the local server is the local agent. */
  envKeyIgnored?: boolean;
}

/**
 * Picks bridge mode: `--url` / OPENOUTBOUND_URL, or a running local server that owns the PGlite
 * database (its lock file carries local keys: `admin` for the CLI, `agent` for MCP, so local
 * semantics are kept). Null means run in-process. Env values may come from `.env`. The key:
 * --api-key, then OPENOUTBOUND_API_KEY, then the lock file's local key; except that an MCP
 * session (`agent`) on the local server ignores OPENOUTBOUND_API_KEY, as embedded mode does, so
 * it never acts as the key a person keeps in `.env`, whether or not `serve` runs.
 */
export async function resolveBridge(
  ctx: CliContext,
  flags: { url?: string; apiKey?: string },
  localKey: "admin" | "agent",
): Promise<BridgeTarget | null> {
  if (flags.url) {
    const apiKey = flags.apiKey ?? ctx.setting("OPENOUTBOUND_API_KEY") ?? null;
    return {
      client: createRemoteClient({ url: flags.url, apiKey, fetch: ctx.fetch }),
      apiKey,
      source: "flag",
    };
  }
  const config = ctx.config();
  const envUrl = config.env.OPENOUTBOUND_URL?.trim();
  const envKey = flags.apiKey ?? config.apiKey;
  if (envUrl) {
    return {
      client: createRemoteClient({ url: envUrl, apiKey: envKey, fetch: ctx.fetch }),
      apiKey: envKey,
      source: "env",
    };
  }
  if (config.database.kind !== "pglite") return null;
  const lock = await detectRunningServer(config.stateDir, { fetch: ctx.fetch });
  if (!lock) return null;
  const envKeyIgnored = localKey === "agent" && !flags.apiKey && Boolean(config.apiKey);
  const apiKey =
    (localKey === "agent" ? flags.apiKey : envKey) ?? lock.local_keys?.[localKey] ?? null;
  return {
    client: createRemoteClient({ url: lock.url, apiKey, fetch: ctx.fetch }),
    apiKey,
    source: "local-server",
    lock,
    ...(envKeyIgnored ? { envKeyIgnored } : {}),
  };
}
