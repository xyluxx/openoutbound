/**
 * Redaction for audit rows and stored idempotent responses: secrets never reach the database
 * in clear text through these paths, and long free text (message bodies) is truncated.
 */

/** snake_case field names that hold secrets (`input_tokens` or `secret_id` do not match). */
const SECRET_FIELD =
  /^(?:.*_)?(?:secret|secrets|password|passwd|token|api_?key|authorization|credentials?|private_?key|cookie|webhook_url)$/i;
/** camelCase variants (`accessToken`, `clientSecret`). */
const SECRET_FIELD_CAMEL = /[a-z](?:Token|Secret|Password|Credentials?)$/;
const API_KEY_VALUE = /^oo_[A-Za-z0-9_-]{43}$/;
const WEBHOOK_SECRET_VALUE = /^whsec_[A-Za-z0-9_-]{20,}$/;
/** Slack incoming-webhook URLs are credentials: anyone holding one can post to the channel. */
const SLACK_WEBHOOK_VALUE = /^https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\//i;

/** True when a field with this name holds a secret. */
export function isSecretField(name: string): boolean {
  return SECRET_FIELD.test(name) || SECRET_FIELD_CAMEL.test(name);
}

export const REDACTED = "[redacted]";
export const SHOWN_ONCE = "[shown once]";

export interface RedactOptions {
  /** Strings longer than this are truncated. Default 500. */
  maxString?: number;
  /** Deeper values are replaced by "[...]". Default 6. */
  maxDepth?: number;
  /** Arrays are cut to this many items. Default 50. */
  maxItems?: number;
}

function looksLikeSecretValue(value: string): boolean {
  return (
    API_KEY_VALUE.test(value) || WEBHOOK_SECRET_VALUE.test(value) || SLACK_WEBHOOK_VALUE.test(value)
  );
}

/**
 * Deep copy with secret-looking fields replaced by "[redacted]" and long strings truncated
 * ("... (N more chars)"). Safe on any JSON-like input; Dates become ISO strings.
 */
export function redact(value: unknown, options: RedactOptions = {}): unknown {
  const maxString = options.maxString ?? 500;
  const maxDepth = options.maxDepth ?? 6;
  const maxItems = options.maxItems ?? 50;

  const walk = (current: unknown, depth: number): unknown => {
    if (current === null || current === undefined) return current ?? null;
    if (typeof current === "string") {
      if (looksLikeSecretValue(current)) return REDACTED;
      return current.length > maxString
        ? `${current.slice(0, maxString)}... (${current.length - maxString} more chars)`
        : current;
    }
    if (typeof current === "number" || typeof current === "boolean") return current;
    if (typeof current === "bigint") return current.toString();
    if (current instanceof Date) return current.toISOString();
    if (depth >= maxDepth) return "[...]";
    if (Array.isArray(current)) {
      const items = current.slice(0, maxItems).map((item) => walk(item, depth + 1));
      if (current.length > maxItems) items.push(`[${current.length - maxItems} more items]`);
      return items;
    }
    if (typeof current === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(current as Record<string, unknown>)) {
        if (inner === undefined) continue;
        out[key] = isSecretField(key) && inner !== null ? REDACTED : walk(inner, depth + 1);
      }
      return out;
    }
    return String(current);
  };
  return walk(value, 0);
}

/** Audit input summary: redacted object, or null when there is nothing to record. */
export function auditInputSummary(input: unknown): Record<string, unknown> | null {
  if (input === null || input === undefined) return null;
  const redacted = redact(input);
  if (typeof redacted === "object" && redacted !== null && !Array.isArray(redacted)) {
    return redacted as Record<string, unknown>;
  }
  return { value: redacted };
}

/**
 * Replaces one-time secrets (new API keys, signing secrets) in an operation result before it is
 * stored for idempotent replay, so the plain value only ever exists in the first response.
 */
export function stripOneTimeSecrets(value: unknown): unknown {
  if (typeof value === "string") return looksLikeSecretValue(value) ? SHOWN_ONCE : value;
  if (Array.isArray(value)) return value.map(stripOneTimeSecrets);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] =
        isSecretField(key) && typeof inner === "string" ? SHOWN_ONCE : stripOneTimeSecrets(inner);
    }
    return out;
  }
  return value;
}
