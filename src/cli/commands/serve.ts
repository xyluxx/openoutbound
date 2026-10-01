import { OpenOutboundError } from "../../core/errors.js";
import { startHttpServer } from "../../http/server.js";
import { commandPrefix, withCommandPrefix } from "../command-prefix.js";
import type { CliContext } from "../context.js";
import { assertNoRunningServer, waitForShutdown } from "./long-running.js";

export interface ServeOptions {
  port?: string;
  host?: string;
  worker?: boolean;
  corsOrigin?: string[];
  rateLimit?: string;
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new OpenOutboundError("validation_failed", `Invalid --port "${value}".`, {
      hint: "Use a number between 1 and 65535, or 0 for any free port.",
    });
  }
  return port;
}

function parseRateLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const perMinute = Number(value);
  if (!Number.isInteger(perMinute) || perMinute < 1) {
    throw new OpenOutboundError("validation_failed", `Invalid --rate-limit "${value}".`, {
      hint: "Use a whole number of requests per minute per API key, e.g. --rate-limit 600.",
    });
  }
  return perMinute;
}

/**
 * `openoutbound serve`: HTTP (REST, /mcp, public module routes) plus the worker unless
 * --no-worker, writes `.openoutbound/server.json`, shuts down gracefully on SIGINT/SIGTERM.
 */
export async function runServe(ctx: CliContext, options: ServeOptions): Promise<number> {
  const port = parsePort(options.port);
  const rateLimit = parseRateLimit(options.rateLimit);
  await assertNoRunningServer(ctx, "`serve`");
  const withWorker = options.worker !== false;
  const engine = await ctx.createEngine({ worker: false });
  let server: Awaited<ReturnType<typeof startHttpServer>> | null = null;
  try {
    if (withWorker) await engine.startWorker();
    server = await startHttpServer(engine, {
      ...(port !== undefined ? { port } : {}),
      ...(options.host ? { host: options.host } : {}),
      ...(options.corsOrigin && options.corsOrigin.length > 0
        ? { corsOrigins: options.corsOrigin }
        : {}),
      ...(rateLimit !== undefined ? { rateLimitPerMinute: rateLimit } : {}),
      workerRunning: () => withWorker,
    });
    const p = ctx.err;
    const mcp = withCommandPrefix("`openoutbound mcp`", commandPrefix(ctx));
    ctx.io.stderr(
      `${p.green("OpenOutbound is running")} at ${server.url} (worker ${withWorker ? "on" : "off"})\n` +
        `  REST: ${server.url}/v1  OpenAPI: ${server.url}/openapi.json  MCP: ${server.url}/mcp\n` +
        `  Local CLI and ${mcp} now bridge to this server. Press Ctrl+C to stop.\n`,
    );
    await waitForShutdown(ctx, "serve");
    ctx.io.stderr("Shutting down...\n");
    return 0;
  } finally {
    await server?.close();
    if (withWorker) await engine.stopWorker().catch(() => {});
    await engine.close();
  }
}

/** `openoutbound worker`: jobs and scheduler only, until SIGINT/SIGTERM. */
export async function runWorker(ctx: CliContext): Promise<number> {
  await assertNoRunningServer(ctx, "`worker`");
  const engine = await ctx.createEngine({ worker: false });
  try {
    await engine.startWorker();
    ctx.io.stderr(
      `${ctx.err.green("Worker running")} (jobs and schedules). Press Ctrl+C to stop.\n`,
    );
    await waitForShutdown(ctx, "worker");
    ctx.io.stderr("Stopping the worker (finishing running jobs)...\n");
    await engine.stopWorker();
    return 0;
  } finally {
    await engine.close();
  }
}
