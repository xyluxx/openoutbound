import { describe, expect, it } from "vitest";
import { createFakeEngine } from "../../tests/e2e/fake-engine.js";
import { buildStaticRegistry } from "../cli/static-registry.js";
import { modules } from "../modules/index.js";
import { buildOpenApi, toOpenApiPath } from "./openapi.js";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

function collectRefs(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) collectRefs(item, out);
  else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (key === "$ref" && typeof inner === "string") out.push(inner);
      else collectRefs(inner, out);
    }
  }
  return out;
}

function resolvePointer(doc: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  return ref
    .slice(2)
    .split("/")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
      doc,
    );
}

describe("buildOpenApi", () => {
  const registry = createFakeEngine().registry;
  const doc = buildOpenApi(registry, {
    serverUrl: "https://outbound.example.com",
    version: "9.9.9",
  });

  it("is an OpenAPI 3.1 document with bearer security and problem responses", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info).toMatchObject({ title: "OpenOutbound API", version: "9.9.9" });
    expect(doc.servers).toEqual([{ url: "https://outbound.example.com" }]);
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.components.schemas.Problem).toMatchObject({
      required: expect.arrayContaining(["code"]),
    });
  });

  it("has unique operationIds equal to operation ids", () => {
    const ids: string[] = [];
    for (const item of Object.values(doc.paths)) {
      for (const method of HTTP_METHODS) {
        const operation = item[method] as { operationId?: string } | undefined;
        if (operation?.operationId) ids.push(operation.operationId);
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
    for (const operation of registry.operations()) expect(ids).toContain(operation.id);
    expect(ids).toEqual(expect.arrayContaining(["callOperation", "listOperations", "getHealth"]));
  });

  it("documents pretty routes with path and query parameters and request bodies", () => {
    const get = doc.paths["/v1/demo/items/{item_id}"]?.get as {
      parameters: Array<{ name?: string; in?: string; $ref?: string }>;
      tags: string[];
    };
    expect(get.tags).toEqual(["demo"]);
    expect(get.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "item_id", in: "path" })]),
    );
    const list = doc.paths["/v1/demo/items"]?.get as {
      parameters: Array<{ name?: string; in?: string; style?: string }>;
    };
    expect(list.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "tags", in: "query", style: "form" }),
        expect.objectContaining({ name: "status", in: "query" }),
      ]),
    );
    const create = doc.paths["/v1/demo/items"]?.post as {
      requestBody: { content: { "application/json": { schema: { required: string[] } } } };
    };
    expect(create.requestBody.content["application/json"].schema.required).toEqual(["name"]);
    const send = doc.paths["/v1/demo/items/{item_id}/send"]?.post as {
      requestBody: { content: { "application/json": { schema: { properties: object } } } };
    };
    expect(
      Object.keys(send.requestBody.content["application/json"].schema.properties),
    ).not.toContain("item_id");
  });

  it("documents RPC routes for operations without a pretty route", () => {
    const rpc = doc.paths["/v1/ops/demo.start_job"]?.post as { operationId: string };
    expect(rpc.operationId).toBe("demo.start_job");
    expect(doc.paths["/v1/ops/{operation_id}"]?.post).toBeDefined();
  });

  it("resolves every $ref inside the document", () => {
    const refs = collectRefs(doc);
    expect(refs.length).toBeGreaterThan(10);
    for (const ref of refs) expect(resolvePointer(doc, ref), ref).toBeDefined();
  });

  it("is deterministic", () => {
    expect(JSON.stringify(buildOpenApi(registry, { version: "1" }))).toBe(
      JSON.stringify(buildOpenApi(registry, { version: "1" })),
    );
  });

  it("builds for the real module registry", () => {
    const real = buildOpenApi(buildStaticRegistry(modules));
    expect(real.paths["/health"]).toBeDefined();
  });

  it("converts express paths", () => {
    expect(toOpenApiPath("/v1/a/:id/b/:other_id")).toEqual({
      path: "/v1/a/{id}/b/{other_id}",
      params: ["id", "other_id"],
    });
  });
});
