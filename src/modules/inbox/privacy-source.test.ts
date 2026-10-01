import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { events, imports } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedPerson } from "../../testing/factories.js";
import { describeDataSource, loadDataSource, plainDate } from "./privacy-source.js";

const ADDED = new Date("2026-09-03T10:00:00Z");
const base = { emailSource: null, addedAt: ADDED, timeZone: "UTC" };

describe("describeDataSource", () => {
  it.each([
    ["apollo", "Apollo, a business contact database, on 3 Sep 2026", true],
    ["google_maps", "your company's public Google Maps listing and website, on 3 Sep 2026", true],
    ["csv", "a contact list imported on 3 Sep 2026", true],
    ["xlsx", "a contact list imported on 3 Sep 2026", true],
    ["json", "a contact list imported on 3 Sep 2026", true],
    ["rows", "a contact list imported on 3 Sep 2026", true],
    ["website", "your company website", true],
    ["linkedin", "your public LinkedIn profile, on 3 Sep 2026", true],
    ["referral", "a referral from a colleague, on 3 Sep 2026", true],
    ["api", "added through our system on 3 Sep 2026", false],
    ["test", "we could not find the source; check your records", false],
    [null, "we could not find the source; check your records", false],
  ])("describes source %j", (source, line, quotable) => {
    expect(describeDataSource({ ...base, source })).toEqual({ line, quotable });
  });

  it("names the import file and uses the import date when known", () => {
    expect(
      describeDataSource({
        ...base,
        source: "csv",
        importFile: "dental-leads-q3.csv",
        importedAt: new Date("2026-08-30T09:00:00Z"),
      }).line,
    ).toBe("a contact list (dental-leads-q3.csv) imported on 30 Aug 2026");
  });

  it("prefers the website page a crawl found the address on", () => {
    expect(
      describeDataSource({
        ...base,
        source: "apollo",
        emailSource: "https://harbor.example.com/team",
      }),
    ).toEqual({ line: "your company website (https://harbor.example.com/team)", quotable: true });
    expect(
      describeDataSource({ ...base, source: "google_maps", emailSource: "website" }).line,
    ).toBe("your company website");
    // A provider label is not a page.
    expect(describeDataSource({ ...base, source: "apollo", emailSource: "apollo" }).line).toBe(
      "Apollo, a business contact database, on 3 Sep 2026",
    );
  });

  it("writes dates in the given timezone", () => {
    const late = new Date("2026-09-27T23:30:00Z");
    expect(plainDate(late, "UTC")).toBe("27 Sep 2026");
    expect(plainDate(late, "Europe/Berlin")).toBe("28 Sep 2026");
    expect(plainDate(late, "Not/AZone")).toBe("27 Sep 2026");
  });
});

describe("loadDataSource", () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
  });
  afterAll(async () => {
    await testDb.close();
  });

  async function importedPerson(ctx: TestContext, importWorkspace: string) {
    const person = await seedPerson(ctx, { source: "csv", created_at: ADDED });
    const [row] = await ctx.db
      .insert(imports)
      .values({
        workspace_id: importWorkspace,
        source: "csv",
        status: "completed",
        file_name: "clinics-austin.csv",
        created_at: new Date("2026-09-01T08:00:00Z"),
      })
      .returning();
    await ctx.db.insert(events).values({
      workspace_id: ctx.workspace.id,
      type: "lead.created",
      subject_type: "person",
      subject_id: person.id,
      data: { kind: "person", id: person.id, source: "csv", import_id: row?.id ?? null },
    });
    return person;
  }

  it("names the import that created the person", async () => {
    const ctx = await createTestContext({ db: testDb });
    const person = await importedPerson(ctx, ctx.workspace.id);
    expect(await loadDataSource(ctx, person, "UTC")).toEqual({
      line: "a contact list (clinics-austin.csv) imported on 1 Sep 2026",
      quotable: true,
    });
  });

  it("never reads another workspace's import, and falls back to the date added", async () => {
    const ctx = await createTestContext({ db: testDb });
    const other = await createTestContext({ db: testDb });
    const person = await importedPerson(ctx, other.workspace.id);
    expect((await loadDataSource(ctx, person, "UTC")).line).toBe(
      "a contact list imported on 3 Sep 2026",
    );
    const bare = await seedPerson(ctx, { source: "xlsx", created_at: ADDED });
    expect((await loadDataSource(ctx, bare, "UTC")).line).toBe(
      "a contact list imported on 3 Sep 2026",
    );
  });
});
