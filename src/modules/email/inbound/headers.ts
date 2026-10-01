/** Header lookup and address helpers for inbound mail (header names are case-insensitive). */

export type HeaderMap = Record<string, string>;

/** Lowercases header names (first value wins). */
export function normalizeHeaders(headers: Record<string, string> | undefined): HeaderMap {
  const out: HeaderMap = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    const name = key.trim().toLowerCase();
    if (name && out[name] === undefined) out[name] = String(value ?? "");
  }
  return out;
}

const ADDRESS = /[^\s<>"'(),;:]+@[^\s<>"'(),;:]+\.[a-z0-9-]{2,}/i;

/** The email address in `Name <address>` or a bare address, lowercased ("" when none). */
export function parseAddress(value: string | null | undefined): string {
  if (!value) return "";
  const bracket = value.match(/<([^>]+)>/);
  const candidate = (bracket?.[1] ?? value).trim();
  const match = candidate.match(ADDRESS);
  return match ? match[0].toLowerCase().replace(/\.$/, "") : "";
}

/** Message-IDs in a header value, each with angle brackets. */
export function extractMessageIds(value: string | null | undefined): string[] {
  if (!value) return [];
  const ids = value.match(/<[^<>\s]+>/g);
  if (ids) return ids;
  const bare = value.trim();
  return bare && !/\s/.test(bare) ? [`<${bare.replace(/^<|>$/g, "")}>`] : [];
}

/** One Message-ID with angle brackets, or null. */
export function normalizeMessageId(value: string | null | undefined): string | null {
  return extractMessageIds(value)[0] ?? null;
}

/** Local part of an address ("" when none). */
export function localPart(address: string): string {
  const at = address.lastIndexOf("@");
  return at > 0 ? address.slice(0, at).toLowerCase() : "";
}

/** Domain of an address ("" when none). */
export function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at > 0 ? address.slice(at + 1).toLowerCase() : "";
}
