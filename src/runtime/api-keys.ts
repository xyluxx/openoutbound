/**
 * API keys (spec 6): `oo_` + 43 base64url chars (32 random bytes). Only the SHA-256 hash and
 * the first 11 characters are stored; the plain key is shown once at creation. A key created by
 * another key never outlives it: it expires no later than its creator, revoking a key revokes
 * every key created from it, and a key whose creator key is revoked or expired is refused.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Clock } from "../core/clock.js";
import type { EngineConfig } from "../core/config.js";
import { type ActorRef, ALL_SCOPES, type Principal } from "../core/context.js";
import type { ApiKeyKind, Scope, Via } from "../core/enums.js";
import type { Db } from "../db/client.js";
import { type ApiKey, api_keys } from "../db/schema/index.js";

export const API_KEY_PATTERN = /^oo_[A-Za-z0-9_-]{43}$/;
export const API_KEY_PREFIX_LENGTH = 11;
/** last_used_at is written at most this often per key. */
const LAST_USED_RESOLUTION_MS = 60_000;

export interface GeneratedApiKey {
  key: string;
  hash: string;
  prefix: string;
}

export function generateApiKey(): GeneratedApiKey {
  const key = `oo_${randomBytes(32).toString("base64url")}`;
  return { key, hash: hashApiKey(key), prefix: key.slice(0, API_KEY_PREFIX_LENGTH) };
}

/** SHA-256 hex of the full key. */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** Default scopes by key kind: agents cannot approve or administer unless asked explicitly. */
export function defaultScopesForKind(kind: ApiKeyKind): Scope[] {
  if (kind === "human") return [...ALL_SCOPES];
  if (kind === "agent") return ["read", "write", "send", "spend"];
  return ["read", "write"];
}

function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Keys followed up a creation chain at most (a guard against a broken chain). */
const MAX_CHAIN = 20;

function isKeyId(id: string | undefined): id is string {
  return typeof id === "string" && id.startsWith("key_");
}

/**
 * The keys a key was created from, nearest first: its creator when that is a key, that key's
 * creator, and so on, while the creator is a key that is still stored.
 */
export async function creatorKeys(
  db: Db,
  row: Pick<ApiKey, "id" | "created_by">,
): Promise<ApiKey[]> {
  const chain: ApiKey[] = [];
  const seen = new Set([row.id]);
  let creator = row.created_by;
  while (chain.length < MAX_CHAIN && isKeyId(creator?.id) && !seen.has(creator.id)) {
    seen.add(creator.id);
    const [parent] = await db.select().from(api_keys).where(eq(api_keys.id, creator.id)).limit(1);
    if (!parent) break;
    chain.push(parent);
    creator = parent.created_by;
  }
  return chain;
}

/** A key that no longer works: revoked, or expired at `now`. */
function ended(row: Pick<ApiKey, "revoked_at" | "expires_at">, now: Date): boolean {
  if (row.revoked_at) return true;
  return row.expires_at !== null && row.expires_at.getTime() <= now.getTime();
}

/**
 * True when `creator` is a stored key that no longer works, or a key it was created from does
 * not: what such a key made (a webhook URL) stops working with it, as the keys it created do.
 */
export async function creatorKeyEnded(
  db: Db,
  creator: { id: string } | null | undefined,
  now: Date,
): Promise<boolean> {
  const id = creator?.id;
  if (!isKeyId(id)) return false;
  const [row] = await db.select().from(api_keys).where(eq(api_keys.id, id)).limit(1);
  if (!row) return false;
  if (ended(row, now)) return true;
  return (await creatorKeys(db, row)).some((parent) => ended(parent, now));
}

/**
 * The latest a key created by `principal` may expire: the earliest expiry of the principal's
 * own key and the keys it was created from, or null when none of them expires (or the
 * principal is not a stored key, like `local-admin`).
 */
export async function creatorExpiry(
  db: Db,
  principal: Pick<Principal, "id">,
): Promise<Date | null> {
  if (!isKeyId(principal.id)) return null;
  const [row] = await db.select().from(api_keys).where(eq(api_keys.id, principal.id)).limit(1);
  if (!row) return null;
  let earliest: Date | null = null;
  for (const key of [row, ...(await creatorKeys(db, row))]) {
    if (key.expires_at && (!earliest || key.expires_at.getTime() < earliest.getTime())) {
      earliest = key.expires_at;
    }
  }
  return earliest;
}

/**
 * Revokes every key created from `keyId`, down the chain (keys revoked earlier are followed
 * too, so their own keys end as well). Returns the ids it revoked now.
 */
export async function revokeKeysCreatedBy(db: Db, keyId: string, now: Date): Promise<string[]> {
  const revoked: string[] = [];
  const seen = new Set([keyId]);
  let parents = [keyId];
  for (let depth = 0; depth < MAX_CHAIN && parents.length > 0; depth++) {
    const children = await db
      .select({ id: api_keys.id, revoked_at: api_keys.revoked_at })
      .from(api_keys)
      .where(inArray(sql`${api_keys.created_by} ->> 'id'`, parents));
    const fresh = children.filter((child) => !seen.has(child.id));
    for (const child of fresh) seen.add(child.id);
    const active = fresh.filter((child) => !child.revoked_at).map((child) => child.id);
    if (active.length > 0) {
      await db
        .update(api_keys)
        .set({ revoked_at: now })
        .where(and(inArray(api_keys.id, active), isNull(api_keys.revoked_at)));
      revoked.push(...active);
    }
    parents = fresh.map((child) => child.id);
  }
  return revoked;
}

/**
 * Who holds a key (`Principal.controller`): the key itself when a person (or the engine)
 * created it; else, since an agent or service holds the plain keys it mints, whoever holds its
 * creator, up the chain to the first key a person created, or the creator itself when it is
 * not a stored key (`local-agent`).
 */
export function keyController(
  row: Pick<ApiKey, "id" | "created_by">,
  chain: Array<Pick<ApiKey, "id" | "created_by">>,
): string {
  let current = row;
  for (const parent of [...chain, null]) {
    const creator = current.created_by;
    if (!creator || creator.type === "human" || creator.type === "system") return current.id;
    if (!parent || parent.id !== creator.id) return creator.id;
    current = parent;
  }
  return current.id;
}

/**
 * Who holds the principal an approval was requested by (see `keyController`): looked up from
 * the key table for an API key, the id itself for anyone else.
 */
export async function requesterController(
  db: Db,
  requestedBy: Pick<ActorRef, "type" | "id"> | null | undefined,
): Promise<string | null> {
  if (!requestedBy) return null;
  if (!isKeyId(requestedBy.id)) return requestedBy.id;
  const [row] = await db.select().from(api_keys).where(eq(api_keys.id, requestedBy.id)).limit(1);
  if (!row) return requestedBy.id;
  return keyController(row, await creatorKeys(db, row));
}

/**
 * Plain key -> principal, or null when the key is malformed, unknown, revoked or expired, or a
 * key it was created from is (a key never outlives its creator, also one stored before keys
 * were capped and revoked together). Updates last_used_at (at most once a minute per key).
 */
export async function authenticateApiKey(
  db: Db,
  clock: Clock,
  apiKey: string,
  via: Via,
): Promise<Principal | null> {
  const key = apiKey.trim();
  if (!API_KEY_PATTERN.test(key)) return null;
  const hash = hashApiKey(key);
  const [row] = await db.select().from(api_keys).where(eq(api_keys.hash, hash)).limit(1);
  if (!row || !hashesEqual(row.hash, hash)) return null;
  const now = clock.now();
  if (ended(row, now)) return null;
  const chain = await creatorKeys(db, row);
  if (chain.some((parent) => ended(parent, now))) return null;
  if (!row.last_used_at || now.getTime() - row.last_used_at.getTime() > LAST_USED_RESOLUTION_MS) {
    await db.update(api_keys).set({ last_used_at: now }).where(eq(api_keys.id, row.id));
  }
  return {
    type: row.kind,
    id: row.id,
    name: row.name,
    scopes: [...row.scopes],
    workspaceId: row.workspace_id,
    via,
    controller: keyController(row, chain),
  };
}

/** `local-admin` (every scope) for the in-process CLI, `local-agent` for embedded stdio MCP. */
export function localPrincipal(
  config: Pick<EngineConfig, "agentScopes">,
  kind: "admin" | "agent",
  via: Via,
): Principal {
  if (kind === "admin") {
    return {
      type: "human",
      id: "local-admin",
      name: "Local admin",
      scopes: [...ALL_SCOPES],
      workspaceId: null,
      via,
    };
  }
  return {
    type: "agent",
    id: "local-agent",
    name: "Local agent",
    scopes: [...config.agentScopes],
    workspaceId: null,
    via,
  };
}
