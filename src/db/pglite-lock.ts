/**
 * One process at a time on a PGlite data directory. PGlite has no locking of its own: two
 * processes on the same directory silently lose each other's writes. The lock file sits next to
 * the directory (`<dataDir>.lock`) and holds the owner's pid; a lock whose process is gone is
 * taken over.
 */
import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { OpenOutboundError } from "../core/errors.js";

interface LockInfo {
  pid: number;
  started_at: string;
  command: string;
}

/** Open handles per lock path in this process (one file, many handles). */
const held = new Map<string, number>();

export function pgliteLockPath(dataDir: string): string {
  return `${dataDir.replace(/[\\/]+$/, "")}.lock`;
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(path: string): LockInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockInfo>;
    return typeof parsed.pid === "number" ? (parsed as LockInfo) : null;
  } catch {
    return null;
  }
}

function tryCreate(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  const info: LockInfo = {
    pid: process.pid,
    started_at: new Date().toISOString(),
    command: process.argv.slice(2).join(" ").slice(0, 200),
  };
  try {
    writeSync(fd, `${JSON.stringify(info)}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Takes the lock for `dataDir` or throws `conflict` naming the process that holds it. Returns
 * the release function (idempotent).
 */
export function acquirePgliteLock(dataDir: string): () => void {
  const path = pgliteLockPath(dataDir);
  const count = held.get(path) ?? 0;
  if (count === 0) {
    let acquired = tryCreate(path);
    if (!acquired) {
      const owner = readLock(path);
      if (owner && owner.pid !== process.pid && isAlive(owner.pid)) {
        throw new OpenOutboundError(
          "conflict",
          `Another OpenOutbound process (pid ${owner.pid}${owner.command ? `, "${owner.command}"` : ""}) is using the local database ${dataDir}.`,
          {
            hint: `The local database allows one process at a time. Run \`openoutbound serve\` so the CLI and MCP share it, stop the other process, or use Postgres (DATABASE_URL). If no such process runs, delete ${path}.`,
            details: { pid: owner.pid, command: owner.command ?? null, lock_file: path },
          },
        );
      }
      // Stale (the owner is gone) or unreadable: take it over.
      rmSync(path, { force: true });
      acquired = tryCreate(path);
      if (!acquired) {
        throw new OpenOutboundError(
          "conflict",
          `Another process took the local database lock ${path} at the same moment.`,
          { hint: "Try again in a moment." },
        );
      }
    }
  }
  held.set(path, count + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (held.get(path) ?? 1) - 1;
    if (left > 0) {
      held.set(path, left);
      return;
    }
    held.delete(path);
    if (readLock(path)?.pid === process.pid) rmSync(path, { force: true });
  };
}
