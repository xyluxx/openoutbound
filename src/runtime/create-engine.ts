/**
 * createEngine(): wires config, database, registry, executor, jobs, scheduler and services.
 */
import { createBrainService } from "../brain/service.js";
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import { type EngineConfig, loadConfig, parseDatabaseUrl } from "../core/config.js";
import type { DnsResolver, Principal, SafeFetch } from "../core/context.js";
import type { CreateEngine, CreateEngineOptions, Engine } from "../core/engine.js";
import { OpenOutboundError } from "../core/errors.js";
import { createLogger, type Logger } from "../core/logger.js";
import { createDb, type DbHandle } from "../db/client.js";
import { migrate } from "../db/migrate.js";
import { modules as builtinModules } from "../modules/index.js";
import { authenticateApiKey, localPrincipal } from "./api-keys.js";
import type { BrainFactory } from "./brain.js";
import { systemContext } from "./context.js";
import { createSystemDns } from "./dns.js";
import { createExecutor } from "./executor.js";
import { createWorker, type DrainResult, type Worker } from "./jobs/worker.js";
import { type Kernel, RecentKeys } from "./kernel.js";
import { maintenanceJob, maintenanceSchedule } from "./maintenance.js";
import { deliverNotificationJob } from "./notify.js";
import { createProviderCache } from "./providers.js";
import { buildRegistry, type KernelContributions } from "./registry.js";
import { createSafeFetch, type HostResolver, type Transport } from "./safe-fetch.js";
import { schedulerTick, syncBuiltinSchedules } from "./scheduler.js";
import { createRuntimeVault } from "./vault.js";
import { deliverWebhookJob } from "./webhooks.js";

/** Jobs and schedules the runtime registers whatever modules are loaded. */
export const KERNEL_CONTRIBUTIONS: KernelContributions = {
  jobs: [deliverWebhookJob, deliverNotificationJob, maintenanceJob],
  schedules: [maintenanceSchedule],
};

/** Test and embedding hooks that `CreateEngineOptions` does not expose. */
export interface EngineInternals {
  clock?: Clock;
  /** An open database (the engine will not close it). */
  db?: DbHandle;
  log?: Logger;
  /** Replaces the SSRF-safe fetch (tests use a routed fake). */
  safeFetch?: SafeFetch;
  /** Hooks for the real safe fetch (DNS + transport), used when `safeFetch` is not given. */
  resolveHost?: HostResolver;
  transport?: Transport;
  /** fetch handed to provider instances. Default: globalThis.fetch. */
  providerFetch?: typeof globalThis.fetch;
  /** ctx.dns. Default: the system resolver (tests pass a fake). */
  dns?: DnsResolver;
  /** Builds ctx.brain. Default: the brain module's `createBrainService`. */
  brain?: BrainFactory;
  workerId?: string;
  pollMs?: number;
  leaseMs?: number;
}

/** The engine plus runtime extras (clock, kernel, synchronous job draining). */
export interface RuntimeEngine extends Engine {
  clock: Clock;
  kernel: Kernel;
  worker: Worker;
  /** Runs due jobs until none is due (fires due schedules first). For tests and one-shot CLIs. */
  drainJobs(options?: { max?: number; schedules?: boolean }): Promise<DrainResult>;
  /** Fires due schedules now. Returns how many jobs were enqueued. */
  runScheduler(): Promise<number>;
}

function resolveConfig(overrides: Partial<EngineConfig> | undefined): EngineConfig {
  const base = loadConfig();
  if (!overrides) return base;
  const config = { ...base, ...overrides };
  if (overrides.databaseUrl && !overrides.database) {
    config.database = parseDatabaseUrl(overrides.databaseUrl);
  }
  return config;
}

/** Engine factory with test/embedding hooks. `createEngine` is this without internals. */
export async function createRuntimeEngine(
  options: CreateEngineOptions & { config?: Partial<EngineConfig> } = {},
  internals: EngineInternals = {},
  configOverride?: EngineConfig,
): Promise<RuntimeEngine> {
  const config = configOverride ?? resolveConfig(options.config);
  const log = internals.log ?? createLogger({ level: config.logLevel });
  const clock = internals.clock ?? systemClock;
  const registry = buildRegistry(options.modules ?? builtinModules, KERNEL_CONTRIBUTIONS);
  const handle = internals.db ?? (await createDb(config));
  const ownsDb = internals.db === undefined;

  try {
    if (options.autoMigrate !== false) {
      try {
        await migrate(handle);
      } catch (error) {
        const reason = (error instanceof Error ? error.message : String(error)).split("\n")[0];
        throw new OpenOutboundError("internal", `Database migration failed: ${reason}`, {
          hint: "Back up the data folder first. Then run `openoutbound db migrate` for the full error and `openoutbound doctor` to check the setup.",
          cause: error,
        });
      }
    }
    let worker: Worker | undefined;
    const kernel: Kernel = {
      config,
      db: handle.db,
      log,
      clock,
      registry,
      vault: createRuntimeVault(handle.db, config),
      safeFetch:
        internals.safeFetch ??
        createSafeFetch({
          allowPrivateNetwork: config.allowPrivateNetwork,
          userAgent: config.userAgent,
          clock,
          log,
          ...(internals.resolveHost ? { resolveHost: internals.resolveHost } : {}),
          ...(internals.transport ? { transport: internals.transport } : {}),
        }),
      providerFetch: internals.providerFetch ?? ((input, init) => globalThis.fetch(input, init)),
      dns: internals.dns ?? createSystemDns(),
      providerCache: createProviderCache(),
      brainFactory: internals.brain ?? createBrainService,
      nudge: () => worker?.nudge(),
      recentWakes: new RecentKeys(clock),
    };
    worker = createWorker(kernel, {
      ...(internals.workerId ? { id: internals.workerId } : {}),
      ...(internals.pollMs ? { pollMs: internals.pollMs } : {}),
      ...(internals.leaseMs ? { leaseMs: internals.leaseMs } : {}),
    });
    await syncBuiltinSchedules(kernel);
    const executor = createExecutor(kernel);
    let closed = false;

    const engine: RuntimeEngine = {
      config,
      db: handle.db,
      log,
      registry,
      clock,
      kernel,
      worker,
      call: (operationId, input, callOptions) => executor.call(operationId, input, callOptions),
      authenticate: (apiKey, via) => authenticateApiKey(handle.db, clock, apiKey, via),
      localPrincipal: (kind, via): Principal => localPrincipal(config, kind, via),
      systemContext: (workspaceId) => systemContext(kernel, workspaceId),
      httpRoutes: () => registry.httpRoutes(),
      async startWorker(workerOptions) {
        if (closed) throw new Error("The engine is closed.");
        worker?.start(workerOptions);
      },
      async stopWorker() {
        await worker?.stop();
      },
      drainJobs: (drainOptions) => (worker as Worker).drain(drainOptions),
      runScheduler: () => schedulerTick(kernel),
      async close() {
        if (closed) return;
        closed = true;
        await worker?.stop();
        if (ownsDb) await handle.close();
      },
    };
    if (options.worker) worker.start();
    return engine;
  } catch (error) {
    if (ownsDb) await handle.close().catch(() => {});
    throw error;
  }
}

export const createEngine: CreateEngine = (options) => createRuntimeEngine(options);
