/**
 * Guard for AI summaries ("facts only from the report data"): every number the summary cites
 * must appear in the report, as a value, its absolute value, a rounded form, or inside one of
 * the report's strings (names, dates). Small counts (0-10) are always allowed.
 */

const NUMBER_IN_TEXT = /\d[\d,]*(?:\.\d+)?/g;
const SMALL_NUMBERS = 10;

function canonical(value: number): string {
  return String(Number(value.toFixed(4)));
}

function numbersInText(text: string): number[] {
  const found: number[] = [];
  for (const match of text.matchAll(NUMBER_IN_TEXT)) {
    const value = Number(match[0].replaceAll(",", ""));
    if (Number.isFinite(value)) found.push(value);
  }
  return found;
}

/** Every number the report contains, in the forms a writer might cite it. */
export function allowedNumbers(source: unknown): Set<string> {
  const allowed = new Set<string>();
  for (let n = 0; n <= SMALL_NUMBERS; n++) allowed.add(String(n));
  const add = (value: number) => {
    for (const form of [value, Math.abs(value), Math.round(value), Math.round(Math.abs(value))]) {
      allowed.add(canonical(form));
    }
    allowed.add(canonical(Math.round(Math.abs(value) * 10) / 10));
  };
  const walk = (value: unknown): void => {
    if (typeof value === "number") add(value);
    else if (typeof value === "string") for (const found of numbersInText(value)) add(found);
    else if (Array.isArray(value)) for (const item of value) walk(item);
    else if (value && typeof value === "object")
      for (const item of Object.values(value)) walk(item);
  };
  walk(source);
  return allowed;
}

/** Numbers cited in `text` that the report does not contain (empty when the text is clean). */
export function unsupportedNumbers(text: string, source: unknown): string[] {
  const allowed = allowedNumbers(source);
  const bad = new Set<string>();
  for (const value of numbersInText(text)) {
    if (!allowed.has(canonical(value))) bad.add(canonical(value));
  }
  return [...bad];
}
