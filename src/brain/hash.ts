import { createHash } from "node:crypto";

/**
 * JSON with sorted object keys, so equal values always serialize the same way. Dates become ISO
 * strings, bigints strings, Maps and Sets arrays; undefined object fields are dropped.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value, new WeakSet()));
}

/** Hex SHA-256 of `stableStringify(value)`, shortened to `length` characters. */
export function stableHash(value: unknown, length = 32): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, length);
}

function normalize(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return null;
  if (typeof value !== "object") return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => normalize(item, seen));
    if (value instanceof Map) {
      return [...value.entries()].map(([key, item]) => [
        normalize(key, seen),
        normalize(item, seen),
      ]);
    }
    if (value instanceof Set) return [...value].map((item) => normalize(item, seen));
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) continue;
      out[key] = normalize(item, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}
