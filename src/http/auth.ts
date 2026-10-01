import { createHash, timingSafeEqual } from "node:crypto";
import type { Principal } from "../core/context.js";
import type { Engine } from "../core/engine.js";
import type { Via } from "../core/enums.js";
import { OpenOutboundError } from "../core/errors.js";

/**
 * Keys the server writes into `.openoutbound/server.json` so local tools (the CLI and
 * `openoutbound mcp` in bridge mode) can reach it without creating an API key: `admin` acts as
 * `local-admin`, `agent` as `local-agent`. Anyone who can read that file can already read the
 * database and `.env`, so this adds no new access.
 */
export interface LocalKeys {
  admin: string;
  agent: string;
}

/** The token from `Authorization: Bearer <token>`, or null. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

export const MISSING_KEY_HINT =
  "Send `Authorization: Bearer oo_...`. Create a key with `openoutbound keys create` (for agents use --kind agent).";

/**
 * Resolves the caller: local keys first (constant time), then `engine.authenticate`.
 * Throws `unauthorized` with a hint when the header is missing or the key is unknown.
 */
export async function authenticate(
  engine: Pick<Engine, "authenticate" | "localPrincipal">,
  authorization: string | null | undefined,
  via: Via,
  localKeys?: LocalKeys | null,
): Promise<Principal> {
  const token = bearerToken(authorization);
  if (!token) {
    throw new OpenOutboundError("unauthorized", "Missing API key.", { hint: MISSING_KEY_HINT });
  }
  if (localKeys) {
    if (sameSecret(token, localKeys.admin)) return engine.localPrincipal("admin", via);
    if (sameSecret(token, localKeys.agent)) return engine.localPrincipal("agent", via);
  }
  const principal = await engine.authenticate(token, via);
  if (!principal) {
    throw new OpenOutboundError("unauthorized", "Invalid, revoked or expired API key.", {
      hint: "Check the key (it starts with oo_), or create a new one with `openoutbound keys create`.",
    });
  }
  return principal;
}
