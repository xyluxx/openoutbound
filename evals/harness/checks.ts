/**
 * Assertion helpers shared by scenarios: questions about the recorded operation calls and the
 * agent's final answer. Each returns plain values so checks stay one-liners.
 */
import type { Engine } from "../../src/core/engine.js";
import type { CheckValue, OperationCall } from "./types.js";

/** Calls of one operation (optionally filtered). */
export function callsOf(
  calls: readonly OperationCall[],
  operation: string,
  where: (call: OperationCall) => boolean = () => true,
): OperationCall[] {
  return calls.filter((call) => call.operation === operation && where(call));
}

/** The first call of an operation matching the filter, or undefined. */
export function firstCall(
  calls: readonly OperationCall[],
  operation: string,
  where: (call: OperationCall) => boolean = () => true,
): OperationCall | undefined {
  return callsOf(calls, operation, where)[0];
}

/** True when the call ran as a dry run (sent dry_run true, or got a dry-run preview back). */
export function isDryRunCall(call: OperationCall): boolean {
  return call.dry_run === true || call.outcome === "dry_run";
}

/** Operations called that are not read-only (by registry effect). */
export function writeCalls(engine: Pick<Engine, "registry">, calls: readonly OperationCall[]) {
  return calls.filter((call) => {
    const operation = engine.registry.operation(call.operation);
    return operation ? operation.effect !== "read" : true;
  });
}

/** Calls that ended with an error code in the list (any error when the list is empty). */
export function failedCalls(calls: readonly OperationCall[], codes: readonly string[] = []) {
  return calls.filter(
    (call) =>
      call.outcome === "error" && (codes.length === 0 || codes.includes(call.error_code ?? "")),
  );
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ");
}

/** True when the text mentions any of the words or phrases (case-insensitive). */
export function mentionsAny(text: string, phrases: readonly (string | RegExp)[]): boolean {
  const haystack = normalize(text);
  return phrases.some((phrase) =>
    typeof phrase === "string" ? haystack.includes(phrase.toLowerCase()) : phrase.test(text),
  );
}

/** True when the number appears as a whole number in the text (1,234 and 1234 both count). */
export function mentionsNumber(text: string, value: number): boolean {
  const plain = text.replace(/(\d),(\d{3})\b/g, "$1$2");
  const pattern = Number.isInteger(value)
    ? new RegExp(`(^|[^\\d.])${value}(?![\\d]|\\.\\d)`)
    : new RegExp(`(^|[^\\d.])${value.toFixed(1).replace(".", "\\.")}(?!\\d)`);
  return pattern.test(plain);
}

/** True when a percentage (one decimal allowed) appears, e.g. 25% or 25.0 %. */
export function mentionsPercent(text: string, value: number): boolean {
  const rounded = Math.round(value * 10) / 10;
  const whole = Number.isInteger(rounded);
  const forms = whole ? [`${rounded}`, `${rounded}.0`] : [rounded.toFixed(1)];
  return forms.some((form) =>
    new RegExp(`(^|[^\\d.])${form.replace(".", "\\.")}\\s?(%|percent)`, "i").test(text),
  );
}

/** Looks like markdown: a heading, a table row or at least two list items. */
export function looksLikeMarkdown(text: string): boolean {
  const lines = text.split(/\r?\n/);
  if (lines.some((line) => /^#{1,6}\s+\S/.test(line))) return true;
  if (lines.filter((line) => /^\s*\|.+\|\s*$/.test(line)).length >= 2) return true;
  return lines.filter((line) => /^\s*([-*]|\d+\.)\s+\S/.test(line)).length >= 2;
}

/** A check outcome with a detail message on failure. */
export function outcome(passed: boolean, detail: string): CheckValue {
  return passed ? { passed: true } : { passed: false, detail };
}

/** Short list of calls for failure messages. */
export function describeCalls(calls: readonly OperationCall[]): string {
  if (calls.length === 0) return "no calls";
  return calls
    .map(
      (call) =>
        `${call.operation}${isDryRunCall(call) ? " (dry run)" : ""} -> ${call.outcome}${call.error_code ? ` ${call.error_code}` : ""}`,
    )
    .join("; ");
}
