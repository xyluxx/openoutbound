import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryRows } from "../db/client.js";
import { companies, knowledge_items, people, secrets, workspaces } from "../db/schema/index.js";
import { createTestDb, type TestDb, truncateAll } from "./db.js";
import { seedCompany, seedPerson, seedWorkspace } from "./factories.js";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.close();
});

describe("createTestDb", () => {
  it("inserts and selects a workspace with defaults", async () => {
    const [ws] = await testDb.db
      .insert(workspaces)
      .values({ slug: "acme", name: "Acme" })
      .returning();
    expect(ws?.id).toMatch(/^ws_/);
    expect(ws?.status).toBe("active");
    expect(ws?.settings).toEqual({});
    expect(ws?.created_at).toBeInstanceOf(Date);
    const found = await testDb.db.query.workspaces.findFirst({
      where: eq(workspaces.slug, "acme"),
    });
    expect(found?.name).toBe("Acme");
  });

  it("enforces partial unique (workspace_id, email) and allows many null emails", async () => {
    const ws = await seedWorkspace(testDb.db);
    const target = { db: testDb.db, workspace: ws };
    await seedPerson(target, { email: "dana@example.com" });
    await expect(seedPerson(target, { email: "dana@example.com" })).rejects.toThrow();
    await seedPerson(target, { email: null });
    await seedPerson(target, { email: null });
    const other = await seedWorkspace(testDb.db);
    await seedPerson({ db: testDb.db, workspace: other }, { email: "dana@example.com" });
    const rows = await testDb.db.select().from(people).where(eq(people.workspace_id, ws.id));
    expect(rows).toHaveLength(3);
  });

  it("enforces NULLS NOT DISTINCT on instance-level secrets", async () => {
    const values = { name: "brain.anthropic.api_key", ciphertext: "x", iv: "y", auth_tag: "z" };
    await testDb.db.insert(secrets).values({ ...values, workspace_id: null });
    await expect(
      testDb.db.insert(secrets).values({ ...values, workspace_id: null }),
    ).rejects.toThrow();
  });

  it("sets people.company_id to null when the company is deleted", async () => {
    const ws = await seedWorkspace(testDb.db);
    const target = { db: testDb.db, workspace: ws };
    const company = await seedCompany(target);
    const person = await seedPerson(target, { company_id: company.id });
    await testDb.db.delete(companies).where(eq(companies.id, company.id));
    const [row] = await testDb.db.select().from(people).where(eq(people.id, person.id));
    expect(row?.company_id).toBeNull();
  });

  it("maintains the knowledge full-text search column", async () => {
    const ws = await seedWorkspace(testDb.db);
    await testDb.db.insert(knowledge_items).values([
      {
        workspace_id: ws.id,
        kind: "faq",
        title: "Pricing",
        body: "We charge per chair each month.",
      },
      { workspace_id: ws.id, kind: "about", title: "About us", body: "Founded in Austin." },
    ]);
    const hits = await queryRows<{ title: string }>(
      testDb.db,
      sql`select title from knowledge_items where search @@ websearch_to_tsquery('simple', 'chair')`,
    );
    expect(hits.map((h) => h.title)).toEqual(["Pricing"]);
  });

  it("gives every call an isolated database", async () => {
    const other = await createTestDb();
    expect(await other.db.select().from(workspaces)).toEqual([]);
    await other.close();
  });

  it("truncateAll empties every table", async () => {
    await truncateAll(testDb.db);
    expect(await testDb.db.select().from(workspaces)).toEqual([]);
    expect(await testDb.db.select().from(people)).toEqual([]);
  });
});
