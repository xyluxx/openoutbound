import type { HeaderMap } from "./headers.js";

/** Headers set by warmup networks (names are matched in lowercase). */
const WARMUP_HEADERS = [
  "x-warmup",
  "x-warmup-id",
  "x-lemwarm",
  "x-mailwarm",
  "x-instantly-warmup",
  "x-smartlead-warmup",
  "x-warmbox",
  "x-mailreach",
  "x-warmy",
];

/** Tags warmup services put in subjects or bodies. */
const WARMUP_TAGS =
  /\b(lemwarm|mailwarm|warmup ?inbox|warmbox|mailreach|warmy\.io|instantly warm-?up)\b/i;

/**
 * True when the email comes from a warmup network (ignored by the inbound path). `patterns` are
 * per-mailbox extras: plain text is matched case-insensitively in the subject and body,
 * `header:<name>` matches a header that is present.
 */
export function isWarmupEmail(
  input: { subject: string; text: string; headers: HeaderMap },
  patterns: readonly string[] = [],
): boolean {
  const names = Object.keys(input.headers);
  if (names.some((name) => WARMUP_HEADERS.includes(name) || /^x-.*warm-?up/.test(name)))
    return true;
  if (WARMUP_TAGS.test(input.subject) || WARMUP_TAGS.test(input.text.slice(0, 5000))) return true;
  const haystack = `${input.subject}\n${input.text.slice(0, 20_000)}`.toLowerCase();
  for (const raw of patterns) {
    const pattern = raw.trim().toLowerCase();
    if (!pattern) continue;
    if (pattern.startsWith("header:")) {
      if (names.includes(pattern.slice(7).trim())) return true;
    } else if (haystack.includes(pattern)) {
      return true;
    }
  }
  return false;
}
