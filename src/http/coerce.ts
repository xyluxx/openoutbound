import { OpenOutboundError } from "../core/errors.js";
import { type JsonSchema, schemaProperties, schemaRequired } from "../mcp/json-schema.js";

/**
 * Turns text (query parameters, CLI flags) into typed operation input using the operation's
 * input JSON Schema: numbers, booleans, arrays (repeated values or comma lists or a JSON
 * array) and objects (JSON).
 */
export type FieldKind = "string" | "number" | "integer" | "boolean" | "array" | "object" | "any";

export interface FieldInfo {
  name: string;
  kind: FieldKind;
  /** For arrays: the item kind. */
  itemKind?: FieldKind;
  /** Allowed values for string enums. */
  enum?: string[];
  required: boolean;
  description?: string;
}

export function fieldsOf(schema: JsonSchema): FieldInfo[] {
  const required = new Set(schemaRequired(schema));
  return Object.entries(schemaProperties(schema)).map(([name, property]) => {
    const shape = kindOf(property);
    const info: FieldInfo = { name, kind: shape.kind, required: required.has(name) };
    if (shape.itemKind) info.itemKind = shape.itemKind;
    if (shape.enum) info.enum = shape.enum;
    const description = describe(property);
    if (description) info.description = description;
    return info;
  });
}

function describe(schema: JsonSchema): string | undefined {
  if (typeof schema.description === "string") return schema.description;
  for (const key of ["anyOf", "oneOf"] as const) {
    const members = schema[key];
    if (Array.isArray(members)) {
      for (const member of members as JsonSchema[]) {
        if (typeof member.description === "string") return member.description;
      }
    }
  }
  return undefined;
}

export function kindOf(schema: JsonSchema): {
  kind: FieldKind;
  itemKind?: FieldKind;
  enum?: string[];
} {
  for (const key of ["anyOf", "oneOf"] as const) {
    const members = schema[key];
    if (Array.isArray(members)) {
      const first = (members as JsonSchema[]).find((member) => member.type !== "null");
      if (first) return kindOf(first);
    }
  }
  let type = schema.type;
  if (Array.isArray(type)) type = type.find((t) => t !== "null");
  if (Array.isArray(schema.enum) && schema.enum.every((v) => typeof v === "string")) {
    return { kind: "string", enum: schema.enum as string[] };
  }
  if (typeof schema.const === "string") return { kind: "string", enum: [schema.const] };
  switch (type) {
    case "string":
    case "number":
    case "integer":
    case "boolean":
    case "object":
      return { kind: type };
    case "array": {
      const items = (schema.items ?? {}) as JsonSchema;
      const item = kindOf(items);
      return { kind: "array", itemKind: item.kind === "array" ? "any" : item.kind };
    }
    default:
      return { kind: "any" };
  }
}

function invalidValue(
  name: string,
  raw: string,
  expected: string,
  hint = `Pass ${name} as ${expected}.`,
): OpenOutboundError {
  return new OpenOutboundError(
    "validation_failed",
    `Invalid value for ${name}: "${raw}" is not ${expected}.`,
    {
      hint,
      details: { issues: [{ path: name, message: `Expected ${expected}` }] },
    },
  );
}

/** One text value to the given kind. Throws `validation_failed` naming the field. */
export function coerceScalar(raw: string, kind: FieldKind, name: string): unknown {
  switch (kind) {
    case "string":
      return raw;
    case "number":
    case "integer": {
      const trimmed = raw.trim();
      const value = Number(trimmed);
      if (trimmed === "" || !Number.isFinite(value)) {
        throw invalidValue(name, raw, kind === "integer" ? "an integer" : "a number");
      }
      if (kind === "integer" && !Number.isInteger(value)) {
        throw invalidValue(name, raw, "an integer");
      }
      return value;
    }
    case "boolean": {
      const normalized = raw.trim().toLowerCase();
      if (["true", "1", "yes", "on", ""].includes(normalized)) return true;
      if (["false", "0", "no", "off"].includes(normalized)) return false;
      throw invalidValue(name, raw, "true or false");
    }
    case "object":
      return parseJson(raw, name, "a JSON object");
    case "array":
      return parseJson(raw, name, "a JSON array");
    default: {
      const trimmed = raw.trim();
      if (/^[[{"]/.test(trimmed) || ["true", "false", "null"].includes(trimmed)) {
        try {
          return JSON.parse(trimmed) as unknown;
        } catch {
          return raw;
        }
      }
      return raw;
    }
  }
}

/**
 * JSON that lost its double quotes on the way in, such as `{company:{postal_address:x}}`:
 * Windows PowerShell 5.1 strips them from every argument it passes to node.
 */
function looksQuoteStripped(raw: string): boolean {
  const text = raw.trim();
  return !text.includes('"') && /^[[{][\s[{]*[A-Za-z_]/.test(text);
}

/** The PowerShell 5.1 way: the JSON in a file, its name after "@". */
function quoteStrippedHint(name: string, expected: string): string {
  const bare = name.replace(/^-+/, "");
  const flag = `--${bare.replaceAll("_", "-")}`;
  return `Pass ${name} as ${expected}. Its double quotes are missing, which is what Windows PowerShell 5.1 does to JSON in an argument: write the JSON to a file and pass ${flag} '@${bare}.json' instead (docs/getting-started/install.md, JSON flags in Windows PowerShell 5.1).`;
}

export function parseJson(raw: string, name: string, expected: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw invalidValue(
      name,
      raw.length > 80 ? `${raw.slice(0, 77)}...` : raw,
      expected,
      looksQuoteStripped(raw) ? quoteStrippedHint(name, expected) : undefined,
    );
  }
}

/**
 * All text values given for one field to its typed value. Arrays accept repeated values,
 * comma lists and JSON arrays (`[...]`); other kinds use the last value.
 */
export function coerceField(values: readonly string[], field: FieldInfo): unknown {
  if (field.kind === "array") {
    const out: unknown[] = [];
    for (const value of values) {
      const trimmed = value.trim();
      if (trimmed.startsWith("[")) {
        const parsed = parseJson(trimmed, field.name, "a JSON array");
        if (!Array.isArray(parsed)) throw invalidValue(field.name, value, "a JSON array");
        out.push(...parsed);
        continue;
      }
      const itemKind = field.itemKind ?? "string";
      const parts = itemKind === "object" || itemKind === "any" ? [trimmed] : trimmed.split(",");
      for (const part of parts.map((p) => p.trim()).filter(Boolean)) {
        out.push(coerceScalar(part, itemKind, field.name));
      }
    }
    return out;
  }
  const last = values.at(-1) ?? "";
  return coerceScalar(last, field.kind, field.name);
}

/** `dry_run` is a boolean for every operation, also those without one (the engine refuses). */
const DRY_RUN_FIELD: FieldInfo = { name: "dry_run", kind: "boolean", required: false };

/** Query parameters to typed input fields; unknown parameters pass through as strings. */
export function coerceQuery(
  query: Record<string, string[]>,
  schema: JsonSchema,
): Record<string, unknown> {
  const fields = new Map(fieldsOf(schema).map((field) => [field.name, field]));
  const out: Record<string, unknown> = {};
  for (const [name, values] of Object.entries(query)) {
    if (values.length === 0) continue;
    const field = fields.get(name) ?? (name === "dry_run" ? DRY_RUN_FIELD : undefined);
    out[name] = field ? coerceField(values, field) : values.at(-1);
  }
  return out;
}
