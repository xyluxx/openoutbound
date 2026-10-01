import { UNTRUSTED_CONTENT_RULE, wrapUntrusted } from "./prompt.js";

export { UNTRUSTED_CONTENT_RULE };

/** Default cap for one untrusted block (characters). Long pages and threads are truncated. */
export const UNTRUSTED_MAX_CHARS = 20_000;

export interface UntrustedOptions {
  /** Truncate the content after this many characters (default 20 000). */
  maxChars?: number;
}

// Patterns are built from escaped strings on purpose, so that no editing tool can turn the
// escapes into invisible literal characters.

/** Zero-width and bidi control characters that can hide or reorder text. */
// biome-ignore lint/complexity/useRegexLiterals: escapes must stay visible (see above)
const INVISIBLE = new RegExp("[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF]", "g");
/** C0 control characters except tab, line feed and carriage return. */
// biome-ignore lint/complexity/useRegexLiterals: escapes must stay visible (see above)
const CONTROL = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]", "g");
/**
 * An opening bracket (ASCII or a lookalike a model may read as "<": fullwidth, small form, angle
 * quotes, math brackets) followed by the tag name, with or without a (fullwidth) slash.
 */
// biome-ignore lint/complexity/useRegexLiterals: escapes must stay visible (see above)
const TAG_LIKE = new RegExp(
  "[<\\uFF1C\\uFE64\\u2039\\u27E8\\u3008\\u2329](\\s*[/\\uFF0F]?\\s*untrusted_content)",
  "gi",
);

/**
 * Wraps text from outside parties (inbound emails, LinkedIn messages, web pages, imported rows)
 * in an `<untrusted_content source="...">` block for prompts (spec section 6). Use it for every
 * piece of outside text and put `UNTRUSTED_CONTENT_RULE` in the prompt's system text.
 *
 * Hardening on top of `wrapUntrusted`: invisible and control characters are removed, tag-like
 * text is escaped even when written with lookalike brackets, and long content is truncated with
 * a marker. Normal text renders exactly like `wrapUntrusted`.
 */
export function untrusted(
  source: string,
  text: string | null | undefined,
  options: UntrustedOptions = {},
): string {
  const maxChars = options.maxChars ?? UNTRUSTED_MAX_CHARS;
  let content = (text ?? "").replace(INVISIBLE, "").replace(CONTROL, "");
  content = content.replace(TAG_LIKE, "&lt;$1");
  if (content.length > maxChars) {
    const rest = content.length - maxChars;
    content = `${content.slice(0, maxChars)}\n[truncated: ${rest} more characters]`;
  }
  const safeSource =
    source
      .replace(INVISIBLE, "")
      .replace(/[\r\n\t]+/g, " ")
      .trim()
      .slice(0, 120) || "unknown";
  return wrapUntrusted(safeSource, content);
}

/** True when the text contains an untrusted block (used to flag outputs for agents). */
export function containsUntrusted(text: string | null | undefined): boolean {
  return typeof text === "string" && /<untrusted_content\b/i.test(text);
}
