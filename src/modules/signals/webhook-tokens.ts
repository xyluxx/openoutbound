/** Tokens for the inbound signals webhook. Only a SHA-256 hash is stored. */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { ActorRef } from "../../core/context.js";
import type { Db } from "../../db/client.js";
import { type SignalWebhookToken, signal_webhook_tokens } from "../../db/schema/index.js";

export const WEBHOOK_TOKEN_PREFIX = "oosig_";

export function generateWebhookToken(): string {
  return `${WEBHOOK_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashWebhookToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Public URL a sender posts to. */
export function webhookUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/hooks/signals/${token}`;
}

/** Creates a token; the plaintext is returned once and only its hash is stored. */
export async function createWebhookToken(
  db: Db,
  input: { workspaceId: string; name: string; createdBy?: ActorRef | null },
): Promise<{ row: SignalWebhookToken; token: string }> {
  const token = generateWebhookToken();
  const [row] = await db
    .insert(signal_webhook_tokens)
    .values({
      workspace_id: input.workspaceId,
      name: input.name,
      prefix: token.slice(0, WEBHOOK_TOKEN_PREFIX.length + 6),
      token_hash: hashWebhookToken(token),
      created_by: input.createdBy ?? null,
    })
    .returning();
  if (!row) throw new Error("Webhook token insert returned no row");
  return { row, token };
}

/** The active (not revoked) token row for a plaintext token, or null. */
export async function findActiveToken(db: Db, token: string): Promise<SignalWebhookToken | null> {
  if (!token.startsWith(WEBHOOK_TOKEN_PREFIX) || token.length > 200) return null;
  const [row] = await db
    .select()
    .from(signal_webhook_tokens)
    .where(
      and(
        eq(signal_webhook_tokens.token_hash, hashWebhookToken(token)),
        isNull(signal_webhook_tokens.revoked_at),
      ),
    );
  return row ?? null;
}

/** In-memory token bucket per key (default 60 requests per minute). */
export interface RateLimiter {
  /** True when a request may proceed; otherwise the seconds to wait. */
  take(key: string, now?: number): { ok: true } | { ok: false; retryAfterSeconds: number };
}

export function createRateLimiter(
  options: { capacity?: number; perSeconds?: number } = {},
): RateLimiter {
  const capacity = options.capacity ?? 60;
  const refillPerMs = capacity / ((options.perSeconds ?? 60) * 1000);
  const buckets = new Map<string, { tokens: number; at: number }>();
  return {
    take(key, now = Date.now()) {
      const bucket = buckets.get(key) ?? { tokens: capacity, at: now };
      bucket.tokens = Math.min(capacity, bucket.tokens + (now - bucket.at) * refillPerMs);
      bucket.at = now;
      buckets.set(key, bucket);
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return { ok: true };
      }
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerMs / 1000)),
      };
    },
  };
}
