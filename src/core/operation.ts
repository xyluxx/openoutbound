import type { Hono } from "hono";
import { z } from "zod";
import type { Approval } from "../db/schema/index.js";
import type { ProviderDefinition } from "../providers/types.js";
import type { ApprovalDecision, AuditTarget, JobContext, OpContext } from "./context.js";
import type { Engine } from "./engine.js";
import {
  type ApprovalKind,
  type Effect,
  JOB_STATUSES,
  type Scope,
  TOOLSETS,
  type Toolset,
} from "./enums.js";
import type { EventHandlerDefinition } from "./events.js";

export type { EmittedEvent, EventHandlerDefinition } from "./events.js";
export { onEvent } from "./events.js";

// --- Operations ------------------------------------------------------------------------------

/** `default` = dry run unless the caller passes `dry_run: false`. */
export type DryRunMode = "supported" | "default" | "none";
export type WorkspaceMode = "required" | "optional" | "none";
/**
 * Whether a principal bound to one workspace (a workspace key, an `openoutbound mcp
 * --workspace` session) may call an operation with `workspace: "none"`. `refuse`: only an
 * unbound principal (instance-level writes such as creating workspaces or seeding the
 * sandbox). `allow`: safe for bound principals because the handler limits what they see to
 * their own workspace. The executor enforces it.
 */
export type BoundPrincipalPolicy = "refuse" | "allow";
export const BOUND_PRINCIPAL_POLICIES = ["refuse", "allow"] as const;
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Any zod object schema (operation inputs must be objects with snake_case keys). */
export type AnyZodObject = z.ZodObject<z.core.$ZodShape, z.core.$ZodObjectConfig>;

export interface HttpSpec {
  method: HttpMethod;
  /** Starts with /v1/. `:name` segments map to input fields of the same name. */
  path: string;
}

export interface OperationExample<I> {
  title: string;
  input: I;
}

/**
 * One capability, exposed through every door (MCP, CLI, REST, OpenAPI, docs) (spec 5.1).
 *
 * Executor contract (spec 6): resolve principal -> workspace -> access -> scopes -> validate
 * input -> idempotency -> paused check (send ops) -> budget (spend ops) -> dry-run flag ->
 * handler -> audit -> idempotency store. The executor adds the common input fields (workspace,
 * reason, dry_run, idempotency_key, response_format); never declare them yourself, read them
 * from `ctx.request`. The handler result is parsed with `output.parse()` (unknown keys are
 * stripped, `isoDateTime()` fields turn Dates into ISO strings), so you may return DB rows.
 *
 * Dry runs: when `ctx.request.dryRun` is true the handler must not write, send or spend; it
 * returns `dryRun(...)`, so declare `output: z.union([result, dryRunOutput(preview)])`.
 * Approval-gated work returns `awaitingApproval(...)` (declare `awaitingApprovalOutput` in the
 * union). Long work enqueues a job and returns `ctx.jobs.enqueue(...)` (`jobHandleOutput`).
 */
export type OperationDefinition<
  In extends AnyZodObject = AnyZodObject,
  Out extends z.ZodType = z.ZodType,
> = OperationFields<In, Out> & OperationWorkspace;

/**
 * Where an operation acts. `workspace: "none"` operations must say whether principals bound to
 * one workspace may call them (`boundPrincipals`); the other modes resolve and fence a
 * workspace on every call, so they cannot set it.
 */
export type OperationWorkspace =
  | { workspace: "required" | "optional"; boundPrincipals?: never }
  | { workspace: "none"; boundPrincipals: BoundPrincipalPolicy };

/** Every field of an operation except where it acts (see `OperationWorkspace`). */
export interface OperationFields<
  In extends AnyZodObject = AnyZodObject,
  Out extends z.ZodType = z.ZodType,
> {
  /** Dotted and stable, e.g. "leads.import". First segment = group (CLI command, docs page). */
  id: string;
  /** One line, imperative ("Import leads from a file or rows"). */
  summary: string;
  /** 3-4 sentences for agents: what, when to use, when not to, caveats. */
  description: string;
  effect: Effect;
  /** Defaults from effect (see EFFECT_SCOPES). */
  scopes?: Scope[];
  /**
   * Added to the hint of the `forbidden` error a caller without the scopes gets: what they can
   * do instead, such as suggesting the change with a proposal.
   */
  forbiddenHint?: string;
  input: In;
  output: Out;
  http?: HttpSpec;
  /** CLI path override, e.g. "leads import". Default: id segments, underscores as hyphens. */
  cli?: string;
  dryRun: DryRunMode;
  /** Repeat-safe with an idempotency key (and MCP idempotentHint). */
  idempotent: boolean;
  /** Valid inputs (checked by defineOperation); used in docs, MCP tool descriptions and tests. */
  examples: Array<OperationExample<z.input<In>>>;
  /**
   * What the audit log records as the input, when it must not keep all of it (for example
   * `leads.forget` never stores the address it was asked to forget). Default: the input.
   */
  auditInput?(input: Record<string, unknown>): Record<string, unknown>;
  /**
   * What the audit log keeps of the call's free text (the caller's `reason`, and the summary,
   * which holds the error message when the call fails), when it must not keep all of it. Gets
   * the input as the caller sent it. Default: kept as written.
   */
  auditText?(text: string, input: Record<string, unknown>): string;
  handler(ctx: OpContext, input: z.output<In>): Promise<z.input<Out>>;
}

/** Scopes required by default for each effect (spec 5.1). */
export const EFFECT_SCOPES: Record<Effect, Scope[]> = {
  read: ["read"],
  write: ["write"],
  send: ["send"],
  spend: ["spend"],
  destructive: ["write"],
  admin: ["admin"],
};

/**
 * Fields the executor adds to every operation input. Doors merge them into MCP input schemas,
 * CLI flags and OpenAPI (dry_run only when dryRun != 'none'; response_format for read ops).
 */
export const RESERVED_INPUT_FIELDS = [
  "workspace",
  "reason",
  "dry_run",
  "idempotency_key",
  "response_format",
] as const;

const OPERATION_ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const SNAKE_KEY = /^[a-z][a-z0-9_]*$/;

/**
 * Declares an operation. Throws at import time on contract violations (bad id, reserved or
 * non-snake_case input fields, invalid examples), so mistakes surface in the first test run.
 */
export function defineOperation<In extends AnyZodObject, Out extends z.ZodType>(
  definition: OperationDefinition<In, Out>,
): OperationDefinition<In, Out> {
  const { id } = definition;
  if (!OPERATION_ID.test(id)) {
    throw new Error(`defineOperation: id "${id}" must be dotted snake_case, e.g. "leads.import"`);
  }
  for (const key of Object.keys(definition.input.shape)) {
    if ((RESERVED_INPUT_FIELDS as readonly string[]).includes(key)) {
      throw new Error(
        `defineOperation(${id}): input field "${key}" is added by the executor; read ctx.request instead`,
      );
    }
    if (!SNAKE_KEY.test(key)) {
      throw new Error(`defineOperation(${id}): input field "${key}" must be snake_case`);
    }
  }
  if (definition.http && !definition.http.path.startsWith("/v1/")) {
    throw new Error(`defineOperation(${id}): http.path must start with /v1/`);
  }
  const policy: unknown = definition.boundPrincipals;
  if (definition.workspace === "none") {
    if (!(BOUND_PRINCIPAL_POLICIES as readonly unknown[]).includes(policy)) {
      throw new Error(
        `defineOperation(${id}): workspace "none" needs boundPrincipals "refuse" (instance-level work) or "allow" (safe for workspace-bound keys)`,
      );
    }
  } else if (policy !== undefined) {
    throw new Error(
      `defineOperation(${id}): boundPrincipals is only for workspace "none" operations`,
    );
  }
  for (const example of definition.examples) {
    const result = definition.input.safeParse(example.input);
    if (!result.success) {
      throw new Error(
        `defineOperation(${id}): example "${example.title}" is not valid input: ${result.error.message}`,
      );
    }
  }
  return definition;
}

/** Scopes a principal needs to run the operation. */
export function operationScopes(
  operation: Pick<OperationDefinition, "effect" | "scopes">,
): Scope[] {
  return operation.scopes ?? EFFECT_SCOPES[operation.effect];
}

/** CLI words for the operation, e.g. ["leads", "import"]; "campaigns.add_step" -> ["campaigns", "add-step"]. */
export function operationCliPath(operation: Pick<OperationDefinition, "id" | "cli">): string[] {
  const path = operation.cli ?? operation.id.split(".").join(" ");
  return path
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replaceAll("_", "-"));
}

/** MCP tool annotations derived from the effect (spec 9.1). */
export function operationAnnotations(
  operation: Pick<OperationDefinition, "effect" | "idempotent">,
): {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
} {
  const { effect } = operation;
  return {
    readOnlyHint: effect === "read",
    destructiveHint: effect === "destructive" || effect === "send" || effect === "spend",
    idempotentHint: effect === "read" || operation.idempotent,
    openWorldHint: effect === "send" || effect === "spend",
  };
}

// --- Standard shapes -------------------------------------------------------------------------

export const PAGE_LIMIT_DEFAULT = 25;
export const PAGE_LIMIT_MAX = 100;

/** `limit` + `cursor` inputs for list operations: `paginationInput.extend({ status: ... })`. */
export const paginationInput = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(PAGE_LIMIT_MAX)
    .default(PAGE_LIMIT_DEFAULT)
    .describe(`Max items to return (1-${PAGE_LIMIT_MAX}, default ${PAGE_LIMIT_DEFAULT})`),
  cursor: z.string().optional().describe("next_cursor from the previous page"),
});

/** List output: `{ items, next_cursor, has_more }`. */
export function paginated<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    next_cursor: z.string().nullable(),
    has_more: z.boolean(),
  });
}

/** Output of operations that start background work: `{ job_id, status }`. */
export const jobHandleOutput = z.object({
  job_id: z.string(),
  status: z.enum(JOB_STATUSES),
});

/** Output when work waits for a human decision. */
export const awaitingApprovalOutput = z.object({
  status: z.literal("awaiting_approval"),
  approval_id: z.string(),
  summary: z.string(),
});

export const estimatedCostSchema = z.object({
  usd: z.number().nullable().optional(),
  credits: z.number().optional(),
  note: z.string().optional(),
});
export type EstimatedCost = z.infer<typeof estimatedCostSchema>;

/** Dry-run output: `{ dry_run: true, preview, estimated_cost?, warnings[] }`. */
export function dryRunOutput<P extends z.ZodType>(preview: P) {
  return z.object({
    dry_run: z.literal(true),
    preview,
    estimated_cost: estimatedCostSchema.optional(),
    warnings: z.array(z.string()),
  });
}

/** `response_format` input (added by the executor to read operations). */
export const responseFormatInput = z
  .enum(["concise", "detailed"])
  .default("concise")
  .describe("concise = key fields only (default); detailed = every field");

/** Zod shapes of the executor-added fields, for doors building input schemas. */
export const commonInputShape = {
  workspace: z
    .string()
    .optional()
    .describe("Workspace id or slug. Only needed with instance-level keys."),
  reason: z
    .string()
    .max(500)
    .optional()
    .describe("Why you are doing this, in one sentence. Recorded in the audit log."),
  dry_run: z.boolean().optional().describe("Preview without writing, sending or spending."),
  idempotency_key: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Makes retries safe: the same key and input return the first result."),
  response_format: responseFormatInput.optional(),
};

/** Builds the `awaiting_approval` result. */
export function awaitingApproval(approvalId: string, summary: string) {
  return { status: "awaiting_approval" as const, approval_id: approvalId, summary };
}

/** Builds a dry-run result. */
export function dryRun<P>(
  preview: P,
  options: { warnings?: string[]; estimatedCost?: EstimatedCost } = {},
) {
  const result: { dry_run: true; preview: P; warnings: string[]; estimated_cost?: EstimatedCost } =
    {
      dry_run: true,
      preview,
      warnings: options.warnings ?? [],
    };
  if (options.estimatedCost) result.estimated_cost = options.estimatedCost;
  return result;
}

/**
 * Timestamp field for outputs: accepts a Date or ISO string from the handler, outputs an ISO
 * 8601 string (JSON Schema: string/date-time). Use `.nullable()` for optional timestamps.
 */
export function isoDateTime() {
  return z.codec(z.union([z.date(), z.string()]), z.iso.datetime({ offset: true }), {
    decode: (value) => (value instanceof Date ? value : new Date(value)).toISOString(),
    encode: (value) => new Date(value),
  });
}

/** Timestamp field for inputs: ISO 8601 string in, Date out. */
export function dateTimeInput() {
  return z.codec(z.iso.datetime({ offset: true }), z.date(), {
    decode: (value) => new Date(value),
    encode: (value) => value.toISOString(),
  });
}

// --- MCP tools -------------------------------------------------------------------------------

interface ToolBase {
  /** verb_noun snake_case, e.g. "manage_knowledge" (Claude tool names forbid dots). */
  name: string;
  title: string;
  /** 3-4 sentences + when not to use. The MCP builder appends an example input. */
  description: string;
  toolset: Toolset;
}

/**
 * An MCP tool. Either one operation (`operation`) or a composite (`actions`: action -> operation
 * id; the tool gets an `action` enum and the safety gate runs per underlying operation).
 */
export type ToolDefinition =
  | (ToolBase & { operation: string; actions?: never })
  | (ToolBase & { actions: Record<string, string>; operation?: never });

export function defineTool<T extends ToolDefinition>(tool: T): T {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name)) {
    throw new Error(`defineTool: name "${tool.name}" must be snake_case (max 64 chars)`);
  }
  if (!(TOOLSETS as readonly string[]).includes(tool.toolset)) {
    throw new Error(`defineTool(${tool.name}): unknown toolset "${tool.toolset}"`);
  }
  if (tool.actions) {
    const actions = Object.keys(tool.actions);
    if (actions.length === 0) throw new Error(`defineTool(${tool.name}): actions is empty`);
    for (const action of actions) {
      if (!SNAKE_KEY.test(action)) {
        throw new Error(`defineTool(${tool.name}): action "${action}" must be snake_case`);
      }
    }
  } else if (!tool.operation) {
    throw new Error(`defineTool(${tool.name}): set operation or actions`);
  }
  return tool;
}

/** Operation ids a tool exposes. */
export function toolOperationIds(tool: ToolDefinition): string[] {
  return tool.actions ? Object.values(tool.actions) : [tool.operation];
}

// --- Jobs ------------------------------------------------------------------------------------

export type BackoffSpec =
  | { type: "fixed"; delayMs: number }
  | { type: "exponential"; baseMs: number; maxMs?: number };

export const DEFAULT_JOB_MAX_ATTEMPTS = 5;
export const DEFAULT_JOB_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_JOB_BACKOFF: BackoffSpec = {
  type: "exponential",
  baseMs: 30_000,
  maxMs: 3_600_000,
};

/**
 * A background job type. Handlers get a JobContext (system principal) and must be idempotent:
 * a job can run more than once (retries, lease expiry). Throw `JobWaitError` to park the job.
 * The return value is stored in jobs.result and shown by `jobs.get`.
 */
export interface JobDefinition<P = unknown> {
  /** Dotted, e.g. "research.run". */
  name: string;
  /** Validates the payload before the handler runs (recommended). */
  payload?: z.ZodType<P>;
  handler(ctx: JobContext, payload: P): Promise<unknown>;
  /** Default 5. */
  maxAttempts?: number;
  /** Delay between failed attempts. Default exponential from 30s, max 1h. */
  backoff?: BackoffSpec;
  /** The job's signal aborts after this. Default 5 minutes. */
  timeoutMs?: number;
}

export function defineJob<P>(definition: JobDefinition<P>): JobDefinition<P> {
  if (!OPERATION_ID.test(definition.name)) {
    throw new Error(
      `defineJob: name "${definition.name}" must be dotted snake_case, e.g. "research.run"`,
    );
  }
  return definition;
}

/** Delay before retry number `attempt` (1-based count of failures so far), with 20% jitter. */
export function backoffDelayMs(
  backoff: BackoffSpec,
  attempt: number,
  random = Math.random,
): number {
  const base =
    backoff.type === "fixed"
      ? backoff.delayMs
      : Math.min(
          backoff.baseMs * 2 ** Math.max(0, attempt - 1),
          backoff.maxMs ?? Number.POSITIVE_INFINITY,
        );
  return Math.round(base * (0.8 + random() * 0.4));
}

/**
 * A recurring job registered by a module. `perWorkspace: true` enqueues one job per active
 * workspace (payload gets `workspace_id`); false enqueues one instance-wide job.
 */
export interface BuiltinSchedule {
  /** Unique, e.g. "campaigns.sequencer_tick". */
  name: string;
  /** Cron expression (croner syntax, 5 or 6 fields), e.g. "* * * * *". */
  cron: string;
  /** Job name to enqueue. */
  job: string;
  perWorkspace: boolean;
  payload?: Record<string, unknown>;
  /** IANA timezone for the cron. Default "UTC". */
  timezone?: string;
}

// --- Approvals -------------------------------------------------------------------------------

/**
 * Applies decisions for one approval kind (modules register one per kind they request).
 * Called inside the decide operation with the decider's context. Must be idempotent.
 * `edit` means approve with `decision.edits` merged into the payload.
 */
export interface ApprovalResolver {
  kind: ApprovalKind;
  /**
   * Kind `custom`: the payload fields a decider may change with decision `edit` (default none:
   * approve or reject). The engine refuses edits to any other field, so the target a request
   * names never changes. Built-in kinds have their lists in the engine (`approvalEdits`).
   */
  editable?: readonly string[];
  apply(
    ctx: OpContext,
    approval: Approval,
    decision: ApprovalDecision,
  ): Promise<ApprovalApplyResult>;
}

/** What a resolver reports back (all optional; return `{}` when there is nothing to say). */
export interface ApprovalApplyResult {
  /** One line for the decider, e.g. "Email scheduled for 10:32 lead time". */
  message?: string;
  target?: AuditTarget;
  data?: Record<string, unknown>;
}

// --- HTTP routes -----------------------------------------------------------------------------

/**
 * Registers public (non-/v1) routes: unsubscribe pages, OAuth callbacks, inbound webhooks.
 * These routes skip API-key auth, so authenticate them yourself (signed tokens, webhook
 * secrets). Use `deps.engine.systemContext(workspaceId)` to act.
 */
export type HttpRouteRegistrar = (app: Hono, deps: { engine: Engine }) => void;

// --- Modules ---------------------------------------------------------------------------------

/**
 * What a module contributes to the engine. Each `src/modules/<name>/index.ts` exports
 * `module: EngineModule`; `src/modules/index.ts` collects them.
 */
export interface EngineModule {
  name: string;
  operations?: AnyOperation[];
  tools?: ToolDefinition[];
  jobs?: AnyJob[];
  schedules?: BuiltinSchedule[];
  eventHandlers?: AnyEventHandler[];
  approvalResolvers?: ApprovalResolver[];
  httpRoutes?: HttpRouteRegistrar[];
  providers?: ProviderDefinition[];
}

// Registries hold heterogeneous schemas and payloads, so these aliases use `any` on purpose.
// biome-ignore lint/suspicious/noExplicitAny: see above
export type AnyOperation = OperationDefinition<any, any>;
// biome-ignore lint/suspicious/noExplicitAny: see above
export type AnyJob = JobDefinition<any>;
// biome-ignore lint/suspicious/noExplicitAny: see above
export type AnyEventHandler = EventHandlerDefinition<any>;
