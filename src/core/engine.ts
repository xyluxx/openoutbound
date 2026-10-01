/**
 * Engine contract (types only). The runtime implements `createEngine`; the doors (CLI, HTTP,
 * MCP) consume `Engine`. Nothing here has behavior.
 */
import type { z } from "zod";
import type { Db } from "../db/client.js";
import type { EngineConfig } from "./config.js";
import type { OpContext, Principal } from "./context.js";
import type { Via } from "./enums.js";
import type { Logger } from "./logger.js";
import type {
  AnyOperation,
  AnyZodObject,
  EngineModule,
  HttpRouteRegistrar,
  ToolDefinition,
} from "./operation.js";

/** Per-call options a door passes to `Engine.call`. */
export interface CallOptions {
  /** Resolved by the door: API key -> principal, or a local principal. */
  principal: Principal;
  /** Workspace id or slug; falls back to principal.workspaceId. */
  workspace?: string | null;
  /**
   * Binds the principal to this workspace (id or slug) for the call, the way an `openoutbound
   * mcp --workspace` session does: other workspaces are refused and instance-level operations
   * follow their `boundPrincipals` policy. It only ever narrows: a principal already bound to
   * another workspace is refused.
   */
  boundWorkspace?: string | null;
  idempotencyKey?: string;
  dryRun?: boolean;
  reason?: string;
  responseFormat?: "concise" | "detailed";
  signal?: AbortSignal;
}

/** Everything the modules registered. */
export interface Registry {
  operations(): AnyOperation[];
  operation(id: string): AnyOperation | undefined;
  /** MCP tools (defineTool results), in registration order. */
  tools(): ToolDefinition[];
  /**
   * The operation's input schema extended with the executor's common fields: workspace, reason,
   * dry_run (only when dryRun != 'none'), idempotency_key, response_format (read ops). Doors use
   * it for MCP inputSchema, CLI flags and OpenAPI.
   */
  inputSchema(operationId: string): AnyZodObject;
  /** Output schema of the operation (for MCP outputSchema and OpenAPI responses). */
  outputSchema(operationId: string): z.ZodType;
}

export interface Engine {
  config: EngineConfig;
  db: Db;
  log: Logger;
  registry: Registry;
  /**
   * Runs one operation through the full safety gate (spec section 6). Common fields may arrive
   * inside `input` (workspace, reason, dry_run, idempotency_key, response_format); the executor
   * strips them, and explicit CallOptions values win. Throws OpenOutboundError. Returns the
   * operation output (or the standard awaiting_approval / dry-run / job-handle shapes).
   */
  call(operationId: string, input: unknown, options: CallOptions): Promise<unknown>;
  /** Plain-text API key -> principal, or null if unknown, revoked or expired. Updates last_used_at. */
  authenticate(apiKey: string, via: Via): Promise<Principal | null>;
  /** `local-admin` (all scopes) for the in-process CLI; `local-agent` (config.agentScopes) for embedded stdio MCP. */
  localPrincipal(kind: "admin" | "agent", via: Via): Principal;
  /** OpContext acting as the system principal: module HTTP routes, maintenance, scripts. */
  systemContext(workspaceId: string | null): Promise<OpContext>;
  /** Module HTTP routes (EngineModule.httpRoutes), mounted by the HTTP door. */
  httpRoutes(): HttpRouteRegistrar[];
  startWorker(options?: { concurrency?: number }): Promise<void>;
  stopWorker(): Promise<void>;
  close(): Promise<void>;
}

export interface CreateEngineOptions {
  /** Overrides on top of `loadConfig()`. */
  config?: Partial<EngineConfig>;
  /** Default: every built-in module (`src/modules/index.ts`). */
  modules?: EngineModule[];
  /** Apply pending migrations on start. Default true. */
  autoMigrate?: boolean;
  /** Start the worker (jobs + scheduler) right away. Default false. */
  worker?: boolean;
}

export type CreateEngine = (options?: CreateEngineOptions) => Promise<Engine>;
