/**
 * A small in-memory Engine for door tests (CLI, HTTP, MCP). It implements the `Engine` contract
 * with a handful of demo operations of every effect, one composite tool and a fake executor.
 * Every permission check is the real executor's (common fields, session binding, workspace
 * resolution and fence, the workspace: none policy, scopes, the dry-run flag, the paused
 * check) over in-memory workspaces; only storage, idempotency and input messages are its own.
 * Permission behavior across doors is asserted in permission-parity.test.ts on the real engine.
 */
import { z } from "zod";
import { buildStaticRegistry } from "../../src/cli/static-registry.js";
import { loadConfig } from "../../src/core/config.js";
import { ALL_SCOPES, type OpContext, type Principal } from "../../src/core/context.js";
import type { CallOptions, Engine } from "../../src/core/engine.js";
import type { Via } from "../../src/core/enums.js";
import { notFound, OpenOutboundError } from "../../src/core/errors.js";
import { silentLogger } from "../../src/core/logger.js";
import {
  type AnyOperation,
  awaitingApproval,
  awaitingApprovalOutput,
  defineOperation,
  defineTool,
  dryRun,
  dryRunOutput,
  type EngineModule,
  isoDateTime,
  jobHandleOutput,
  paginated,
  paginationInput,
} from "../../src/core/operation.js";
import {
  assertScopes,
  dryRunFlag,
  splitCommonFields,
  workspaceNotActive,
} from "../../src/runtime/executor.js";
import {
  assertWorkspacePolicy,
  bindPrincipal,
  resolveWorkspace,
  type WorkspaceLookup,
} from "../../src/runtime/workspace-resolution.js";

export interface DemoItem {
  id: string;
  name: string;
  status: "open" | "done";
  score: number;
  tags: string[];
  created_at: Date;
}

interface Store {
  items: DemoItem[];
  sent: string[];
}

const itemOutput = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["open", "done"]),
  score: z.number(),
  tags: z.array(z.string()),
  created_at: isoDateTime(),
});

function storeOf(ctx: OpContext): Store {
  return (ctx as unknown as { store: Store }).store;
}

const listItems = defineOperation({
  id: "demo.list_items",
  summary: "List demo items",
  description:
    "Lists demo items with filters. Use it to browse. Do not use it to fetch one item (use demo.get_item). Results paginate.",
  effect: "read",
  input: paginationInput.extend({
    status: z.enum(["open", "done"]).optional().describe("Only items with this status"),
    tags: z.array(z.string()).optional().describe("Items having all of these tags"),
    min_score: z.number().int().optional().describe("Minimum score"),
  }),
  output: paginated(itemOutput),
  http: { method: "GET", path: "/v1/demo/items" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Open items", input: { status: "open", limit: 10 } }],
  handler: async (ctx, input) => {
    const all = storeOf(ctx).items.filter(
      (item) =>
        (!input.status || item.status === input.status) &&
        (!input.tags || input.tags.every((tag) => item.tags.includes(tag))) &&
        (input.min_score === undefined || item.score >= input.min_score),
    );
    const start = input.cursor ? Number(input.cursor) : 0;
    const page = all.slice(start, start + input.limit);
    const next = start + input.limit < all.length ? String(start + input.limit) : null;
    return { items: page, next_cursor: next, has_more: next !== null };
  },
});

const getItem = defineOperation({
  id: "demo.get_item",
  summary: "Get one demo item",
  description: "Returns one item by id.",
  effect: "read",
  input: z.object({ item_id: z.string().min(1).describe("Item id") }),
  output: itemOutput,
  http: { method: "GET", path: "/v1/demo/items/:item_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "One item", input: { item_id: "it_1" } }],
  handler: async (ctx, input) => {
    const item = storeOf(ctx).items.find((candidate) => candidate.id === input.item_id);
    if (!item) throw notFound("Item", input.item_id);
    return item;
  },
});

const createItem = defineOperation({
  id: "demo.create_item",
  summary: "Create a demo item",
  description: "Creates an item. Supports dry runs.",
  effect: "write",
  input: z.object({
    name: z.string().min(1).describe("Item name"),
    tags: z.array(z.string()).default([]).describe("Tags"),
    score: z.number().int().min(0).max(100).optional().describe("Score 0-100"),
    urgent: z.boolean().optional().describe("Mark as urgent"),
    meta: z.record(z.string(), z.unknown()).optional().describe("Free-form metadata"),
    note: z.string().nullable().optional().describe("Note (null clears it)"),
  }),
  output: z.union([itemOutput, dryRunOutput(z.object({ name: z.string() }))]),
  http: { method: "POST", path: "/v1/demo/items" },
  dryRun: "supported",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "New item", input: { name: "Alpha", tags: ["a"] } }],
  handler: async (ctx, input) => {
    if (ctx.request.dryRun) return dryRun({ name: input.name }, { warnings: ["demo warning"] });
    const store = storeOf(ctx);
    const item: DemoItem = {
      id: `it_${store.items.length + 1}`,
      name: input.name,
      status: "open",
      score: input.score ?? 0,
      tags: input.tags,
      created_at: new Date("2026-09-19T12:00:00Z"),
    };
    store.items.push(item);
    return item;
  },
});

const sendItem = defineOperation({
  id: "demo.send_item",
  summary: "Send a demo item",
  description: "Sends an item. Dry run by default; big items need approval.",
  effect: "send",
  input: z.object({ item_id: z.string().min(1) }),
  output: z.union([
    z.object({ sent: z.boolean(), item_id: z.string() }),
    dryRunOutput(z.object({ item_id: z.string() })),
    awaitingApprovalOutput,
  ]),
  http: { method: "POST", path: "/v1/demo/items/:item_id/send" },
  dryRun: "default",
  idempotent: false,
  workspace: "required",
  examples: [{ title: "Send", input: { item_id: "it_1" } }],
  handler: async (ctx, input) => {
    if (ctx.request.dryRun) return dryRun({ item_id: input.item_id });
    if (input.item_id === "it_big") return awaitingApproval("apr_1", "Send the big item");
    storeOf(ctx).sent.push(input.item_id);
    return { sent: true, item_id: input.item_id };
  },
});

const startJob = defineOperation({
  id: "demo.start_job",
  summary: "Start a demo job",
  description: "Starts background work and returns a job handle.",
  effect: "spend",
  input: z.object({ size: z.number().int().min(1).default(1) }),
  output: jobHandleOutput,
  dryRun: "none",
  idempotent: false,
  workspace: "required",
  examples: [],
  handler: async () => ({ job_id: "job_1", status: "queued" as const }),
});

const deleteItem = defineOperation({
  id: "demo.delete_item",
  summary: "Delete a demo item",
  description: "Deletes an item.",
  effect: "destructive",
  input: z.object({ item_id: z.string().min(1) }),
  output: z.object({ deleted: z.boolean() }),
  http: { method: "DELETE", path: "/v1/demo/items/:item_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [],
  handler: async (ctx, input) => {
    const store = storeOf(ctx);
    const before = store.items.length;
    store.items = store.items.filter((item) => item.id !== input.item_id);
    return { deleted: store.items.length < before };
  },
});

const ping = defineOperation({
  id: "admin.ping",
  summary: "Ping the engine",
  description: "Admin-only health check.",
  effect: "admin",
  input: z.object({}),
  output: z.object({ pong: z.boolean(), workspace: z.string().nullable() }),
  dryRun: "none",
  idempotent: true,
  workspace: "optional",
  examples: [{ title: "Ping", input: {} }],
  handler: async (ctx) => ({ pong: true, workspace: ctx.workspace?.slug ?? null }),
});

export const demoModule: EngineModule = {
  name: "demo",
  operations: [listItems, getItem, createItem, sendItem, startJob, deleteItem, ping],
  tools: [
    defineTool({
      name: "manage_items",
      title: "Items",
      description: "Browse and edit demo items.",
      toolset: "core",
      actions: {
        list: "demo.list_items",
        get: "demo.get_item",
        create: "demo.create_item",
        delete: "demo.delete_item",
      },
    }),
    defineTool({
      name: "send_item",
      title: "Send item",
      description: "Sends one item.",
      toolset: "campaigns",
      operation: "demo.send_item",
    }),
    defineTool({
      name: "run_job",
      title: "Run job",
      description: "Starts a job.",
      toolset: "agent_brain",
      operation: "demo.start_job",
    }),
    defineTool({
      name: "ping",
      title: "Ping",
      description: "Admin ping.",
      toolset: "admin",
      operation: "admin.ping",
    }),
  ],
  httpRoutes: [(app) => app.get("/demo/ping", (c) => c.text("pong"))],
};

/**
 * `workspaces.get` over the fake workspaces, for tests that need it next to the demo module: a
 * bridge bound to a workspace asks it once to learn the workspace's id and slug.
 */
export const fakeWorkspacesModule: EngineModule = {
  name: "workspaces",
  operations: [
    defineOperation({
      id: "workspaces.get",
      summary: "Get the workspace",
      description: "Returns the id and slug of the workspace the call acts on.",
      effect: "read",
      input: z.object({}),
      output: z.object({ id: z.string(), slug: z.string() }),
      dryRun: "none",
      idempotent: true,
      workspace: "required",
      examples: [{ title: "Current workspace", input: {} }],
      handler: async (ctx) => ({ id: ctx.workspace?.id ?? "", slug: ctx.workspace?.slug ?? "" }),
    }),
  ],
};

export interface FakeWorkspace {
  id: string;
  slug: string;
  status?: "active" | "paused";
}

type LookedUp = FakeWorkspace & { is_sandbox: boolean; status: "active" | "paused" };

/** The real workspace rules read fake workspaces through this lookup. */
function fakeLookup(workspaces: readonly FakeWorkspace[]): WorkspaceLookup<LookedUp> {
  const all = workspaces.map((ws) => ({ ...ws, is_sandbox: false, status: ws.status ?? "active" }));
  return {
    find: async (ref) => {
      const value = ref.trim();
      return all.find((ws) => ws.id === value || ws.slug === value.toLowerCase()) ?? null;
    },
    candidates: async () => all,
  };
}

export interface RecordedCall {
  operationId: string;
  input: unknown;
  options: CallOptions;
}

export interface FakeEngine extends Engine {
  calls: RecordedCall[];
  store: Store;
  workerRunning: boolean;
  closed: boolean;
}

export interface FakeEngineOptions {
  /** API key -> principal (via is set by authenticate). */
  keys?: Record<string, Omit<Principal, "via">>;
  workspaces?: FakeWorkspace[];
  modules?: EngineModule[];
  env?: Record<string, string>;
  /** Base directory for config paths (stateDir = <cwd>/.openoutbound). */
  cwd?: string;
}

export const DEFAULT_WORKSPACES: FakeWorkspace[] = [
  { id: "ws_1", slug: "acme" },
  { id: "ws_2", slug: "globex" },
];

/** Keys every test can use. */
export const TEST_KEYS = {
  admin: "oo_admin_key_000000000000000000000000000000000",
  agent: "oo_agent_key_000000000000000000000000000000000",
  reader: "oo_reader_key_00000000000000000000000000000000",
  scoped: "oo_scoped_key_00000000000000000000000000000000",
};

const defaultKeys: Record<string, Omit<Principal, "via">> = {
  [TEST_KEYS.admin]: {
    type: "human",
    id: "key_admin",
    name: "Admin",
    scopes: [...ALL_SCOPES],
    workspaceId: null,
  },
  [TEST_KEYS.agent]: {
    type: "agent",
    id: "key_agent",
    name: "Agent",
    scopes: ["read", "write", "send", "spend"],
    workspaceId: null,
  },
  [TEST_KEYS.reader]: {
    type: "service",
    id: "key_reader",
    name: "Reader",
    scopes: ["read"],
    workspaceId: null,
  },
  [TEST_KEYS.scoped]: {
    type: "agent",
    id: "key_scoped",
    name: "Acme agent",
    scopes: ["read", "write"],
    workspaceId: "ws_1",
  },
};

export function createFakeEngine(options: FakeEngineOptions = {}): FakeEngine {
  const modules = options.modules ?? [demoModule];
  const registry = buildStaticRegistry(modules);
  const workspaces = options.workspaces ?? DEFAULT_WORKSPACES;
  const keys = options.keys ?? defaultKeys;
  const config = loadConfig(
    { DATABASE_URL: "memory://", ...options.env },
    { envFile: false, ...(options.cwd ? { cwd: options.cwd } : {}) },
  );
  const idempotency = new Map<string, { hash: string; output: unknown }>();
  const store: Store = {
    items: [
      {
        id: "it_1",
        name: "Alpha",
        status: "open",
        score: 10,
        tags: ["a"],
        created_at: new Date("2026-09-19T12:00:00Z"),
      },
      {
        id: "it_2",
        name: "Beta",
        status: "done",
        score: 70,
        tags: ["a", "b"],
        created_at: new Date("2026-09-19T12:00:00Z"),
      },
    ],
    sent: [],
  };

  const engine: FakeEngine = {
    config,
    db: undefined as unknown as Engine["db"],
    log: silentLogger(),
    registry,
    calls: [],
    store,
    workerRunning: false,
    closed: false,
    async call(operationId, rawInput, callOptions) {
      engine.calls.push({ operationId, input: rawInput, options: callOptions });
      const operation = registry.operation(operationId);
      if (!operation) {
        throw new OpenOutboundError("not_found", `Unknown operation ${operationId}.`, {
          hint: "List operations with GET /v1/ops or `openoutbound --help`.",
        });
      }
      // The real executor's checks, in its order.
      const { fields, rest: input } = splitCommonFields(operation, rawInput);
      const lookup = fakeLookup(workspaces);
      let principal = callOptions.principal;
      if (callOptions.boundWorkspace?.trim()) {
        principal = await bindPrincipal(lookup, principal, callOptions.boundWorkspace);
      }
      const workspace = await resolveWorkspace(
        lookup,
        operation.workspace,
        principal,
        callOptions.workspace ?? fields.workspace ?? null,
      );
      assertWorkspacePolicy(operation, principal);
      assertScopes(operation, principal);
      const parsed = operation.input.safeParse(input);
      if (!parsed.success) {
        const issues = (parsed.error as z.ZodError).issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
        }));
        throw new OpenOutboundError(
          "validation_failed",
          `Invalid input. ${issues.map((issue: { path: string; message: string }) => `${issue.path}: ${issue.message}`).join("; ")}`,
          { hint: "Fix the listed fields and try again.", details: { issues } },
        );
      }
      const dryRun = dryRunFlag(operation, callOptions.dryRun ?? fields.dry_run ?? undefined);
      if (operation.effect === "send" && workspace && workspace.status !== "active") {
        throw workspaceNotActive(workspace);
      }
      const idempotencyKey = callOptions.idempotencyKey ?? fields.idempotency_key ?? undefined;
      const hash = JSON.stringify([operationId, parsed.data, dryRun]);
      const scopeKey = `${workspace?.id ?? "instance"}:${idempotencyKey}`;
      if (idempotencyKey) {
        const previous = idempotency.get(scopeKey);
        if (previous && previous.hash !== hash) {
          throw new OpenOutboundError(
            "idempotency_mismatch",
            "This idempotency key was used with a different request.",
            { hint: "Use a new idempotency_key for a different request." },
          );
        }
        if (previous) return previous.output;
      }
      const ctx = {
        store,
        workspace: workspace ? { ...workspace, name: workspace.slug } : null,
        principal,
        config,
        request: {
          dryRun,
          reason: callOptions.reason,
          idempotencyKey,
          responseFormat: callOptions.responseFormat ?? "concise",
        },
      } as unknown as OpContext;
      const output = (operation as AnyOperation).output.parse(
        await operation.handler(ctx, parsed.data),
      );
      if (idempotencyKey) idempotency.set(scopeKey, { hash, output });
      return output;
    },
    async authenticate(apiKey, via) {
      const principal = keys[apiKey];
      return principal ? { ...principal, via } : null;
    },
    localPrincipal(kind, via: Via): Principal {
      return kind === "admin"
        ? {
            type: "human",
            id: "local-admin",
            name: "Local admin",
            scopes: [...ALL_SCOPES],
            workspaceId: null,
            via,
          }
        : {
            type: "agent",
            id: "local-agent",
            name: "Local agent",
            scopes: [...config.agentScopes],
            workspaceId: null,
            via,
          };
    },
    async systemContext() {
      throw new Error("systemContext is not available in the fake engine");
    },
    httpRoutes: () => modules.flatMap((module) => module.httpRoutes ?? []),
    async startWorker() {
      engine.workerRunning = true;
    },
    async stopWorker() {
      engine.workerRunning = false;
    },
    async close() {
      engine.closed = true;
      engine.workerRunning = false;
    },
  };
  return engine;
}
