import { OpenOutboundError } from "../../core/errors.js";
import { detectRunningServer } from "../../http/lock-file.js";
import type { CliContext } from "../context.js";

/**
 * Resolves on SIGINT or SIGTERM (and, for `mcp`, when stdin closes: the agent host ended the
 * session). Tests inject `deps.waitForShutdown`.
 */
export function waitForShutdown(
  ctx: CliContext,
  reason: "serve" | "worker" | "mcp",
): Promise<void> {
  if (ctx.deps.waitForShutdown) return ctx.deps.waitForShutdown(reason);
  return new Promise((resolve) => {
    const done = () => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      process.stdin.off("close", done);
      process.stdin.off("end", done);
      resolve();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
    if (reason === "mcp") {
      process.stdin.once("close", done);
      process.stdin.once("end", done);
    }
  });
}

/** Fails when another local server already owns the PGlite database. */
export async function assertNoRunningServer(ctx: CliContext, action: string): Promise<void> {
  const config = ctx.config();
  if (config.database.kind !== "pglite") return;
  const running = await detectRunningServer(config.stateDir, { fetch: ctx.fetch });
  if (running) {
    throw new OpenOutboundError(
      "conflict",
      `A server is already running at ${running.url} (pid ${running.pid}) and owns the PGlite database, so ${action} cannot open it.`,
      {
        hint: "Stop that server first, use it instead (commands and `openoutbound mcp` bridge to it automatically), or switch to Postgres.",
        details: { url: running.url, pid: running.pid },
      },
    );
  }
}
