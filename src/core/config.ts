import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parseEnv } from "node:util";
import { SCOPES, type Scope, TOOLSETS } from "./enums.js";
import { OpenOutboundError } from "./errors.js";
import { LOG_LEVELS, type LogLevel } from "./logger.js";
import { USER_AGENT, VERSION } from "./version.js";

/** Parsed DATABASE_URL. */
export type DatabaseConfig =
  | { kind: "postgres"; url: string }
  | { kind: "pglite"; dataDir: string }
  | { kind: "memory" };

/** Engine configuration (spec section 4). Built by `loadConfig`; never log it (holds the key). */
export interface EngineConfig {
  database: DatabaseConfig;
  /** DATABASE_URL as given (or the default). */
  databaseUrl: string;
  /** 32-byte vault key from OPENOUTBOUND_SECRET_KEY, or null when unset. See `resolveSecretKey`. */
  secretKey: Buffer | null;
  /** Public base URL without trailing slash (unsubscribe links, OAuth callbacks, webhooks). */
  baseUrl: string;
  port: number;
  host: string;
  logLevel: LogLevel;
  /** OPENOUTBOUND_API_KEY: used by the CLI and MCP bridge mode to call a server. */
  apiKey: string | null;
  /** Toolset names, or ["all"]. */
  mcpToolsets: string[];
  /** Scopes for the local embedded stdio MCP principal (`local-agent`). */
  agentScopes: Scope[];
  allowPrivateNetwork: boolean;
  /** Local state directory (`<cwd>/.openoutbound`): lock file, default PGlite data. */
  stateDir: string;
  /** Environment snapshot (after .env merge). Providers read their env fallbacks from here. */
  env: Readonly<Record<string, string | undefined>>;
  version: string;
  userAgent: string;
}

export interface LoadConfigOptions {
  /** Base directory for relative paths and the .env file. Default: process.cwd(). */
  cwd?: string;
  /**
   * .env file to load, or false to skip. Default: `<cwd>/.env` when `env` is `process.env`,
   * false otherwise (tests pass their own env objects). Existing variables always win.
   */
  envFile?: string | false;
}

export const DEFAULT_DATABASE_URL = "pglite://.openoutbound/pglite";
export const DEFAULT_PORT = 7331;
/**
 * Scopes of the local embedded agent (`local-agent`) unless OPENOUTBOUND_AGENT_SCOPES says
 * otherwise: what agent keys get, so a person decides approvals.
 */
export const DEFAULT_AGENT_SCOPES: Scope[] = ["read", "write", "send", "spend"];

/**
 * Builds the engine config from environment variables, loading `.env` first when present
 * (via `process.loadEnvFile` for the real process env). Throws `validation_failed` with a
 * hint on bad values. A missing OPENOUTBOUND_SECRET_KEY is not an error here, so `init` and
 * `doctor` can run; use `resolveSecretKey` where the key is needed.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  options: LoadConfigOptions = {},
): EngineConfig {
  const cwd = options.cwd ?? process.cwd();
  const usingProcessEnv = env === process.env;
  const envFile =
    options.envFile === undefined
      ? usingProcessEnv
        ? resolve(cwd, ".env")
        : false
      : options.envFile;

  let merged: Record<string, string | undefined> = env;
  if (envFile && existsSync(envFile)) {
    if (usingProcessEnv) {
      process.loadEnvFile(envFile); // does not override variables that are already set
    } else {
      const fromFile = parseEnv(readFileSync(envFile, "utf8"));
      merged = { ...fromFile, ...env };
    }
  }

  const get = (name: string): string | undefined => {
    const value = merged[name]?.trim();
    return value === undefined || value === "" ? undefined : value;
  };

  const databaseUrl = get("DATABASE_URL") ?? DEFAULT_DATABASE_URL;
  const port = parsePort(get("PORT"));
  const baseUrl = parseBaseUrl(get("OPENOUTBOUND_BASE_URL") ?? `http://localhost:${port}`);

  return {
    database: parseDatabaseUrl(databaseUrl, cwd),
    databaseUrl,
    secretKey: parseSecretKey(get("OPENOUTBOUND_SECRET_KEY")),
    baseUrl,
    port,
    host: get("HOST") ?? "127.0.0.1",
    logLevel: parseLogLevel(get("LOG_LEVEL")),
    apiKey: get("OPENOUTBOUND_API_KEY") ?? null,
    mcpToolsets: parseToolsets(get("OPENOUTBOUND_MCP_TOOLSETS")),
    agentScopes: parseScopes(get("OPENOUTBOUND_AGENT_SCOPES")),
    allowPrivateNetwork: parseBoolean(
      "OPENOUTBOUND_ALLOW_PRIVATE_NETWORK",
      get("OPENOUTBOUND_ALLOW_PRIVATE_NETWORK"),
      false,
    ),
    stateDir: resolve(cwd, ".openoutbound"),
    env: Object.freeze({ ...merged }),
    version: VERSION,
    userAgent: USER_AGENT,
  };
}

/**
 * `postgres://` / `postgresql://` -> Postgres; `pglite://<dir>` -> PGlite on disk (relative
 * dirs resolve against `cwd`); `memory://` -> PGlite in memory.
 */
export function parseDatabaseUrl(url: string, cwd: string = process.cwd()): DatabaseConfig {
  const trimmed = url.trim();
  if (/^postgres(ql)?:\/\//i.test(trimmed)) return { kind: "postgres", url: trimmed };
  if (/^memory:\/\/\/?$/i.test(trimmed)) return { kind: "memory" };
  if (/^pglite:\/\//i.test(trimmed)) {
    const dir = trimmed.slice("pglite://".length);
    if (dir === "") {
      throw configError(
        "DATABASE_URL",
        url,
        "pglite:// needs a directory, e.g. pglite://.openoutbound/pglite",
      );
    }
    return { kind: "pglite", dataDir: isAbsolute(dir) ? dir : resolve(cwd, dir) };
  }
  throw configError(
    "DATABASE_URL",
    url,
    "Use postgres://user:pass@host:5432/db, pglite://<dir> or memory://",
  );
}

const ephemeralKeys = new WeakMap<EngineConfig, Buffer>();

/**
 * The vault key. With `memory://` and no key set, returns an ephemeral random key (data dies
 * with the process anyway). Otherwise throws an actionable error when the key is missing.
 */
export function resolveSecretKey(config: EngineConfig): Buffer {
  if (config.secretKey) return config.secretKey;
  if (config.database.kind === "memory") {
    let key = ephemeralKeys.get(config);
    if (!key) {
      key = randomBytes(32);
      ephemeralKeys.set(config, key);
    }
    return key;
  }
  throw new OpenOutboundError(
    "validation_failed",
    "OPENOUTBOUND_SECRET_KEY is not set, so stored secrets cannot be encrypted or read.",
    {
      hint: "Run `openoutbound init` to generate one in .env, or set OPENOUTBOUND_SECRET_KEY to 32 random bytes in base64 (openssl rand -base64 32).",
    },
  );
}

function parseSecretKey(value: string | undefined): Buffer | null {
  if (value === undefined) return null;
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw configError(
      "OPENOUTBOUND_SECRET_KEY",
      "(hidden)",
      "It must be 32 random bytes encoded as base64 (openssl rand -base64 32).",
    );
  }
  return key;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw configError("PORT", value, "Use a number between 1 and 65535.");
  }
  return port;
}

function parseBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configError(
      "OPENOUTBOUND_BASE_URL",
      value,
      "Use a full URL like https://outbound.example.com",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw configError("OPENOUTBOUND_BASE_URL", value, "Use an http:// or https:// URL.");
  }
  return value.replace(/\/+$/, "");
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (value === undefined) return "info";
  const level = value.toLowerCase();
  if (!(LOG_LEVELS as readonly string[]).includes(level)) {
    throw configError("LOG_LEVEL", value, `Use one of: ${LOG_LEVELS.join(", ")}.`);
  }
  return level as LogLevel;
}

function parseToolsets(value: string | undefined): string[] {
  const names = splitList(value ?? "core");
  const allowed = [...TOOLSETS, "all"] as string[];
  const unknown = names.filter((name) => !allowed.includes(name));
  if (unknown.length > 0) {
    throw configError(
      "OPENOUTBOUND_MCP_TOOLSETS",
      value ?? "",
      `Unknown toolset(s) ${unknown.join(", ")}. Use: ${allowed.join(", ")}.`,
    );
  }
  return names.length > 0 ? names : ["core"];
}

function parseScopes(value: string | undefined): Scope[] {
  if (value === undefined) return [...DEFAULT_AGENT_SCOPES];
  const names = splitList(value);
  const unknown = names.filter((name) => !(SCOPES as readonly string[]).includes(name));
  if (unknown.length > 0) {
    throw configError(
      "OPENOUTBOUND_AGENT_SCOPES",
      value,
      `Unknown scope(s) ${unknown.join(", ")}. Use: ${SCOPES.join(", ")}.`,
    );
  }
  return [...new Set(names)] as Scope[];
}

function parseBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw configError(name, value, "Use true or false.");
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function configError(name: string, value: string, hint: string): OpenOutboundError {
  return new OpenOutboundError("validation_failed", `Invalid ${name} value "${value}".`, {
    hint: `${hint} Fix it in .env or the environment.`,
    details: { variable: name },
  });
}
