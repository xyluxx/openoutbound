import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { Engine } from "../core/engine.js";
import { OpenOutboundError } from "../core/errors.js";
import { createHttpApp, type HttpAppOptions } from "./app.js";
import type { LocalKeys } from "./auth.js";
import { generateLocalKeys, removeServerLock, writeServerLock } from "./lock-file.js";

export interface StartHttpServerOptions extends Omit<HttpAppOptions, "localKeys"> {
  port?: number;
  host?: string;
  /** Write `.openoutbound/server.json` (with local keys) while running. Default true. */
  writeLock?: boolean;
}

export interface RunningHttpServer {
  /** Local URL, e.g. http://127.0.0.1:7331 */
  url: string;
  port: number;
  localKeys: LocalKeys | null;
  /** Stops accepting connections, closes the MCP handler and removes the lock file. */
  close(): Promise<void>;
}

/**
 * Turns the usual listen failures into actionable errors. On Windows a port held by another
 * program (or reserved by the system) fails with EACCES rather than EADDRINUSE.
 */
export function listenError(
  error: unknown,
  host: string,
  port: number,
  platform: NodeJS.Platform = process.platform,
): unknown {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const hint =
    "Stop that program, or run on another port with `openoutbound serve --port <n>` (or PORT in .env). Agents that connect over HTTP then need OPENOUTBOUND_URL=http://127.0.0.1:<n>.";
  if (code === "EADDRINUSE") {
    return new OpenOutboundError(
      "conflict",
      `Port ${port} on ${host} is already in use by another program.`,
      { hint, cause: error, details: { host, port } },
    );
  }
  if (code === "EACCES") {
    if (port < 1024 && platform !== "win32") {
      return new OpenOutboundError("forbidden", `Port ${port} needs admin rights on this system.`, {
        hint: "Use a port above 1024 with `openoutbound serve --port <n>`.",
        cause: error,
      });
    }
    return new OpenOutboundError(
      "conflict",
      `Port ${port} on ${host} is blocked: another program holds it, or the system reserved it.`,
      {
        hint:
          platform === "win32"
            ? `${hint} Reserved ranges: netsh interface ipv4 show excludedportrange protocol=tcp`
            : hint,
        cause: error,
        details: { host, port },
      },
    );
  }
  if (code === "EADDRNOTAVAIL") {
    return new OpenOutboundError(
      "validation_failed",
      `Host ${host} is not an address of this machine.`,
      {
        hint: "Use 127.0.0.1 (this machine only) or 0.0.0.0 (all interfaces) with --host or HOST.",
        cause: error,
      },
    );
  }
  return error;
}

/** Starts the HTTP door on Node and (by default) publishes the lock file for local tools. */
export async function startHttpServer(
  engine: Engine,
  options: StartHttpServerOptions = {},
): Promise<RunningHttpServer> {
  const writeLock = options.writeLock ?? true;
  const localKeys = writeLock ? generateLocalKeys() : null;
  const { app, close: closeApp } = createHttpApp(engine, { ...options, localKeys });
  const host = options.host ?? engine.config.host;
  const requestedPort = options.port ?? engine.config.port;

  let server: ReturnType<typeof serve>;
  try {
    server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
      const instance = serve({ fetch: app.fetch, port: requestedPort, hostname: host }, () =>
        resolve(instance),
      );
      instance.once("error", reject);
    });
  } catch (error) {
    await closeApp();
    throw listenError(error, host, requestedPort);
  }
  const address = server.address() as AddressInfo;
  const localHost =
    host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  const url = `http://${localHost}:${address.port}`;

  if (writeLock) {
    writeServerLock(engine.config.stateDir, {
      url,
      pid: process.pid,
      started_at: new Date().toISOString(),
      version: engine.config.version,
      database: engine.config.database.kind,
      ...(localKeys ? { local_keys: localKeys } : {}),
    });
  }

  let closed = false;
  return {
    url,
    port: address.port,
    localKeys,
    async close() {
      if (closed) return;
      closed = true;
      if (writeLock) removeServerLock(engine.config.stateDir);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        const closeAll = (server as { closeAllConnections?: () => void }).closeAllConnections;
        closeAll?.call(server);
      });
      await closeApp();
    },
  };
}
