import type { Registry } from "../core/engine.js";
import { type AnyOperation, operationScopes } from "../core/operation.js";
import { VERSION } from "../core/version.js";
import {
  type JsonSchema,
  schemaProperties,
  schemaRequired,
  toJsonSchema,
} from "../mcp/json-schema.js";

export type OpenApiDocument = Record<string, unknown> & {
  openapi: string;
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: {
    schemas: Record<string, JsonSchema>;
    [key: string]: unknown;
  };
};

export interface BuildOpenApiOptions {
  /** Server URL listed in `servers` (default http://localhost:7331). */
  serverUrl?: string;
  version?: string;
}

const PROBLEM_SCHEMA: JsonSchema = {
  type: "object",
  description: "RFC 9457 problem details with OpenOutbound's code and hint.",
  properties: {
    type: { type: "string", description: "URI of the error documentation" },
    title: { type: "string" },
    status: { type: "integer" },
    detail: { type: "string", description: "What happened" },
    code: {
      type: "string",
      description:
        "Stable error code: validation_failed, unauthorized, forbidden, not_found, conflict, idempotency_mismatch, limit_reached, budget_exceeded, provider_not_configured, provider_error, suppressed, workspace_paused, unsupported, internal",
    },
    hint: { type: "string", description: "What to do next" },
    details: { type: "object", additionalProperties: true },
    instance: { type: "string" },
    request_id: { type: "string" },
    retry_after_seconds: { type: "number" },
  },
  required: ["type", "title", "status", "detail", "code"],
};

function problemResponse(description: string) {
  return {
    description,
    content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
  };
}

const ERROR_RESPONSES = {
  "401": { $ref: "#/components/responses/Unauthorized" },
  "422": { $ref: "#/components/responses/ValidationFailed" },
  "429": { $ref: "#/components/responses/RateLimited" },
  "4XX": { $ref: "#/components/responses/Problem" },
  "5XX": { $ref: "#/components/responses/Problem" },
};

/** `leads.find_people` -> `LeadsFindPeople`. */
function pascal(id: string): string {
  return id
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** Express-style `/v1/leads/:person_id` -> OpenAPI `/v1/leads/{person_id}` plus the names. */
export function toOpenApiPath(path: string): { path: string; params: string[] } {
  const params: string[] = [];
  const converted = path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => {
    params.push(name);
    return `{${name}}`;
  });
  return { path: converted, params };
}

/**
 * Moves `$defs` out of a generated schema into `components.schemas` and rewrites
 * `#/$defs/X` references, so every `$ref` resolves inside the OpenAPI document.
 */
function hoistDefs(schema: JsonSchema, components: Record<string, JsonSchema>, prefix: string) {
  const defs = (schema.$defs ?? {}) as Record<string, JsonSchema>;
  const renames = new Map<string, string>();
  for (const name of Object.keys(defs)) renames.set(name, `${prefix}${pascal(name)}`);
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        if (key === "$defs") continue;
        if (key === "$ref" && typeof inner === "string") {
          if (inner === "#") out[key] = `#/components/schemas/${prefix}`;
          else if (inner.startsWith("#/$defs/")) {
            const name = inner.slice("#/$defs/".length);
            out[key] = `#/components/schemas/${renames.get(name) ?? name}`;
          } else out[key] = inner;
          continue;
        }
        out[key] = rewrite(inner);
      }
      return out;
    }
    return value;
  };
  for (const [name, def] of Object.entries(defs)) {
    components[renames.get(name) as string] = rewrite(def) as JsonSchema;
  }
  return rewrite(schema) as JsonSchema;
}

function operationExtensions(operation: AnyOperation) {
  return {
    "x-openoutbound-effect": operation.effect,
    "x-openoutbound-scopes": operationScopes(operation),
    "x-openoutbound-dry-run": operation.dryRun,
    "x-openoutbound-idempotent": operation.idempotent,
    "x-openoutbound-workspace": operation.workspace,
  };
}

/**
 * OpenAPI 3.1 for the REST door: every operation's pretty route (from its `http` spec) or, when
 * it has none, its RPC route `POST /v1/ops/<id>`; plus the generic RPC route, the registry
 * listing and health. Schemas come from zod (`z.toJSONSchema`), operationId = operation id,
 * tags by module (first id segment), bearer auth, problem+json errors. Deterministic.
 */
export function buildOpenApi(
  registry: Registry,
  options: BuildOpenApiOptions = {},
): OpenApiDocument {
  const schemas: Record<string, JsonSchema> = { Problem: PROBLEM_SCHEMA };
  const paths: Record<string, Record<string, Record<string, unknown>>> = {};
  const tags = new Set<string>();
  const usedNames = new Set<string>(["Problem"]);
  const uniqueName = (base: string) => {
    let name = base;
    let n = 2;
    while (usedNames.has(name)) name = `${base}${n++}`;
    usedNames.add(name);
    return name;
  };
  const addPath = (path: string, method: string, operation: Record<string, unknown>) => {
    paths[path] ??= {};
    (paths[path] as Record<string, Record<string, unknown>>)[method] = operation;
  };

  const operations = [...registry.operations()].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const operation of operations) {
    const tag = operation.id.split(".")[0] as string;
    tags.add(tag);
    const inputName = uniqueName(`${pascal(operation.id)}Input`);
    const outputName = uniqueName(`${pascal(operation.id)}Output`);
    const input = hoistDefs(
      toJsonSchema(registry.inputSchema(operation.id), "input"),
      schemas,
      inputName,
    );
    schemas[inputName] = input;
    schemas[outputName] = hoistDefs(
      toJsonSchema(registry.outputSchema(operation.id), "output"),
      schemas,
      outputName,
    );
    const base = {
      operationId: operation.id,
      tags: [tag],
      summary: operation.summary,
      description: operation.description,
      ...operationExtensions(operation),
    };
    const success = {
      "200": {
        description:
          "The operation result (or a dry-run preview, job handle or awaiting_approval result).",
        content: { "application/json": { schema: { $ref: `#/components/schemas/${outputName}` } } },
      },
      ...ERROR_RESPONSES,
    };
    const headerParams = [
      { $ref: "#/components/parameters/WorkspaceHeader" },
      { $ref: "#/components/parameters/BindWorkspaceHeader" },
      ...(operation.effect === "read" ? [] : [{ $ref: "#/components/parameters/IdempotencyKey" }]),
    ];

    if (!operation.http) {
      addPath(`/v1/ops/${operation.id}`, "post", {
        ...base,
        parameters: headerParams,
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: `#/components/schemas/${inputName}` } },
          },
        },
        responses: success,
      });
      continue;
    }

    const { path, params } = toOpenApiPath(operation.http.path);
    const properties = schemaProperties(input);
    const required = new Set(schemaRequired(input));
    const parameters: Record<string, unknown>[] = params.map((name) => ({
      name,
      in: "path",
      required: true,
      schema: properties[name] ?? { type: "string" },
    }));
    parameters.push(...headerParams);
    const method = operation.http.method.toLowerCase();
    const entry: Record<string, unknown> = { ...base, responses: success };
    if (method === "get" || method === "delete") {
      for (const [name, property] of Object.entries(properties)) {
        if (params.includes(name)) continue;
        const kind = property.type;
        const parameter: Record<string, unknown> = {
          name,
          in: "query",
          required: required.has(name),
        };
        if (typeof property.description === "string") parameter.description = property.description;
        if (kind === "object") parameter.content = { "application/json": { schema: property } };
        else {
          parameter.schema = property;
          if (kind === "array") {
            parameter.style = "form";
            parameter.explode = true;
          }
        }
        parameters.push(parameter);
      }
    } else {
      const bodyProperties = Object.fromEntries(
        Object.entries(properties).filter(([name]) => !params.includes(name)),
      );
      const bodyRequired = [...required].filter((name) => !params.includes(name));
      const body: JsonSchema = { ...input, properties: bodyProperties };
      if (bodyRequired.length > 0) body.required = bodyRequired;
      else delete body.required;
      entry.requestBody = {
        required: bodyRequired.length > 0,
        content: { "application/json": { schema: body } },
      };
    }
    entry.parameters = parameters;
    addPath(path, method, entry);
  }

  addPath("/v1/ops/{operation_id}", "post", {
    operationId: "callOperation",
    tags: ["ops"],
    summary: "Call any operation by id (generic RPC)",
    description:
      "Runs one operation with the JSON body as its input and returns its output. Used by CLI and MCP bridges. Every operation is reachable this way, including those with a dedicated route.",
    parameters: [
      {
        name: "operation_id",
        in: "path",
        required: true,
        schema: { type: "string", pattern: "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$" },
        description: "Operation id, e.g. leads.search",
      },
      { $ref: "#/components/parameters/WorkspaceHeader" },
      { $ref: "#/components/parameters/BindWorkspaceHeader" },
      { $ref: "#/components/parameters/IdempotencyKey" },
    ],
    requestBody: {
      required: false,
      content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
    },
    responses: {
      "200": {
        description: "The operation output.",
        content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
      },
      ...ERROR_RESPONSES,
    },
  });
  addPath("/v1/ops", "get", {
    operationId: "listOperations",
    tags: ["ops"],
    summary: "List operations and MCP tools",
    description:
      "The registry as data: every operation (id, summary, effect, scopes, input JSON Schema, examples) and every MCP tool definition.",
    responses: {
      "200": {
        description: "Operation catalog.",
        content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
      },
      ...ERROR_RESPONSES,
    },
  });
  addPath("/health", "get", {
    operationId: "getHealth",
    tags: ["system"],
    summary: "Health check",
    security: [],
    responses: {
      "200": {
        description: "The server is up and the database answers.",
        content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
      },
      "503": problemResponse("The database is not reachable."),
    },
  });

  const sortedPaths = Object.fromEntries(
    Object.keys(paths)
      .sort()
      .map((key) => [key, paths[key] as Record<string, Record<string, unknown>>]),
  );
  const sortedSchemas = Object.fromEntries(
    Object.keys(schemas)
      .sort()
      .map((key) => [key, schemas[key] as JsonSchema]),
  );
  tags.add("ops");
  tags.add("system");
  return {
    openapi: "3.1.0",
    info: {
      title: "OpenOutbound API",
      version: options.version ?? VERSION,
      description:
        "REST API of OpenOutbound, the open-source AI SDR engine. Every operation is also available as an MCP tool and a CLI command. Authenticate with `Authorization: Bearer oo_...`; errors are RFC 9457 problem+json with `code` and `hint`.",
      license: { name: "Apache-2.0", identifier: "Apache-2.0" },
    },
    servers: [{ url: options.serverUrl ?? "http://localhost:7331" }],
    security: [{ bearerAuth: [] }],
    tags: [...tags].sort().map((name) => ({ name })),
    paths: sortedPaths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "API key (oo_...)",
          description: "Create a key with `openoutbound keys create`.",
        },
      },
      parameters: {
        WorkspaceHeader: {
          name: "OpenOutbound-Workspace",
          in: "header",
          required: false,
          schema: { type: "string" },
          description: "Workspace id or slug (instance-level keys only).",
        },
        BindWorkspaceHeader: {
          name: "OpenOutbound-Bind-Workspace",
          in: "header",
          required: false,
          schema: { type: "string" },
          description:
            "Binds the key to this workspace (id or slug) for the request, like a workspace key: other workspaces and instance-level operations answer 403 forbidden. It only narrows: a key bound to another workspace is refused.",
        },
        IdempotencyKey: {
          name: "Idempotency-Key",
          in: "header",
          required: false,
          schema: { type: "string", maxLength: 200 },
          description:
            "Makes retries safe for 24 hours: same key + same body returns the first result.",
        },
      },
      responses: {
        Problem: problemResponse("Error (problem+json)."),
        Unauthorized: problemResponse("Missing, invalid, revoked or expired API key."),
        ValidationFailed: problemResponse(
          "The input failed validation; details.issues lists the fields.",
        ),
        RateLimited: problemResponse("Too many requests or a sending limit; see Retry-After."),
      },
      schemas: sortedSchemas,
    },
  };
}
