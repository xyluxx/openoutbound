import { and, eq, inArray } from "drizzle-orm";
import { budgetOf, budgetRefusal, budgetStatusOf, usedUpRefusal } from "../core/budget.js";
import type { Clock } from "../core/clock.js";
import {
  type ActorRef,
  type ApprovalCancelFilter,
  type ApprovalRequest,
  type ApprovalService,
  type AuditEntry,
  type AuditLog,
  actorRef,
  type BudgetKind,
  type BudgetStatus,
  type EnqueueOptions,
  type EventBus,
  type JobQueue,
  type Principal,
  type ProviderResolver,
  type UsageMeter,
  type UsageRecordInput,
  type UsageTotals,
} from "../core/context.js";
import type { JobStatus } from "../core/enums.js";
import { OpenOutboundError } from "../core/errors.js";
import type { EventSubject, EventType } from "../core/events.js";
import { newId } from "../core/ids.js";
import { parseWorkspaceSettings } from "../core/settings.js";
import type { Db } from "../db/client.js";
import { approvals, type Job, workspaces } from "../db/schema/index.js";
import type { Slot, SlotInterfaces } from "../providers/types.js";
import { assertInFence } from "../runtime/workspace-fence.js";

/** What a fake job queue saw. */
export interface RecordedJob {
  job_id: string;
  name: string;
  payload: unknown;
  options: EnqueueOptions;
  workspaceId: string | null;
  status: JobStatus;
}

export interface RecordedEvent {
  id: string;
  type: EventType;
  subject: EventSubject | null;
  data: unknown;
  workspaceId: string;
}

export interface RecordedApproval {
  id: string;
  workspaceId: string;
  request: ApprovalRequest;
}

/** Live accessors the fakes use, so derived contexts (ctx.with) record the right principal. */
export interface FakeScope {
  db: Db;
  clock: Clock;
  principal(): Principal;
  workspaceId(): string | null;
  /**
   * The only workspace jobs, events and approvals may be created in (null: any), as the engine's
   * context services enforce (`runtime/workspace-fence.ts`). Omitted: no check.
   */
  fence?(): string | null;
}

// --- Jobs ------------------------------------------------------------------------------------

export function createFakeJobs(
  scope: FakeScope,
  recorded: RecordedJob[],
  wakes: string[],
): JobQueue {
  return {
    async enqueue(name, payload = {}, options = {}) {
      if (options.singletonKey) {
        const existing = recorded.find(
          (job) =>
            job.options.singletonKey === options.singletonKey &&
            (job.status === "queued" || job.status === "waiting" || job.status === "running"),
        );
        if (existing)
          return { job_id: existing.job_id, status: existing.status, deduplicated: true };
      }
      const workspaceId =
        options.workspaceId !== undefined ? options.workspaceId : scope.workspaceId();
      assertInFence(scope.fence?.() ?? null, workspaceId, `enqueue job "${name}"`);
      const job: RecordedJob = {
        job_id: newId("job"),
        name,
        payload,
        options,
        workspaceId,
        status: "queued",
      };
      recorded.push(job);
      return { job_id: job.job_id, status: job.status };
    },
    async get(jobId) {
      const job = recorded.find((candidate) => candidate.job_id === jobId);
      return job ? toJobRow(job, scope.clock.now()) : null;
    },
    async cancel(jobId) {
      const job = recorded.find((candidate) => candidate.job_id === jobId);
      if (!job || (job.status !== "queued" && job.status !== "waiting")) return false;
      job.status = "cancelled";
      return true;
    },
    async wake(waitFor) {
      wakes.push(waitFor);
      return 0;
    },
  };
}

function toJobRow(job: RecordedJob, now: Date): Job {
  return {
    id: job.job_id,
    workspace_id: job.workspaceId,
    name: job.name,
    payload: job.payload,
    status: job.status,
    priority: job.options.priority ?? 0,
    run_at: job.options.runAt ?? now,
    attempts: 0,
    max_attempts: job.options.maxAttempts ?? 5,
    lease_owner: null,
    lease_expires_at: null,
    last_error: null,
    result: null,
    singleton_key: job.options.singletonKey ?? null,
    wait_for: null,
    progress: null,
    created_at: now,
    updated_at: now,
    finished_at: null,
  };
}

// --- Events ----------------------------------------------------------------------------------

export function createFakeEvents(scope: FakeScope, recorded: RecordedEvent[]): EventBus {
  return {
    async emit(type, input) {
      const workspaceId = input.workspaceId ?? scope.workspaceId();
      assertInFence(scope.fence?.() ?? null, workspaceId ?? undefined, `emit "${type}" events`);
      if (!workspaceId) {
        throw new Error(`FakeEvents: "${type}" emitted without a workspace (pass workspaceId).`);
      }
      const id = newId("evt");
      recorded.push({ id, type, subject: input.subject ?? null, data: input.data, workspaceId });
      return { id };
    },
  };
}

// --- Audit -----------------------------------------------------------------------------------

export function createFakeAudit(scope: FakeScope, recorded: AuditEntry[]): AuditLog {
  return {
    async record(entry) {
      const principal = scope.principal();
      recorded.push({
        ...entry,
        workspaceId: entry.workspaceId !== undefined ? entry.workspaceId : scope.workspaceId(),
        actor: entry.actor ?? actorRef(principal),
        via: entry.via ?? principal.via,
        occurredAt: entry.occurredAt ?? scope.clock.now(),
      });
    },
  };
}

// --- Approvals -------------------------------------------------------------------------------

/** Inserts real `approvals` rows (so resolvers and queries work), records, and emits `approval.requested`. */
export function createFakeApprovals(
  scope: FakeScope,
  recorded: RecordedApproval[],
  events: EventBus,
): ApprovalService {
  return {
    async request(request) {
      const workspaceId = request.workspaceId ?? scope.workspaceId();
      assertInFence(scope.fence?.() ?? null, workspaceId ?? undefined, "request approvals");
      if (!workspaceId) throw new Error("FakeApprovals: approvals need a workspace.");
      const requestedBy: ActorRef = actorRef(scope.principal());
      const expiresAt =
        request.expiresAt ?? new Date(scope.clock.now().getTime() + 7 * 24 * 60 * 60 * 1000);
      const [row] = await scope.db
        .insert(approvals)
        .values({
          workspace_id: workspaceId,
          kind: request.kind,
          status: "pending",
          title: request.title,
          summary: request.summary,
          payload: request.payload,
          target_type: request.target?.type ?? null,
          target_id: request.target?.id ?? null,
          requested_by: requestedBy,
          expires_at: expiresAt,
        })
        .returning({ id: approvals.id });
      if (!row) throw new Error("FakeApprovals: insert failed");
      recorded.push({ id: row.id, workspaceId, request });
      await events.emit("approval.requested", {
        workspaceId,
        subject: { type: "approval", id: row.id },
        data: {
          approval_id: row.id,
          kind: request.kind,
          title: request.title,
          target_type: request.target?.type ?? null,
          target_id: request.target?.id ?? null,
        },
      });
      return { id: row.id };
    },
    async cancel(filter: ApprovalCancelFilter) {
      const workspaceId = scope.workspaceId();
      const conditions = [eq(approvals.status, "pending")];
      if (workspaceId) conditions.push(eq(approvals.workspace_id, workspaceId));
      if (filter.id) conditions.push(eq(approvals.id, filter.id));
      if (filter.kind) conditions.push(eq(approvals.kind, filter.kind));
      if (filter.target) {
        conditions.push(eq(approvals.target_type, filter.target.type));
        conditions.push(eq(approvals.target_id, filter.target.id));
      }
      const rows = await scope.db
        .select({ id: approvals.id })
        .from(approvals)
        .where(and(...conditions));
      if (rows.length === 0) return 0;
      await scope.db
        .update(approvals)
        .set({ status: "cancelled", decided_at: scope.clock.now() })
        .where(
          inArray(
            approvals.id,
            rows.map((r) => r.id),
          ),
        );
      return rows.length;
    },
  };
}

// --- Usage -----------------------------------------------------------------------------------

export interface FakeUsageMeter extends UsageMeter {
  /**
   * Makes assertBudget(workspace, kind) throw budget_exceeded, and budgetStatus report nothing
   * left, for one workspace (default: the scope's one; a test context's meter uses its own), or
   * lets it pass again with `false`. Other workspaces are not affected.
   */
  setOverBudget(kind: "ai" | "data", over?: boolean, workspaceId?: string | null): void;
}

export function createFakeUsage(
  scope: FakeScope,
  recorded: UsageRecordInput[],
  overBudget: Array<"ai" | "data"> = [],
): FakeUsageMeter {
  /** "<workspace id>:<kind>" for each budget forced over (overBudget: the scope's workspace). */
  const key = (workspaceId: string | null, kind: BudgetKind) => `${workspaceId}:${kind}`;
  const over = new Set(overBudget.map((kind) => key(scope.workspaceId(), kind)));
  const monthToDate = async (workspaceId: string): Promise<UsageTotals> => {
    const totals: UsageTotals = { aiCostUsd: 0, dataCredits: 0, dataCostUsd: 0 };
    for (const entry of recorded) {
      if (entry.workspaceId !== workspaceId) continue;
      if (entry.slot === "brain") totals.aiCostUsd += entry.costUsd ?? 0;
      else {
        totals.dataCredits += entry.credits ?? 0;
        totals.dataCostUsd += entry.costUsd ?? 0;
      }
    }
    return totals;
  };
  /** Budget from the workspace settings, usage from the recorded rows (as the real meter). */
  const budgetStatus = async (workspaceId: string, kind: BudgetKind): Promise<BudgetStatus> => {
    const [row] = await scope.db
      .select({ settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    const budget = row ? budgetOf(parseWorkspaceSettings(row.settings), kind) : null;
    const totals = await monthToDate(workspaceId);
    const used = kind === "ai" ? totals.aiCostUsd : totals.dataCredits;
    if (over.has(key(workspaceId, kind))) {
      return budgetStatusOf(kind, budget ?? used, Math.max(used, budget ?? 0));
    }
    return budgetStatusOf(kind, budget, used);
  };
  return {
    async record(entry) {
      recorded.push({
        ...entry,
        workspaceId: entry.workspaceId !== undefined ? entry.workspaceId : scope.workspaceId(),
      });
    },
    monthToDate,
    async assertBudget(workspaceId, kind) {
      if (!over.has(key(workspaceId, kind))) return;
      // The same error as the real meter, with the numbers budgetStatus reports.
      throw usedUpRefusal(await budgetStatus(workspaceId, kind));
    },
    budgetStatus,
    async assertCanSpend(workspaceId, kind, needed, options = {}) {
      if (!(needed > 0)) return;
      const refusal = budgetRefusal(await budgetStatus(workspaceId, kind), needed, options);
      if (refusal) throw refusal;
    },
    setOverBudget(kind, isOver = true, workspaceId = scope.workspaceId()) {
      if (isOver) over.add(key(workspaceId, kind));
      else over.delete(key(workspaceId, kind));
    },
  };
}

// --- Providers -------------------------------------------------------------------------------

/** Slot -> fake instance (or several, highest priority first). */
export type FakeProviderMap = { [S in Slot]?: SlotInterfaces[S] | Array<SlotInterfaces[S]> };

export interface FakeProviderResolver extends ProviderResolver {
  set<S extends Slot>(
    slot: S,
    instances: SlotInterfaces[S] | Array<SlotInterfaces[S]> | null,
  ): void;
}

export function createFakeProviders(initial: FakeProviderMap = {}): FakeProviderResolver {
  const map = new Map<Slot, unknown[]>();
  for (const [slot, value] of Object.entries(initial)) {
    if (value) map.set(slot as Slot, Array.isArray(value) ? value : [value]);
  }
  const pick = <S extends Slot>(slot: S, id?: string): SlotInterfaces[S] | null => {
    const list = (map.get(slot) ?? []) as Array<SlotInterfaces[S]>;
    const found = id === undefined ? list[0] : list.find((instance) => instance.id === id);
    return found ?? null;
  };
  return {
    async get(slot, options) {
      const instance = pick(slot, options?.id);
      if (!instance) {
        const which = options?.id ? `"${options.id}" ` : "";
        throw new OpenOutboundError(
          "provider_not_configured",
          `No ${which}${slot} provider is configured.`,
          {
            hint: `In tests, pass providers: { ${slot}: fake } to createTestContext or call ctx.providers.set("${slot}", fake).`,
            details: { slot },
          },
        );
      }
      return instance;
    },
    async tryGet(slot, options) {
      return pick(slot, options?.id);
    },
    async list(slot) {
      return [...((map.get(slot) ?? []) as Array<SlotInterfaces[typeof slot]>)];
    },
    set(slot, instances) {
      if (instances === null) map.delete(slot);
      else map.set(slot, Array.isArray(instances) ? instances : [instances]);
    },
  };
}
