import { z } from "zod";
import type { Registry } from "../core/engine.js";
import {
  type AnyOperation,
  type AnyZodObject,
  commonInputShape,
  type EngineModule,
  type ToolDefinition,
} from "../core/operation.js";

/**
 * The operation input schema plus the executor's common fields, following the `Registry`
 * contract: workspace, reason, idempotency_key always; dry_run when dryRun != 'none';
 * response_format for read operations.
 */
export function operationInputSchema(operation: AnyOperation): AnyZodObject {
  const extra: Record<string, z.ZodType> = {
    workspace: commonInputShape.workspace,
    reason: commonInputShape.reason,
    idempotency_key: commonInputShape.idempotency_key,
  };
  if (operation.dryRun === "default") {
    extra.dry_run = z
      .boolean()
      .optional()
      .describe("Preview only. On by default for this operation: pass false to apply it.");
  } else if (operation.dryRun === "supported") {
    extra.dry_run = commonInputShape.dry_run;
  }
  if (operation.effect === "read") extra.response_format = commonInputShape.response_format;
  return operation.input.safeExtend(extra) as AnyZodObject;
}

/**
 * A registry built straight from module definitions, without a database. The CLI uses it to
 * generate commands and help quickly (no engine start), and tests use it for fake engines.
 * The runtime registry (`createEngine`) is built from the same definitions.
 */
export function buildStaticRegistry(modules: readonly EngineModule[]): Registry {
  const operations = new Map<string, AnyOperation>();
  const tools: ToolDefinition[] = [];
  for (const module of modules) {
    for (const operation of module.operations ?? []) {
      if (operations.has(operation.id)) {
        throw new Error(`Duplicate operation id "${operation.id}" (module ${module.name})`);
      }
      operations.set(operation.id, operation);
    }
    tools.push(...(module.tools ?? []));
  }
  const inputSchemas = new Map<string, AnyZodObject>();
  const require = (id: string): AnyOperation => {
    const operation = operations.get(id);
    if (!operation) throw new Error(`Unknown operation "${id}"`);
    return operation;
  };
  return {
    operations: () => [...operations.values()],
    operation: (id) => operations.get(id),
    tools: () => [...tools],
    inputSchema: (id) => {
      let schema = inputSchemas.get(id);
      if (!schema) {
        schema = operationInputSchema(require(id));
        inputSchemas.set(id, schema);
      }
      return schema;
    },
    outputSchema: (id) => require(id).output,
  };
}
