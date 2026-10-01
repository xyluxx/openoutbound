import { z } from "zod";

/** A JSON Schema object (draft 2020-12). */
export type JsonSchema = Record<string, unknown>;

/**
 * Converts a zod schema to JSON Schema (draft 2020-12) for tool listings, OpenAPI and docs.
 * Never throws on types JSON Schema cannot express (they become `{}`) and drops the `$schema`
 * marker so the result can be embedded in bigger documents.
 */
export function toJsonSchema(schema: z.ZodType, io: "input" | "output" = "input"): JsonSchema {
  const result = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io,
    unrepresentable: "any",
    reused: "inline",
    cycles: "ref",
  }) as JsonSchema;
  const { $schema: _ignored, ...rest } = result;
  return rest;
}

/** Top-level properties of an object JSON Schema (empty when it has none). */
export function schemaProperties(schema: JsonSchema): Record<string, JsonSchema> {
  const properties = schema.properties;
  return properties && typeof properties === "object"
    ? (properties as Record<string, JsonSchema>)
    : {};
}

/** Names of the required top-level properties. */
export function schemaRequired(schema: JsonSchema): string[] {
  return Array.isArray(schema.required) ? (schema.required as string[]) : [];
}

/** Stable JSON for comparing schemas (object keys sorted). */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return Object.fromEntries(entries.map(([key, inner]) => [key, sortKeys(inner)]));
  }
  return value;
}
