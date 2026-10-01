import pino from "pino";

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Pino-style log method: `log.info({ job_id }, "claimed")` or `log.info("started")`. */
export interface LogFn {
  (obj: object, msg?: string): void;
  (msg: string): void;
}

/**
 * The logger contract: a subset of pino, so a pino instance satisfies it.
 * Never log secrets, API keys, tokens or message bodies of prospects.
 */
export interface Logger {
  level: string;
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
  child(bindings: Record<string, unknown>): Logger;
}

export interface CreateLoggerOptions {
  level?: LogLevel;
  /** Extra fields on every line, e.g. `{ component: "worker" }`. */
  bindings?: Record<string, unknown>;
}

/** Paths redacted from log objects wherever they appear (one level deep and top level). */
const REDACT_PATHS = [
  "password",
  "secret",
  "token",
  "apiKey",
  "api_key",
  "authorization",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "*.password",
  "*.secret",
  "*.token",
  "*.apiKey",
  "*.api_key",
  "*.authorization",
  "*.accessToken",
  "*.access_token",
  "*.refreshToken",
  "*.refresh_token",
];

/**
 * JSON logger writing to stderr (fd 2), so stdout stays clean for the stdio MCP transport and
 * for `--json` CLI output. Synchronous writes: no lost lines when a CLI process exits.
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  return pino(
    {
      level: options.level ?? "info",
      base: { ...options.bindings },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: "[redacted]" },
      formatters: { level: (label) => ({ level: label }) },
    },
    pino.destination({ dest: 2, sync: true }),
  );
}

/** Logger that drops everything (tests). */
export function silentLogger(): Logger {
  return pino({ level: "silent" });
}
