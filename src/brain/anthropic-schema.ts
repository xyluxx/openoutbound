import {
  isJsonObject,
  type JsonSchema,
  resolveRef,
  schemaTypes,
  UnsupportedSchemaError,
} from "./json-schema.js";
import { describe, isMeaningfulBound } from "./strict-schema.js";

/** String formats Anthropic structured outputs accept. */
const ANTHROPIC_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

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

/** Documented complexity limits for one request (optional properties, union-typed properties). */
export const ANTHROPIC_SCHEMA_LIMITS = { optionalProperties: 24, unionProperties: 16 } as const;

interface Counters {
  optional: number;
  unions: number;
}

/**
 * Converts a JSON Schema (from `outputJsonSchema`) into the subset Anthropic structured outputs
 * (`output_config.format`) accept: objects closed with `additionalProperties: false`, `oneOf`
 * as `anyOf`, and unsupported constraints (numeric bounds, string lengths, patterns, unsupported
 * formats, array sizes above 1) moved into the description so the model still sees them; zod
 * enforces them afterwards. Optional properties stay optional.
 *
 * Throws `UnsupportedSchemaError` for recursive schemas, free-form values or maps, tuples, and
 * schemas over the documented limits (24 optional and 16 union-typed properties); the caller
 * then sends the schema as prompt instructions instead.
 */
export function toAnthropicJsonSchema(schema: JsonSchema): JsonSchema {
  if (!schemaTypes(schema).includes("object") || schema.anyOf || schema.oneOf) {
    throw new UnsupportedSchemaError("", "the root must be a plain object");
  }
  assertNotRecursive(schema);
  const counters: Counters = { optional: 0, unions: 0 };
  const out = convert(schema, "", counters);
  const defsKey = schema.$defs ? "$defs" : schema.definitions ? "definitions" : undefined;
  const defs = defsKey ? schema[defsKey] : undefined;
  if (defsKey && isJsonObject(defs)) {
    const converted: JsonSchema = {};
    for (const [name, def] of Object.entries(defs)) {
      converted[name] = convert(def, `$defs.${name}`, counters);
    }
    out[defsKey] = converted;
  }
  if (counters.optional > ANTHROPIC_SCHEMA_LIMITS.optionalProperties) {
    throw new UnsupportedSchemaError("", `${counters.optional} optional properties (max 24)`);
  }
  if (counters.unions > ANTHROPIC_SCHEMA_LIMITS.unionProperties) {
    throw new UnsupportedSchemaError("", `${counters.unions} union-typed properties (max 16)`);
  }
  return out;
}

function convert(node: unknown, path: string, counters: Counters): JsonSchema {
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

  const out: JsonSchema = {};
  const notes: string[] = [];
  const variants = node.anyOf ?? node.oneOf;
  if (Array.isArray(variants)) {
    out.anyOf = variants.map((variant, index) =>
      convert(variant, `${path}.anyOf[${index}]`, counters),
    );
  } else if (Array.isArray(node.allOf)) {
    if (node.allOf.some((entry) => isJsonObject(entry) && typeof entry.$ref === "string")) {
      throw new UnsupportedSchemaError(path, '"allOf" with "$ref"');
    }
    out.allOf = node.allOf.map((entry, index) =>
      convert(entry, `${path}.allOf[${index}]`, counters),
    );
  } else {
    const types = schemaTypes(node);
    const hasEnum = Array.isArray(node.enum) || node.const !== undefined;
    if (types.length === 0 && !hasEnum)
      throw new UnsupportedSchemaError(path, "a value of any type");
    if (types.length > 0) out.type = typeof node.type === "string" ? node.type : [...types];
    if (node.const !== undefined) out.const = primitiveOrThrow(node.const, path);
    if (Array.isArray(node.enum)) out.enum = node.enum.map((v) => primitiveOrThrow(v, path));

    if (types.includes("object")) convertObject(node, out, path, counters);
    if (types.includes("array")) convertArray(node, out, notes, path, counters);
    if (types.includes("string")) convertString(node, out, notes);
    if (types.includes("number") || types.includes("integer")) {
      for (const key of NUMBER_KEYWORDS) {
        if (isMeaningfulBound(node[key])) notes.push(`${key}=${node[key]}`);
      }
    }
  }
  if (node.default !== undefined) out.default = node.default;
  const text = describe(description, notes);
  if (text) out.description = text;
  return out;
}

function convertObject(node: JsonSchema, out: JsonSchema, path: string, counters: Counters): void {
  const properties = isJsonObject(node.properties) ? node.properties : {};
  const keys = Object.keys(properties);
  const extra = node.additionalProperties;
  const openExtra = extra === true || (isJsonObject(extra) && Object.keys(extra).length > 0);
  if (keys.length === 0 && (openExtra || isJsonObject(extra))) {
    throw new UnsupportedSchemaError(path, "a map with free-form keys");
  }
  const required = Array.isArray(node.required)
    ? node.required.filter((key): key is string => typeof key === "string" && keys.includes(key))
    : [];
  const converted: JsonSchema = {};
  for (const key of keys) {
    const child = convert(properties[key], path ? `${path}.${key}` : key, counters);
    if (!required.includes(key)) counters.optional += 1;
    if (Array.isArray(child.anyOf) || Array.isArray(child.type)) counters.unions += 1;
    converted[key] = child;
  }
  out.properties = converted;
  if (required.length > 0) out.required = required;
  out.additionalProperties = false;
}

function convertArray(
  node: JsonSchema,
  out: JsonSchema,
  notes: string[],
  path: string,
  counters: Counters,
): void {
  const items = node.items;
  if (!isJsonObject(items) || Object.keys(items).length === 0) {
    throw new UnsupportedSchemaError(`${path}[]`, "array items of any type");
  }
  out.items = convert(items, `${path}[]`, counters);
  if (typeof node.minItems === "number") {
    if (node.minItems <= 1) out.minItems = node.minItems;
    else {
      out.minItems = 1;
      notes.push(`minItems=${node.minItems}`);
    }
  }
  if (typeof node.maxItems === "number") notes.push(`maxItems=${node.maxItems}`);
  if (node.uniqueItems === true) notes.push("uniqueItems=true");
}

function convertString(node: JsonSchema, out: JsonSchema, notes: string[]): void {
  const format = typeof node.format === "string" ? node.format : undefined;
  const supported = format !== undefined && ANTHROPIC_FORMATS.has(format);
  if (supported) out.format = format;
  else if (format) notes.push(`format=${format}`);
  if (typeof node.pattern === "string" && !supported) notes.push(`pattern=${node.pattern}`);
  if (typeof node.minLength === "number") notes.push(`minLength=${node.minLength}`);
  if (typeof node.maxLength === "number") notes.push(`maxLength=${node.maxLength}`);
}

function primitiveOrThrow(value: unknown, path: string): unknown {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  throw new UnsupportedSchemaError(path, "enum values must be strings, numbers, booleans or null");
}

/** Anthropic rejects recursive schemas: follow every `$ref` and fail on a cycle. */
function assertNotRecursive(root: JsonSchema): void {
  const visit = (node: unknown, stack: string[]): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, stack);
      return;
    }
    if (!isJsonObject(node)) return;
    if (typeof node.$ref === "string") {
      if (stack.includes(node.$ref) || node.$ref === "#") {
        throw new UnsupportedSchemaError(node.$ref, "recursive schema");
      }
      const target = resolveRef(root, node.$ref);
      if (target) visit(target, [...stack, node.$ref]);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "$defs" || key === "definitions") continue;
      if (typeof value === "object" && value !== null) visit(value, stack);
    }
  };
  visit(root, []);
}
