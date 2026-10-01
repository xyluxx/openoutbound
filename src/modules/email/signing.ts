import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { type EngineConfig, resolveSecretKey } from "../../core/config.js";
import { previousSecretKeys } from "../../runtime/vault.js";

const derived = new WeakMap<EngineConfig, Map<string, Buffer>>();

/**
 * A 32-byte key derived from the vault secret key with HKDF-SHA256 and a fixed `info` string,
 * so each use (unsubscribe links, OAuth state, PKCE) has its own key.
 */
export function deriveKey(config: EngineConfig, info: string): Buffer {
  let keys = derived.get(config);
  if (!keys) {
    keys = new Map();
    derived.set(config, keys);
  }
  let key = keys.get(info);
  if (!key) {
    key = Buffer.from(hkdfSync("sha256", resolveSecretKey(config), Buffer.alloc(0), info, 32));
    keys.set(info, key);
  }
  return key;
}

/**
 * The same key derived from each older secret key (OPENOUTBOUND_PREVIOUS_SECRET_KEYS), newest
 * first, for checking signatures made before a key rotation. Empty when none are listed or the
 * list is invalid (the vault reports that).
 */
export function derivePreviousKeys(config: EngineConfig, info: string): Buffer[] {
  let previous: Buffer[];
  try {
    previous = previousSecretKeys(config);
  } catch {
    return [];
  }
  return previous.map((secret) =>
    Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), info, 32)),
  );
}

/** HMAC-SHA256 of `data`, base64url. */
export function hmacBase64Url(key: Buffer, data: string): string {
  return createHmac("sha256", key).update(data, "utf8").digest("base64url");
}

/** SHA-256 of `data`, base64url (PKCE S256 challenge). */
export function sha256Base64Url(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("base64url");
}

/** Constant-time string comparison (false on length mismatch). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
