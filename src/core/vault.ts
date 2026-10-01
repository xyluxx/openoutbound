import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { secrets } from "../db/schema/index.js";
import type { EncryptedValue, Vault } from "./context.js";
import { OpenOutboundError } from "./errors.js";
import { newId } from "./ids.js";

export interface CreateVaultOptions {
  db: Db;
  /** 32-byte key (resolveSecretKey(config)). */
  key: Buffer;
  /** Version stamped on new ciphertexts. Default 1. */
  keyVersion?: number;
  /** Older keys by version, for reading secrets written before a rotation. */
  previousKeys?: Record<number, Buffer>;
}

/**
 * AES-256-GCM vault persisting to the `secrets` table. Each secret's ciphertext is bound to its
 * `(workspace_id, name)` as additional authenticated data, so rows cannot be swapped.
 */
export function createVault(options: CreateVaultOptions): Vault {
  const { db } = options;
  const keyVersion = options.keyVersion ?? 1;
  const keys = new Map<number, Buffer>(
    Object.entries(options.previousKeys ?? {}).map(([version, key]) => [Number(version), key]),
  );
  keys.set(keyVersion, options.key);
  for (const [version, key] of keys) {
    if (key.length !== 32) throw new Error(`Vault key version ${version} must be 32 bytes`);
  }

  const encrypt = (plaintext: string, aad?: string): EncryptedValue => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", options.key, iv);
    if (aad !== undefined) cipher.setAAD(Buffer.from(aad, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      keyVersion,
    };
  };

  const decrypt = (value: EncryptedValue, aad?: string): string => {
    const key = keys.get(value.keyVersion);
    if (!key) {
      throw new OpenOutboundError("internal", `No vault key for key version ${value.keyVersion}.`, {
        hint: "Restore the OPENOUTBOUND_SECRET_KEY that was used when this secret was stored.",
      });
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
      if (aad !== undefined) decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(Buffer.from(value.authTag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(value.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch (error) {
      throw new OpenOutboundError("internal", "A stored secret could not be decrypted.", {
        hint: "OPENOUTBOUND_SECRET_KEY probably changed. Restore the old key, or set the secret again.",
        cause: error,
      });
    }
  };

  const aadFor = (workspaceId: string | null, name: string) =>
    `${workspaceId ?? "instance"}/${name}`;

  return {
    encrypt,
    decrypt,
    async putSecret(workspaceId, name, value) {
      const encrypted = encrypt(value, aadFor(workspaceId, name));
      const fields = {
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        auth_tag: encrypted.authTag,
        key_version: encrypted.keyVersion,
      };
      const [row] = await db
        .insert(secrets)
        .values({ id: newId("sec"), workspace_id: workspaceId, name, ...fields })
        .onConflictDoUpdate({
          target: [secrets.workspace_id, secrets.name],
          set: { ...fields, updated_at: new Date() },
        })
        .returning({ id: secrets.id });
      if (!row) throw new OpenOutboundError("internal", "Failed to store secret.");
      return row.id;
    },
    async getSecret(secretId, workspaceId) {
      const [row] = await db.select().from(secrets).where(eq(secrets.id, secretId)).limit(1);
      if (!row) return null;
      if (workspaceId !== undefined && row.workspace_id !== workspaceId) return null;
      return decrypt(
        {
          ciphertext: row.ciphertext,
          iv: row.iv,
          authTag: row.auth_tag,
          keyVersion: row.key_version,
        },
        aadFor(row.workspace_id, row.name),
      );
    },
    async deleteSecret(secretId) {
      await db.delete(secrets).where(eq(secrets.id, secretId));
    },
  };
}
