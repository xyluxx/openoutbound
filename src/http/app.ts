import { randomBytes } from "node:crypto";
import { validateOriginHeader } from "@modelcontextprotocol/server";
import { sql } from "drizzle-orm";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import type { Principal } from "../core/context.js";
import type { CallOptions, Engine } from "../core/engine.js";
import type { Via } from "../core/enums.js";
import { OpenOutboundError, toOpenOutboundError } from "../core/errors.js";
import type { HttpMethod } from "../core/operation.js";
import { agentBrainInUse } from "../mcp/agent-brain.js";
import { isAwaitingApproval, isJobHandle } from "../mcp/format.js";
import { createMcpHttpHandler } from "../mcp/http-handler.js";
import { engineCatalog } from "../mcp/server.js";
import { resolveToolsets } from "../mcp/tools.js";
import { authenticate, type LocalKeys } from "./auth.js";
import { coerceQuery } from "./coerce.js";
import { buildOpenApi, type OpenApiDocument } from "./openapi.js";
import { problemResponse } from "./problem.js";
import { createRateLimiter } from "./rate-limit.js";

export const DEFAULT_RATE_LIMIT_PER_MINUTE = 600;
/**
 * Binds the API key's principal to one workspace for the request, as `openoutbound mcp
 * --workspace` does: other workspaces and instance-level operations are refused. It only
 * narrows: a key bound to another workspace is refused.
 */
export const BIND_HEADER = "OpenOutbound-Bind-Workspace";
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

export interface HttpAppOptions {
  /** Requests per minute per API key (token bucket). Default 600. */
  rateLimitPerMinute?: number;
  /** Origins allowed for CORS. CORS is off unless this is set. */
  corsOrigins?: string[];
  /** Local keys from `.openoutbound/server.json` (see `LocalKeys`). */
  localKeys?: LocalKeys | null;
  /** Body size limit in bytes. Default 10 MB. */
  maxBodyBytes?: number;
  /** Shown by /health. */
  workerRunning?: () => boolean;
}

type Env = { Variables: { requestId: string; principal: Principal } };

export interface HttpApp {
  app: Hono<Env>;
  close(): Promise<void>;
}

/**
 * The REST + MCP door (spec 9.3): `/health`, `/openapi.json`, `/mcp`, `GET /v1/ops`,
 * `POST /v1/ops/{operation_id}`, every operation's pretty route and the modules' public routes.
 * Bearer auth on /v1 and /mcp, problem+json errors, per-key rate limit, request ids, 10 MB
 * body limit, CORS off by default, Origin checks on /mcp.
 */
export function createHttpApp(engine: Engine, options: HttpAppOptions = {}): HttpApp {
  const app = new Hono<Env>();
  const limiter = createRateLimiter(options.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE);
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const mcp = createMcpHttpHandler(engine);
  const startedAt = Date.now();
  let openapi: OpenApiDocument | null = null;

  const fail = (c: Context<Env>, error: unknown, headers: Record<string, string> = {}) => {
    const normalized = toOpenOutboundError(error);
    if (normalized.code === "internal") {
      engine.log.error(
        { request_id: c.get("requestId"), err: normalized.cause ?? normalized },
        "request failed",
      );
    }
    const response = problemResponse(normalized, {
      instance: c.req.path,
      requestId: c.get("requestId"),
    });
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
  };

  app.use("*", async (c, next) => {
    const incoming = c.req.header("X-Request-Id");
    const id =
      incoming && /^[A-Za-z0-9._:-]{1,128}$/.test(incoming)
        ? incoming
        : `req_${randomBytes(12).toString("base64url")}`;
    c.set("requestId", id);
    await next();
    try {
      c.res.headers.set("X-Request-Id", id);
    } catch {
      c.res = new Response(c.res.body, c.res);
      c.res.headers.set("X-Request-Id", id);
    }
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: maxBodyBytes,
      onError: (c) =>
        fail(
          c as Context<Env>,
          new OpenOutboundError(
            "validation_failed",
            `Request body is larger than ${Math.round(maxBodyBytes / 1024 / 1024)} MB.`,
            { status: 413, hint: "Send smaller batches (for example split imports)." },
          ),
        ),
    }),
  );
  if (options.corsOrigins && options.corsOrigins.length > 0) {
    app.use(
      "*",
      cors({
        origin: options.corsOrigins,
        allowHeaders: [
          "Authorization",
          "Content-Type",
          "Idempotency-Key",
          "OpenOutbound-Workspace",
          BIND_HEADER,
          "X-Request-Id",
          "Mcp-Session-Id",
          "Mcp-Protocol-Version",
        ],
        exposeHeaders: [
          "X-Request-Id",
          "Retry-After",
          "X-RateLimit-Limit",
          "X-RateLimit-Remaining",
        ],
      }),
    );
  }
  app.onError((error, c) => fail(c, error));
  app.notFound((c) =>
    fail(
      c,
      new OpenOutboundError("not_found", `No route for ${c.req.method} ${c.req.path}.`, {
        hint: "See GET /openapi.json for every route, or GET /v1/ops for the operation ids.",
      }),
    ),
  );

  const requireKey =
    (via: Via): MiddlewareHandler<Env> =>
    async (c, next) => {
      let principal: Principal;
      try {
        principal = await authenticate(
          engine,
          c.req.header("Authorization"),
          via,
          options.localKeys,
        );
      } catch (error) {
        return fail(c, error, { "WWW-Authenticate": 'Bearer realm="openoutbound"' });
      }
      const decision = limiter.take(principal.id);
      const limitHeaders = {
        "X-RateLimit-Limit": String(decision.limit),
        "X-RateLimit-Remaining": String(decision.remaining),
      };
      if (!decision.allowed) {
        return fail(
          c,
          new OpenOutboundError("limit_reached", "Too many requests for this API key.", {
            hint: `Wait ${decision.retryAfterSeconds} seconds, then retry. The limit is ${decision.limit} requests per minute per key.`,
            retryAfterSeconds: decision.retryAfterSeconds,
            details: { limit_per_minute: decision.limit },
          }),
          limitHeaders,
        );
      }
      c.set("principal", principal);
      await next();
      try {
        for (const [name, value] of Object.entries(limitHeaders)) c.res.headers.set(name, value);
      } catch {
        // Immutable response headers: skip the informational rate-limit headers.
      }
    };

  // --- Public routes ---------------------------------------------------------------------------

  app.get("/health", async (c) => {
    if (engine.db) {
      try {
        await engine.db.execute(sql`select 1`);
      } catch (error) {
        return fail(
          c,
          new OpenOutboundError("internal", "The database is not reachable.", {
            status: 503,
            hint: "Check DATABASE_URL and run `openoutbound doctor`.",
            cause: error,
          }),
        );
      }
    }
    return c.json({
      status: "ok",
      version: engine.config.version,
      database: engine.config.database.kind,
      worker: options.workerRunning ? options.workerRunning() : null,
      uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
    });
  });

  app.get("/openapi.json", (c) => {
    openapi ??= buildOpenApi(engine.registry, {
      serverUrl: engine.config.baseUrl,
      version: engine.config.version,
    });
    return c.json(openapi);
  });

  // --- MCP over Streamable HTTP -------------------------------------------------------------

  const allowedOriginHosts = originHostnames(engine.config.baseUrl, options.corsOrigins);
  const mcpRoute = async (c: Context<Env>) => {
    const origin = c.req.header("Origin");
    if (origin) {
      const check = validateOriginHeader(origin, allowedOriginHosts);
      if (!check.ok) {
        return fail(
          c,
          new OpenOutboundError("forbidden", "Cross-site request to /mcp blocked.", {
            hint: "Browsers may only call /mcp from the server's own origin. Remote agents do not send an Origin header.",
            details: { origin },
          }),
        );
      }
    }
    const toolsets = c.req.query("toolsets") ?? null;
    if (toolsets) resolveToolsets(toolsets);
    return mcp.fetch(c.req.raw, {
      principal: c.get("principal"),
      toolsets,
      workspace: c.req.header("OpenOutbound-Workspace") ?? null,
      boundWorkspace: c.req.header(BIND_HEADER) ?? null,
    });
  };
  app.on(["GET", "POST", "DELETE"], "/mcp", requireKey("mcp"), mcpRoute);

  // --- REST ------------------------------------------------------------------------------------

  app.use("/v1/*", requireKey("http"));

  const run = async (c: Context<Env>, operationId: string, input: Record<string, unknown>) => {
    const callOptions: CallOptions = { principal: c.get("principal"), signal: c.req.raw.signal };
    const workspace = c.req.header("OpenOutbound-Workspace");
    if (workspace) callOptions.workspace = workspace;
    // A session bound to one workspace (`openoutbound mcp --url ... --workspace`).
    const bound = c.req.header(BIND_HEADER);
    if (bound) callOptions.boundWorkspace = bound;
    const idempotencyKey = c.req.header("Idempotency-Key");
    if (idempotencyKey !== undefined) {
      if (idempotencyKey.length < 1 || idempotencyKey.length > 200) {
        throw new OpenOutboundError(
          "validation_failed",
          "Idempotency-Key must be 1 to 200 characters.",
          {
            status: 400,
            hint: "Use a UUID or another unique string per logical request.",
          },
        );
      }
      callOptions.idempotencyKey = idempotencyKey;
    }
    const output = await engine.call(operationId, input, callOptions);
    const status = isAwaitingApproval(output) || isJobHandle(output) ? 202 : 200;
    return c.json((output ?? {}) as Record<string, unknown>, status);
  };

  app.get("/v1/ops", async (c) =>
    c.json({ ...engineCatalog(engine), agent_brain: await agentBrainInUse(engine.db) }),
  );

  app.post("/v1/ops/:operation_id", async (c) => {
    const operationId = c.req.param("operation_id");
    if (!engine.registry.operation(operationId)) {
      throw new OpenOutboundError("not_found", `Unknown operation "${operationId}".`, {
        hint: "GET /v1/ops lists every operation id.",
        details: { operation_id: operationId },
      });
    }
    return run(c, operationId, await readJsonBody(c));
  });

  const catalog = engineCatalog(engine);
  const schemas = new Map(catalog.operations.map((op) => [op.id, op.input_schema]));
  const taken = new Set<string>();
  for (const operation of engine.registry.operations()) {
    if (!operation.http) continue;
    const key = `${operation.http.method} ${operation.http.path}`;
    if (taken.has(key)) {
      engine.log.warn({ route: key, operation: operation.id }, "duplicate http route ignored");
      continue;
    }
    taken.add(key);
    const schema = schemas.get(operation.id) ?? {};
    const method = operation.http.method;
    app.on(method, operation.http.path, async (c) => {
      const input: Record<string, unknown> = coerceQuery(c.req.queries(), schema);
      if (hasBody(method)) Object.assign(input, await readJsonBody(c));
      const params = Object.fromEntries(
        Object.entries(c.req.param() as Record<string, string>).map(([name, value]) => [
          name,
          [value],
        ]),
      );
      Object.assign(input, coerceQuery(params, schema));
      return run(c, operation.id, input);
    });
  }

  // --- Module routes (unsubscribe pages, OAuth callbacks, inbound webhooks) -------------------

  for (const register of engine.httpRoutes()) {
    register(app as unknown as Hono, { engine });
  }

  return { app, close: () => mcp.close() };
}

function hasBody(method: HttpMethod): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH";
}

/** JSON object body; empty body = {}. Invalid JSON is a 400. */
async function readJsonBody(c: Context<Env>): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OpenOutboundError("validation_failed", "Request body is not valid JSON.", {
      status: 400,
      hint: "Send a JSON object with Content-Type: application/json.",
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OpenOutboundError("validation_failed", "Request body must be a JSON object.", {
      status: 400,
      hint: 'Wrap the input fields in an object, e.g. {"limit": 10}.',
    });
  }
  return parsed as Record<string, unknown>;
}

/** Hostnames allowed in an Origin header on /mcp: loopback, the base URL host, CORS origins. */
function originHostnames(baseUrl: string, corsOrigins: string[] | undefined): string[] {
  const hosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  for (const url of [baseUrl, ...(corsOrigins ?? [])]) {
    try {
      hosts.add(new URL(url).hostname);
    } catch {
      // ignore malformed entries
    }
  }
  return [...hosts];
}
