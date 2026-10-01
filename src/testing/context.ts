/**
 * `createTestContext()`: a real OpContext for handler tests, backed by a fresh migrated PGlite
 * database, a seeded workspace, a fixed clock and fakes that record every call.
 *
 *   const ctx = await createTestContext({ providers: { email_verifier: fakeVerifier } });
 *   await myHandler(ctx, input);
 *   expect(ctx.emitted("lead.created")).toHaveLength(1);
 *   expect(ctx.enqueued("research.run")[0]?.payload).toEqual({ company_id: "co_..." });
 *   await ctx.close();
 */
import { eq } from "drizzle-orm";
import { DEFAULT_TEST_TIME, type FixedClock, fixedClock } from "../core/clock.js";
import { type EngineConfig, loadConfig } from "../core/config.js";
import {
  ALL_SCOPES,
  type AuditEntry,
  type JobContext,
  type JobProgress,
  type OpContext,
  type OpRequest,
  type Principal,
  type RunningJob,
  SYSTEM_PRINCIPAL,
  type UsageRecordInput,
} from "../core/context.js";
import type { EventData, EventSubject, EventType } from "../core/events.js";
import { newId } from "../core/ids.js";
import { type Logger, silentLogger } from "../core/logger.js";
import type { WorkspaceSettingsInput } from "../core/settings.js";
import { createVault } from "../core/vault.js";
import type { Db } from "../db/client.js";
import { type NewWorkspace, type Workspace, workspaces } from "../db/schema/index.js";
import { registerTransactionBinder, registerWorkspaceBinder } from "../runtime/context.js";
import { createTestDb, type TestDb } from "./db.js";
import { seedWorkspace } from "./factories.js";
import {
  type BrainCall,
  createFakeBrain,
  type FakeBrain,
  type FakeBrainHandler,
} from "./fake-brain.js";
import { createFakeDns, type FakeDns, type FakeDnsRecords } from "./fake-dns.js";
import {
  createFakeFetch,
  type FakeRequest,
  type FakeSafeFetch,
  type FetchRoute,
} from "./fake-fetch.js";
import {
  createFakeApprovals,
  createFakeAudit,
  createFakeEvents,
  createFakeJobs,
  createFakeProviders,
  createFakeUsage,
  type FakeProviderMap,
  type FakeProviderResolver,
  type FakeScope,
  type FakeUsageMeter,
  type RecordedApproval,
  type RecordedEvent,
  type RecordedJob,
} from "./fakes.js";

/** Fixed vault key for tests (never use outside tests). */
export const TEST_SECRET_KEY = Buffer.alloc(32, 7);

/** Everything the fakes recorded, in call order. */
export interface Recorded {
  jobs: RecordedJob[];
  /** Keys passed to jobs.wake(). */
  wakes: string[];
  events: RecordedEvent[];
  audit: AuditEntry[];
  approvals: RecordedApproval[];
  usage: UsageRecordInput[];
  brain: BrainCall[];
  fetch: FakeRequest[];
  /** setProgress calls from job contexts. */
  progress: Array<{ jobId: string; progress: JobProgress }>;
}

export interface TestContextOptions {
  /** Share one database between contexts (e.g. two workspaces). Default: a fresh one (closed by ctx.close()). */
  db?: TestDb;
  /** Overrides for the seeded workspace row. */
  workspace?: Partial<NewWorkspace>;
  /** Seed a sandbox workspace (is_sandbox = true). */
  sandbox?: boolean;
  /** Workspace settings overrides (stored as-is, read through parseWorkspaceSettings). */
  settings?: WorkspaceSettingsInput;
  /** Principal overrides. Default: human "Test User" with every scope, via "cli". */
  principal?: Partial<Principal>;
  /** Clock start. Default 2026-09-19T12:00:00Z. */
  now?: Date | string;
  request?: Partial<OpRequest>;
  /** Slot -> fake provider instance(s). `providers.tryGet` returns null for other slots. */
  providers?: FakeProviderMap;
  /** Prompt id -> fake answer (value or `(vars) => value`). Others get a minimal valid output. */
  brain?: Record<string, FakeBrainHandler>;
  /** Routes for ctx.fetch (SafeFetch). Unmatched URLs throw. */
  fetchRoutes?: FetchRoute[];
  /** Records for ctx.dns by name (more with ctx.dns.set). Other names fail with ENOTFOUND. */
  dnsRecords?: Record<string, FakeDnsRecords>;
  /** Budgets of the seeded workspace that fail assertBudget from the start (see setOverBudget). */
  overBudget?: Array<"ai" | "data">;
  config?: Partial<EngineConfig>;
  log?: Logger;
}

export interface TestContextOverrides {
  principal?: Partial<Principal>;
  request?: Partial<OpRequest>;
  workspace?: Workspace;
}

/** A job/event handler context sharing the test context's db and recorders. */
export type TestJobContext = TestContext & JobContext;

export interface TestContext extends OpContext {
  workspace: Workspace;
  clock: FixedClock;
  brain: FakeBrain;
  fetch: FakeSafeFetch;
  dns: FakeDns;
  providers: FakeProviderResolver;
  usage: FakeUsageMeter;
  testDb: TestDb;
  recorded: Recorded;
  /** Recorded events of one type, with typed data. */
  emitted<T extends EventType>(
    type: T,
  ): Array<{ id: string; subject: EventSubject | null; data: EventData[T] }>;
  /** Recorded jobs, optionally filtered by name. */
  enqueued(name?: string): RecordedJob[];
  /** Same db, clock and recorders, different principal / request / workspace. */
  with(overrides: TestContextOverrides): TestContext;
  /** JobContext (system principal, via "worker") for calling job and event handlers directly. */
  jobContext(job?: Partial<RunningJob>): TestJobContext;
  /** Re-reads the workspace row (after settings or status changes) and updates ctx.workspace. */
  reloadWorkspace(): Promise<Workspace>;
  /** Closes the database if this context created it. */
  close(): Promise<void>;
}

interface Shared {
  testDb: TestDb;
  ownsDb: boolean;
  clock: FixedClock;
  config: EngineConfig;
  log: Logger;
  recorded: Recorded;
  providers: FakeProviderResolver;
  fetch: FakeSafeFetch;
  dns: FakeDns;
  usage: FakeUsageMeter;
  brain: FakeBrain;
  vault: OpContext["vault"];
}

interface State {
  workspace: Workspace;
  principal: Principal;
  request: OpRequest;
}

export async function createTestContext(options: TestContextOptions = {}): Promise<TestContext> {
  const testDb = options.db ?? (await createTestDb());
  const clock = fixedClock(options.now ?? DEFAULT_TEST_TIME);
  const config: EngineConfig = {
    ...loadConfig(
      {
        DATABASE_URL: "memory://",
        OPENOUTBOUND_SECRET_KEY: TEST_SECRET_KEY.toString("base64"),
        OPENOUTBOUND_BASE_URL: "http://localhost:7331",
      },
      { envFile: false },
    ),
    ...options.config,
  };
  const workspace = await seedWorkspace(testDb.db, {
    is_sandbox: options.sandbox ?? false,
    settings: options.settings ?? {},
    ...options.workspace,
  });
  const state: State = {
    workspace,
    principal: {
      type: "human",
      id: "usr_test",
      name: "Test User",
      scopes: [...ALL_SCOPES],
      workspaceId: workspace.id,
      via: "cli",
      ...options.principal,
    },
    request: { dryRun: false, responseFormat: "concise", ...options.request },
  };
  const recorded: Recorded = {
    jobs: [],
    wakes: [],
    events: [],
    audit: [],
    approvals: [],
    usage: [],
    brain: [],
    fetch: [],
    progress: [],
  };
  const baseScope: FakeScope = {
    db: testDb.db,
    clock,
    principal: () => state.principal,
    workspaceId: () => state.workspace.id,
  };
  const usage = createFakeUsage(baseScope, recorded.usage, options.overBudget);
  const shared: Shared = {
    testDb,
    ownsDb: options.db === undefined,
    clock,
    config,
    log: options.log ?? silentLogger(),
    recorded,
    providers: createFakeProviders(options.providers),
    fetch: createFakeFetch(options.fetchRoutes, recorded.fetch),
    dns: createFakeDns(options.dnsRecords),
    usage,
    // Each context runs it for its own workspace (see build), like the real per-context brain.
    brain: createFakeBrain({
      ...(options.brain ? { handlers: options.brain } : {}),
      calls: recorded.brain,
      usage,
    }),
    vault: createVault({ db: testDb.db, key: TEST_SECRET_KEY }),
  };
  return build(shared, state);
}

/**
 * `db` defaults to the test database; `withTransaction` passes a transaction. `fence` is the only
 * workspace the fakes create jobs, events and approvals in (null: any, for instance-level jobs),
 * as the engine's context services enforce.
 */
function build(
  shared: Shared,
  state: State,
  db: Db = shared.testDb.db,
  fence: string | null = state.workspace.id,
): TestContext {
  const { recorded } = shared;
  const scope: FakeScope = {
    db,
    clock: shared.clock,
    principal: () => state.principal,
    workspaceId: () => state.workspace.id,
    fence: () => fence,
  };
  const events = createFakeEvents(scope, recorded.events);

  const ctx: TestContext = {
    db,
    workspace: state.workspace,
    principal: state.principal,
    config: shared.config,
    providers: shared.providers,
    // Shared answers and calls, but runs without a workspace use this context's one.
    brain: shared.brain.withWorkspace(scope.workspaceId),
    jobs: createFakeJobs(scope, recorded.jobs, recorded.wakes),
    events,
    audit: createFakeAudit(scope, recorded.audit),
    approvals: createFakeApprovals(scope, recorded.approvals, events),
    // Shared budgets and records, but usage without a workspace goes to this context's one,
    // as the real meter (created per context) does, and setOverBudget is for this workspace.
    usage: {
      ...shared.usage,
      record: (entry) =>
        shared.usage.record({
          ...entry,
          workspaceId: entry.workspaceId !== undefined ? entry.workspaceId : scope.workspaceId(),
        }),
      setOverBudget: (kind, over, workspaceId = scope.workspaceId()) =>
        shared.usage.setOverBudget(kind, over, workspaceId),
    },
    vault: shared.vault,
    fetch: shared.fetch,
    dns: shared.dns,
    clock: shared.clock,
    log: shared.log,
    request: state.request,
    testDb: shared.testDb,
    recorded,
    emitted: <T extends EventType>(type: T) =>
      recorded.events
        .filter((event) => event.type === type)
        .map((event) => ({
          id: event.id,
          subject: event.subject,
          data: event.data as EventData[T],
        })),
    enqueued: (name) => recorded.jobs.filter((job) => name === undefined || job.name === name),
    with: (overrides) =>
      build(shared, {
        workspace: overrides.workspace ?? state.workspace,
        principal: { ...state.principal, ...overrides.principal },
        request: { ...state.request, ...overrides.request },
      }),
    jobContext: (job = {}) => {
      const running: RunningJob = {
        id: newId("job"),
        name: "test.job",
        attempt: 1,
        maxAttempts: 5,
        workspaceId: state.workspace.id,
        singletonKey: null,
        signal: new AbortController().signal,
        ...job,
      };
      return buildJobContext(shared, state.workspace, running, running.workspaceId);
    },
    reloadWorkspace: async () => {
      const [row] = await db.select().from(workspaces).where(eq(workspaces.id, state.workspace.id));
      if (!row) throw new Error("reloadWorkspace: workspace row is gone");
      state.workspace = row;
      ctx.workspace = row;
      return row;
    },
    close: async () => {
      if (shared.ownsDb) await shared.testDb.close();
    },
  };
  // withTransaction: the same recorders, with the fakes that write rows going through the transaction.
  registerTransactionBinder(ctx, (tx) => build(shared, state, tx, fence));
  return ctx;
}

/**
 * A job context like the engine's: the system principal (via "worker") bound to the job's
 * workspace. An instance-level job (`workspaceId: null`) keeps the test workspace as
 * `ctx.workspace` for convenience, but its fakes accept any workspace and `contextForWorkspace`
 * switches it to another workspace (a job context bound to that one, same job).
 */
function buildJobContext(
  shared: Shared,
  workspace: Workspace,
  running: RunningJob,
  fence: string | null,
): TestJobContext {
  const base = build(
    shared,
    {
      workspace,
      principal: {
        ...SYSTEM_PRINCIPAL,
        scopes: [...ALL_SCOPES],
        workspaceId: fence,
        via: "worker",
      },
      request: { dryRun: false, responseFormat: "concise" },
    },
    shared.testDb.db,
    fence,
  );
  const ctx: TestJobContext = {
    ...base,
    job: running,
    setProgress: async (progress: JobProgress) => {
      shared.recorded.progress.push({ jobId: running.id, progress });
    },
  };
  registerWorkspaceBinder(ctx, (target) => buildJobContext(shared, target, running, target.id));
  return ctx;
}
