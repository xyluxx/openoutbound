import { CommanderError } from "commander";
import { errorPayload } from "../mcp/errors.js";
import { withCommandPrefix } from "./command-prefix.js";
import type { CliIO, Palette } from "./io.js";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_VALIDATION = 2;

/** Help and version output end commander with these codes; they are not failures. */
const COMMANDER_OK = new Set(["commander.helpDisplayed", "commander.version", "commander.help"]);

/** 2 for validation and usage errors, 1 for everything else (spec 5.3). */
export function exitCodeFor(error: unknown): number {
  if (error instanceof CommanderError) {
    return COMMANDER_OK.has(error.code) ? EXIT_OK : EXIT_VALIDATION;
  }
  return errorPayload(error).code === "validation_failed" ? EXIT_VALIDATION : EXIT_ERROR;
}

/**
 * Prints `Error (code): message`, the hint and the wait ("retry after N s") on stderr, with
 * commands written the way the person runs the CLI (`prefix`); with `--json` also prints
 * `{ "error": { code, message, hint, details, retry_after_seconds } }` on stdout for scripts.
 */
export function reportError(
  io: CliIO,
  error: unknown,
  options: { json: boolean; palette: Palette; prefix?: string },
): number {
  const payload = errorPayload(error);
  const p = options.palette;
  const words = (text: string) => withCommandPrefix(text, options.prefix ?? "openoutbound");
  io.stderr(`${p.red(`Error (${payload.code}):`)} ${words(payload.message)}\n`);
  if (payload.hint) io.stderr(`${p.dim("Hint:")} ${words(payload.hint)}\n`);
  if (payload.retry_after_seconds !== undefined) {
    io.stderr(`${p.dim("Wait:")} retry after ${payload.retry_after_seconds} s\n`);
  }
  const issues = payload.details?.issues;
  if (Array.isArray(issues)) {
    for (const issue of issues.slice(0, 10) as Array<{ path?: string; message?: string }>) {
      io.stderr(`  - ${issue.path ? `${issue.path}: ` : ""}${issue.message ?? ""}\n`);
    }
  }
  if (options.json) io.stdout(`${JSON.stringify({ error: payload }, null, 2)}\n`);
  return exitCodeFor(error);
}
