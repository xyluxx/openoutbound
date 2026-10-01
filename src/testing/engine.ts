/**
 * `createTestEngine()`: a real engine (every module, or `modules`) on a cloned in-memory PGlite
 * database, with a fixed clock you move by hand and jobs you run by hand.
 *
 *   const engine = await createTestEngine();
 *   const ws = await engine.call("workspaces.create", { name: "Acme" });
 *   await engine.call("leads.import", { rows: [...] }, { workspace: "acme" });
 *   engine.advance(60_000);
 *   await engine.runJobs();
 *   await engine.close();
 */
import { DEFAULT_TEST_TIME, type FixedClock, fixedClock } from "../core/clock.js";
import { type EngineConfig, loadConfig } from "../core/config.js";
import { ALL_SCOPES, type BrainService, type Principal, type SafeFetch } from "../core/context.js";
import type { CallOptions, Engine } from "../core/engine.js";
import type { Scope } from "../core/enums.js";
import { type Logger, silentLogger } from "../core/logger.js";
import type { EngineModule } from "../core/operation.js";
import type { BrainFactory } from "../runtime/brain.js";
import { createRuntimeEngine, type RuntimeEngine } from "../runtime/create-engine.js";
import type { DrainResult } from "../runtime/jobs/worker.js";
import { TEST_SECRET_KEY } from "./context.js";
import { createTestDb, type TestDb } from "./db.js";
import { createFakeDns, type FakeDns, type FakeDnsRecords } from "./fake-dns.js";
import { createFakeFetch, type FakeSafeFetch, type FetchRoute } from "./fake-fetch.js";

export interface TestEngineOptions {
  /** Default: every built-in module. */
  modules?: EngineModule[];
  /** Clock start. Default 2026-09-19T12:00:00Z. */
  now?: Date | string;
  config?: Partial<EngineConfig>;
  /** Routes for the engine's safe fetch (ctx.fetch, webhooks, notifications). Unmatched URLs throw. */
  fetchRoutes?: FetchRoute[];
  /** Replaces the routed fake safe fetch entirely. */
  safeFetch?: SafeFetch;
  /** fetch handed to provider instances. Default: throws (no network in tests). */
  providerFetch?: typeof globalThis.fetch;
  /** Records for ctx.dns by name (more with engine.dns.set). Other names fail with ENOTFOUND. */
  dnsRecords?: Record<string, FakeDnsRecords>;
  /** A fixed BrainService (e.g. createFakeBrain()) or a factory. Default: the runtime's provider-based brain. */
  brain?: BrainService | BrainFactory;
  log?: Logger;
}

export interface TestCallOptions extends Partial<Omit<CallOptions, "principal">> {
  /** Default: a human test admin with every scope (or `scopes`). */
  principal?: Principal;
  /** Scopes of the default principal. */
  scopes?: Scope[];
}

export interface RunJobsOptions {
  /** Stop after this many jobs. Default 100. */
  max?: number;
  /** Fire due schedules first. Default true. */
  schedules?: boolean;
}

export interface TestEngine extends Engine {
  clock: FixedClock;
  runtime: RuntimeEngine;
  testDb: TestDb;
  /** Routed fake behind ctx.fetch (when `safeFetch` was not given). */
  fetch: FakeSafeFetch;
  /** Fake behind ctx.dns. */
  dns: FakeDns;
  /** Moves the clock forward. */
  advance(ms: number): void;
  call(operationId: string, input?: unknown, options?: TestCallOptions): Promise<unknown>;
  /** Runs due jobs synchronously, one at a time, until none is due. */
  runJobs(options?: RunJobsOptions): Promise<DrainResult>;
  /** The default principal (human, every scope unless `scopes`). */
  principal(overrides?: Partial<Principal>): Principal;
  close(): Promise<void>;
}

export async function createTestEngine(options: TestEngineOptions = {}): Promise<TestEngine> {
  const testDb = await createTestDb();
  const clock = fixedClock(options.now ?? DEFAULT_TEST_TIME);
  const config: EngineConfig = {
    ...loadConfig(
      {
        DATABASE_URL: "memory://",
        OPENOUTBOUND_SECRET_KEY: TEST_SECRET_KEY.toString("base64"),
        OPENOUTBOUND_BASE_URL: "http://localhost:7331",
        LOG_LEVEL: "silent",
      },
      { envFile: false },
    ),
    ...options.config,
  };
  const fakeFetch = createFakeFetch(options.fetchRoutes);
  const fakeDns = createFakeDns(options.dnsRecords);
  const brain = options.brain;
  let brainFactory: BrainFactory | undefined;
  if (typeof brain === "function") brainFactory = brain;
  else if (brain) brainFactory = () => brain;

  const runtime = await createRuntimeEngine(
    { ...(options.modules ? { modules: options.modules } : {}), autoMigrate: false },
    {
      clock,
      db: testDb,
      log: options.log ?? silentLogger(),
      safeFetch: options.safeFetch ?? fakeFetch,
      providerFetch:
        options.providerFetch ??
        (async (input) => {
          throw new Error(
            `Provider fetch to ${String(input)} is not allowed in tests. Pass providerFetch to createTestEngine.`,
          );
        }),
      dns: fakeDns,
      ...(brainFactory ? { brain: brainFactory } : {}),
      workerId: "test-worker",
    },
    config,
  );

  const principal = (overrides: Partial<Principal> = {}): Principal => ({
    type: "human",
    id: "test-admin",
    name: "Test Admin",
    scopes: [...ALL_SCOPES],
    workspaceId: null,
    via: "cli",
    ...overrides,
  });

  return {
    ...runtime,
    clock,
    runtime,
    testDb,
    fetch: fakeFetch,
    dns: fakeDns,
    advance: (ms) => clock.advance(ms),
    principal,
    call: (operationId, input = {}, callOptions = {}) => {
      const { scopes, principal: explicit, ...rest } = callOptions;
      return runtime.call(operationId, input, {
        ...rest,
        principal: explicit ?? principal(scopes ? { scopes } : {}),
      });
    },
    runJobs: (runOptions = {}) => runtime.drainJobs(runOptions),
    close: async () => {
      await runtime.close();
      await testDb.close();
    },
  };
}
