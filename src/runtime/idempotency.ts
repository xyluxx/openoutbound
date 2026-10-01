/**
 * Idempotency keys (spec 6): the same key and request replay the stored response for 24 hours;
 * the same key with a different request fails with `idempotency_mismatch`. A placeholder row
 * is claimed before the handler runs, so two concurrent calls with one key never both execute.
 */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Clock } from "../core/clock.js";
import { OpenOutboundError } from "../core/errors.js";
import type { Db } from "../db/client.js";
import { idempotency_records } from "../db/schema/index.js";

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface IdempotencyTarget {
  /** "instance" or a workspace id. */
  scope: string;
  key: string;
}

export type IdempotencyClaim = { kind: "new" } | { kind: "replay"; response: unknown };

/** JSON with sorted object keys, so equal inputs hash equally whatever the key order. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, inner]) => inner !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, inner]) => `${JSON.stringify(k)}:${stableStringify(inner)}`).join(",")}}`;
}

export function requestHash(operationId: string, input: unknown): string {
  return createHash("sha256")
    .update(`${operationId}\n${stableStringify(input)}`)
    .digest("hex");
}

/**
 * Claims the key for this request, or returns the stored response to replay. Throws
 * `idempotency_mismatch` (different request) or `conflict` (same request still running).
 */
export async function claimIdempotency(
  db: Db,
  clock: Clock,
  target: IdempotencyTarget,
  operation: string,
  hash: string,
): Promise<IdempotencyClaim> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = clock.now();
    const inserted = await db
      .insert(idempotency_records)
      .values({
        scope: target.scope,
        key: target.key,
        operation,
        request_hash: hash,
        response: null,
        created_at: now,
        expires_at: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
      })
      .onConflictDoNothing()
      .returning({ key: idempotency_records.key });
    if (inserted.length > 0) return { kind: "new" };

    const where = and(
      eq(idempotency_records.scope, target.scope),
      eq(idempotency_records.key, target.key),
    );
    const [existing] = await db.select().from(idempotency_records).where(where).limit(1);
    if (!existing) continue; // deleted in between: claim again
    if (existing.expires_at.getTime() <= now.getTime()) {
      await db
        .delete(idempotency_records)
        .where(and(where, eq(idempotency_records.expires_at, existing.expires_at)));
      continue;
    }
    if (existing.operation !== operation || existing.request_hash !== hash) {
      throw new OpenOutboundError(
        "idempotency_mismatch",
        `Idempotency key "${target.key}" was already used for a different request.`,
        {
          hint: "Use a new idempotency_key for a different input, or repeat the original request exactly.",
          details: { operation: existing.operation },
        },
      );
    }
    if (existing.response === null || existing.response === undefined) {
      throw new OpenOutboundError(
        "conflict",
        `A request with idempotency key "${target.key}" is still running.`,
        { hint: "Wait a moment and retry with the same key to get its result." },
      );
    }
    return { kind: "replay", response: existing.response };
  }
  throw new OpenOutboundError("conflict", "Could not claim the idempotency key.", {
    hint: "Retry the request.",
  });
}

export async function completeIdempotency(
  db: Db,
  target: IdempotencyTarget,
  response: unknown,
): Promise<void> {
  await db
    .update(idempotency_records)
    .set({ response: response ?? {} })
    .where(
      and(eq(idempotency_records.scope, target.scope), eq(idempotency_records.key, target.key)),
    );
}

/** Frees the key after a failed call so the client can retry with it. */
export async function releaseIdempotency(db: Db, target: IdempotencyTarget): Promise<void> {
  await db
    .delete(idempotency_records)
    .where(
      and(eq(idempotency_records.scope, target.scope), eq(idempotency_records.key, target.key)),
    );
}
