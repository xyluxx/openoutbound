/**
 * One eval environment: a fresh engine on its own PGlite database (a temp directory by
 * default), the deterministic eval brain, the routed web and provider APIs (no real network and
 * no DNS), the HTTP door on a random local port with the MCP endpoint, and a call recorder in
 * front of the engine. Everything the agent does goes through that endpoint with an agent API
 * key bound to the scenario workspace.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, or } from "drizzle-orm";
import { loadConfig } from "../../src/core/config.js";
import type { Principal } from "../../src/core/context.js";
import type { Scope } from "../../src/core/enums.js";
import { type Logger, silentLogger } from "../../src/core/logger.js";
import type { DbHandle } from "../../src/db/client.js";
import { workspaces } from "../../src/db/schema/index.js";
import { type RunningHttpServer, startHttpServer } from "../../src/http/server.js";
import { createRuntimeEngine, type RuntimeEngine } from "../../src/runtime/create-engine.js";
import { createEvalApis, type EvalApis } from "./eval-apis.js";
import { createEvalBrain, type EvalBrain } from "./eval-brain.js";
import { installEvalDns } from "./eval-dns.js";
import { createEvalWeb, type EvalWeb } from "./eval-web.js";
import { type CallRecorder, createCallRecorder } from "./recorder.js";
import type { AdminCallOptions, SeededSandbox, SetupApi } from "./types.js";

export interface EvalEnvironmentOptions {
  /** DATABASE_URL for the engine. Default: PGlite in a fresh temp directory. */
  databaseUrl?: string;
  /** An open database with the schema applied (tests pass an in-memory clone). Closed on close(). */
  db?: DbHandle;
  /** Keep the temp directory after close (debugging). */
  keepDir?: boolean;
  log?: Logger;
  /** Worker poll interval. Default 200 ms. */
  pollMs?: number;
}

export interface EvalEnvironment {
  engine: RuntimeEngine;
  web: EvalWeb;
  apis: EvalApis;
  brain: EvalBrain;
  recorder: CallRecorder;
  server: RunningHttpServer;
  /** Temp directory of this run (database, runner configs). */
  dir: string;
  admin: Principal;
  setup: SetupApi;
  /** Workspace id for a slug or id. Throws when unknown. */
  workspaceId(reference: string): Promise<string>;
  /** Creates an agent API key bound to the workspace; returns the plain key. */
  createAgentKey(workspaceId: string, scopes?: Scope[]): Promise<string>;
  /** MCP endpoint URL for these toolsets. */
  mcpUrl(toolsets: string): string;
  startWorker(): Promise<void>;
  /** Stops the worker and runs whatever is due, so assertions see a settled state. */
  settle(): Promise<void>;
  close(): Promise<void>;
}

export async function startEvalEnvironment(
  options: EvalEnvironmentOptions = {},
): Promise<EvalEnvironment> {
  const dir = mkdtempSync(join(tmpdir(), "openoutbound-eval-"));
  const releaseDns = installEvalDns();
  const web = createEvalWeb();
  const apis = createEvalApis();
  const brain = createEvalBrain();
  const log = options.log ?? silentLogger();
  const config = loadConfig(
    {
      DATABASE_URL: options.databaseUrl ?? `pglite://${join(dir, "pglite")}`,
      OPENOUTBOUND_SECRET_KEY: randomBytes(32).toString("base64"),
      OPENOUTBOUND_BASE_URL: "http://127.0.0.1:7331",
      LOG_LEVEL: "silent",
    },
    { envFile: false, cwd: dir },
  );
  let engine: RuntimeEngine | undefined;
  let server: RunningHttpServer | undefined;
  try {
    engine = await createRuntimeEngine(
      options.db ? { autoMigrate: false } : {},
      {
        log,
        safeFetch: web,
        brain: brain.factory,
        providerFetch: apis.fetch,
        ...(options.db ? { db: options.db } : {}),
        pollMs: options.pollMs ?? 200,
        workerId: "eval-worker",
      },
      config,
    );
    const recorder = createCallRecorder(engine);
    server = await startHttpServer(recorder.engine, {
      port: 0,
      host: "127.0.0.1",
      writeLock: false,
      rateLimitPerMinute: 6000,
    });
    return buildEnvironment({
      engine,
      server,
      recorder,
      web,
      apis,
      brain,
      dir,
      options,
      releaseDns,
    });
  } catch (error) {
    await server?.close().catch(() => {});
    await engine?.close().catch(() => {});
    await options.db?.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    releaseDns();
    throw error;
  }
}

function buildEnvironment(parts: {
  engine: RuntimeEngine;
  server: RunningHttpServer;
  recorder: CallRecorder;
  web: EvalWeb;
  apis: EvalApis;
  brain: EvalBrain;
  dir: string;
  options: EvalEnvironmentOptions;
  releaseDns: () => void;
}): EvalEnvironment {
  const { engine, server, recorder, web, apis, brain, dir, options, releaseDns } = parts;
  const admin = engine.localPrincipal("admin", "cli");

  const call = <T>(operationId: string, input: unknown = {}, callOptions: AdminCallOptions = {}) =>
    engine.call(operationId, input, {
      principal: admin,
      ...(callOptions.workspace ? { workspace: callOptions.workspace } : {}),
      ...(callOptions.dryRun !== undefined ? { dryRun: callOptions.dryRun } : {}),
    }) as Promise<T>;

  const workspaceId = async (reference: string): Promise<string> => {
    const [row] = await engine.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(or(eq(workspaces.id, reference), eq(workspaces.slug, reference)))
      .limit(1);
    if (!row) throw new Error(`Eval setup: no workspace "${reference}".`);
    return row.id;
  };

  const runJobs = async (): Promise<number> => {
    let total = 0;
    for (let round = 0; round < 10; round++) {
      const result = await engine.drainJobs({ max: 500, schedules: false });
      total += result.ran;
      if (result.ran === 0) break;
    }
    return total;
  };

  const setup: SetupApi = {
    engine,
    db: engine.db,
    call,
    web,
    apis,
    brain,
    runJobs,
    async seedSandbox(): Promise<SeededSandbox> {
      const seeded = await call<{ workspaces: Array<{ slug: string; workspace_id: string }> }>(
        "sandbox.seed",
        { reset: true },
      );
      return {
        workspaces: Object.fromEntries(seeded.workspaces.map((ws) => [ws.slug, ws.workspace_id])),
      };
    },
    async context(workspace) {
      return engine.systemContext(await workspaceId(workspace));
    },
  };

  let closed = false;
  return {
    engine,
    web,
    apis,
    brain,
    recorder,
    server,
    dir,
    admin,
    setup,
    workspaceId,
    async createAgentKey(id, scopes) {
      const created = await call<{ key: string }>(
        "keys.create",
        { name: "OpenOutbound eval agent", kind: "agent", ...(scopes ? { scopes } : {}) },
        { workspace: id },
      );
      return created.key;
    },
    mcpUrl(toolsets) {
      return `${server.url}/mcp?toolsets=${encodeURIComponent(toolsets)}`;
    },
    async startWorker() {
      await engine.startWorker({ concurrency: 4 });
    },
    async settle() {
      await engine.stopWorker();
      await runJobs();
    },
    async close() {
      if (closed) return;
      closed = true;
      await server.close().catch(() => {});
      await engine.close().catch(() => {});
      await options.db?.close().catch(() => {});
      if (!options.keepDir) rmSync(dir, { recursive: true, force: true });
      releaseDns();
    },
  };
}
