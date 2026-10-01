import type { z } from "zod";
import { isJsonObject, type JsonSchema, resolveRef, schemaTypes } from "./json-schema.js";

/**
 * Parses a model reply into JSON. Accepts plain JSON, JSON inside a Markdown code fence, or JSON
 * surrounded by prose (first "{" or "[" to the matching last bracket). Returns undefined when
 * nothing parses.
 */
export function parseJsonReply(text: string | null | undefined): unknown {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;

  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/.exec(trimmed);
  if (fence?.[1]) {
    const fenced = tryParse(fence[1].trim());
    if (fenced !== undefined) return fenced;
  }
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const start = trimmed.indexOf(open);
    const end = trimmed.lastIndexOf(close);
    if (start !== -1 && end > start) {
      const sliced = tryParse(trimmed.slice(start, end + 1));
      if (sliced !== undefined) return sliced;
    }
  }
  return undefined;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Removes `null` values on optional properties whose schema does not allow null. Strict-mode
 * providers must answer every property, so they send null for "absent"; zod's `.optional()`
 * rejects null, and `.default()` only applies to undefined. Walks nested objects, arrays,
 * `$ref`s and unions (picking the variant that matches the value's discriminator).
 */
export function stripNullOptionals(value: unknown, schema: JsonSchema): unknown {
  return strip(value, schema, schema, 0);
}

function strip(value: unknown, node: JsonSchema, root: JsonSchema, depth: number): unknown {
  if (depth > 64) return value;
  const schema = deref(node, root);
  if (!schema) return value;
  if (Array.isArray(value)) {
    const items = arraySchema(schema, root)?.items;
    return isJsonObject(items)
      ? value.map((item) => strip(item, items as JsonSchema, root, depth + 1))
      : value;
  }
  if (!isJsonObject(value)) return value;
  const objectSchema = pickObjectSchema(schema, value, root);
  if (!objectSchema) return value;
  const properties = isJsonObject(objectSchema.properties) ? objectSchema.properties : {};
  const required = new Set(Array.isArray(objectSchema.required) ? objectSchema.required : []);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const propertySchema = properties[key];
    if (!isJsonObject(propertySchema)) {
      out[key] = item;
      continue;
    }
    if (item === null && !required.has(key) && !allowsNull(propertySchema, root, 0)) continue;
    out[key] = strip(item, propertySchema, root, depth + 1);
  }
  return out;
}

function deref(node: JsonSchema, root: JsonSchema): JsonSchema | undefined {
  let current: JsonSchema | undefined = node;
  for (let hops = 0; current && typeof current.$ref === "string" && hops < 16; hops++) {
    current = resolveRef(root, current.$ref);
  }
  return current;
}

function variantsOf(schema: JsonSchema): JsonSchema[] {
  const list = schema.anyOf ?? schema.oneOf ?? schema.allOf;
  return Array.isArray(list) ? list.filter(isJsonObject) : [];
}

function arraySchema(schema: JsonSchema, root: JsonSchema): JsonSchema | undefined {
  if (schemaTypes(schema).includes("array") || schema.items !== undefined) return schema;
  for (const variant of variantsOf(schema)) {
    const resolved = deref(variant, root);
    const found = resolved ? arraySchema(resolved, root) : undefined;
    if (found) return found;
  }
  return undefined;
}

function pickObjectSchema(
  schema: JsonSchema,
  value: Record<string, unknown>,
  root: JsonSchema,
): JsonSchema | undefined {
  if (isJsonObject(schema.properties)) return schema;
  const candidates = variantsOf(schema)
    .map((variant) => deref(variant, root))
    .filter((variant): variant is JsonSchema => variant !== undefined)
    .map((variant) => (isJsonObject(variant.properties) ? variant : undefined))
    .filter((variant): variant is JsonSchema => variant !== undefined);
  if (candidates.length <= 1) return candidates[0];
  const byConst = candidates.find((candidate) => {
    const properties = candidate.properties as Record<string, unknown>;
    const discriminators = Object.entries(properties).filter(
      ([, property]) => isJsonObject(property) && property.const !== undefined,
    );
    return (
      discriminators.length > 0 &&
      discriminators.every(([key, property]) => value[key] === (property as JsonSchema).const)
    );
  });
  if (byConst) return byConst;
  const byRequired = candidates.find((candidate) =>
    (Array.isArray(candidate.required) ? candidate.required : []).every(
      (key) => typeof key === "string" && key in value,
    ),
  );
  return byRequired ?? candidates[0];
}

function allowsNull(node: JsonSchema, root: JsonSchema, depth: number): boolean {
  if (depth > 16) return false;
  const schema = deref(node, root);
  if (!schema) return true;
  if (Object.keys(schema).filter((key) => key !== "description").length === 0) return true;
  if (schemaTypes(schema).includes("null")) return true;
  if (schema.const === null) return true;
  if (Array.isArray(schema.enum) && schema.enum.includes(null)) return true;
  return variantsOf(schema).some((variant) => allowsNull(variant, root, depth + 1));
}

/** Zod issues as short lines for repair prompts and error details: "subject: Too big ...". */
export function describeIssues(issues: readonly z.core.$ZodIssue[], limit = 12): string[] {
  const lines = issues.slice(0, limit).map((issue) => {
    const path = issue.path.map(String).join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  if (issues.length > limit) lines.push(`(and ${issues.length - limit} more problems)`);
  return lines;
}
