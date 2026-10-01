import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  companies,
  icps,
  imports,
  list_members,
  lists,
  people,
  workspaces,
} from "../../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../../testing/context.js";
import { truncateAll } from "../../../testing/db.js";
import { seedCompany, seedPerson, seedWorkspace } from "../../../testing/factories.js";
import { addSuppression } from "../service.js";
import { hashSuppressionValue } from "../suppressions.js";
import { importRunJob } from "./import-job.js";
import { executeImport, type ImportRequest, previewImport } from "./import-leads.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  const workspace = await seedWorkspace(ctx.db, { settings: {} });
  ctx = ctx.with({ workspace });
  ctx.recorded.events.length = 0;
  ctx.recorded.jobs.length = 0;
  ctx.recorded.brain.length = 0;
});

function request(over: Partial<ImportRequest>): ImportRequest {
  return {
    source: "csv",
    ai_mapping: false,
    merge_policy: "fill_empty",
    score: true,
    include_consent_countries: false,
    ...over,
  };
}

const CSV = [
  "First Name,Last Name,Work Email,Job Title,Company,Company Website,Country,Person Linkedin Url",
  "Dana,Reyes,dana@harbor.example.com,Practice Manager,Harbor Dental,https://harbor.example.com,United States,",
  "Omar,Haddad,omar@lumen.example.org,Founder,Lumen Home,lumen.example.org,US,https://www.linkedin.com/in/omar-haddad",
  "Dana,Reyes,DANA@harbor.example.com,Practice Manager,Harbor Dental,,US,",
  "Lukas,Becker,lukas@northwind.example.com,Owner,Northwind,,Germany,",
  "Priya,Nair,priya@blocked.example.com,COO,Blocked Co,,US,",
  ",,,,,,,",
  "Mei,Chen,not-an-email,Director,,,US,",
  "Aisha,Bello,aisha@cedar.example.com,Head of Ops,Cedar,,US,",
].join("\n");

describe("import dry run", () => {
  it("previews mapping, samples and counts without writing", async () => {
    await seedPerson(ctx, { email: "aisha@cedar.example.com", first_name: "Aisha", title: null });
    await addSuppression(ctx, {
      type: "email",
      value: "priya@blocked.example.com",
      reason: "unsubscribed",
      source: "test",
    });
    const { preview, warnings } = await previewImport(
      ctx,
      request({ content: CSV, list_name: "Q4 import", tags: ["Dental"] }),
    );
    expect(preview.mapping).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          header: "Work Email",
          field: "email",
          method: "synonym",
          sample: "dana@harbor.example.com",
        }),
        expect.objectContaining({ header: "Company Website", field: "company.website" }),
      ]),
    );
    expect(preview.counts).toEqual({
      total: 8,
      create: 2,
      update: 0,
      merge: 1,
      duplicate: 1,
      suppressed: 1,
      invalid: 2,
      consent_country: 1,
      excluded_country: 0,
      role_address: 0,
      companies_create: 3,
    });
    expect(preview.duplicates).toEqual([{ row: 4, detail: "same lead as row 2" }]);
    expect(preview.suppressed).toEqual([{ row: 6, detail: "email is suppressed (unsubscribed)" }]);
    expect(preview.invalid).toEqual([
      { row: 7, detail: "empty_row" },
      { row: 8, detail: "no_identity" },
    ]);
    expect(preview.consent_country).toEqual([
      { row: 5, detail: "country DE requires recorded consent for email" },
    ]);
    expect(preview.list).toEqual({ id: null, name: "Q4 import", will_create: true });
    expect((preview.sample_rows as unknown[]).length).toBe(5);
    expect(preview.sample_rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          full_name: "Dana Reyes",
          email: "dana@harbor.example.com",
          tags: ["dental"],
        }),
      ]),
    );
    expect(warnings.join(" ")).toContain("consent-required");
    expect(await ctx.db.select().from(people)).toHaveLength(1);
    expect(await ctx.db.select().from(imports)).toHaveLength(0);
    expect(await ctx.db.select().from(lists)).toHaveLength(0);
    expect(ctx.recorded.events).toHaveLength(0);
  });

  it("maps unknown headers with one AI call", async () => {
    ctx.brain.on("leads.import_map_columns", { mappings: [{ header: "Mobil", field: "phone" }] });
    const { preview } = await previewImport(
      ctx,
      request({ content: "Email,Mobil\nx@example.org,+49 30 123456\n", ai_mapping: true }),
    );
    expect(preview.mapping).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ header: "Mobil", field: "phone", method: "ai" }),
      ]),
    );
    expect(ctx.recorded.brain).toHaveLength(1);
  });
});

describe("import run", () => {
  it("creates, merges and skips with row numbers, adds to a list and emits events", async () => {
    const existing = await seedPerson(ctx, {
      email: "aisha@cedar.example.com",
      first_name: "Aisha",
      last_name: null,
      title: null,
    });
    await addSuppression(ctx, {
      type: "email",
      value: "priya@blocked.example.com",
      reason: "unsubscribed",
      source: "test",
    });
    const result = await executeImport(
      ctx,
      request({ content: CSV, list_name: "Q4 import", tags: ["dental"] }),
    );
    if (!("stats" in result)) throw new Error("expected an inline result");
    expect(result.stats).toMatchObject({
      total: 8,
      created: 2,
      merged: 1,
      updated: 0,
      skipped: 5,
      failed: 0,
      skipped_by_reason: { duplicate: 1, suppressed: 1, invalid: 2, consent_country: 1 },
    });
    expect(result.skipped_rows.map((r) => [r.row, r.reason])).toEqual([
      [4, "duplicate"],
      [5, "consent_country"],
      [6, "suppressed"],
      [7, "invalid"],
      [8, "invalid"],
    ]);
    const merged = await ctx.db.select().from(people).where(eq(people.id, existing.id));
    expect(merged[0]).toMatchObject({ title: "Head of Ops", last_name: "Bello", tags: ["dental"] });
    const dana = (
      await ctx.db.select().from(people).where(eq(people.email, "dana@harbor.example.com"))
    )[0];
    expect(dana).toMatchObject({
      country: "US",
      source: "csv",
      email_source: "csv",
      email_status: "unknown",
    });
    const [harbor] = await ctx.db
      .select()
      .from(companies)
      .where(eq(companies.domain, "harbor.example.com"));
    expect(harbor?.name).toBe("Harbor Dental");
    expect(dana?.company_id).toBe(harbor?.id);
    const [list] = await ctx.db.select().from(lists);
    expect(list?.name).toBe("Q4 import");
    expect(await ctx.db.select().from(list_members)).toHaveLength(3);
    const [importRow] = await ctx.db.select().from(imports);
    expect(importRow).toMatchObject({ status: "completed", source: "csv", list_id: list?.id });
    expect(importRow?.errors?.map((e) => e.code)).toEqual([
      "duplicate",
      "consent_country",
      "suppressed",
      "invalid",
      "invalid",
    ]);
    expect(ctx.emitted("lead.created").filter((e) => e.data.kind === "person")).toHaveLength(2);
    expect(ctx.emitted("lead.created")[0]?.data.import_id).toBe(result.import_id);
    expect(ctx.emitted("import.completed")[0]?.data).toMatchObject({
      import_id: result.import_id,
      status: "completed",
      stats: { created: 2, updated: 1, skipped: 5, failed: 0 },
    });
  });

  it("applies merge policies to existing people", async () => {
    await seedPerson(ctx, {
      email: "dana@harbor.example.com",
      title: "Office Manager",
      first_name: "Dana",
    });
    const csv = "Email,Title,City\ndana@harbor.example.com,Practice Manager,Austin\n";
    const fill = await executeImport(ctx, request({ content: csv }));
    if (!("stats" in fill)) throw new Error("inline");
    expect(fill.stats).toMatchObject({ merged: 1, updated: 0 });
    let [dana] = await ctx.db.select().from(people);
    expect(dana).toMatchObject({ title: "Office Manager", city: "Austin" });

    const skip = await executeImport(ctx, request({ content: csv, merge_policy: "skip" }));
    if (!("stats" in skip)) throw new Error("inline");
    expect(skip.stats.skipped_by_reason?.duplicate).toBe(1);

    const overwrite = await executeImport(
      ctx,
      request({ content: csv, merge_policy: "overwrite" }),
    );
    if (!("stats" in overwrite)) throw new Error("inline");
    expect(overwrite.stats).toMatchObject({ updated: 1 });
    [dana] = await ctx.db.select().from(people);
    expect(dana?.title).toBe("Practice Manager");
  });

  it("scores people with the default ICP", async () => {
    await ctx.db.insert(icps).values({
      workspace_id: ctx.workspace.id,
      name: "Dental",
      is_default: true,
      criteria: { titles: ["practice manager"] },
    });
    await executeImport(
      ctx,
      request({ content: "Email,Title\ndana@harbor.example.com,Practice Manager\n" }),
    );
    const [dana] = await ctx.db.select().from(people);
    expect(dana?.fit_score).toBe(100);
    expect(dana?.fit_reasons?.[0]).toMatchObject({ rule: "title", matched: true });
  });

  it("imports company-only rows and dedupes by domain and name + city", async () => {
    await seedCompany(ctx, {
      name: "Smile Studio",
      domain: null,
      city: "Austin",
      website: null,
      industry: null,
    });
    const csv =
      "Business Name,Website,City,Category\nHarbor Dental,harbor.example.com,Austin,Dentist\nSmile Studio,,Austin,Dentist\n";
    const result = await executeImport(ctx, request({ content: csv }));
    if (!("stats" in result)) throw new Error("inline");
    expect(result.stats).toMatchObject({ created: 1, merged: 1, companies_created: 1 });
    const rows = await ctx.db.select().from(companies);
    expect(rows).toHaveLength(2);
    expect(rows.find((c) => c.domain === "harbor.example.com")?.industry).toBe("Dentist");
  });

  it("never re-imports erased people (hashed suppression)", async () => {
    await addSuppression(ctx, {
      type: "email",
      value: hashSuppressionValue("gone@example.org"),
      reason: "gdpr_erasure",
      source: "test",
    });
    const result = await executeImport(ctx, request({ content: "Email\ngone@example.org\n" }));
    if (!("stats" in result)) throw new Error("inline");
    expect(result.stats.skipped_by_reason?.suppressed).toBe(1);
    expect(await ctx.db.select().from(people)).toHaveLength(0);
  });

  it("keeps consent-country rows when asked and skips excluded countries", async () => {
    await ctx.db
      .update(workspaces)
      .set({ settings: { compliance: { excluded_countries: ["FR"] } } })
      .where(eq(workspaces.id, ctx.workspace.id));
    ctx = ctx.with({
      workspace:
        (await ctx.db.select().from(workspaces).where(eq(workspaces.id, ctx.workspace.id)))[0] ??
        ctx.workspace,
    });
    const csv = "Email,Country\nlukas@northwind.example.com,DE\nclaire@paris.example.com,France\n";
    const result = await executeImport(
      ctx,
      request({ content: csv, include_consent_countries: true }),
    );
    if (!("stats" in result)) throw new Error("inline");
    expect(result.stats).toMatchObject({ created: 1, skipped_by_reason: { excluded_country: 1 } });
  });

  it("runs large imports as a resumable job with progress", async () => {
    const lines = ["Email,First Name"];
    for (let i = 0; i < 520; i++) lines.push(`person${i}@bulk.example.com,P${i}`);
    lines.push("person1@bulk.example.com,Duplicate");
    const handle = await executeImport(ctx, request({ content: lines.join("\n") }));
    expect(handle).toMatchObject({ status: "queued" });
    if (!("job_id" in handle)) throw new Error("expected a job");
    const job = ctx.enqueued("leads.import_run")[0];
    expect(job?.payload).toEqual({ import_id: handle.import_id });
    const result = await importRunJob.handler(ctx.jobContext({ name: "leads.import_run" }), {
      import_id: handle.import_id,
    });
    expect(result).toMatchObject({ status: "completed", stats: { created: 520, skipped: 1 } });
    expect(ctx.recorded.progress.at(-1)?.progress).toMatchObject({ done: 521, total: 521 });
    const [importRow] = await ctx.db.select().from(imports);
    expect(importRow?.status).toBe("completed");
    expect(importRow?.options.rows).toBeUndefined();
    // A second run (retry after completion) is a no-op.
    expect(await importRunJob.handler(ctx.jobContext(), { import_id: handle.import_id })).toEqual({
      skipped: "not_running",
    });
  });

  it("rejects smart lists and unknown lists as destinations", async () => {
    const [smart] = await ctx.db
      .insert(lists)
      .values({ workspace_id: ctx.workspace.id, name: "Smart", kind: "smart", filter: {} })
      .returning();
    await expect(
      executeImport(ctx, request({ content: "Email\nx@example.org\n", list_id: smart?.id })),
    ).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(
      executeImport(
        ctx,
        request({ content: "Email\nx@example.org\n", list_id: "ls_01k6a3v0q8x3m2n4p5r6s7t8v9" }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
