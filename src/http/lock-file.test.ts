import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectRunningServer,
  generateLocalKeys,
  isProcessAlive,
  readServerLock,
  removeServerLock,
  writeServerLock,
} from "./lock-file.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "oo-lock-"));
  dirs.push(dir);
  return join(dir, ".openoutbound");
}

const okFetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
const downFetch = (async () => {
  throw new Error("connection refused");
}) as unknown as typeof fetch;

describe("server lock file", () => {
  it("writes, reads and removes the lock (only its own)", () => {
    const dir = stateDir();
    const keys = generateLocalKeys();
    expect(keys.admin).not.toBe(keys.agent);
    writeServerLock(dir, {
      url: "http://127.0.0.1:7331",
      pid: 123,
      started_at: "x",
      local_keys: keys,
    });
    expect(readServerLock(dir)).toMatchObject({ url: "http://127.0.0.1:7331", pid: 123 });
    removeServerLock(dir, 999);
    expect(readServerLock(dir)).not.toBeNull();
    removeServerLock(dir, 123);
    expect(readServerLock(dir)).toBeNull();
  });

  it("ignores malformed lock files", () => {
    const dir = stateDir();
    writeServerLock(dir, { url: "http://x", pid: 1, started_at: "x" });
    writeFileSync(join(dir, "server.json"), "{nope");
    expect(readServerLock(dir)).toBeNull();
  });

  it("detects a running server only when the pid is alive and /health answers", async () => {
    const dir = stateDir();
    expect(await detectRunningServer(dir, { fetch: okFetch })).toBeNull();
    writeServerLock(dir, { url: "http://127.0.0.1:7331", pid: process.pid, started_at: "x" });
    expect(await detectRunningServer(dir, { fetch: okFetch })).toMatchObject({ pid: process.pid });
    expect(await detectRunningServer(dir, { fetch: downFetch })).toBeNull();
    writeServerLock(dir, { url: "http://127.0.0.1:7331", pid: 2 ** 22 + 12345, started_at: "x" });
    expect(await detectRunningServer(dir, { fetch: okFetch })).toBeNull();
  });

  it("checks process liveness", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-5)).toBe(false);
  });
});
