import type { EngineConfig } from "../../core/config.js";
import { isId } from "../../core/ids.js";
import { isPublicUrl } from "../../runtime/notify.js";
import { deriveKey, derivePreviousKeys, hmacBase64Url, safeEqual } from "./signing.js";

const TOKEN_KEY_INFO = "openoutbound/unsubscribe-token/v1";

/** What an unsubscribe link identifies. */
export interface UnsubscribeTarget {
  messageId: string;
  workspaceId: string;
  /** Recipient address (lowercase), so the link works even after the message row is deleted. */
  email: string;
}

interface Payload {
  m: string;
  w: string;
  e: string;
}

/**
 * Unsubscribe token: `<base64url JSON {m, w, e}>.<base64url HMAC-SHA256(payload)>` with a key
 * derived (HKDF) from the vault secret key. Tokens never expire (opt-out links must keep working)
 * and stay valid after the message, campaign or person is deleted. After a key rotation, links
 * signed with an older key still work while that key is in OPENOUTBOUND_PREVIOUS_SECRET_KEYS.
 */
export function signUnsubscribeToken(config: EngineConfig, target: UnsubscribeTarget): string {
  const payload: Payload = {
    m: target.messageId,
    w: target.workspaceId,
    e: target.email.trim().toLowerCase(),
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${hmacBase64Url(deriveKey(config, TOKEN_KEY_INFO), encoded)}`;
}

/** The target of a valid token, or null (constant-time signature check). */
export function verifyUnsubscribeToken(
  config: EngineConfig,
  token: string,
): UnsubscribeTarget | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || token.length > 2048) return null;
  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!signature) return null;
  const keys = [deriveKey(config, TOKEN_KEY_INFO), ...derivePreviousKeys(config, TOKEN_KEY_INFO)];
  if (!keys.some((key) => safeEqual(signature, hmacBase64Url(key, encoded)))) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<Payload>;
    if (!isId(payload.m, "msg") || !isId(payload.w, "ws") || typeof payload.e !== "string")
      return null;
    return { messageId: payload.m, workspaceId: payload.w, email: payload.e };
  } catch {
    return null;
  }
}

/** Public one-click unsubscribe URL (`<base>/u/<token>`). */
export function unsubscribeUrl(config: EngineConfig, target: UnsubscribeTarget): string {
  return `${config.baseUrl}/u/${signUnsubscribeToken(config, target)}`;
}

/**
 * Whether unsubscribe links and RFC 8058 One-Click work: recipients must reach the engine, so
 * the base URL has to be a public https URL. Without one, real email carries no link and no
 * List-Unsubscribe-Post: the List-Unsubscribe mailto and a footer line asking people to reply
 * "unsubscribe" remain (sandbox email keeps its simulated link).
 */
export function unsubscribeReadiness(config: Pick<EngineConfig, "baseUrl">): {
  one_click: boolean;
  reason: string | null;
} {
  let https = false;
  try {
    https = new URL(config.baseUrl).protocol === "https:";
  } catch {
    https = false;
  }
  if (https && isPublicUrl(config.baseUrl)) return { one_click: true, reason: null };
  return {
    one_click: false,
    reason: `OPENOUTBOUND_BASE_URL (${config.baseUrl}) is not a public https URL, so emails carry no unsubscribe link and no One-Click header; recipients opt out by replying "unsubscribe" (List-Unsubscribe mailto). Set OPENOUTBOUND_BASE_URL to the engine's public https address.`,
  };
}
