import { McpServer, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type { Principal } from "../core/context.js";
import type { Engine, Registry } from "../core/engine.js";
import type { Logger } from "../core/logger.js";
import { buildCatalog, type Catalog } from "./catalog.js";
import { toolErrorResult } from "./errors.js";
import { renderMarkdown } from "./format.js";
import { mcpInstructions } from "./instructions.js";
import type { JsonSchema } from "./json-schema.js";
import { MCP_PROMPTS } from "./prompts.js";
import {
  buildToolSpecs,
  type McpCallOptions,
  type McpToolSpec,
  prepareCall,
  resolveToolsets,
} from "./tools.js";

/** Runs one operation for a tool call (in-process engine or a bridge to a server). */
export type OperationCaller = (
  operationId: string,
  input: Record<string, unknown>,
  options: McpCallOptions,
  signal: AbortSignal,
) => Promise<unknown>;

export interface CreateMcpServerOptions {
  specs: readonly McpToolSpec[];
  call: OperationCaller;
  version: string;
  /** Workspace used when a call does not name one (`--workspace` / OPENOUTBOUND_WORKSPACE). */
  defaultWorkspace?: string | null;
  /** The workspace the session is bound to, named in the server instructions. */
  boundWorkspace?: string | null;
}

/**
 * An MCP server (name `openoutbound`) with the given tools, the three prompts and the server
 * instructions. Input validation happens per underlying operation in the engine, so tool
 * schemas are advertised as-is and every failure comes back in the OpenOutbound error shape.
 */
export function createMcpServer(options: CreateMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: "openoutbound", title: "OpenOutbound", version: options.version },
    {
      capabilities: { tools: {}, prompts: {} },
      instructions: mcpInstructions(options.boundWorkspace),
    },
  );
  for (const spec of options.specs) {
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: advertisedSchema(spec.inputSchema),
        annotations: { title: spec.title, ...spec.annotations },
      },
      async (args, ctx) => {
        try {
          const prepared = prepareCall(spec, args, options.defaultWorkspace);
          const output = await options.call(
            prepared.operation.id,
            prepared.input,
            prepared.options,
            ctx.mcpReq.signal,
          );
          return toolSuccessResult(output);
        } catch (error) {
          return toolErrorResult(error);
        }
      },
    );
  }
  for (const prompt of MCP_PROMPTS) {
    server.registerPrompt(
      prompt.name,
      { title: prompt.title, description: prompt.description, argsSchema: prompt.args },
      (args) => ({
        description: prompt.description,
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: prompt.text(args as Record<string, string | undefined>),
            },
          },
        ],
      }),
    );
  }
  return server;
}

/** Success result: markdown text for every host, the raw output as structuredContent. */
export function toolSuccessResult(output: unknown) {
  const json = toJsonValue(output);
  const structured =
    json !== null && typeof json === "object" && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : { result: json };
  return {
    content: [{ type: "text" as const, text: renderMarkdown(json) }],
    structuredContent: structured,
  };
}

function toJsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/**
 * Wraps a JSON Schema as a Standard Schema for `registerTool`: the SDK advertises it in
 * `tools/list` and lets every argument through, so the engine validates per operation and
 * returns actionable errors instead of the SDK's generic message.
 */
function advertisedSchema(
  jsonSchema: JsonSchema,
): StandardSchemaWithJSON<Record<string, unknown>, Record<string, unknown>> {
  return {
    "~standard": {
      version: 1,
      vendor: "openoutbound",
      validate: (value: unknown) => ({
        value:
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {},
      }),
      jsonSchema: { input: () => jsonSchema, output: () => jsonSchema },
    },
  };
}

// --- Engine-backed servers -------------------------------------------------------------------

export interface BuildMcpServerOptions {
  /** Toolset names (comma list or array). Default: engine.config.mcpToolsets. */
  toolsets?: string | readonly string[];
  principal: Principal;
  defaultWorkspace?: string | null;
  /** Binds the principal to this workspace for every call (`CallOptions.boundWorkspace`). */
  boundWorkspace?: string | null;
  /** Adds the agent_brain toolset (see `agentBrainInUse`). */
  agentBrain?: boolean;
}

const catalogs = new WeakMap<Registry, Catalog>();
const specCache = new WeakMap<Catalog, Map<string, McpToolSpec[]>>();

/** Catalog of an engine's registry, computed once per registry. */
export function engineCatalog(engine: Pick<Engine, "registry" | "config">): Catalog {
  let catalog = catalogs.get(engine.registry);
  if (!catalog) {
    catalog = buildCatalog(engine.registry, engine.config.version);
    catalogs.set(engine.registry, catalog);
  }
  return catalog;
}

/** Tool specs for a catalog and toolset selection (cached; problems are logged once). */
export function toolSpecsFor(
  catalog: Catalog,
  toolsets: string | readonly string[] | undefined,
  agentBrain: boolean,
  log?: Pick<Logger, "warn">,
): McpToolSpec[] {
  const selected = resolveToolsets(toolsets, { agentBrain });
  const key = [...selected].sort().join(",");
  let byKey = specCache.get(catalog);
  if (!byKey) {
    byKey = new Map();
    specCache.set(catalog, byKey);
  }
  let specs = byKey.get(key);
  if (!specs) {
    const built = buildToolSpecs(catalog, selected);
    for (const problem of built.problems) log?.warn({ component: "mcp" }, problem);
    specs = built.specs;
    byKey.set(key, specs);
  }
  return specs;
}

/**
 * The MCP server for an in-process engine: composite and single-operation tools from the
 * registry filtered by toolset, calls run through `engine.call` as `principal`.
 */
export function buildMcpServer(engine: Engine, options: BuildMcpServerOptions): McpServer {
  const catalog = engineCatalog(engine);
  const specs = toolSpecsFor(
    catalog,
    options.toolsets ?? engine.config.mcpToolsets,
    options.agentBrain ?? false,
    engine.log,
  );
  return createMcpServer({
    specs,
    version: engine.config.version,
    defaultWorkspace: options.defaultWorkspace ?? null,
    boundWorkspace: options.boundWorkspace ?? null,
    call: (operationId, input, callOptions, signal) =>
      engine.call(operationId, input, {
        ...callOptions,
        principal: options.principal,
        ...(options.boundWorkspace ? { boundWorkspace: options.boundWorkspace } : {}),
        signal,
      }),
  });
}
