import { afterEach, describe, expect, it } from "vitest";
import { BIND_HEADER, createHttpApp, type HttpAppOptions } from "../../src/http/app.js";
import { createFakeEngine, type FakeEngine, TEST_KEYS } from "./fake-engine.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

function setup(options: HttpAppOptions = {}, engine: FakeEngine = createFakeEngine()) {
  const { app, close } = createHttpApp(engine, options);
  closers.push(close);
  const request = (path: string, init: RequestInit & { key?: string | null } = {}) => {
    const headers = new Headers(init.headers);
    const key = init.key === undefined ? TEST_KEYS.admin : init.key;
    if (key) headers.set("Authorization", `Bearer ${key}`);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return app.request(path, { ...init, headers });
  };
  return { app, engine, request };
}

async function problem(response: Response) {
  expect(response.headers.get("Content-Type")).toContain("application/problem+json");
  return (await response.json()) as {
    type: string;
    title: string;
    status: number;
    detail: string;
    code: string;
    hint?: string;
    details?: Record<string, unknown>;
    request_id?: string;
  };
}

describe("public routes", () => {
  it("GET /health answers without auth and echoes request ids", async () => {
    const { request } = setup({ workerRunning: () => true });
    const response = await request("/health", { key: null, headers: { "X-Request-Id": "abc-1" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Request-Id")).toBe("abc-1");
    expect(await response.json()).toMatchObject({
      status: "ok",
      database: "memory",
      worker: true,
    });
    const generated = await request("/health", { key: null });
    expect(generated.headers.get("X-Request-Id")).toMatch(/^req_/);
  });

  it("serves /openapi.json without auth", async () => {
    const { request } = setup();
    const response = await request("/openapi.json", { key: null });
    expect(response.status).toBe(200);
    const doc = (await response.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths)).toContain("/v1/demo/items/{item_id}");
  });

  it("mounts module routes and answers unknown routes with problem+json", async () => {
    const { request } = setup();
    const ping = await request("/demo/ping", { key: null });
    expect(await ping.text()).toBe("pong");
    const missing = await request("/nope", { key: null });
    expect(missing.status).toBe(404);
    expect((await problem(missing)).code).toBe("not_found");
  });

  it("keeps CORS off by default and on for configured origins", async () => {
    const off = setup();
    const plain = await off.request("/health", {
      key: null,
      headers: { Origin: "https://app.example.com" },
    });
    expect(plain.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const on = setup({ corsOrigins: ["https://app.example.com"] });
    const preflight = await on.request("/v1/ops", {
      key: null,
      method: "OPTIONS",
      headers: { Origin: "https://app.example.com", "Access-Control-Request-Method": "GET" },
    });
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
  });
});

describe("auth", () => {
  it("rejects missing and invalid keys with 401 problem+json and a hint", async () => {
    const { request } = setup();
    const missing = await request("/v1/ops", { key: null });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("WWW-Authenticate")).toContain("Bearer");
    const body = await problem(missing);
    expect(body).toMatchObject({ code: "unauthorized", status: 401, title: "Unauthorized" });
    expect(body.hint).toContain("openoutbound keys create");
    expect(body.request_id).toMatch(/^req_/);
    const invalid = await request("/v1/ops", { key: "oo_nope" });
    expect(invalid.status).toBe(401);
    expect((await problem(invalid)).detail).toContain("Invalid");
  });

  it("accepts the local keys written to server.json", async () => {
    const localKeys = { admin: "oo_local_admin_test", agent: "oo_local_agent_test" };
    const { request, engine } = setup({ localKeys });
    const response = await request("/v1/ops/admin.ping", {
      key: localKeys.admin,
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(engine.calls.at(-1)?.options.principal).toMatchObject({
      id: "local-admin",
      via: "http",
    });
    const agent = await request("/v1/ops/admin.ping", {
      key: localKeys.agent,
      method: "POST",
      body: "{}",
    });
    expect(agent.status).toBe(403);
  });

  it("binds a request to one workspace with the OpenOutbound-Bind-Workspace header", async () => {
    const { request, engine } = setup();
    const own = await request("/v1/ops/demo.list_items", {
      method: "POST",
      headers: { [BIND_HEADER]: "acme" },
      body: JSON.stringify({}),
    });
    expect(own.status).toBe(200);
    expect(engine.calls.at(-1)?.options).toMatchObject({ boundWorkspace: "acme" });
    const other = await request("/v1/ops/demo.list_items", {
      method: "POST",
      headers: { [BIND_HEADER]: "acme" },
      body: JSON.stringify({ workspace: "globex" }),
    });
    expect(other.status).toBe(403);
    expect((await problem(other)).details).toMatchObject({ reason: "workspace_scope" });
    const pretty = await request("/v1/demo/items", {
      headers: { [BIND_HEADER]: "acme", "OpenOutbound-Workspace": "globex" },
    });
    expect(pretty.status).toBe(403);
    const unknown = await request("/v1/demo/items", { headers: { [BIND_HEADER]: "nowhere" } });
    expect(unknown.status).toBe(404);
    // A key bound to one workspace cannot bind itself to another.
    const widened = await request("/v1/demo/items", {
      key: TEST_KEYS.scoped,
      headers: { [BIND_HEADER]: "globex" },
    });
    expect(widened.status).toBe(403);
  });

  it("rate limits per key with 429 and Retry-After", async () => {
    const { request } = setup({ rateLimitPerMinute: 2 });
    const headers = { "OpenOutbound-Workspace": "acme" };
    expect((await request("/v1/demo/items", { headers })).status).toBe(200);
    const second = await request("/v1/demo/items", { headers });
    expect(second.headers.get("X-RateLimit-Remaining")).toBe("0");
    const third = await request("/v1/demo/items", { headers });
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect((await problem(third)).code).toBe("limit_reached");
    // Another key has its own bucket.
    expect((await request("/v1/demo/items", { headers, key: TEST_KEYS.agent })).status).toBe(200);
  });
});

describe("generic RPC and registry listing", () => {
  it("GET /v1/ops lists operations with input schemas and tools", async () => {
    const { request } = setup();
    const response = await request("/v1/ops");
    const catalog = (await response.json()) as {
      version: string;
      operations: Array<{ id: string; effect: string; input_schema: { properties: object } }>;
      tools: Array<{ name: string }>;
      agent_brain: boolean;
    };
    expect(catalog.operations.map((op) => op.id)).toContain("demo.list_items");
    const list = catalog.operations.find((op) => op.id === "demo.list_items");
    expect(list?.effect).toBe("read");
    expect(Object.keys(list?.input_schema.properties ?? {})).toEqual(
      expect.arrayContaining(["limit", "cursor", "status", "workspace", "response_format"]),
    );
    expect(catalog.tools.map((tool) => tool.name)).toContain("manage_items");
    expect(catalog.agent_brain).toBe(false);
  });

  it("POST /v1/ops/{id} runs any operation with the body as input", async () => {
    const { request, engine } = setup();
    const response = await request("/v1/ops/demo.list_items", {
      method: "POST",
      headers: { "OpenOutbound-Workspace": "globex" },
      body: JSON.stringify({ status: "done", reason: "report" }),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { items: Array<{ id: string }> }).items).toEqual([
      expect.objectContaining({ id: "it_2" }),
    ]);
    expect(engine.calls.at(-1)).toMatchObject({
      operationId: "demo.list_items",
      input: { status: "done", reason: "report" },
      options: { workspace: "globex", principal: { id: "key_admin", via: "http" } },
    });
  });

  it("maps validation, unknown operations and bad JSON to problems", async () => {
    const { request } = setup();
    const noWorkspace = await request("/v1/ops/demo.list_items", { method: "POST", body: "{}" });
    expect(noWorkspace.status).toBe(422);
    expect((await problem(noWorkspace)).code).toBe("validation_failed");

    const invalid = await request("/v1/ops/demo.create_item", {
      method: "POST",
      headers: { "OpenOutbound-Workspace": "acme" },
      body: JSON.stringify({ name: "" }),
    });
    const body = await problem(invalid);
    expect(invalid.status).toBe(422);
    expect(body.details?.issues).toEqual([expect.objectContaining({ path: "name" })]);

    const unknown = await request("/v1/ops/demo.nothing", { method: "POST", body: "{}" });
    expect(unknown.status).toBe(404);
    expect((await problem(unknown)).hint).toContain("GET /v1/ops");

    const badJson = await request("/v1/ops/demo.list_items", { method: "POST", body: "{nope" });
    expect(badJson.status).toBe(400);
    expect((await problem(badJson)).detail).toBe("Request body is not valid JSON.");

    const notObject = await request("/v1/ops/demo.list_items", { method: "POST", body: "[1]" });
    expect(notObject.status).toBe(400);
  });

  it("returns 202 for job handles and awaiting approval results", async () => {
    const { request } = setup();
    const headers = { "OpenOutbound-Workspace": "acme" };
    const job = await request("/v1/ops/demo.start_job", { method: "POST", headers, body: "{}" });
    expect(job.status).toBe(202);
    expect(await job.json()).toEqual({ job_id: "job_1", status: "queued" });
    const gated = await request("/v1/demo/items/it_big/send", {
      method: "POST",
      headers,
      body: JSON.stringify({ dry_run: false }),
    });
    expect(gated.status).toBe(202);
    expect(await gated.json()).toMatchObject({ status: "awaiting_approval" });
  });

  it("passes the Idempotency-Key header through to the engine", async () => {
    const { request, engine } = setup();
    const send = (body: object, key = "idem-42") =>
      request("/v1/demo/items", {
        method: "POST",
        headers: { "OpenOutbound-Workspace": "acme", "Idempotency-Key": key },
        body: JSON.stringify(body),
      });
    const first = await send({ name: "Once" });
    const second = await send({ name: "Once" });
    expect(await second.json()).toEqual(await first.json());
    expect(engine.calls.at(-1)?.options.idempotencyKey).toBe("idem-42");
    expect(engine.store.items.filter((item) => item.name === "Once")).toHaveLength(1);
    const mismatch = await send({ name: "Twice" });
    expect(mismatch.status).toBe(409);
    expect((await problem(mismatch)).code).toBe("idempotency_mismatch");
    const tooLong = await send({ name: "x" }, "k".repeat(201));
    expect(tooLong.status).toBe(400);
  });

  it("limits the request body size", async () => {
    const { request } = setup({ maxBodyBytes: 100 });
    const response = await request("/v1/ops/demo.create_item", {
      method: "POST",
      headers: { "OpenOutbound-Workspace": "acme" },
      body: JSON.stringify({ name: "x".repeat(500) }),
    });
    expect(response.status).toBe(413);
    expect((await problem(response)).code).toBe("validation_failed");
  });
});

describe("pretty routes", () => {
  it("maps query parameters to typed input fields for GET", async () => {
    const { request, engine } = setup();
    const response = await request("/v1/demo/items?tags=a&tags=b&min_score=5&limit=5", {
      headers: { "OpenOutbound-Workspace": "acme" },
    });
    expect(response.status).toBe(200);
    expect(engine.calls.at(-1)?.input).toEqual({ tags: ["a", "b"], min_score: 5, limit: 5 });
    expect(((await response.json()) as { items: unknown[] }).items).toHaveLength(1);
    const comma = await request("/v1/demo/items?tags=a,b", {
      headers: { "OpenOutbound-Workspace": "acme" },
    });
    expect(comma.status).toBe(200);
    expect(engine.calls.at(-1)?.input).toEqual({ tags: ["a", "b"] });
  });

  it("rejects query values of the wrong type", async () => {
    const { request } = setup();
    const response = await request("/v1/demo/items?min_score=lots", {
      headers: { "OpenOutbound-Workspace": "acme" },
    });
    expect(response.status).toBe(422);
    expect((await problem(response)).detail).toContain("min_score");
  });

  it("maps path parameters, bodies and DELETE", async () => {
    const { request, engine } = setup();
    const headers = { "OpenOutbound-Workspace": "acme" };
    const one = await request("/v1/demo/items/it_2", { headers });
    expect(await one.json()).toMatchObject({ id: "it_2", name: "Beta" });
    const created = await request("/v1/demo/items", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Gamma", tags: ["x"], score: 5 }),
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ id: "it_3", name: "Gamma", score: 5 });
    const dry = await request("/v1/demo/items", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Preview", dry_run: true }),
    });
    expect(await dry.json()).toMatchObject({ dry_run: true, preview: { name: "Preview" } });
    const removed = await request("/v1/demo/items/it_1", { method: "DELETE", headers });
    expect(await removed.json()).toEqual({ deleted: true });
    expect(engine.calls.at(-1)?.input).toEqual({ item_id: "it_1" });
  });
});
