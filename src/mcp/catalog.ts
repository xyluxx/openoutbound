import type { Registry } from "../core/engine.js";
import type { Effect, Scope, Toolset } from "../core/enums.js";
import {
  type DryRunMode,
  type HttpSpec,
  operationCliPath,
  operationScopes,
  type WorkspaceMode,
} from "../core/operation.js";
import { type JsonSchema, toJsonSchema } from "./json-schema.js";

/** One operation as the doors describe it (JSON only, so it can travel over HTTP). */
export interface OperationInfo {
  id: string;
  summary: string;
  description: string;
  effect: Effect;
  scopes: Scope[];
  idempotent: boolean;
  dry_run: DryRunMode;
  workspace: WorkspaceMode;
  http: HttpSpec | null;
  /** CLI words, e.g. ["leads", "import"]. */
  cli: string[];
  /** Input JSON Schema including the executor's common fields. */
  input_schema: JsonSchema;
  examples: Array<{ title: string; input: unknown }>;
}

/** One MCP tool definition (composite `actions` or single `operation`). */
export interface ToolInfo {
  name: string;
  title: string;
  description: string;
  toolset: Toolset;
  actions: Record<string, string> | null;
  operation: string | null;
}

/**
 * The registry as data: what `GET /v1/ops` returns and what MCP bridge mode builds its tools
 * from, so a bridge always matches the server it talks to.
 */
export interface Catalog {
  version: string;
  operations: OperationInfo[];
  tools: ToolInfo[];
}

/** Snapshot of a registry. Operations sorted by id; tools keep registration order. */
export function buildCatalog(registry: Registry, version: string): Catalog {
  const operations = registry
    .operations()
    .map(
      (operation): OperationInfo => ({
        id: operation.id,
        summary: operation.summary,
        description: operation.description,
        effect: operation.effect,
        scopes: operationScopes(operation),
        idempotent: operation.idempotent,
        dry_run: operation.dryRun,
        workspace: operation.workspace,
        http: operation.http ?? null,
        cli: operationCliPath(operation),
        input_schema: toJsonSchema(registry.inputSchema(operation.id), "input"),
        examples: operation.examples.map((example: { title: string; input: unknown }) => ({
          title: example.title,
          input: example.input,
        })),
      }),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const tools = registry.tools().map(
    (tool): ToolInfo => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      toolset: tool.toolset,
      actions: tool.actions ? { ...tool.actions } : null,
      operation: tool.operation ?? null,
    }),
  );
  return { version, operations, tools };
}

/** Operation ids a tool exposes. */
export function toolInfoOperationIds(tool: ToolInfo): string[] {
  if (tool.actions) return Object.values(tool.actions);
  return tool.operation ? [tool.operation] : [];
}
