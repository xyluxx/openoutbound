/** Small helpers shared by the email finder adapters. */
import { normalizeDomain, splitName } from "../../lib/web/extract.js";
import type { FindEmailInput, FindEmailResult } from "../types.js";

export interface NameParts {
  first: string | null;
  last: string | null;
  full: string | null;
}

/** First, last and full name from whatever the input has. */
export function nameParts(input: FindEmailInput): NameParts {
  let first = input.first_name?.trim() || null;
  let last = input.last_name?.trim() || null;
  const full = input.full_name?.trim() || [first, last].filter(Boolean).join(" ") || null;
  if ((!first || !last) && full) {
    const split = splitName(full);
    first = first ?? split.first_name;
    last = last ?? split.last_name;
  }
  return { first, last, full };
}

/** Bare company domain from the input (a website URL or domain), or null. */
export function inputDomain(input: FindEmailInput): string | null {
  return input.domain ? normalizeDomain(input.domain) : null;
}

/** A "no match" answer that cost nothing. */
export function noMatch(reason: string, raw?: unknown): FindEmailResult {
  return {
    email: null,
    creditsUsed: 0,
    raw: raw === undefined ? { reason } : { reason, ...asObject(raw) },
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}

/** Lowercased address when it looks like a real, unmasked email. */
export function cleanEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!/^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/.test(email)) return null;
  return email;
}
