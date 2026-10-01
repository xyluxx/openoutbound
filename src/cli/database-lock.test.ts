import { describe, expect, it } from "vitest";
import { OpenOutboundError } from "../core/errors.js";
import { explainDatabaseLock } from "./database-lock.js";

function lockConflict(command: string | null): OpenOutboundError {
  return new OpenOutboundError("conflict", "Another OpenOutbound process is using the database.", {
    hint: "The local database allows one process at a time.",
    details: { pid: 4242, command, lock_file: "/srv/engine/.openoutbound/pglite.lock" },
  });
}

describe("explainDatabaseLock", () => {
  it("names the agent's MCP session and says to start serve first", () => {
    const explained = explainDatabaseLock(
      lockConflict("--home /srv/engine mcp --workspace northwind"),
      "node dist/cli/main.js",
    );
    expect(explained?.code).toBe("conflict");
    expect(explained?.message).toContain("Your agent's OpenOutbound session (pid 4242");
    expect(explained?.message).toContain("one process at a time");
    expect(explained?.hint).toContain("Close the agent session (or stop pid 4242)");
    expect(explained?.hint).toContain("start `node dist/cli/main.js serve` in its own terminal");
    expect(explained?.hint).toContain("delete /srv/engine/.openoutbound/pglite.lock");
    expect(explained?.details).toMatchObject({ pid: 4242, lock_file: expect.any(String) });
  });

  it("tells a silent server apart from another command", () => {
    const server = explainDatabaseLock(lockConflict("serve --port 7331"), "openoutbound");
    expect(server?.message).toContain("server or worker");
    expect(server?.hint).toContain("start `openoutbound serve` again");
    const other = explainDatabaseLock(lockConflict(null), "pnpm openoutbound");
    expect(other?.message).toContain("Another OpenOutbound command (pid 4242)");
    expect(other?.hint).toContain("start `pnpm openoutbound serve` first");
  });

  it("leaves every other error alone", () => {
    expect(explainDatabaseLock(new Error("boom"), "openoutbound")).toBeNull();
    expect(
      explainDatabaseLock(new OpenOutboundError("conflict", "Slug taken."), "openoutbound"),
    ).toBeNull();
  });
});
