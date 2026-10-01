import { z } from "zod";

/** A JSON Schema object (draft 2020-12). */
export type JsonSchema = Record<string, unknown>;

const cache = new WeakMap<z.ZodType, JsonSchema>();

/**
 * JSON Schema of what the model must return for a prompt: the *input* side of the zod schema
 * (defaults and optional fields may be omitted by the model; zod fills them in), without the
 * `$schema` marker. Types zod cannot express become `{}`; provider converters then fall back to
 * prompt instructions. Cached per schema object.
 */
export function outputJsonSchema(schema: z.ZodType): JsonSchema {
  const cached = cache.get(schema);
  if (cached) return cached;
  const generated = z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
    reused: "inline",
  }) as JsonSchema;
  const { $schema: _ignored, ...rest } = generated;
  cache.set(schema, rest);
  return rest;
}

/** Schema name for providers that need one (letters, digits, underscores; max 64). */
export function schemaNameFor(promptId: string): string {
  const name = promptId.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return (name || "output").slice(0, 64);
}

/**
 * Instructions describing the output format, for providers that cannot enforce a schema
 * natively (JSON mode or prompt-only brains).
 */
export function schemaInstruction(jsonSchema: JsonSchema): string {
  return [
    "Output format: reply with one JSON object and nothing else (no prose, no Markdown code fences).",
    "The JSON must match this JSON Schema. Include every required property; leave out optional",
    "properties you have no value for.",
    "<output_json_schema>",
    JSON.stringify(jsonSchema),
    "</output_json_schema>",
  ].join("\n");
}

/** `system` plus the output format instructions (unchanged when there is no schema). */
export function withSchemaInstruction(system: string, jsonSchema: JsonSchema | undefined): string {
  if (!jsonSchema) return system;
  const trimmed = system.trimEnd();
  return trimmed ? `${trimmed}\n\n${schemaInstruction(jsonSchema)}` : schemaInstruction(jsonSchema);
}

/** Thrown by schema converters when a schema cannot be expressed in a provider's subset. */
export class UnsupportedSchemaError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`Schema at ${path || "(root)"} is not supported: ${reason}`);
    this.name = "UnsupportedSchemaError";
    this.path = path;
  }
}

export function isUnsupportedSchemaError(error: unknown): error is UnsupportedSchemaError {
  return error instanceof UnsupportedSchemaError;
}

/** True for plain JSON objects (not arrays, not null). */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolves a local `$ref` ("#/$defs/name" or "#") against the root schema. */
export function resolveRef(root: JsonSchema, ref: string): JsonSchema | undefined {
  if (ref === "#") return root;
  const match = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
  if (!match) return undefined;
  const defs = root[match[1] as string];
  if (!isJsonObject(defs)) return undefined;
  const name = decodeURIComponent((match[2] as string).replaceAll("~1", "/").replaceAll("~0", "~"));
  const target = defs[name];
  return isJsonObject(target) ? target : undefined;
}

/** The `type` keyword as a list ("string" -> ["string"]). */
export function schemaTypes(schema: JsonSchema): string[] {
  const type = schema.type;
  if (typeof type === "string") return [type];
  if (Array.isArray(type)) return type.filter((t): t is string => typeof t === "string");
  return [];
}
