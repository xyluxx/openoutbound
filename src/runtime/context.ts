import { eq } from "drizzle-orm";
import {
  ALL_SCOPES,
  type JobContext,
  type JobProgress,
  type OpContext,
  type OpRequest,
  type Principal,
  type RunningJob,
  SYSTEM_PRINCIPAL,
} from "../core/context.js";
import type { Via } from "../core/enums.js";
import { OpenOutboundError } from "../core/errors.js";
import type { Db } from "../db/client.js";
import { type Job, jobs, type Workspace, workspaces } from "../db/schema/index.js";
import { createApprovalService } from "./approvals.js";
import { createAuditLog } from "./audit.js";
import { createBrainHealthReporter } from "./brain-health.js";
import { createEventBus } from "./events.js";
import { createJobQueue } from "./jobs/queue.js";
import type { Kernel } from "./kernel.js";
import { createProviderResolver } from "./providers.js";
import { createUsageMeter } from "./usage.js";
import { contextFence } from "./workspace-fence.js";

export interface ContextScope {
  workspace: Workspace | null;
  principal: Principal;
  request?: Partial<OpRequest>;
  /** Set for job contexts: the brain uses it for agent tasks and usage rows. */
  jobId?: string;
}

const kernels = new WeakMap<object, Kernel>();

/**
 * The kernel behind a context built by the runtime (registry, provider catalog, cache).
 * For runtime-owned modules only; throws for contexts from elsewhere (e.g. createTestContext).
 */
export function kernelOf(ctx: OpContext): Kernel {
  const kernel = kernels.get(ctx);
  if (!kernel) {
    throw new OpenOutboundError("internal", "This context was not created by the engine.", {
      hint: "Run the operation through engine.call (createTestEngine in tests).",
    });
  }
  return kernel;
}

/** Builds an OpContext whose services are bound to the workspace and principal. */
export function createOpContext(kernel: Kernel, scope: ContextScope): OpContext {
  const workspaceId = scope.workspace?.id ?? null;
  // Events, jobs and approvals from this context stay in its workspace (see workspace-fence).
  const fence = contextFence(workspaceId, scope.principal);
  const jobQueue = createJobQueue(kernel, { workspaceId, fence });
  const events = createEventBus(kernel, { workspaceId, jobs: jobQueue, fence });
  let healthContext: OpContext | undefined;
  const providers = createProviderResolver(kernel, scope.workspace, {
    // Problems about provider health are the engine's own bookkeeping: system principal.
    healthContext: () => {
      healthContext ??= createOpContext(kernel, {
        workspace: scope.workspace,
        principal: systemPrincipal(workspaceId, "system"),
      });
      return healthContext;
    },
  });
  const usage = createUsageMeter(kernel, { workspaceId });
  const log = kernel.log.child({
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
    principal: scope.principal.id,
    ...(scope.jobId ? { job_id: scope.jobId } : {}),
  });
  const ctx: OpContext = {
    db: kernel.db,
    workspace: scope.workspace,
    principal: scope.principal,
    config: kernel.config,
    providers,
    brain: kernel.brainFactory({
      db: kernel.db,
      providers,
      usage,
      clock: kernel.clock,
      log,
      workspaceId,
      jobId: scope.jobId ?? null,
      health: createBrainHealthReporter(() => ctx),
    }),
    jobs: jobQueue,
    events,
    audit: createAuditLog(kernel, { workspaceId, principal: scope.principal }),
    approvals: createApprovalService(kernel, {
      workspace: scope.workspace,
      principal: scope.principal,
      events,
    }),
    usage,
    vault: kernel.vault,
    fetch: kernel.safeFetch,
    dns: kernel.dns,
    clock: kernel.clock,
    log,
    request: {
      dryRun: false,
      responseFormat: "concise",
      ...scope.request,
    },
  };
  kernels.set(ctx, kernel);
  return ctx;
}

/** The engine acting on its own behalf, bound to a workspace (or instance-wide). */
export function systemPrincipal(workspaceId: string | null, via: Via = "system"): Principal {
  return { ...SYSTEM_PRINCIPAL, scopes: [...ALL_SCOPES], workspaceId, via };
}

export async function loadWorkspace(
  kernel: Kernel,
  workspaceId: string,
): Promise<Workspace | null> {
  const [row] = await kernel.db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return row ?? null;
}

/** OpContext for the system principal (module HTTP routes, maintenance, scripts). */
export async function systemContext(
  kernel: Kernel,
  workspaceId: string | null,
): Promise<OpContext> {
  let workspace: Workspace | null = null;
  if (workspaceId) {
    workspace = await loadWorkspace(kernel, workspaceId);
    if (!workspace) {
      throw new OpenOutboundError("not_found", `Workspace ${workspaceId} not found.`, {
        hint: "List workspaces with workspaces.list.",
      });
    }
  }
  return createOpContext(kernel, {
    workspace,
    principal: systemPrincipal(workspace?.id ?? null, "system"),
  });
}

/** JobContext for a claimed job: system principal (via worker), job info and progress. */
export function createJobContext(
  kernel: Kernel,
  job: Job,
  workspace: Workspace | null,
  signal: AbortSignal,
): JobContext {
  const base = createOpContext(kernel, {
    workspace,
    principal: systemPrincipal(workspace?.id ?? job.workspace_id, "worker"),
    jobId: job.id,
  });
  const running: RunningJob = {
    id: job.id,
    name: job.name,
    attempt: job.attempts,
    maxAttempts: job.max_attempts,
    workspaceId: job.workspace_id,
    singletonKey: job.singleton_key,
    signal,
  };
  const ctx: JobContext = {
    ...base,
    job: running,
    setProgress: progressWriter(kernel.db, job.id),
  };
  kernels.set(ctx, kernel);
  return ctx;
}

function progressWriter(db: Db, jobId: string): (progress: JobProgress) => Promise<void> {
  return async (progress) => {
    await db
      .update(jobs)
      .set({ progress: JSON.parse(JSON.stringify(progress)) })
      .where(eq(jobs.id, jobId));
  };
}

const workspaceBinders = new WeakMap<object, (workspace: Workspace) => OpContext>();

/**
 * Tells `contextForWorkspace` how a context the engine did not build (a test context) rebuilds
 * itself for another workspace, with every service bound to it.
 */
export function registerWorkspaceBinder(
  ctx: OpContext,
  bind: (workspace: Workspace) => OpContext,
): void {
  workspaceBinders.set(ctx, bind);
}

function crossWorkspace(fence: string, target: string): OpenOutboundError {
  return new OpenOutboundError(
    "forbidden",
    `A context of workspace ${fence} cannot act in workspace ${target}.`,
    {
      hint: "A job or call that belongs to one workspace acts only there; switching workspaces is for instance-level jobs.",
      details: { reason: "workspace_scope", workspace_id: fence, target_workspace_id: target },
    },
  );
}

/**
 * Where a context may switch to: a job context by its job's workspace (an instance-level job may
 * visit every workspace, one at a time), any other context by its fence.
 */
function switchFence(ctx: OpContext): string | null {
  const job = (ctx as Partial<JobContext>).job;
  if (job) return job.workspaceId ?? null;
  return contextFence(ctx.workspace?.id ?? null, ctx.principal);
}

/**
 * The context acting in `workspaceId`, every service bound to it (events, jobs, approvals,
 * audit, providers, usage, brain), job info kept: never a shallow `{ ...ctx, workspace }`,
 * whose services would still write to the old workspace. Returns `ctx` itself when it already
 * acts there. Only instance-level contexts (an instance-level job, or a call with no workspace
 * by a principal bound to none) may switch; any other is refused with `forbidden`. Null when the
 * workspace does not exist.
 */
export async function contextForWorkspace<C extends OpContext>(
  ctx: C,
  workspaceId: string,
): Promise<C | null> {
  if (ctx.workspace?.id === workspaceId) return ctx;
  const fence = switchFence(ctx);
  if (fence !== null && fence !== workspaceId) throw crossWorkspace(fence, workspaceId);
  const [row] = await ctx.db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!row) return null;
  return rebindWorkspace(ctx, row) as C;
}

function rebindWorkspace(ctx: OpContext, workspace: Workspace): OpContext {
  const kernel = kernels.get(ctx);
  if (!kernel) {
    const bind = workspaceBinders.get(ctx);
    if (!bind) {
      throw new OpenOutboundError("internal", "This context cannot switch workspaces.", {
        hint: "Run it through engine.call or a job (createTestEngine or createTestContext in tests).",
      });
    }
    return bind(workspace);
  }
  // The engine acting for the job binds to the workspace the way a workspace job's context is.
  const principal =
    ctx.principal.type === "system"
      ? { ...ctx.principal, workspaceId: workspace.id }
      : ctx.principal;
  const job = (ctx as Partial<JobContext>).job;
  const fresh = createOpContext(kernel, {
    workspace,
    principal,
    request: ctx.request,
    ...(job ? { jobId: job.id } : {}),
  });
  if (!job) return fresh;
  const out: JobContext = {
    ...fresh,
    job,
    setProgress: (ctx as JobContext).setProgress,
  };
  kernels.set(out, kernel);
  return out;
}

/**
 * The context a job acts in (spec 2, rule 9). A job that belongs to a workspace
 * (`jobs.workspace_id`) acts only there: a payload naming another workspace is refused with
 * `forbidden`, which fails the job without retries. An instance-level job gets a full context
 * for the payload's workspace. Null when there is no workspace to act in, or it is gone.
 */
export async function jobWorkspaceContext<C extends JobContext>(
  ctx: C,
  payloadWorkspaceId?: string | null,
): Promise<C | null> {
  const own = ctx.job.workspaceId;
  if (own) {
    if (payloadWorkspaceId && payloadWorkspaceId !== own) {
      throw new OpenOutboundError(
        "forbidden",
        `Job ${ctx.job.id} belongs to workspace ${own}, and its payload names workspace ${payloadWorkspaceId}.`,
        {
          hint: "Enqueue the job from the workspace it is for: a job acts only in its own workspace.",
          details: {
            reason: "workspace_scope",
            workspace_id: own,
            target_workspace_id: payloadWorkspaceId,
          },
        },
      );
    }
    return contextForWorkspace(ctx, own);
  }
  if (!payloadWorkspaceId) return ctx.workspace ? ctx : null;
  return contextForWorkspace(ctx, payloadWorkspaceId);
}

const binders = new WeakMap<object, (db: Db) => OpContext>();

/**
 * Tells `withTransaction` how a context the engine did not build (a test context) binds itself
 * to a transaction: the same context with `db`, and every service that writes to the database,
 * going through the transaction.
 */
export function registerTransactionBinder(ctx: OpContext, bind: (db: Db) => OpContext): void {
  binders.set(ctx, bind);
}

/** The context with its database, and the services that write to it, bound to `db`. */
function bindContext(ctx: OpContext, db: Db): OpContext {
  const kernel = kernels.get(ctx);
  if (!kernel) return binders.get(ctx)?.(db) ?? { ...ctx, db };
  const bound: Kernel = { ...kernel, db };
  const job = (ctx as Partial<JobContext>).job;
  const fresh = createOpContext(bound, {
    workspace: ctx.workspace,
    principal: ctx.principal,
    request: ctx.request,
    ...(job ? { jobId: job.id } : {}),
  });
  const out: OpContext = job
    ? ({ ...ctx, ...fresh, job, setProgress: progressWriter(db, job.id) } as JobContext)
    : { ...ctx, ...fresh };
  kernels.set(out, bound);
  return out;
}

/**
 * Runs `fn` in one database transaction with a context whose database and services (events,
 * jobs, approvals, audit, usage) all write through it: everything commits together, or nothing
 * does when `fn` throws. Events, their handler jobs and webhook deliveries become visible when
 * it commits. Keep outside calls (HTTP) out of `fn`: the transaction holds a connection (on
 * PGlite, the whole database) until it ends. Engine and test contexts rebind every service;
 * any other context only gets the transaction as `db`.
 */
export async function withTransaction<T>(
  ctx: OpContext,
  fn: (tx: OpContext) => Promise<T>,
): Promise<T> {
  return ctx.db.transaction(async (db) => fn(bindContext(ctx, db)));
}
