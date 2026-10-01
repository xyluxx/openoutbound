/**
 * Records every operation an agent runs through the MCP door. The HTTP server gets a wrapped
 * engine whose `call` notes operation, tool and action, input, dry-run flag, outcome and error
 * code, so assertions see the same record whichever runner drove the session.
 */
import type { CallOptions, Engine } from "../../src/core/engine.js";
import { toOpenOutboundError } from "../../src/core/errors.js";
import { isAwaitingApproval, isDryRun, isJobHandle } from "../../src/mcp/format.js";
import { engineCatalog, toolSpecsFor } from "../../src/mcp/server.js";
import type { OperationCall } from "./types.js";

export interface CallRecorder {
  calls: OperationCall[];
  /** The engine to hand to the HTTP door. */
  engine: Engine;
  reset(): void;
}

/** operation id -> [tool, action] for the tools of every toolset. */
export function toolIndex(
  engine: Pick<Engine, "registry" | "config">,
): Map<string, [string, string | null]> {
  const index = new Map<string, [string, string | null]>();
  for (const spec of toolSpecsFor(engineCatalog(engine), "all", true)) {
    if (spec.actions) {
      for (const [action, operation] of Object.entries(spec.actions)) {
        if (!index.has(operation.id)) index.set(operation.id, [spec.name, action]);
      }
    } else if (spec.operation && !index.has(spec.operation.id)) {
      index.set(spec.operation.id, [spec.name, null]);
    }
  }
  return index;
}

function outcomeOf(output: unknown): OperationCall["outcome"] {
  if (isDryRun(output)) return "dry_run";
  if (isAwaitingApproval(output)) return "awaiting_approval";
  if (isJobHandle(output)) return "job";
  return "ok";
}

function plain(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}

/** Wraps `engine.call` for principals that come in through MCP. */
export function createCallRecorder(engine: Engine): CallRecorder {
  const index = toolIndex(engine);
  const calls: OperationCall[] = [];
  let seq = 0;

  const call = async (operationId: string, input: unknown, options: CallOptions) => {
    if (options.principal.via !== "mcp") return engine.call(operationId, input, options);
    const [tool, action] = index.get(operationId) ?? [null, null];
    const started = Date.now();
    const record: OperationCall = {
      seq: ++seq,
      operation: operationId,
      tool,
      action,
      input: (plain(input) ?? {}) as Record<string, unknown>,
      dry_run: options.dryRun,
      reason: options.reason,
      outcome: "ok",
      error_code: null,
      error_message: null,
      output: null,
      started_at: new Date(started).toISOString(),
      duration_ms: 0,
    };
    calls.push(record);
    try {
      const output = await engine.call(operationId, input, options);
      record.outcome = outcomeOf(output);
      record.output = plain(output);
      return output;
    } catch (error) {
      const normalized = toOpenOutboundError(error);
      record.outcome = "error";
      record.error_code = normalized.code;
      record.error_message = normalized.message;
      throw error;
    } finally {
      record.duration_ms = Date.now() - started;
    }
  };

  return {
    calls,
    engine: { ...engine, call },
    reset() {
      calls.length = 0;
      seq = 0;
    },
  };
}
