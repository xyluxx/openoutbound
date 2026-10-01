import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpApp } from "../../src/http/app.js";
import { MCP_INSTRUCTIONS } from "../../src/mcp/instructions.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import { serveBridgeStdio, serveEmbeddedStdio } from "../../src/mcp/stdio.js";
import { createFakeEngine, type FakeEngine, TEST_KEYS } from "./fake-engine.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function connectEmbedded(
  engine: FakeEngine,
  options: { toolsets?: string; defaultWorkspace?: string } = {},
): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const handle = await serveEmbeddedStdio(engine, { ...options, transport: serverSide });
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(clientSide);
  cleanups.push(async () => {
    await client.close();
    await handle.close();
  });
  return client;
}

function text(result: ToolResult): string {
  return result.content.map((block) => block.text ?? "").join("\n");
}

function routeTo(app: { fetch: (request: Request) => Response | Promise<Response> }) {
  return (async (input: string | URL | Request, init?: RequestInit) =>
    app.fetch(new Request(input, init))) as typeof fetch;
}

describe("MCP over stdio (embedded)", () => {
  it("identifies itself with name, title, version and instructions", async () => {
    const client = await connectEmbedded(createFakeEngine());
    expect(client.getServerVersion()).toMatchObject({
      name: "openoutbound",
      title: "OpenOutbound",
      version: expect.any(String),
    });
    expect(client.getInstructions()).toBe(MCP_INSTRUCTIONS);
    expect(MCP_INSTRUCTIONS.split("\n").length).toBeGreaterThanOrEqual(8);
    expect(MCP_INSTRUCTIONS).toContain("untrusted");
  });

  it("lists the core toolset by default and more with --toolsets", async () => {
    const core = await connectEmbedded(createFakeEngine());
    const coreTools = await core.listTools();
    expect(coreTools.tools.map((tool) => tool.name)).toEqual(["manage_items"]);
    const tool = coreTools.tools[0];
    expect(tool?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(tool?.inputSchema).toMatchObject({ type: "object", required: ["action"] });

    const all = await connectEmbedded(createFakeEngine(), { toolsets: "all" });
    expect((await all.listTools()).tools.map((t) => t.name)).toEqual([
      "manage_items",
      "send_item",
      "run_job",
      "ping",
    ]);
    const some = await connectEmbedded(createFakeEngine(), { toolsets: "core,campaigns" });
    expect((await some.listTools()).tools.map((t) => t.name)).toEqual([
      "manage_items",
      "send_item",
    ]);
  });

  it("adds the agent_brain toolset when a workspace uses the agent brain", async () => {
    const engine = createFakeEngine();
    const server = buildMcpServer(engine, {
      principal: engine.localPrincipal("agent", "mcp"),
      toolsets: "core",
      agentBrain: true,
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(clientSide);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
      "manage_items",
      "run_job",
    ]);
  });

  it("calls a composite tool: structuredContent is the output, text is a markdown table", async () => {
    const engine = createFakeEngine();
    const client = await connectEmbedded(engine, { defaultWorkspace: "acme" });
    const result = (await client.callTool({
      name: "manage_items",
      arguments: { action: "list", status: "open", reason: "checking" },
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      items: [
        {
          id: "it_1",
          name: "Alpha",
          status: "open",
          score: 10,
          tags: ["a"],
          created_at: "2026-09-19T12:00:00.000Z",
        },
      ],
      next_cursor: null,
      has_more: false,
    });
    expect(text(result)).toContain("| id | name | status | score |");
    const call = engine.calls.at(-1);
    expect(call?.operationId).toBe("demo.list_items");
    expect(call?.input).toEqual({ status: "open" });
    expect(call?.options).toMatchObject({
      workspace: "acme",
      reason: "checking",
      principal: { id: "local-agent", via: "mcp" },
    });
  });

  it("returns dry-run previews and approval results for send tools", async () => {
    const engine = createFakeEngine();
    const client = await connectEmbedded(engine, { toolsets: "all", defaultWorkspace: "acme" });
    const preview = (await client.callTool({
      name: "send_item",
      arguments: { item_id: "it_1" },
    })) as ToolResult;
    expect(preview.structuredContent).toMatchObject({ dry_run: true });
    expect(text(preview)).toContain("**Dry run**");
    const gated = (await client.callTool({
      name: "send_item",
      arguments: { item_id: "it_big", dry_run: false },
    })) as ToolResult;
    expect(gated.structuredContent).toMatchObject({ status: "awaiting_approval" });
    expect(text(gated)).toContain("**Awaiting approval** (apr_1)");
    expect(engine.store.sent).toEqual([]);
  });

  it("returns errors as isError with code, message and hint", async () => {
    const client = await connectEmbedded(createFakeEngine(), { defaultWorkspace: "acme" });
    const missing = (await client.callTool({
      name: "manage_items",
      arguments: { action: "get", item_id: "it_404" },
    })) as ToolResult;
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/^Error \(not_found\): Item it_404 not found\.\nHint: /);
    expect(missing.structuredContent).toMatchObject({
      error: { code: "not_found", message: "Item it_404 not found.", hint: expect.any(String) },
    });

    const invalid = (await client.callTool({
      name: "manage_items",
      arguments: { action: "create", name: "" },
    })) as ToolResult;
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent).toMatchObject({ error: { code: "validation_failed" } });

    const wrongField = (await client.callTool({
      name: "manage_items",
      arguments: { action: "get", item_id: "it_1", tags: ["x"] },
    })) as ToolResult;
    expect(text(wrongField)).toContain('Field "tags" is not used by action "get".');

    const noAction = (await client.callTool({
      name: "manage_items",
      arguments: {},
    })) as ToolResult;
    expect(text(noAction)).toContain("Hint: Pass action as one of: list, get, create, delete.");
  });

  it("serves the three prompts", async () => {
    const client = await connectEmbedded(createFakeEngine());
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name)).toEqual([
      "setup_outbound",
      "daily_review",
      "weekly_report",
    ]);
    const setup = await client.getPrompt({
      name: "setup_outbound",
      arguments: { website: "https://acme.example.com", workspace: "acme" },
    });
    const body = setup.messages[0]?.content;
    expect(body && "text" in body ? body.text : "").toContain(
      "bootstrap_from_website for https://acme.example.com",
    );
    const daily = await client.getPrompt({ name: "daily_review", arguments: {} });
    const dailyText = daily.messages[0]?.content;
    expect(dailyText && "text" in dailyText ? dailyText.text : "").toContain("get_attention_queue");
  });
});

describe("MCP bridge mode", () => {
  it("builds tools from the server catalog and forwards calls with the API key", async () => {
    const engine = createFakeEngine();
    const { app, close } = createHttpApp(engine);
    cleanups.push(close);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const handle = await serveBridgeStdio({
      url: "http://127.0.0.1:7331",
      apiKey: TEST_KEYS.agent,
      toolsets: "core",
      defaultWorkspace: "globex",
      transport: serverSide,
      fetch: routeTo(app),
    });
    const client = new Client({ name: "bridge-test", version: "1.0.0" });
    await client.connect(clientSide);
    cleanups.push(async () => {
      await client.close();
      await handle.close();
    });

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["manage_items"]);
    const created = (await client.callTool({
      name: "manage_items",
      arguments: { action: "create", name: "Delta", idempotency_key: "idem-1", reason: "demo" },
    })) as ToolResult;
    expect(created.isError).toBeFalsy();
    expect(created.structuredContent).toMatchObject({ name: "Delta", status: "open" });
    const call = engine.calls.at(-1);
    expect(call?.operationId).toBe("demo.create_item");
    expect(call?.options).toMatchObject({
      workspace: "globex",
      idempotencyKey: "idem-1",
      principal: { id: "key_agent", via: "http" },
    });
    expect(call?.input).toMatchObject({ name: "Delta", reason: "demo" });

    const missing = (await client.callTool({
      name: "manage_items",
      arguments: { action: "get", item_id: "it_404" },
    })) as ToolResult;
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toMatchObject({ error: { code: "not_found" } });
  });

  it("fails fast with an actionable error when the key is rejected", async () => {
    const engine = createFakeEngine();
    const { app, close } = createHttpApp(engine);
    cleanups.push(close);
    await expect(
      serveBridgeStdio({
        url: "http://127.0.0.1:7331",
        apiKey: "oo_wrong",
        transport: InMemoryTransport.createLinkedPair()[1],
        fetch: routeTo(app),
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });
});

describe("MCP over Streamable HTTP (/mcp)", () => {
  async function connectHttp(engine: FakeEngine, key: string, path = "/mcp") {
    const { app, close } = createHttpApp(engine);
    cleanups.push(close);
    const client = new Client({ name: "http-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:7331${path}`), {
      fetch: routeTo(app),
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    });
    await client.connect(transport);
    cleanups.push(() => client.close());
    return client;
  }

  it("serves tools behind bearer auth with the key's principal", async () => {
    const engine = createFakeEngine();
    const client = await connectHttp(engine, TEST_KEYS.scoped);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["manage_items"]);
    const result = (await client.callTool({
      name: "manage_items",
      arguments: { action: "get", item_id: "it_2" },
    })) as ToolResult;
    expect(result.structuredContent).toMatchObject({ id: "it_2", name: "Beta" });
    expect(engine.calls.at(-1)?.options.principal).toMatchObject({
      id: "key_scoped",
      via: "mcp",
      workspaceId: "ws_1",
    });
  });

  it("honors ?toolsets=", async () => {
    const client = await connectHttp(createFakeEngine(), TEST_KEYS.admin, "/mcp?toolsets=admin");
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["ping"]);
    const result = (await client.callTool({ name: "ping", arguments: {} })) as ToolResult;
    expect(result.structuredContent).toEqual({ pong: true, workspace: null });
  });

  it("rejects missing keys and cross-site origins", async () => {
    const engine = createFakeEngine();
    const { app, close } = createHttpApp(engine);
    cleanups.push(close);
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "x", version: "1" },
      },
    };
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const unauthenticated = await app.request("/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify(initialize),
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("WWW-Authenticate")).toContain("Bearer");

    const crossSite = await app.request("/mcp", {
      method: "POST",
      headers: {
        ...headers,
        Authorization: `Bearer ${TEST_KEYS.admin}`,
        Origin: "https://evil.example.org",
      },
      body: JSON.stringify(initialize),
    });
    expect(crossSite.status).toBe(403);
    expect(((await crossSite.json()) as { code: string }).code).toBe("forbidden");

    const localOrigin = await app.request("/mcp", {
      method: "POST",
      headers: {
        ...headers,
        Authorization: `Bearer ${TEST_KEYS.admin}`,
        Origin: "http://localhost:3000",
      },
      body: JSON.stringify(initialize),
    });
    expect(localOrigin.status).toBe(200);
  });
});
