import { createMcpHandler } from "@modelcontextprotocol/server";
import type { Principal } from "../core/context.js";
import type { Engine } from "../core/engine.js";
import { agentBrainInUse } from "./agent-brain.js";
import { buildMcpServer } from "./server.js";

export const MCP_MAX_BODY_BYTES = 10 * 1024 * 1024;
const AGENT_BRAIN_TTL_MS = 30_000;

export interface McpRequestContext {
  principal: Principal;
  /** Toolsets for this request (`?toolsets=`), else the engine default. */
  toolsets?: string | null;
  /** Default workspace for calls (`OpenOutbound-Workspace` header). */
  workspace?: string | null;
  /** Binds the principal to this workspace for every call (`OpenOutbound-Bind-Workspace`). */
  boundWorkspace?: string | null;
}

export interface McpHttpHandler {
  fetch(request: Request, context: McpRequestContext): Promise<Response>;
  close(): Promise<void>;
}

/**
 * Streamable HTTP MCP endpoint (stateless, 2025-era clients served by the stateless legacy
 * fallback). Authentication happens before this handler; the principal travels in `authInfo`.
 */
export function createMcpHttpHandler(engine: Engine): McpHttpHandler {
  let agentBrain: { value: boolean; at: number } | null = null;
  const agentBrainNow = async (): Promise<boolean> => {
    const now = Date.now();
    if (!agentBrain || now - agentBrain.at > AGENT_BRAIN_TTL_MS) {
      agentBrain = { value: await agentBrainInUse(engine.db), at: now };
    }
    return agentBrain.value;
  };
  const handler = createMcpHandler(
    async (ctx) => {
      const extra = (ctx.authInfo?.extra ?? {}) as Partial<McpRequestContext>;
      if (!extra.principal) throw new Error("MCP request reached the handler without a principal");
      return buildMcpServer(engine, {
        principal: extra.principal,
        toolsets: extra.toolsets ?? undefined,
        defaultWorkspace: extra.workspace ?? null,
        boundWorkspace: extra.boundWorkspace ?? null,
        agentBrain: await agentBrainNow(),
      });
    },
    {
      legacy: "stateless",
      maxRequestBodySize: MCP_MAX_BODY_BYTES,
      onerror: (error) => engine.log.warn({ component: "mcp", err: error.message }, "mcp error"),
    },
  );
  return {
    fetch: (request, context) =>
      handler.fetch(request, {
        authInfo: {
          token: "",
          clientId: context.principal.id,
          scopes: [...context.principal.scopes],
          extra: { ...context },
        },
      }),
    close: () => handler.close(),
  };
}
