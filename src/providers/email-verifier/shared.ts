/** Small helpers shared by the email verifier adapters. */
import type { FailureClass } from "../../core/failures.js";

/** A provider's error text as a name to look up: "Invalid API key." -> "invalid_api_key". */
export function errorName(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * The class of a documented error, looked up by name: the error text, normalized with
 * {@link errorName}, equals a documented name or starts with one ("Invalid API key. Please
 * check your key." is `invalid_api_key`). Undefined for errors the docs do not list.
 */
export function documentedErrorClass(
  text: string,
  documented: Record<string, FailureClass>,
): FailureClass | undefined {
  const name = errorName(text);
  for (const [documentedName, failureClass] of Object.entries(documented)) {
    if (name === documentedName || name.startsWith(`${documentedName}_`)) return failureClass;
  }
  return undefined;
}
