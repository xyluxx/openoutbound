/**
 * Deep diffs for the change log. Paths are dotted (`booking.mode`); a key that is not a plain
 * word is written in brackets as a JSON string (`ai.task_models["campaigns.write_email"].model`)
 * so every path parses back. Arrays are compared as whole values. In an entry, a missing
 * `before` means the path did not exist before (an undo removes it) and a missing `after` means
 * it was removed; `null` is a stored value like any other.
 */
import { isDeepStrictEqual } from "node:util";
import type { ChangeDiffEntry } from "../../db/schema/index.js";

type PlainObject = Record<string, unknown>;

const PLAIN_KEY = /^[A-Za-z0-9_-]+$/;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value as stored in JSON (dates become ISO strings, undefined fields disappear). */
export function toJsonValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/** Path segments to the stored path text. */
export function formatPath(segments: readonly string[]): string {
  let out = "";
  for (const segment of segments) {
    if (PLAIN_KEY.test(segment)) out += out ? `.${segment}` : segment;
    else out += `[${JSON.stringify(segment)}]`;
  }
  return out;
}

/** Stored path text back to its segments ("" is the whole value). */
export function parsePath(path: string): string[] {
  const segments: string[] = [];
  let index = 0;
  while (index < path.length) {
    const char = path[index];
    if (char === ".") {
      index++;
      continue;
    }
    if (char === "[" && path[index + 1] === '"') {
      let end = index + 2;
      while (end < path.length && path[end] !== '"') end += path[end] === "\\" ? 2 : 1;
      segments.push(JSON.parse(path.slice(index + 1, end + 1)) as string);
      index = end + 2;
      continue;
    }
    let end = index;
    while (end < path.length && path[end] !== "." && path[end] !== "[") end++;
    segments.push(path.slice(index, end));
    index = end;
  }
  return segments;
}

function walk(before: unknown, after: unknown, path: string[], out: ChangeDiffEntry[]): void {
  if (before === undefined && after === undefined) return;
  const beforeIsObject = isPlainObject(before) || before === undefined;
  const afterIsObject = isPlainObject(after) || after === undefined;
  if (beforeIsObject && afterIsObject) {
    const a = (before ?? {}) as PlainObject;
    const b = (after ?? {}) as PlainObject;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      walk(a[key], b[key], [...path, key], out);
    }
    return;
  }
  if (isDeepStrictEqual(before, after)) return;
  const entry = { path: formatPath(path) } as ChangeDiffEntry;
  if (before !== undefined) entry.before = before;
  if (after !== undefined) entry.after = after;
  out.push(entry);
}

/**
 * Every leaf that differs between `before` and `after`, in key order. `null` or `undefined` at
 * the top means "did not exist" (a create or a delete lists every field). Returns [] when equal.
 */
export function diffValues(before: unknown, after: unknown): ChangeDiffEntry[] {
  const out: ChangeDiffEntry[] = [];
  walk(toJsonValue(before ?? undefined), toJsonValue(after ?? undefined), [], out);
  return out;
}

/** True when one path is the other or contains it (`booking` and `booking.mode` overlap). */
export function pathsOverlap(a: string, b: string): boolean {
  const left = parsePath(a);
  const right = parsePath(b);
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function setAt(root: unknown, segments: string[], value: unknown): unknown {
  const [head, ...rest] = segments;
  if (head === undefined) return value;
  const node: PlainObject = isPlainObject(root) ? { ...root } : {};
  node[head] = setAt(node[head], rest, value);
  return node;
}

function removeAt(root: unknown, segments: string[]): unknown {
  const [head, ...rest] = segments;
  if (head === undefined || !isPlainObject(root) || !(head in root)) return root;
  const node: PlainObject = { ...root };
  if (rest.length === 0) {
    delete node[head];
    return node;
  }
  const child = removeAt(node[head], rest);
  // A parent left empty by the removal goes too, so stored settings stay minimal.
  if (isPlainObject(child) && Object.keys(child).length === 0) delete node[head];
  else node[head] = child;
  return node;
}

/**
 * `current` with every path of `diff` set back to its `before` value; paths that did not exist
 * before are removed. The input is not modified.
 */
export function revertDiff(current: unknown, diff: readonly ChangeDiffEntry[]): unknown {
  let value = toJsonValue(current);
  for (const entry of diff) {
    const segments = parsePath(entry.path);
    if (entry.before === undefined) value = removeAt(value, segments);
    else value = setAt(value, segments, toJsonValue(entry.before));
  }
  return value;
}

/** A short text for a value in one-line summaries. */
export function describeValue(value: unknown): string {
  if (value === undefined) return "(none)";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}
