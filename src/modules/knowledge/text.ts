/**
 * Small text helpers shared by the knowledge module: normalized keys for dedupe, titles and
 * truncation. Pure functions, no I/O.
 */

/** Lowercase letters and digits separated by single spaces ("What's the price?" -> "what s the price"). */
export function normalizeKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Collapses whitespace and cuts at `max` characters on a word boundary, adding "...". */
export function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, Math.max(0, max - 3));
  const lastSpace = cut.lastIndexOf(" ");
  const base = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${base.replace(/[\s,;:.-]+$/, "")}...`;
}

export const MAX_TITLE_CHARS = 200;

/** A title for untitled text: its first line when short, else its first words. */
export function titleFromText(text: string, fallback = "Untitled"): string {
  const firstLine =
    text
      .split("\n")
      .map((line) => stripMarkdown(line))
      .find((line) => line.length > 0) ?? "";
  if (!firstLine) return fallback;
  if (firstLine.length <= 80) return firstLine;
  return truncate(firstLine, 80);
}

/** Removes inline markdown (emphasis, links, code ticks, heading marks) from one line. */
export function stripMarkdown(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Title safe for storage: stripped, single line, at most 200 characters. */
export function cleanTitle(value: string, fallback = "Untitled"): string {
  const title = truncate(stripMarkdown(value), MAX_TITLE_CHARS);
  return title || fallback;
}
