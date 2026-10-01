import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../core/config.js";
import { secrets, type Workspace, workspaces } from "../db/schema/index.js";
import { createTestDb, type TestDb } from "../testing/db.js";
import { createRuntimeVault, reencryptSecrets } from "./vault.js";

const firstKey = randomBytes(32);
const secondKey = randomBytes(32);

const config = (env: Record<string, string>) =>
  loadConfig({ DATABASE_URL: "memory://", LOG_LEVEL: "silent", ...env }, { envFile: false });

let testDb: TestDb;
let acme: Workspace;
let globex: Workspace;

beforeAll(async () => {
  testDb = await createTestDb();
  const rows = await testDb.db
    .insert(workspaces)
    .values([
      { slug: "acme", name: "Acme" },
      { slug: "globex", name: "Globex" },
    ])
    .returning();
  [acme, globex] = rows as [Workspace, Workspace];
});
afterAll(async () => {
  await testDb.close();
});
beforeEach(async () => {
  await testDb.db.delete(secrets);
});

describe("runtime vault", () => {
  it("round-trips secrets bound to their workspace", async () => {
    const vault = createRuntimeVault(
      testDb.db,
      config({ OPENOUTBOUND_SECRET_KEY: firstKey.toString("base64") }),
    );
    const id = await vault.putSecret(acme.id, "provider:research:exa:api_key", "exa-secret-value");
    const instanceId = await vault.putSecret(
      null,
      "provider:brain:anthropic:api_key",
      "brain-secret",
    );
    expect(await vault.getSecret(id, acme.id)).toBe("exa-secret-value");
    expect(await vault.getSecret(id)).toBe("exa-secret-value");
    expect(await vault.getSecret(id, globex.id)).toBeNull();
    expect(await vault.getSecret(instanceId, null)).toBe("brain-secret");
    expect(await vault.getSecret(instanceId, acme.id)).toBeNull();

    const again = await vault.putSecret(null, "provider:brain:anthropic:api_key", "rotated");
    expect(again).toBe(instanceId);
    expect(await vault.getSecret(instanceId)).toBe("rotated");
    const rows = await testDb.db.select().from(secrets);
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toMatch(/exa-secret-value|rotated/);

    await vault.deleteSecret(id);
    expect(await vault.getSecret(id)).toBeNull();
  });

  it("detects swapped or tampered rows", async () => {
    const vault = createRuntimeVault(
      testDb.db,
      config({ OPENOUTBOUND_SECRET_KEY: firstKey.toString("base64") }),
    );
    const id = await vault.putSecret(acme.id, "notification:ntf_1", "https://hooks.example.com/x");
    await testDb.db.update(secrets).set({ name: "notification:ntf_2" }).where(eq(secrets.id, id));
    await expect(vault.getSecret(id)).rejects.toMatchObject({
      code: "internal",
      hint: expect.stringContaining("OPENOUTBOUND_SECRET_KEY"),
    });

    const other = createRuntimeVault(
      testDb.db,
      config({ OPENOUTBOUND_SECRET_KEY: secondKey.toString("base64") }),
    );
    const fresh = await vault.putSecret(acme.id, "webhook:whk_1", "whsec_example");
    await expect(other.getSecret(fresh)).rejects.toMatchObject({ code: "internal" });
  });

  it("starts without a key and explains how to set one on first use", async () => {
    const withoutKey = loadConfig(
      { DATABASE_URL: "postgres://oo@localhost:5432/openoutbound", LOG_LEVEL: "silent" },
      { envFile: false },
    );
    const vault = createRuntimeVault(testDb.db, withoutKey);
    await expect(vault.putSecret(acme.id, "x", "y")).rejects.toMatchObject({
      code: "validation_failed",
      hint: expect.stringContaining("openoutbound init"),
    });
  });

  it("reads old key versions during a rotation and re-encrypts them", async () => {
    const before = createRuntimeVault(
      testDb.db,
      config({ OPENOUTBOUND_SECRET_KEY: firstKey.toString("base64") }),
    );
    const id = await before.putSecret(acme.id, "provider:lead_source:apollo:api_key", "apollo-key");
    expect(before.keyVersion()).toBe(1);

    const rotating = createRuntimeVault(
      testDb.db,
      config({
        OPENOUTBOUND_SECRET_KEY: secondKey.toString("base64"),
        OPENOUTBOUND_SECRET_KEY_VERSION: "2",
        OPENOUTBOUND_PREVIOUS_SECRET_KEYS: `1:${firstKey.toString("base64")}`,
      }),
    );
    expect(await rotating.getSecret(id)).toBe("apollo-key");
    expect(await reencryptSecrets(testDb.db, rotating)).toBe(1);
    expect(await reencryptSecrets(testDb.db, rotating)).toBe(0);
    const [row] = await testDb.db.select().from(secrets).where(eq(secrets.id, id));
    expect(row?.key_version).toBe(2);

    const after = createRuntimeVault(
      testDb.db,
      config({
        OPENOUTBOUND_SECRET_KEY: secondKey.toString("base64"),
        OPENOUTBOUND_SECRET_KEY_VERSION: "2",
      }),
    );
    expect(await after.getSecret(id)).toBe("apollo-key");
    await expect(before.getSecret(id)).rejects.toMatchObject({
      code: "internal",
      message: "No vault key for key version 2.",
    });
  });

  it("rejects malformed rotation settings", async () => {
    const cases: Array<Record<string, string>> = [
      { OPENOUTBOUND_SECRET_KEY_VERSION: "two" },
      { OPENOUTBOUND_SECRET_KEY_VERSION: "0" },
      { OPENOUTBOUND_PREVIOUS_SECRET_KEYS: "1:short" },
      { OPENOUTBOUND_PREVIOUS_SECRET_KEYS: `x:${firstKey.toString("base64")}` },
    ];
    for (const env of cases) {
      const vault = createRuntimeVault(
        testDb.db,
        config({ OPENOUTBOUND_SECRET_KEY: secondKey.toString("base64"), ...env }),
      );
      await expect(vault.putSecret(null, "x", "y")).rejects.toMatchObject({
        code: "validation_failed",
      });
    }
  });
});
