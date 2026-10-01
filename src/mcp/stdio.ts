import type { Transport } from "@modelcontextprotocol/server";
import { type StdioServerHandle, serveStdio } from "@modelcontextprotocol/server/stdio";
import type { Principal } from "../core/context.js";
import type { Engine } from "../core/engine.js";
import type { Logger } from "../core/logger.js";
import { createRemoteClient, type RemoteClient } from "../http/client.js";
import { bindPrincipal, workspaceForbidden } from "../runtime/workspace-resolution.js";
import { agentBrainInUse } from "./agent-brain.js";
import { buildMcpServer, createMcpServer, toolSpecsFor } from "./server.js";

export interface EmbeddedStdioOptions {
  toolsets?: string | readonly string[];
  defaultWorkspace?: string | null;
  /** Who the session acts as. Default `local-agent` (OPENOUTBOUND_AGENT_SCOPES). */
  principal?: Principal;
  /**
   * Binds the session's principal to this workspace (id or slug): `openoutbound mcp
   * --workspace`. Calls naming another workspace and instance-level operations are refused.
   */
  boundWorkspace?: string | null;
  /** Custom transport (tests); default: this process's stdin/stdout. */
  transport?: Transport;
}

/**
 * Serves MCP over stdio with the engine in this process, acting as `options.principal` (default
 * `local-agent`), bound to `options.boundWorkspace` when given: every call carries the binding
 * through the executor, and an unknown workspace fails here, before the session starts. The
 * caller owns the engine and its worker.
 */
export async function serveEmbeddedStdio(
  engine: Engine,
  options: EmbeddedStdioOptions = {},
): Promise<StdioServerHandle> {
  const principal = options.principal ?? engine.localPrincipal("agent", "mcp");
  const bound = options.boundWorkspace?.trim() || null;
  if (bound && engine.db) await bindPrincipal(engine.db, principal, bound);
  const agentBrain = await agentBrainInUse(engine.db);
  return serveStdio(
    () =>
      buildMcpServer(engine, {
        principal,
        toolsets: options.toolsets,
        defaultWorkspace: options.defaultWorkspace ?? null,
        boundWorkspace: bound,
        agentBrain,
      }),
    {
      ...(options.transport ? { transport: options.transport } : {}),
      onerror: (error) => engine.log.warn({ component: "mcp", err: error.message }, "mcp error"),
    },
  );
}

export interface BridgeStdioOptions {
  url: string;
  apiKey: string | null;
  toolsets?: string | readonly string[];
  defaultWorkspace?: string | null;
  /**
   * Binds the session to this workspace (id or slug): calls naming another workspace are
   * refused before they leave the process, and the server binds the key's principal too.
   */
  boundWorkspace?: string | null;
  transport?: Transport;
  fetch?: typeof globalThis.fetch;
  log?: Pick<Logger, "warn">;
}

/** The bound workspace's id and slug, asked from the server (the client sends the binding). */
async function bridgeFence(client: RemoteClient): Promise<{ id: string; slug: string }> {
  const found = (await client.call("workspaces.get", {}, {})) as { id?: unknown; slug?: unknown };
  return { id: String(found.id ?? ""), slug: String(found.slug ?? "").toLowerCase() };
}

/**
 * Serves MCP over stdio as a bridge: tools come from the server's catalog (`GET /v1/ops`) and
 * every call is forwarded to `POST /v1/ops/{operation_id}` with the API key. Used when another
 * process owns the database (PGlite) or the engine runs elsewhere.
 */
export async function serveBridgeStdio(options: BridgeStdioOptions): Promise<StdioServerHandle> {
  const bound = options.boundWorkspace?.trim() || null;
  const client = createRemoteClient({
    url: options.url,
    apiKey: options.apiKey,
    ...(bound ? { boundWorkspace: bound } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const catalog = await client.catalog();
  // A call naming another workspace is refused here; the bound workspace's id and slug are asked
  // once, the first time a call names it differently than the binding does.
  let fence: { id: string; slug: string } | null = null;
  const sameWorkspace = async (named: string): Promise<boolean> => {
    if (!bound || named.toLowerCase() === bound.toLowerCase()) return true;
    fence ??= await bridgeFence(client);
    return named === fence.id || named.toLowerCase() === fence.slug;
  };
  const specs = toolSpecsFor(catalog, options.toolsets, catalog.agent_brain === true, options.log);
  return serveStdio(
    () =>
      createMcpServer({
        specs,
        version: catalog.version,
        defaultWorkspace: options.defaultWorkspace ?? null,
        boundWorkspace: bound,
        call: async (operationId, input, callOptions, signal) => {
          const named = callOptions.workspace?.trim();
          if (named && !(await sameWorkspace(named))) {
            throw workspaceForbidden(fence?.slug || bound);
          }
          return client.call(operationId, input, { ...callOptions, signal });
        },
      }),
    {
      ...(options.transport ? { transport: options.transport } : {}),
      onerror: (error) => options.log?.warn({ component: "mcp", err: error.message }, "mcp error"),
    },
  );
}
