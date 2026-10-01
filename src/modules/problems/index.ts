import type { EngineModule } from "../../core/operation.js";
import { problemOperations } from "./operations.js";
import { problemTools } from "./tools.js";

/**
 * Problems: the records behind the attention queue (`service.ts`: open, resolve, snooze, get,
 * list), with operations to list, read, resolve and snooze them and the `resolve_exception`
 * MCP tool.
 */
export const module: EngineModule = {
  name: "problems",
  operations: problemOperations,
  tools: problemTools,
};
