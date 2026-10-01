/**
 * The engine vault: AES-256-GCM (core `createVault`) with the configured secret key, created
 * lazily so the engine starts without a key (init and doctor must run). The first use without
 * a key fails with an actionable error ("Run `openoutbound init`").
 *
 * Key rotation: set the new key in OPENOUTBOUND_SECRET_KEY with a higher
 * OPENOUTBOUND_SECRET_KEY_VERSION, and keep older keys in OPENOUTBOUND_PREVIOUS_SECRET_KEYS
 * ("1:<base64>,2:<base64>"). `openoutbound db reencrypt-secrets` (`reencryptSecrets`) then
 * rewrites every stored secret with the new key; the old keys stay listed for unsubscribe links
 * signed before the rotation.
 */
import { eq, ne } from "drizzle-orm";
import { type EngineConfig, resolveSecretKey } from "../core/config.js";
import type { Vault } from "../core/context.js";
import { OpenOutboundError } from "../core/errors.js";
import { createVault } from "../core/vault.js";
import type { Db } from "../db/client.js";
import { secrets } from "../db/schema/index.js";

interface KeyRing {
  version: number;
  previous: Record<number, Buffer>;
}

function keyRing(config: EngineConfig): KeyRing {
  const rawVersion = config.env.OPENOUTBOUND_SECRET_KEY_VERSION?.trim();
  const version = rawVersion ? Number(rawVersion) : 1;
  if (!Number.isInteger(version) || version < 1) {
    throw new OpenOutboundError(
      "validation_failed",
      `Invalid OPENOUTBOUND_SECRET_KEY_VERSION "${rawVersion}".`,
      { hint: "Use a positive integer (1 for the first key)." },
    );
  }
  const previous: Record<number, Buffer> = {};
  const list = config.env.OPENOUTBOUND_PREVIOUS_SECRET_KEYS?.trim();
  for (const entry of list ? list.split(",") : []) {
    const [versionText, base64] = entry.split(":");
    const keyVersion = Number(versionText);
    const key = Buffer.from(base64 ?? "", "base64");
    if (!Number.isInteger(keyVersion) || key.length !== 32) {
      throw new OpenOutboundError(
        "validation_failed",
        "Invalid OPENOUTBOUND_PREVIOUS_SECRET_KEYS.",
        {
          hint: 'Use "<version>:<32-byte base64 key>" pairs separated by commas.',
        },
      );
    }
    previous[keyVersion] = key;
  }
  return { version, previous };
}

/**
 * The older secret keys (OPENOUTBOUND_PREVIOUS_SECRET_KEYS), newest first. Signatures made with
 * a key derived from the secret key (unsubscribe links) are checked against these too, so links
 * in emails sent before a rotation keep working. Invalid entries throw, like the vault.
 */
export function previousSecretKeys(config: EngineConfig): Buffer[] {
  return Object.entries(keyRing(config).previous)
    .sort(([left], [right]) => Number(right) - Number(left))
    .map(([, key]) => key);
}

export function createRuntimeVault(db: Db, config: EngineConfig): Vault & { keyVersion(): number } {
  let inner: Vault | undefined;
  let ring: KeyRing | undefined;
  const vault = (): Vault => {
    if (!inner) {
      ring = keyRing(config);
      inner = createVault({
        db,
        key: resolveSecretKey(config),
        keyVersion: ring.version,
        previousKeys: ring.previous,
      });
    }
    return inner;
  };
  return {
    encrypt: (plaintext, aad) => vault().encrypt(plaintext, aad),
    decrypt: (value, aad) => vault().decrypt(value, aad),
    // async so a missing or malformed key surfaces as a rejection, like every other failure.
    putSecret: async (workspaceId, name, value) => vault().putSecret(workspaceId, name, value),
    getSecret: async (secretId, workspaceId) => vault().getSecret(secretId, workspaceId),
    deleteSecret: async (secretId) => {
      await db.delete(secrets).where(eq(secrets.id, secretId));
    },
    keyVersion: () => {
      vault();
      return ring?.version ?? 1;
    },
  };
}

/**
 * Rewrites secrets stored with an older key version using the current key and returns the
 * count. Every such secret is decrypted before anything is written, and the rewrite is one
 * transaction, so a missing or wrong old key changes nothing.
 */
export async function reencryptSecrets(
  db: Db,
  vault: Vault & { keyVersion(): number },
): Promise<number> {
  const current = vault.keyVersion();
  const rows = await db.select().from(secrets).where(ne(secrets.key_version, current));
  const unreadable = new Map<number, number>();
  const plain: Array<{ id: string; aad: string; value: string }> = [];
  for (const row of rows) {
    const aad = `${row.workspace_id ?? "instance"}/${row.name}`;
    try {
      const value = vault.decrypt(
        {
          ciphertext: row.ciphertext,
          iv: row.iv,
          authTag: row.auth_tag,
          keyVersion: row.key_version,
        },
        aad,
      );
      plain.push({ id: row.id, aad, value });
    } catch {
      unreadable.set(row.key_version, (unreadable.get(row.key_version) ?? 0) + 1);
    }
  }
  if (unreadable.size > 0) throw unreadableSecrets(unreadable);
  await db.transaction(async (tx) => {
    for (const entry of plain) {
      const next = vault.encrypt(entry.value, entry.aad);
      await tx
        .update(secrets)
        .set({
          ciphertext: next.ciphertext,
          iv: next.iv,
          auth_tag: next.authTag,
          key_version: next.keyVersion,
        })
        .where(eq(secrets.id, entry.id));
    }
  });
  return rows.length;
}

function unreadableSecrets(unreadable: Map<number, number>): OpenOutboundError {
  const versions = [...unreadable.keys()].sort((left, right) => left - right);
  const count = [...unreadable.values()].reduce((sum, n) => sum + n, 0);
  const list = versions.map((version) => `${version}:<old key>`).join(",");
  return new OpenOutboundError(
    "validation_failed",
    `${count} stored secret${count === 1 ? "" : "s"} with key version ${versions.join(", ")} cannot be decrypted with the keys given. Nothing was changed.`,
    {
      hint: `Set OPENOUTBOUND_PREVIOUS_SECRET_KEYS="${list}" with the base64 OPENOUTBOUND_SECRET_KEY used for ${versions.length === 1 ? "that version" : "each version"}, then run \`openoutbound db reencrypt-secrets\` again.`,
      details: { key_versions: versions },
    },
  );
}
