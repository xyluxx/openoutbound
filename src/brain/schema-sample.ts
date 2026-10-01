import type { z } from "zod";
import { DEFAULT_TEST_TIME } from "../core/clock.js";

/**
 * Builds the smallest value that passes a zod schema: optional fields omitted, defaults
 * applied, nullable -> null, arrays at their minimum length, enums/unions -> first valid
 * option, strings honoring formats and length limits. Used by fake brains (tests, sandbox).
 * Throws when no valid sample can be built (e.g. a custom regex); register a handler then.
 */
export function sampleFromSchema<T>(schema: z.ZodType<T>): T {
  const candidate = sample(schema as unknown as ZodLike, 0);
  const result = schema.safeParse(candidate);
  if (result.success) return result.data;
  throw new Error(
    `sampleFromSchema: could not build a valid sample automatically (${result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ")}). Provide an explicit fake output for this schema.`,
  );
}

interface ZodLike {
  _zod: { def: Def; bag?: Record<string, unknown>; optin?: "optional" | "defaulted" };
  safeParse(value: unknown): { success: boolean };
}

interface Def {
  type: string;
  [key: string]: unknown;
}

const FORMAT_SAMPLES: Record<string, string> = {
  email: "sample@example.com",
  url: "https://example.com",
  uuid: "00000000-0000-4000-8000-000000000000",
  guid: "00000000-0000-4000-8000-000000000000",
  datetime: DEFAULT_TEST_TIME,
  date: DEFAULT_TEST_TIME.slice(0, 10),
  time: "12:00:00",
  duration: "P1D",
  ipv4: "192.0.2.1",
  ipv6: "2001:db8::1",
  cidrv4: "192.0.2.0/24",
  cidrv6: "2001:db8::/32",
  ulid: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  cuid: "cjld2cjxh0000qzrmn831i7rn",
  cuid2: "tz4a98xxat96iws9zmbrgj3a",
  nanoid: "V1StGXR8_Z5jdHi6B-myT",
  e164: "+15555550100",
  base64: "c2FtcGxl",
  base64url: "c2FtcGxl",
  hostname: "example.com",
  hex: "00",
  lowercase: "sample",
};

const MAX_DEPTH = 24;

function sample(schema: ZodLike, depth: number): unknown {
  if (depth > MAX_DEPTH) return undefined;
  const def = schema._zod.def;
  const bag = constraints(schema);
  const inner = (key: string) => sample(def[key] as ZodLike, depth + 1);

  switch (def.type) {
    case "string":
      return sampleString(bag);
    case "number":
    case "int":
      return sampleNumber(bag);
    case "bigint":
      return BigInt(Math.ceil(Number(bag.minimum ?? 0)));
    case "boolean":
      return false;
    case "date":
      return new Date(DEFAULT_TEST_TIME);
    case "null":
      return null;
    case "undefined":
    case "void":
    case "optional":
    case "default":
    case "prefault":
      // Missing values: optional stays absent, default/prefault are applied by parse.
      return undefined;
    case "any":
    case "unknown":
    case "custom":
      return null;
    case "nan":
      return Number.NaN;
    case "literal":
      return (def.values as unknown[])[0];
    case "enum":
      return Object.values(def.entries as Record<string, unknown>)[0];
    case "nullable":
      return null;
    case "nonoptional":
    case "readonly":
    case "catch":
      return inner("innerType");
    case "pipe":
      return inner("in");
    case "lazy":
      return sample((def.getter as () => ZodLike)(), depth + 1);
    case "promise":
      return Promise.resolve(inner("innerType"));
    case "array": {
      const min = Number(bag.minimum ?? 0);
      return Array.from({ length: min }, () => inner("element"));
    }
    case "tuple":
      return (def.items as ZodLike[]).map((item) => sample(item, depth + 1));
    case "record":
      return {};
    case "map":
      return new Map();
    case "set":
      return new Set();
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(def.shape as Record<string, ZodLike>)) {
        if (field._zod.optin !== undefined) continue; // optional or defaulted
        out[key] = sample(field, depth + 1);
      }
      return out;
    }
    case "union": {
      const options = def.options as ZodLike[];
      for (const option of options) {
        const value = sample(option, depth + 1);
        if (option.safeParse(value).success) return value;
      }
      return options[0] ? sample(options[0], depth + 1) : undefined;
    }
    case "intersection": {
      const left = inner("left");
      const right = inner("right");
      return isRecord(left) && isRecord(right) ? { ...left, ...right } : left;
    }
    default:
      return null;
  }
}

interface CheckLike {
  _zod: {
    def: {
      check?: string;
      format?: string;
      value?: unknown;
      inclusive?: boolean;
      minimum?: number;
      maximum?: number;
      length?: number;
    };
  };
}

/** Collects format and bounds from the schema's def and checks (zod 4 keeps them there). */
function constraints(schema: ZodLike): Record<string, unknown> {
  const def = schema._zod.def;
  const out: Record<string, unknown> = { ...schema._zod.bag };
  if (typeof def.format === "string") out.format = def.format;
  for (const check of (def.checks as CheckLike[] | undefined) ?? []) {
    const c = check._zod.def;
    switch (c.check) {
      case "string_format":
      case "number_format":
        if (c.format) out.format = c.format;
        break;
      case "min_length":
        out.minimum = c.minimum;
        break;
      case "max_length":
        out.maximum = c.maximum;
        break;
      case "length_equals":
        out.minimum = c.length;
        out.maximum = c.length;
        break;
      case "greater_than":
        out[c.inclusive ? "minimum" : "exclusiveMinimum"] = c.value;
        break;
      case "less_than":
        out[c.inclusive ? "maximum" : "exclusiveMaximum"] = c.value;
        break;
    }
  }
  return out;
}

function sampleString(bag: Record<string, unknown>): string {
  const format = typeof bag.format === "string" ? bag.format : undefined;
  let value = (format && FORMAT_SAMPLES[format]) ?? "sample";
  const min = typeof bag.minimum === "number" ? bag.minimum : undefined;
  const max = typeof bag.maximum === "number" ? bag.maximum : undefined;
  if (min !== undefined && value.length < min) value = value.padEnd(min, "x");
  if (max !== undefined && value.length > max) value = value.slice(0, max);
  return value;
}

function sampleNumber(bag: Record<string, unknown>): number {
  const num = (key: string) => (typeof bag[key] === "number" ? (bag[key] as number) : undefined);
  const minimum = num("minimum");
  const exclusiveMinimum = num("exclusiveMinimum");
  const maximum = num("maximum");
  const exclusiveMaximum = num("exclusiveMaximum");
  let value = 0;
  if (minimum !== undefined) value = Math.max(value, minimum);
  if (exclusiveMinimum !== undefined && value <= exclusiveMinimum) value = exclusiveMinimum + 1;
  if (minimum !== undefined && value < minimum) value = minimum;
  if (maximum !== undefined && value > maximum) value = maximum;
  if (exclusiveMaximum !== undefined && value >= exclusiveMaximum) value = exclusiveMaximum - 1;
  const isInt = typeof bag.format === "string" && /int/.test(bag.format);
  return isInt ? Math.ceil(value) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
