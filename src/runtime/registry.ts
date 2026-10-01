/**
 * Builds the operation/tool/job registry from the engine modules and validates it at startup
 * (unique ids and names, tools pointing at existing operations, schedules pointing at jobs).
 */
import { z } from "zod";
import type { Registry } from "../core/engine.js";
import type { ApprovalKind } from "../core/enums.js";
import { OpenOutboundError } from "../core/errors.js";
import type { EmittedEvent, EventType } from "../core/events.js";
import {
  type AnyEventHandler,
  type AnyJob,
  type AnyOperation,
  type AnyZodObject,
  type ApprovalResolver,
  type BuiltinSchedule,
  commonInputShape,
  type EngineModule,
  type HttpRouteRegistrar,
  type JobDefinition,
  type ToolDefinition,
  toolOperationIds,
} from "../core/operation.js";
import { builtinProviders } from "../providers/all.js";
import { createProviderCatalog, type ProviderCatalog } from "../providers/registry.js";
import type { ProviderDefinition } from "../providers/types.js";

/** Job name that runs one event handler. Colons keep it apart from module job names. */
export function eventJobName(handlerName: string): string {
  return `event:${handlerName}`;
}

/** Payload of an event handler job. */
export interface EventJobPayload {
  event: {
    id: string;
    type: EventType;
    workspace_id: string;
    subject: { type: string; id: string } | null;
    data: unknown;
    occurred_at: string;
  };
}

export interface RuntimeRegistry extends Registry {
  modules(): readonly EngineModule[];
  job(name: string): AnyJob | undefined;
  jobNames(): string[];
  eventHandlers(event: EventType): AnyEventHandler[];
  approvalResolver(kind: ApprovalKind): ApprovalResolver | undefined;
  schedules(): BuiltinSchedule[];
  schedule(name: string): BuiltinSchedule | undefined;
  httpRoutes(): HttpRouteRegistrar[];
  providers(): ProviderCatalog;
}

/** Jobs and schedules the runtime always registers (webhook deliveries, maintenance, ...). */
export interface KernelContributions {
  jobs: AnyJob[];
  schedules: BuiltinSchedule[];
}

function eventHandlerJob(handler: AnyEventHandler): AnyJob {
  const job: JobDefinition<EventJobPayload> = {
    name: eventJobName(handler.name),
    handler: async (ctx, payload) => {
      const raw = payload.event;
      const event: EmittedEvent = {
        id: raw.id,
        type: raw.type,
        workspaceId: raw.workspace_id,
        subject: raw.subject,
        data: raw.data as EmittedEvent["data"],
        occurredAt: new Date(raw.occurred_at),
      };
      await handler.handler(ctx, event);
      return { handled: raw.type };
    },
  };
  if (handler.maxAttempts !== undefined) job.maxAttempts = handler.maxAttempts;
  return job;
}

/**
 * Collects every module contribution. Throws one Error listing every problem found, so a bad
 * module fails the engine start (and the first test run) with a precise message.
 */
export function buildRegistry(
  modules: readonly EngineModule[],
  kernel: KernelContributions = { jobs: [], schedules: [] },
): RuntimeRegistry {
  const problems: string[] = [];
  const operations = new Map<string, AnyOperation>();
  const tools = new Map<string, ToolDefinition>();
  const jobs = new Map<string, AnyJob>();
  const handlers = new Map<string, AnyEventHandler>();
  const resolvers = new Map<ApprovalKind, ApprovalResolver>();
  const schedules = new Map<string, BuiltinSchedule>();
  const routes: HttpRouteRegistrar[] = [];
  const providerDefinitions: ProviderDefinition[] = [...builtinProviders];
  const moduleNames = new Set<string>();
  const httpPaths = new Map<string, string>();

  const addJob = (job: AnyJob, owner: string) => {
    if (jobs.has(job.name)) problems.push(`duplicate job "${job.name}" (${owner})`);
    else jobs.set(job.name, job);
  };

  for (const job of kernel.jobs) addJob(job, "runtime");
  for (const schedule of kernel.schedules) schedules.set(schedule.name, schedule);

  for (const module of modules) {
    if (moduleNames.has(module.name)) problems.push(`duplicate module "${module.name}"`);
    moduleNames.add(module.name);
    for (const op of module.operations ?? []) {
      if (operations.has(op.id)) problems.push(`duplicate operation "${op.id}" (${module.name})`);
      else operations.set(op.id, op);
      if (op.http) {
        const key = `${op.http.method} ${op.http.path}`;
        const other = httpPaths.get(key);
        if (other) problems.push(`operations "${other}" and "${op.id}" share the route ${key}`);
        else httpPaths.set(key, op.id);
      }
    }
    for (const tool of module.tools ?? []) {
      if (tools.has(tool.name)) problems.push(`duplicate tool "${tool.name}" (${module.name})`);
      else tools.set(tool.name, tool);
    }
    for (const job of module.jobs ?? []) addJob(job, module.name);
    for (const handler of module.eventHandlers ?? []) {
      if (handlers.has(handler.name)) {
        problems.push(`duplicate event handler "${handler.name}" (${module.name})`);
        continue;
      }
      handlers.set(handler.name, handler);
      addJob(eventHandlerJob(handler), module.name);
    }
    for (const resolver of module.approvalResolvers ?? []) {
      if (resolvers.has(resolver.kind)) {
        problems.push(`two approval resolvers for kind "${resolver.kind}" (${module.name})`);
      } else resolvers.set(resolver.kind, resolver);
    }
    for (const schedule of module.schedules ?? []) {
      if (schedules.has(schedule.name)) {
        problems.push(`duplicate schedule "${schedule.name}" (${module.name})`);
      } else schedules.set(schedule.name, schedule);
    }
    routes.push(...(module.httpRoutes ?? []));
    providerDefinitions.push(...(module.providers ?? []));
  }

  for (const tool of tools.values()) {
    for (const opId of toolOperationIds(tool)) {
      if (!operations.has(opId)) {
        problems.push(`tool "${tool.name}" references unknown operation "${opId}"`);
      }
    }
  }
  for (const schedule of schedules.values()) {
    if (!jobs.has(schedule.job)) {
      problems.push(`schedule "${schedule.name}" references unknown job "${schedule.job}"`);
    }
  }

  let catalog: ProviderCatalog;
  try {
    catalog = createProviderCatalog(providerDefinitions);
  } catch (error) {
    problems.push((error as Error).message);
    catalog = createProviderCatalog([]);
  }

  if (problems.length > 0) {
    throw new Error(`Invalid engine modules:\n- ${problems.join("\n- ")}`);
  }

  const inputSchemas = new Map<string, AnyZodObject>();
  const requireOperation = (id: string): AnyOperation => {
    const op = operations.get(id);
    if (!op) throw unknownOperation(id, [...operations.keys()]);
    return op;
  };
  const operationList = [...operations.values()];
  const toolList = [...tools.values()];
  const handlerList = [...handlers.values()];

  return {
    operations: () => operationList,
    operation: (id) => operations.get(id),
    tools: () => toolList,
    inputSchema: (id) => {
      const cached = inputSchemas.get(id);
      if (cached) return cached;
      const schema = extendedInputSchema(requireOperation(id));
      inputSchemas.set(id, schema);
      return schema;
    },
    outputSchema: (id) => requireOperation(id).output,
    modules: () => modules,
    job: (name) => jobs.get(name),
    jobNames: () => [...jobs.keys()],
    eventHandlers: (event) => handlerList.filter((handler) => handler.event === event),
    approvalResolver: (kind) => resolvers.get(kind),
    schedules: () => [...schedules.values()],
    schedule: (name) => schedules.get(name),
    httpRoutes: () => routes,
    providers: () => catalog,
  };
}

const DEFAULT_DRY_RUN_DESCRIPTION =
  "Preview without writing, sending or spending. This operation previews by default: pass false to run it for real.";

/** The op input plus the executor's common fields, with descriptions for doors. */
export function extendedInputSchema(op: AnyOperation): AnyZodObject {
  const shape: Record<string, z.ZodType> = {
    workspace: commonInputShape.workspace,
    reason: commonInputShape.reason,
    idempotency_key: commonInputShape.idempotency_key,
  };
  if (op.dryRun === "supported") shape.dry_run = commonInputShape.dry_run;
  if (op.dryRun === "default") {
    shape.dry_run = z.boolean().optional().describe(DEFAULT_DRY_RUN_DESCRIPTION);
  }
  if (op.effect === "read") shape.response_format = commonInputShape.response_format;
  const input = op.input as AnyZodObject & {
    safeExtend(shape: Record<string, z.ZodType>): AnyZodObject;
  };
  return input.safeExtend(shape);
}

export function unknownOperation(id: string, known: string[]): OpenOutboundError {
  const group = id.split(".")[0] ?? "";
  const similar = known.filter((candidate) => candidate.startsWith(`${group}.`)).slice(0, 8);
  return new OpenOutboundError("not_found", `Unknown operation "${id}".`, {
    hint:
      similar.length > 0
        ? `Did you mean one of: ${similar.join(", ")}?`
        : "List operations with `openoutbound --help` or GET /v1/ops.",
    details: { operation: id },
  });
}
