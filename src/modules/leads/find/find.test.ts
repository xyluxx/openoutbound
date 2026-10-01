import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import type { AnyZodObject, OperationDefinition } from "../../../core/operation.js";
import {
  companies,
  icps,
  imports,
  list_members,
  people,
  workspaces,
} from "../../../db/schema/index.js";
import { createApollo } from "../../../providers/lead-source/apollo.js";
import {
  createGoogleMaps,
  googleMapsConfigSchema,
} from "../../../providers/lead-source/google-maps.js";
import { createTestContext, type TestContext } from "../../../testing/context.js";
import { truncateAll } from "../../../testing/db.js";
import { seedPerson, seedWorkspace } from "../../../testing/factories.js";
import { findLeads, importFoundLeads } from "../operations/find.js";
import type { FindPreviewOptions } from "./preview.js";

async function call<In extends AnyZodObject, Out extends z.ZodType>(
  op: OperationDefinition<In, Out>,
  ctx: TestContext,
  input: unknown,
): Promise<z.output<Out>> {
  return op.output.parse(await op.handler(ctx, op.input.parse(input))) as z.output<Out>;
}

// biome-ignore lint/suspicious/noExplicitAny: test results are checked with expect
type Any = any;

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`../../../providers/lead-source/fixtures/${name}.json`, import.meta.url),
      "utf8",
    ),
  );

const APOLLO = "https://api.apollo.io/api/v1";
const PLACES = "https://places.googleapis.com/v1/places:searchText";
const DANA = "64a1f0c2e5b7a10001a1b2c3";
const MARCO = "64a1f0c2e5b7a10001a1b2c4";

let ctx: TestContext;
let bulkMatch: unknown;

function requests(pattern: string) {
  return ctx.fetch.calls.filter((call) => call.url.includes(pattern));
}

async function seedIcp(criteria: Record<string, unknown>) {
  await ctx.db.insert(icps).values({
    workspace_id: ctx.workspace.id,
    name: "Dental owners",
    criteria,
    is_default: true,
  });
}

async function previewRow(id: string) {
  const [row] = await ctx.db.select().from(imports).where(eq(imports.id, id));
  return row;
}

beforeAll(async () => {
  ctx = await createTestContext();
  ctx.fetch.route(`${APOLLO}/mixed_people/api_search`, () => ({
    json: fixture("apollo-people-search"),
  }));
  ctx.fetch.route(`${APOLLO}/mixed_companies/search`, () => ({
    json: fixture("apollo-org-search"),
  }));
  ctx.fetch.route(`${APOLLO}/people/bulk_match`, () => ({ json: bulkMatch }));
  ctx.fetch.route(PLACES, (request) => {
    const body = JSON.parse(String(request.init?.body ?? "{}"));
    return {
      json: fixture(
        body.pageToken === "page-token-2" ? "places-search-page2" : "places-search-page1",
      ),
    };
  });
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  ctx = ctx.with({ workspace: await seedWorkspace(ctx.db, { settings: {} }) });
  for (const list of [ctx.recorded.events, ctx.recorded.jobs, ctx.recorded.usage]) list.length = 0;
  ctx.fetch.calls.length = 0;
  ctx.usage.setOverBudget("data", false);
  bulkMatch = fixture("apollo-bulk-match");
  ctx.providers.set("lead_source", [
    createApollo({ apiKey: "apollo-test-key", fetch: ctx.fetch as unknown as typeof fetch }),
    createGoogleMaps({
      apiKey: "maps-test-key",
      config: googleMapsConfigSchema.parse({}),
      fetch: ctx.fetch as unknown as typeof fetch,
    }),
  ]);
});

describe("leads.find", () => {
  it("previews Apollo people with fit scores and known records, and keeps the preview", async () => {
    await seedIcp({ titles: ["owner"] });
    const known = await seedPerson(ctx, { email: null, source_refs: { apollo: MARCO } });
    const result: Any = await call(findLeads, ctx, {
      source: "apollo",
      titles: ["Practice Owner"],
      limit: 25,
    });
    expect(result.kind).toBe("people");
    expect(result.untrusted).toBe(true);
    expect(result.credits_used).toBe(0);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({
      candidate_id: "c1",
      name: "Dana Ri***s",
      title: "Practice Owner",
      company: "Brightsmile Dental Studio",
      has_email: true,
      in_database: false,
      suppressed: false,
    });
    expect(result.candidates[0].fit_score).toBeGreaterThan(result.candidates[1].fit_score);
    expect(result.candidates[1]).toMatchObject({ in_database: true, existing_id: known.id });
    expect(result.import_estimate.credits).toBe(2);
    const body = JSON.parse(String(requests("api_search")[0]?.init?.body));
    expect(body.person_titles).toEqual(["Practice Owner"]);

    const row = await previewRow(result.preview_id);
    expect(row?.status).toBe("previewed");
    const options = row?.options as unknown as FindPreviewOptions;
    expect(options.candidates).toHaveLength(2);
    expect(JSON.stringify(options)).not.toContain("has_email");
    expect(ctx.recorded.usage).toHaveLength(0);
  });

  it("estimates in a dry run without calling the provider", async () => {
    const dry = ctx.with({ request: { dryRun: true } });
    const people: Any = await call(findLeads, dry, { source: "apollo", titles: ["Owner"] });
    expect(people).toMatchObject({ dry_run: true, estimated_cost: { credits: 0 } });
    const maps: Any = await call(findLeads, dry, { source: "google_maps", query: "dentist" });
    expect(maps.preview.kind).toBe("companies");
    expect(maps.estimated_cost.credits).toBe(2);
    expect(ctx.fetch.calls).toHaveLength(0);
  });

  it("refuses people on Google Maps, empty criteria and bad countries", async () => {
    await expect(
      call(findLeads, ctx, { source: "google_maps", kind: "people", query: "dentist" }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(call(findLeads, ctx, { source: "apollo" })).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(
      call(findLeads, ctx, { source: "apollo", countries: ["Atlantis"] }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(ctx.fetch.calls).toHaveLength(0);
  });

  it("checks the data budget before searches that cost credits only", async () => {
    ctx.usage.setOverBudget("data");
    await expect(
      call(findLeads, ctx, { source: "apollo", kind: "companies", query: "dental" }),
    ).rejects.toMatchObject({ code: "budget_exceeded" });
    const free: Any = await call(findLeads, ctx, { source: "apollo", titles: ["Owner"] });
    expect(free.candidates).toHaveLength(2);
  });

  it("stops a Google Maps search at what is left of the data budget, and continues it with the cursor", async () => {
    ctx = ctx.with({
      workspace: await seedWorkspace(ctx.db, { settings: { data: { monthly_credit_budget: 10 } } }),
    });
    const spend = (credits: number) =>
      ctx.usage.record({ slot: "lead_source", provider: "google_maps", operation: "x", credits });
    const dry = ctx.with({ request: { dryRun: true } });
    const search = { source: "google_maps", query: "dentist", location: "Austin, TX" };

    // 6 left: room for the least it takes (2 requests), so nothing to warn about.
    await spend(4);
    const fits: Any = await call(findLeads, dry, { ...search, limit: 25 });
    expect(fits.estimated_cost).toEqual({
      credits: 2,
      note: expect.stringContaining("Returning 25 places takes at least 2 Text Search requests"),
    });
    expect(fits.warnings).toEqual([]);

    // 1 left (9 of 10 used): the search starts, and stops after one request.
    await spend(5);
    const short: Any = await call(findLeads, dry, { ...search, limit: 25 });
    expect(short.warnings).toEqual([
      "Not enough data budget to finish: needs at least 2 credits, 1 left this month (9 of 10 used), so the real run stops after 1 credit with fewer results. Ask for fewer results (a lower limit), or ask the human to raise settings.data.monthly_credit_budget (openoutbound workspaces update).",
    ]);
    const first: Any = await call(findLeads, ctx, { ...search, limit: 25 });
    expect(requests("places:searchText")).toHaveLength(1);
    expect(first.credits_used).toBe(1);
    expect(first.candidates.map((c: Any) => c.name)).toEqual([
      "Brightsmile Dental Studio",
      "Lakeview Orthodontics",
    ]);
    expect(first.next_cursor).toEqual(expect.any(String));
    expect(first.warnings).toContain(
      "The search stopped after 1 credit, all that was left of the monthly data budget, with 2 of 25 results. To get the rest, ask the human to raise settings.data.monthly_credit_budget (openoutbound workspaces update), then pass next_cursor.",
    );
    expect((await ctx.usage.budgetStatus(ctx.workspace.id, "data")).remaining).toBe(0);

    // Nothing left: refused before any request.
    ctx.fetch.calls.length = 0;
    const none: Any = await call(findLeads, dry, { ...search, limit: 25 });
    expect(none.warnings).toEqual([
      "The monthly data budget is used up (10 of 10 credits), so the real run will be refused (budget_exceeded). Wait until next month, or ask the human to raise settings.data.monthly_credit_budget (openoutbound workspaces update).",
    ]);
    const more = { ...search, limit: 25, cursor: first.next_cursor };
    await expect(call(findLeads, ctx, more)).rejects.toMatchObject({
      code: "budget_exceeded",
      message:
        "Not enough data budget: needs at least 1 credit, 0 left this month (10 of 10 used).",
      hint: "Wait until next month, or ask the human to raise settings.data.monthly_credit_budget (openoutbound workspaces update).",
      details: { needed: 1, most: 30, remaining: 0 },
    });
    expect(ctx.fetch.calls).toHaveLength(0);

    // A bigger budget: the cursor picks up where the search stopped.
    await ctx.db
      .update(workspaces)
      .set({ settings: { data: { monthly_credit_budget: 20 } } })
      .where(eq(workspaces.id, ctx.workspace.id));
    const rest: Any = await call(findLeads, ctx, more);
    expect(rest.credits_used).toBe(1);
    const body = JSON.parse(String(requests("places:searchText")[0]?.init?.body));
    expect(body.pageToken).toBe("page-token-2");
    expect(rest.warnings.join(" ")).not.toContain("stopped");
  });

  it("shows Google business facts but stores only the place id, domain and country", async () => {
    const result: Any = await call(findLeads, ctx, {
      source: "google_maps",
      query: "dentist",
      location: "Austin, TX",
      limit: 10,
    });
    // Page 1 has a closed place (dropped); page 2 repeats Brightsmile (deduped).
    expect(result.candidates.map((c: Any) => c.name)).toEqual([
      "Brightsmile Dental Studio",
      "Lakeview Orthodontics",
      "Hillside Dental Care",
    ]);
    expect(result.candidates[0]).toMatchObject({
      domain: "brightsmile.example.com",
      rating: 4.8,
      location: "Austin, TX, US",
    });
    expect(result.credits_used).toBe(2);
    expect(result.warnings.join(" ")).toContain("1 place(s) have no website");
    expect(ctx.recorded.usage).toEqual([
      expect.objectContaining({ slot: "lead_source", provider: "google_maps", credits: 2 }),
    ]);

    const options = (await previewRow(result.preview_id))?.options as unknown as FindPreviewOptions;
    const stored = JSON.stringify(options);
    for (const text of [
      "Brightsmile Dental Studio",
      "Lakeview",
      "Example Ave",
      "555-0101",
      "4.8",
      "78701",
    ]) {
      expect(stored).not.toContain(text);
    }
    expect(options.candidates[0]).toMatchObject({
      external_id: "ChIJexample0000000000000001",
      company: {
        name: "brightsmile.example.com",
        domain: "brightsmile.example.com",
        website: "https://brightsmile.example.com",
        country: "US",
      },
    });
  });
});

describe("leads.find_import", () => {
  async function apolloPreview(): Promise<string> {
    const result: Any = await call(findLeads, ctx, { source: "apollo", titles: ["Owner"] });
    return result.preview_id;
  }

  it("dry runs by default: lists the selection and credits without revealing", async () => {
    await seedPerson(ctx, { email: null, source_refs: { apollo: MARCO } });
    const previewId = await apolloPreview();
    const dry = ctx.with({ request: { dryRun: true } });
    const plan: Any = await call(importFoundLeads, dry, { preview_id: previewId, top_n: 5 });
    expect(plan.dry_run).toBe(true);
    expect(plan.preview.selected.map((c: Any) => c.candidate_id)).toEqual(["c1"]);
    expect(plan.estimated_cost.credits).toBe(1);
    expect(requests("bulk_match")).toHaveLength(0);
    expect((await previewRow(previewId))?.status).toBe("previewed");
  });

  it("refuses an import that costs more than the budget has left, and warns in the dry run", async () => {
    ctx = ctx.with({
      workspace: await seedWorkspace(ctx.db, {
        settings: { data: { monthly_credit_budget: 3 } },
      }),
    });
    await ctx.usage.record({
      slot: "lead_source",
      provider: "apollo",
      operation: "leads.find_import",
      credits: 2,
    });
    const previewId = await apolloPreview();

    const dry = ctx.with({ request: { dryRun: true } });
    const plan: Any = await call(importFoundLeads, dry, { preview_id: previewId, top_n: 2 });
    expect(plan.estimated_cost.credits).toBe(2);
    expect(plan.preview.budget).toEqual({
      monthly_credits: 3,
      used_this_month: 2,
      left_this_month: 1,
    });
    expect(plan.warnings).toContain(
      "Not enough data budget: needs 2 credits, 1 left this month (2 of 3 used), so the real run will be refused. Import at most 1 (top_n 1), or ask the human to raise settings.data.monthly_credit_budget (openoutbound workspaces update).",
    );

    await expect(
      call(importFoundLeads, ctx, { preview_id: previewId, top_n: 2 }),
    ).rejects.toMatchObject({
      code: "budget_exceeded",
      message: "Not enough data budget: needs 2 credits, 1 left this month (2 of 3 used).",
      hint: "Import at most 1 (top_n 1), or ask the human to raise settings.data.monthly_credit_budget (openoutbound workspaces update).",
    });
    expect(requests("bulk_match")).toHaveLength(0);
    expect((await previewRow(previewId))?.status).toBe("previewed");

    bulkMatch = { ...(fixture("apollo-bulk-match") as object), credits_consumed: 1 };
    const done: Any = await call(importFoundLeads, ctx, { preview_id: previewId, top_n: 1 });
    expect(done.stats.created).toBe(1);
    expect((await ctx.usage.budgetStatus(ctx.workspace.id, "data")).remaining).toBe(0);
  });

  it("reveals only the selected Apollo people and imports them into a list", async () => {
    const previewId = await apolloPreview();
    const result: Any = await call(importFoundLeads, ctx, {
      preview_id: previewId,
      candidate_ids: ["c1"],
      list_name: "Dental owners",
    });
    expect(result.stats.created).toBe(1);
    expect(result.credits_used).toBe(2);
    const body = JSON.parse(String(requests("bulk_match")[0]?.init?.body));
    expect(body.details).toEqual([{ id: DANA }]);
    expect(ctx.recorded.usage).toEqual([
      expect.objectContaining({ provider: "apollo", operation: "leads.find_import", credits: 2 }),
    ]);

    const [dana] = await ctx.db
      .select()
      .from(people)
      .where(eq(people.workspace_id, ctx.workspace.id));
    expect(dana).toMatchObject({
      full_name: "Dana Rivers",
      email: "dana.rivers@brightsmile.example.com",
      email_status: "valid",
      email_source: "apollo",
      linkedin_url: "https://www.linkedin.com/in/dana-rivers-example",
      source: "apollo",
    });
    expect(dana?.source_refs).toMatchObject({ apollo: DANA });
    const members = await ctx.db.select().from(list_members);
    expect(members.map((m) => m.person_id)).toEqual([dana?.id]);

    const row = await previewRow(previewId);
    expect(row?.status).toBe("completed");
    expect((row?.options as Record<string, unknown> | undefined)?.candidates).toBeUndefined();
    await expect(
      call(importFoundLeads, ctx, { preview_id: previewId, candidate_ids: ["c2"] }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("skips people the source cannot match and queues enrichment for the rest", async () => {
    const full = fixture("apollo-bulk-match") as { matches: unknown[] };
    bulkMatch = { matches: [null, full.matches[1]], credits_consumed: 1 };
    const previewId = await apolloPreview();
    const result: Any = await call(importFoundLeads, ctx, {
      preview_id: previewId,
      candidate_ids: ["c1", "c2"],
      enrich: true,
    });
    expect(result.stats.created).toBe(1);
    expect(result.stats.skipped_by_reason.no_match).toBe(1);
    expect(result.skipped_rows).toEqual([expect.objectContaining({ row: 1, reason: "no_match" })]);
    expect(result.enrichment_job_id).not.toBeNull();
    expect(ctx.recorded.jobs.map((job) => job.name)).toContain("enrichment.run");
  });

  it("imports Google places by place id and domain, then queues the website crawl", async () => {
    const found: Any = await call(findLeads, ctx, {
      source: "google_maps",
      query: "dental clinic",
      categories: ["dentist"],
      location: "Austin, TX",
      limit: 10,
    });
    const result: Any = await call(importFoundLeads, ctx, {
      preview_id: found.preview_id,
      top_n: 10,
      list_name: "Austin dental",
    });
    expect(result.stats.created).toBe(2);
    expect(result.stats.skipped_by_reason.no_website).toBe(1);
    expect(result.credits_used).toBe(0);

    const rows = await ctx.db
      .select()
      .from(companies)
      .where(eq(companies.workspace_id, ctx.workspace.id));
    const brightsmile = rows.find((c) => c.domain === "brightsmile.example.com");
    expect(brightsmile).toMatchObject({
      name: "brightsmile.example.com",
      website: "https://brightsmile.example.com",
      country: "US",
      industry: "dentist",
      address: null,
      phone: null,
      city: null,
      source: "google_maps",
    });
    expect(brightsmile?.source_refs).toEqual({
      google_maps: "ChIJexample0000000000000001",
      google_maps_fetched_at: ctx.clock.now().toISOString(),
    });

    const job = ctx.recorded.jobs.find((j) => j.name === "enrichment.find_contacts");
    expect(job?.payload).toMatchObject({ find_people: true, list_id: result.list_id });
    expect((job?.payload as Any)?.company_ids).toHaveLength(2);
    expect(result.contacts_job_id).toBe(job?.job_id);
  });

  it("refuses unknown candidate ids, a missing selection and file imports", async () => {
    const previewId = await apolloPreview();
    await expect(
      call(importFoundLeads, ctx, { preview_id: previewId, candidate_ids: ["c9"] }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(call(importFoundLeads, ctx, { preview_id: previewId })).rejects.toMatchObject({
      code: "validation_failed",
    });
    const [fileImport] = await ctx.db
      .insert(imports)
      .values({ workspace_id: ctx.workspace.id, source: "csv", status: "completed" })
      .returning();
    await expect(
      call(importFoundLeads, ctx, { preview_id: fileImport?.id, top_n: 1 }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(requests("bulk_match")).toHaveLength(0);
  });
});
