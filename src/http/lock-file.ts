import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LocalKeys } from "./auth.js";

export const LOCK_FILE_NAME = "server.json";

/** `.openoutbound/server.json`: lets local tools find a running server (spec section 4). */
export interface ServerLock {
  url: string;
  pid: number;
  started_at: string;
  version?: string;
  /** Database kind the server owns (pglite, postgres, memory). */
  database?: string;
  /** Local-only keys; see `LocalKeys`. */
  local_keys?: LocalKeys;
}

export function lockFilePath(stateDir: string): string {
  return join(stateDir, LOCK_FILE_NAME);
}

/** Fresh random local keys (never persisted anywhere but the lock file). */
export function generateLocalKeys(): LocalKeys {
  return {
    admin: `oo_local_${randomBytes(32).toString("base64url")}`,
    agent: `oo_local_${randomBytes(32).toString("base64url")}`,
  };
}

/** Writes the lock file (owner read/write only where the OS supports it). */
export function writeServerLock(stateDir: string, lock: ServerLock): string {
  mkdirSync(stateDir, { recursive: true });
  const path = lockFilePath(stateDir);
  writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Not supported on every platform.
  }
  return path;
}

export function readServerLock(stateDir: string): ServerLock | null {
  try {
    const parsed = JSON.parse(readFileSync(lockFilePath(stateDir), "utf8")) as Partial<ServerLock>;
    if (typeof parsed.url !== "string" || typeof parsed.pid !== "number") return null;
    return parsed as ServerLock;
  } catch {
    return null;
  }
}

/** Removes the lock file when it still belongs to `pid` (another server may have replaced it). */
export function removeServerLock(stateDir: string, pid: number = process.pid): void {
  const current = readServerLock(stateDir);
  if (current && current.pid !== pid) return;
  rmSync(lockFilePath(stateDir), { force: true });
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The running local server described by the lock file, or null when there is none: the file
 * must exist, its pid must be alive and `GET /health` must answer OK.
 */
export async function detectRunningServer(
  stateDir: string,
  options: { fetch?: typeof globalThis.fetch; timeoutMs?: number } = {},
): Promise<ServerLock | null> {
  const lock = readServerLock(stateDir);
  if (!lock || !isProcessAlive(lock.pid)) return null;
  try {
    const response = await (options.fetch ?? globalThis.fetch)(
      `${lock.url.replace(/\/+$/, "")}/health`,
      { signal: AbortSignal.timeout(options.timeoutMs ?? 1500) },
    );
    return response.ok ? lock : null;
  } catch {
    return null;
  }
}
