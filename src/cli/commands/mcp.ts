import type { StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { Principal } from "../../core/context.js";
import { OpenOutboundError } from "../../core/errors.js";
import { resolveToolsets } from "../../mcp/tools.js";
import { type CliContext, resolveBridge } from "../context.js";
import { waitForShutdown } from "./long-running.js";

export interface McpOptions {
  url?: string;
  apiKey?: string;
  workspace?: string;
  toolsets?: string;
}

/** Printed when OPENOUTBOUND_API_KEY is set but the session runs as the local agent. */
const ENV_KEY_NOTE =
  "openoutbound mcp: OPENOUTBOUND_API_KEY is only used with --url (or OPENOUTBOUND_URL); running as the local agent. Pass --api-key to run as that key.\n";

/**
 * `openoutbound mcp`: stdio MCP server. Bridge mode with --url (or OPENOUTBOUND_URL), or when a
 * local server owns the PGlite database; otherwise embedded: the engine and its worker run in
 * this process for the session. Without --url it acts as `local-agent`, or as the key given
 * with --api-key, whether or not a local server runs: OPENOUTBOUND_API_KEY counts only with
 * --url, so an agent session never acts as the key a person keeps in `.env`.
 * `--workspace` binds the session to that workspace (other workspaces and instance-level
 * operations are refused); OPENOUTBOUND_WORKSPACE is only a default. stdout carries MCP only.
 */
export async function runMcp(ctx: CliContext, options: McpOptions): Promise<number> {
  const config = ctx.config();
  const toolsets = options.toolsets ?? config.mcpToolsets;
  resolveToolsets(toolsets);
  const bound = options.workspace?.trim() || null;
  const defaultWorkspace = bound ?? (config.env.OPENOUTBOUND_WORKSPACE?.trim() || null);
  const transport = ctx.deps.mcpTransport ? { transport: ctx.deps.mcpTransport } : {};
  const bridge = await resolveBridge(ctx, { url: options.url, apiKey: options.apiKey }, "agent");
  const { serveBridgeStdio, serveEmbeddedStdio } = await import("../../mcp/stdio.js");
  const boundNote = bound ? `, bound to workspace ${bound}` : "";

  let handle: StdioServerHandle;
  if (bridge) {
    handle = await serveBridgeStdio({
      url: bridge.client.url,
      apiKey: bridge.apiKey,
      toolsets,
      defaultWorkspace,
      boundWorkspace: bound,
      fetch: ctx.fetch,
      ...transport,
    });
    if (bridge.envKeyIgnored) ctx.io.stderr(ENV_KEY_NOTE);
    ctx.io.stderr(`openoutbound mcp: bridge mode to ${bridge.client.url}${boundNote}\n`);
    try {
      await waitForShutdown(ctx, "mcp");
    } finally {
      await handle.close();
    }
    return 0;
  }

  const engine = await ctx.createEngine({ worker: false });
  try {
    let principal: Principal = engine.localPrincipal("agent", "mcp");
    if (options.apiKey) {
      const authenticated = await engine.authenticate(options.apiKey, "mcp");
      if (!authenticated) {
        throw new OpenOutboundError(
          "unauthorized",
          "The API key passed with --api-key is unknown, revoked or expired.",
          {
            hint: "Check it against `openoutbound keys list` (prefixes), create one with `openoutbound keys create`, or omit --api-key to run as the local agent.",
          },
        );
      }
      principal = authenticated;
    } else if (ctx.setting("OPENOUTBOUND_API_KEY")) {
      ctx.io.stderr(ENV_KEY_NOTE);
    }
    await engine.startWorker();
    handle = await serveEmbeddedStdio(engine, {
      toolsets,
      defaultWorkspace,
      principal,
      boundWorkspace: bound,
      ...transport,
    });
    ctx.io.stderr(
      `openoutbound mcp: embedded mode (home ${ctx.home.dir}) as ${principal.name}${boundNote}\n`,
    );
    try {
      await waitForShutdown(ctx, "mcp");
    } finally {
      await handle.close();
    }
    return 0;
  } finally {
    await engine.stopWorker().catch(() => {});
    await engine.close();
  }
}
