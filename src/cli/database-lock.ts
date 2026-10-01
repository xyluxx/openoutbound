/**
 * The embedded database (PGlite) allows one process at a time. When another OpenOutbound
 * process holds it (db/pglite-lock.ts), the CLI says which one and what to do, in the words of
 * the command the person runs: most often an agent's `openoutbound mcp` session started before
 * `openoutbound serve`.
 */
import { isOpenOutboundError, OpenOutboundError } from "../core/errors.js";

interface LockDetails {
  pid: number;
  command: string;
  lock_file: string;
}

function lockDetails(error: unknown): LockDetails | null {
  if (!isOpenOutboundError(error) || error.code !== "conflict") return null;
  const details = error.details as Record<string, unknown> | undefined;
  if (typeof details?.pid !== "number" || typeof details.lock_file !== "string") return null;
  return {
    pid: details.pid,
    command: typeof details.command === "string" ? details.command : "",
    lock_file: details.lock_file,
  };
}

/** Which kind of process holds the lock, from the command line it was started with. */
function holderKind(command: string): "mcp" | "server" | "other" {
  const words = command.split(/\s+/);
  if (words.includes("mcp")) return "mcp";
  if (words.includes("serve") || words.includes("worker")) return "server";
  return "other";
}

/**
 * The lock conflict explained for a person at the CLI (null for any other error): what holds
 * the database and the exact way out. `prefix` is the command the person runs.
 */
export function explainDatabaseLock(error: unknown, prefix: string): OpenOutboundError | null {
  const lock = lockDetails(error);
  if (!lock) return null;
  const serve = `\`${prefix} serve\``;
  const started = lock.command
    ? ` (pid ${lock.pid}, started with "${lock.command}")`
    : ` (pid ${lock.pid})`;
  const stale = `If no such process runs any more, delete ${lock.lock_file}.`;
  const details = { ...lock };
  switch (holderKind(lock.command)) {
    case "mcp":
      return new OpenOutboundError(
        "conflict",
        `Your agent's OpenOutbound session${started} has the local database open, and the embedded database allows one process at a time.`,
        {
          hint: `Close the agent session (or stop pid ${lock.pid}), start ${serve} in its own terminal, then start the agent again: the CLI and \`${prefix} mcp\` both connect to the running server by themselves. ${stale}`,
          details,
        },
      );
    case "server":
      return new OpenOutboundError(
        "conflict",
        `An OpenOutbound server or worker${started} has the local database open but does not answer, so this command cannot go through it.`,
        {
          hint: `Stop it (Ctrl+C in its terminal, or end pid ${lock.pid}) and start ${serve} again; commands then go through it. ${stale}`,
          details,
        },
      );
    default:
      return new OpenOutboundError(
        "conflict",
        `Another OpenOutbound command${started} has the local database open, and the embedded database allows one process at a time.`,
        {
          hint: `Wait for it to finish, or stop it. To use the CLI and an agent at the same time, start ${serve} first: commands and \`${prefix} mcp\` then go through it. ${stale}`,
          details,
        },
      );
  }
}
