import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { provider_settings } from "../db/schema/index.js";
import { createTestDb, type TestDb } from "../testing/db.js";
import { agentBrainInUse } from "./agent-brain.js";

let handle: TestDb;
beforeAll(async () => {
  handle = await createTestDb();
});
afterAll(async () => {
  await handle.close();
});

describe("agentBrainInUse", () => {
  it("is false without a database or without an agent brain", async () => {
    expect(await agentBrainInUse(undefined)).toBe(false);
    expect(await agentBrainInUse(handle.db)).toBe(false);
  });

  it("is true once an enabled agent brain provider exists (instance or workspace)", async () => {
    await handle.db.insert(provider_settings).values({ slot: "brain", provider: "anthropic" });
    await handle.db
      .insert(provider_settings)
      .values({ slot: "brain", provider: "agent", enabled: false });
    expect(await agentBrainInUse(handle.db)).toBe(false);
    await handle.db
      .update(provider_settings)
      .set({ enabled: true })
      .where(eq(provider_settings.provider, "agent"));
    expect(await agentBrainInUse(handle.db)).toBe(true);
  });

  it("never throws on a broken database", async () => {
    const broken = {
      select: () => {
        throw new Error("closed");
      },
    } as unknown as Db;
    expect(await agentBrainInUse(broken)).toBe(false);
  });
});
