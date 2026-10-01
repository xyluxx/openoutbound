import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { audit_events, events } from "../../db/schema/index.js";
import { createTestEngine, type TestEngine } from "../../testing/engine.js";
import { createFakeFetch } from "../../testing/fake-fetch.js";

// biome-ignore lint/suspicious/noExplicitAny: results are checked with expect
type Any = any;

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`../../providers/lead-source/fixtures/${name}.json`, import.meta.url),
      "utf8",
    ),
  );

const APOLLO = "https://api.apollo.io/api/v1";

let engine: TestEngine;
let workspace: string;

beforeAll(async () => {
  const providerFetch = createFakeFetch([
    {
      match: `${APOLLO}/mixed_people/api_search`,
      response: { json: fixture("apollo-people-search") },
    },
    { match: `${APOLLO}/people/bulk_match`, response: { json: fixture("apollo-bulk-match") } },
  ]) as unknown as typeof globalThis.fetch;
  engine = await createTestEngine({
    config: { env: { APOLLO_API_KEY: "apollo-test-key" } },
    providerFetch,
  });
  const created = (await engine.call("workspaces.create", { name: "Brightsmile Supply" })) as Any;
  workspace = created.id;
});
afterAll(async () => {
  await engine.close();
});

describe("leads through the engine", () => {
  it("finds Apollo people, dry runs the import by default and imports on dry_run false", async () => {
    const opts = { workspace };
    await engine.call("icps.create", { name: "Owners", criteria: { titles: ["owner"] } }, opts);
    const found = (await engine.call(
      "leads.find",
      { source: "apollo", titles: ["Owner"] },
      opts,
    )) as Any;
    expect(found.candidates).toHaveLength(2);

    const plan = (await engine.call(
      "leads.find_import",
      { preview_id: found.preview_id, top_n: 1 },
      opts,
    )) as Any;
    expect(plan.dry_run).toBe(true);
    expect(plan.preview.selected).toHaveLength(1);

    const done = (await engine.call(
      "leads.find_import",
      { preview_id: found.preview_id, top_n: 1 },
      { ...opts, dryRun: false },
    )) as Any;
    expect(done.stats.created).toBe(1);
    const search = (await engine.call("leads.search", { query: "rivers" }, opts)) as Any;
    expect(search.items.map((p: Any) => p.full_name)).toEqual(["Dana Rivers"]);
  });

  it("asks before importing a saved search and imports when approved", async () => {
    const opts = { workspace };
    const saved = (await engine.call(
      "saved_searches.create",
      {
        name: "Owners weekly",
        source: "apollo",
        criteria: { titles: ["Owner"] },
        mode: "ask_first",
      },
      opts,
    )) as Any;
    const run = (await engine.call(
      "saved_searches.run",
      { saved_search_id: saved.id },
      { ...opts, dryRun: false },
    )) as Any;
    // Dana was imported above, so only one candidate is new.
    expect(run).toMatchObject({ status: "awaiting_approval", new_candidates: 1 });

    const decided = (await engine.call(
      "approvals.decide",
      { approval_id: run.approval_id, decision: "approve" },
      opts,
    )) as Any;
    expect(JSON.stringify(decided)).toContain("Imported 1 new");
    const search = (await engine.call("leads.search", {}, opts)) as Any;
    expect(search.total).toBe(2);
  });

  it("needs the approve scope to remove a suppression", async () => {
    const opts = { workspace };
    await engine.call("suppressions.add", { type: "domain", value: "rival.example.com" }, opts);
    await expect(
      engine.call(
        "suppressions.remove",
        { type: "domain", value: "rival.example.com" },
        { ...opts, scopes: ["read", "write"] },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    const removed = (await engine.call(
      "suppressions.remove",
      { type: "domain", value: "rival.example.com" },
      opts,
    )) as Any;
    expect(removed.removed).toBe(true);
  });
});

describe("leads.forget through the engine", () => {
  it("runs in one transaction with the real services: events, jobs and the audit row", async () => {
    const opts = { workspace };
    const lead = (await engine.call(
      "leads.create",
      { full_name: "Lee Park", email: "lee@northwind-clinic.example.org" },
      opts,
    )) as Any;
    await engine.call(
      "suppressions.add",
      { type: "email", value: "lee@northwind-clinic.example.org" },
      opts,
    );
    const result = (await engine.call(
      "leads.forget",
      { person_id: lead.person.id },
      { ...opts, dryRun: false, reason: "Asked by lee@northwind-clinic.example.org" },
    )) as Any;
    expect(result).toMatchObject({ person_deleted: true, hashed_suppressions: 1 });
    const db = engine.testDb.db;
    const forgotten = await db.select().from(events).where(eq(events.type, "lead.forgotten"));
    expect(forgotten.map((row) => row.subject_id)).toContain(lead.person.id);
    const [audit] = await db
      .select()
      .from(audit_events)
      .where(eq(audit_events.operation, "leads.forget"));
    expect(audit).toMatchObject({ status: "ok", reason: "Asked by [erased]" });

    // A failed call keeps neither the address in its error message nor in its reason.
    await expect(
      engine.call(
        "leads.forget",
        { email: "lee at northwind-clinic.example.org" },
        { ...opts, dryRun: false, reason: "lee at northwind-clinic.example.org asked" },
      ),
    ).rejects.toMatchObject({ code: "validation_failed" });
    const failed = await db.select().from(audit_events).where(eq(audit_events.status, "error"));
    const entry = failed.find((row) => row.operation === "leads.forget");
    expect(entry).toMatchObject({
      reason: "[erased] asked",
      summary: 'validation_failed: "[erased]" is not a valid email.',
      input: { email: "[erased]" },
    });
  });
});
