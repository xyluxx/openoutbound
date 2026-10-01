import { afterAll, describe, expect, it } from "vitest";
import { fixedClock } from "../../core/clock.js";
import { silentLogger } from "../../core/logger.js";
import { workspaces } from "../../db/schema/index.js";
import type { ProviderRuntime } from "../../providers/types.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { WORLD } from "../world/index.js";
import { createSandboxLeadSource } from "./lead-source.js";

function runtime(db: TestDb["db"], workspaceId: string | null): ProviderRuntime {
  return {
    fetch: (() => {
      throw new Error("not used by lead_source");
    }) as unknown as typeof fetch,
    safeFetch: (() => {
      throw new Error("not used by lead_source");
    }) as unknown as ProviderRuntime["safeFetch"],
    log: silentLogger(),
    clock: fixedClock(),
    baseUrl: "http://localhost:7331",
    workspaceId,
    db,
  };
}

describe("sandbox lead_source provider", () => {
  let testDb: TestDb;
  afterAll(async () => {
    await testDb?.close();
  });

  it("is deterministic and searches people/companies across the whole world without a workspace", async () => {
    testDb = await createTestDb();
    const provider = await createSandboxLeadSource(runtime(testDb.db, null));
    const first = await provider.searchPeople?.({ titles: ["operations"] }, { limit: 10 });
    const second = await provider.searchPeople?.({ titles: ["operations"] }, { limit: 10 });
    expect(first).toEqual(second);
    expect(first?.items.length).toBeGreaterThan(0);
    expect(first?.creditsUsed).toBe(0);
  });

  it("scopes people search to the workspace's own world when bound to a sandbox workspace", async () => {
    testDb = await createTestDb();
    const [ws] = await testDb.db
      .insert(workspaces)
      .values({ slug: "northwind", name: "Northwind Analytics (sandbox)", is_sandbox: true })
      .returning();
    expect(ws).toBeDefined();
    if (!ws) return;
    const provider = await createSandboxLeadSource(runtime(testDb.db, ws.id));
    const result = await provider.searchPeople?.({}, { limit: 200 });
    expect(result?.items.length).toBeGreaterThan(0);
    // Northwind's world never has "Practice Manager" (that's Brightsmile's dental persona).
    expect(result?.items.some((p) => p.title === "Practice Manager")).toBe(false);
  });

  it("filters companies by employee_range and paginates with a cursor", async () => {
    testDb = await createTestDb();
    const provider = await createSandboxLeadSource(runtime(testDb.db, null));
    const page1 = await provider.searchCompanies?.(
      { employee_range: { min: 20, max: 500 } },
      { limit: 5 },
    );
    expect(page1?.items.length).toBe(5);
    expect(page1?.nextCursor).toBeTruthy();
    const page2 = await provider.searchCompanies?.(
      { employee_range: { min: 20, max: 500 } },
      { limit: 5, cursor: page1?.nextCursor ?? undefined },
    );
    expect(page2?.items[0]?.name).not.toBe(page1?.items[0]?.name);
  });

  it("never returns a competitor company", async () => {
    testDb = await createTestDb();
    const competitor = WORLD.northwind?.companies.find((c) => c.status === "competitor");
    expect(competitor).toBeDefined();
    const provider = await createSandboxLeadSource(runtime(testDb.db, null));
    const result = await provider.searchCompanies?.({}, { limit: 500 });
    expect(result?.items.some((c) => c.domain === competitor?.domain)).toBe(false);
  });
});
