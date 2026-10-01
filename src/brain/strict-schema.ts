import {
  isJsonObject,
  type JsonSchema,
  schemaTypes,
  UnsupportedSchemaError,
} from "./json-schema.js";

/** String formats OpenAI Structured Outputs accept in strict mode. */
const STRICT_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "uuid",
]);

/** Keywords strict mode cannot express at all: the schema falls back to JSON mode. */
const FAIL_KEYWORDS = [
  "not",
  "if",
  "then",
  "else",
  "dependentRequired",
  "dependentSchemas",
  "patternProperties",
  "propertyNames",
  "prefixItems",
  "contains",
  "unevaluatedProperties",
  "unevaluatedItems",
] as const;

const NUMBER_KEYWORDS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
] as const;
const PRIMITIVE_TYPES = new Set(["string", "number", "integer", "boolean"]);

/** OpenAI documents up to 10 levels of object nesting. */
const MAX_DEPTH = 10;

/**
 * Converts a JSON Schema (from `outputJsonSchema`) into the subset OpenAI Structured Outputs
 * accept with `strict: true` (also used for Codex `--output-schema` and OpenAI-compatible
 * servers):
 * - every object is closed (`additionalProperties: false`) and lists all its properties in
 *   `required`; optional properties become nullable (the brain service removes those nulls
 *   again before validating with zod),
 * - `oneOf` becomes `anyOf`, `const` becomes a one-value `enum`,
 * - keywords strict mode does not support (string lengths, patterns, unsupported formats,
 *   defaults, unique items) move into the description; zod still enforces them afterwards.
 *
 * Throws `UnsupportedSchemaError` for shapes strict mode cannot express (a non-object root,
 * records with free-form keys, tuples, values of any type, `allOf`, `not`, conditionals); the
 * caller then uses JSON mode plus prompt instructions.
 */
export function toStrictJsonSchema(schema: JsonSchema): JsonSchema {
  if (!schemaTypes(schema).includes("object") || schema.anyOf || schema.oneOf) {
    throw new UnsupportedSchemaError("", "the root must be a plain object");
  }
  const out = convert(schema, "", 0);
  const defs = schema.$defs ?? schema.definitions;
  if (isJsonObject(defs)) {
    const converted: JsonSchema = {};
    for (const [name, def] of Object.entries(defs)) {
      converted[name] = convert(def, `$defs.${name}`, 0);
    }
    out[schema.$defs ? "$defs" : "definitions"] = converted;
  }
  return out;
}

function convert(node: unknown, path: string, depth: number): JsonSchema {
  if (!isJsonObject(node) || Object.keys(node).length === 0) {
    throw new UnsupportedSchemaError(path, "a value of any type");
  }
  for (const keyword of FAIL_KEYWORDS) {
    if (node[keyword] !== undefined) throw new UnsupportedSchemaError(path, `"${keyword}"`);
  }
  const description = typeof node.description === "string" ? node.description : undefined;
  if (typeof node.$ref === "string") {
    return description ? { $ref: node.$ref, description } : { $ref: node.$ref };
  }
  if (Array.isArray(node.allOf)) {
    if (node.allOf.length === 1 && node.type === undefined && !node.anyOf && !node.oneOf) {
      return convert(node.allOf[0], path, depth);
    }
    throw new UnsupportedSchemaError(path, '"allOf"');
  }

  const out: JsonSchema = {};
  const notes: string[] = [];
  const variants = node.anyOf ?? node.oneOf;
  const types = schemaTypes(node);
  const nonNull = types.filter((type) => type !== "null");
  if (Array.isArray(variants)) {
    out.anyOf = variants.map((variant, index) =>
      convert(variant, `${path}.anyOf[${index}]`, depth),
    );
  } else if (nonNull.length > 1 && node.enum === undefined && node.const === undefined) {
    // ["string", "number"] -> anyOf of single types (clearer for strict mode).
    const { description: _description, default: _default, ...rest } = node;
    out.anyOf = nonNull.map((type) => convert({ ...rest, type }, path, depth));
    if (types.includes("null")) (out.anyOf as JsonSchema[]).push({ type: "null" });
  } else {
    const hasEnum = Array.isArray(node.enum) || node.const !== undefined;
    if (types.length === 0 && !hasEnum)
      throw new UnsupportedSchemaError(path, "a value of any type");
    if (types.length > 0) out.type = typeof node.type === "string" ? node.type : [...types];
    if (node.const !== undefined) out.enum = [primitiveOrThrow(node.const, path)];
    else if (Array.isArray(node.enum)) out.enum = node.enum.map((v) => primitiveOrThrow(v, path));

    if (types.includes("object")) convertObject(node, out, path, depth);
    if (types.includes("array")) convertArray(node, out, notes, path, depth);
    if (types.includes("string")) convertString(node, out, notes);
    if (types.includes("number") || types.includes("integer")) {
      for (const key of NUMBER_KEYWORDS) {
        if (isMeaningfulBound(node[key])) out[key] = node[key];
      }
    }
  }
  if (node.default !== undefined) notes.push(`default=${JSON.stringify(node.default)}`);
  const text = describe(description, notes);
  if (text) out.description = text;
  return out;
}

function convertObject(node: JsonSchema, out: JsonSchema, path: string, depth: number): void {
  if (depth >= MAX_DEPTH) throw new UnsupportedSchemaError(path, "objects nested too deeply");
  const properties = isJsonObject(node.properties) ? node.properties : {};
  const keys = Object.keys(properties);
  const extra = node.additionalProperties;
  const openExtra = extra === true || (isJsonObject(extra) && Object.keys(extra).length > 0);
  if (keys.length === 0 && (openExtra || isJsonObject(extra))) {
    throw new UnsupportedSchemaError(path, "a map with free-form keys");
  }
  const required = new Set(
    Array.isArray(node.required) ? node.required.filter((k) => typeof k === "string") : [],
  );
  const converted: JsonSchema = {};
  for (const key of keys) {
    const child = convert(properties[key], path ? `${path}.${key}` : key, depth + 1);
    converted[key] = required.has(key) ? child : nullable(child);
  }
  out.properties = converted;
  out.required = keys;
  out.additionalProperties = false;
}

function convertArray(
  node: JsonSchema,
  out: JsonSchema,
  notes: string[],
  path: string,
  depth: number,
): void {
  const items = node.items;
  if (!isJsonObject(items) || Object.keys(items).length === 0) {
    throw new UnsupportedSchemaError(`${path}[]`, "array items of any type");
  }
  out.items = convert(items, `${path}[]`, depth + 1);
  if (typeof node.minItems === "number") out.minItems = node.minItems;
  if (typeof node.maxItems === "number") out.maxItems = node.maxItems;
  if (node.uniqueItems === true) notes.push("uniqueItems=true");
}

function convertString(node: JsonSchema, out: JsonSchema, notes: string[]): void {
  const format = typeof node.format === "string" ? node.format : undefined;
  if (format && STRICT_FORMATS.has(format)) out.format = format;
  else if (format) notes.push(`format=${format}`);
  // A pattern next to a supported format is zod's implementation of that format: drop it.
  if (typeof node.pattern === "string" && !(format && STRICT_FORMATS.has(format))) {
    notes.push(`pattern=${node.pattern}`);
  }
  if (typeof node.minLength === "number") notes.push(`minLength=${node.minLength}`);
  if (typeof node.maxLength === "number") notes.push(`maxLength=${node.maxLength}`);
}

/** Lets a converted schema also accept null (how strict mode expresses "optional"). */
export function nullable(schema: JsonSchema): JsonSchema {
  if (acceptsNull(schema)) return schema;
  const types = schemaTypes(schema);
  if (
    types.length > 0 &&
    schema.enum === undefined &&
    schema.anyOf === undefined &&
    schema.$ref === undefined &&
    types.every((type) => PRIMITIVE_TYPES.has(type))
  ) {
    return { ...schema, type: [...types, "null"] };
  }
  if (Array.isArray(schema.anyOf)) return { ...schema, anyOf: [...schema.anyOf, { type: "null" }] };
  const { description, ...rest } = schema;
  return typeof description === "string"
    ? { anyOf: [rest, { type: "null" }], description }
    : { anyOf: [rest, { type: "null" }] };
}

function acceptsNull(schema: JsonSchema): boolean {
  if (schemaTypes(schema).includes("null")) return true;
  if (Array.isArray(schema.enum) && schema.enum.includes(null)) return true;
  return (
    Array.isArray(schema.anyOf) &&
    schema.anyOf.some((variant) => isJsonObject(variant) && acceptsNull(variant))
  );
}

/** zod adds +-MAX_SAFE_INTEGER bounds to every `.int()`; they carry no meaning for a model. */
export function isMeaningfulBound(value: unknown): value is number {
  return typeof value === "number" && Math.abs(value) !== Number.MAX_SAFE_INTEGER;
}

function primitiveOrThrow(value: unknown, path: string): unknown {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  throw new UnsupportedSchemaError(path, "enum values must be strings, numbers, booleans or null");
}

/** Appends constraint notes to a description: "Subject line (maxLength=80)". */
export function describe(description: string | undefined, notes: string[]): string | undefined {
  if (notes.length === 0) return description;
  const suffix = `(${notes.join(", ")})`;
  return description ? `${description} ${suffix}` : suffix;
}
