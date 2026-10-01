import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isOpenOutboundError } from "../core/errors.js";
import { acquirePgliteLock, pgliteLockPath } from "./pglite-lock.js";

const dirs: string[] = [];
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "oo-lock-"));
  dirs.push(dir);
  return join(dir, "db");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("PGlite process lock", () => {
  it("writes the owner pid and removes the file when the last handle closes", () => {
    const dir = dataDir();
    const releaseA = acquirePgliteLock(dir);
    const releaseB = acquirePgliteLock(dir);
    const path = pgliteLockPath(dir);
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(process.pid);
    releaseA();
    releaseA();
    expect(existsSync(path)).toBe(true);
    releaseB();
    expect(existsSync(path)).toBe(false);
  });

  it("refuses while another live process holds it", async () => {
    const dir = dataDir();
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
    try {
      writeFileSync(
        pgliteLockPath(dir),
        JSON.stringify({ pid: other.pid, started_at: new Date().toISOString(), command: "mcp" }),
      );
      let caught: unknown;
      try {
        acquirePgliteLock(dir);
      } catch (error) {
        caught = error;
      }
      expect(isOpenOutboundError(caught) && caught.code).toBe("conflict");
      expect(String((caught as Error).message)).toContain(`pid ${other.pid}, "mcp"`);
      // The CLI reads these to say which process holds the database (cli/database-lock.ts).
      expect(isOpenOutboundError(caught) && caught.details).toEqual({
        pid: other.pid,
        command: "mcp",
        lock_file: pgliteLockPath(dir),
      });
    } finally {
      other.kill();
    }
  });

  it("takes over a lock left by a process that is gone", () => {
    const dir = dataDir();
    writeFileSync(
      pgliteLockPath(dir),
      JSON.stringify({ pid: 2_147_483_000, started_at: "2026-01-01T00:00:00Z", command: "serve" }),
    );
    const release = acquirePgliteLock(dir);
    expect(JSON.parse(readFileSync(pgliteLockPath(dir), "utf8")).pid).toBe(process.pid);
    release();
  });
});
