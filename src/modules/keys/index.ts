import type { EngineModule } from "../../core/operation.js";
import { createKey, listKeys, revokeKey } from "./operations.js";

/** API keys: CLI and REST only (no MCP tool, so agents cannot mint keys for themselves). */
export const module: EngineModule = {
  name: "keys",
  operations: [createKey, listKeys, revokeKey],
};
