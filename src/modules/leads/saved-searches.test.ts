import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import type { AnyZodObject, OperationDefinition } from "../../core/operation.js";
import {
  approvals,
  list_members,
  lists,
  people,
  saved_searches,
  workspaces,
} from "../../db/schema/index.js";
import { createApollo } from "../../providers/lead-source/apollo.js";
import {
  createGoogleMaps,
  googleMapsConfigSchema,
} from "../../providers/lead-source/google-maps.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { truncateAll } from "../../testing/db.js";
import { seedPerson, seedWorkspace } from "../../testing/factories.js";
import { createFakeFetch } from "../../testing/fake-fetch.js";
import {
  createSavedSearch,
  runSavedSearchOp,
  updateSavedSearch,
} from "./operations/saved-searches.js";
import {
  assertSchedule,
  leadImportResolver,
  nextRunAt,
  savedSearchTickJob,
} from "./saved-searches.js";

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
      new URL(`../../providers/lead-source/fixtures/${name}.json`, import.meta.url),
      "utf8",
    ),
  );

const APOLLO = "https://api.apollo.io/api/v1";
const PLACES = "https://places.googleapis.com/v1/places:searchText";

let ctx: TestContext;

const apolloSearch = { name: "Dental owners", source: "apollo", criteria: { titles: ["Owner"] } };

beforeAll(async () => {
  ctx = await createTestContext();
  ctx.fetch.route(`${APOLLO}/mixed_people/api_search`, () => ({
    json: fixture("apollo-people-search"),
  }));
  ctx.fetch.route(`${APOLLO}/people/bulk_match`, () => ({ json: fixture("apollo-bulk-match") }));
  ctx.fetch.route(PLACES, () => ({ json: fixture("places-search-page2") }));
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  ctx = ctx.with({ workspace: await seedWorkspace(ctx.db, { settings: {} }) });
  for (const list of [ctx.recorded.jobs, ctx.recorded.usage, ctx.recorded.approvals]) {
    list.length = 0;
  }
  ctx.fetch.calls.length = 0;
  ctx.usage.setOverBudget("data", false);
  const fetch = ctx.fetch as unknown as typeof globalThis.fetch;
  ctx.providers.set("lead_source", [
    createApollo({ apiKey: "apollo-test-key", fetch }),
    createGoogleMaps({ apiKey: "maps-key", config: googleMapsConfigSchema.parse({}), fetch }),
  ]);
});

describe("saved_searches.create", () => {
  it("validates the source, the spend cap and the schedule", async () => {
    await expect(
      call(createSavedSearch, ctx, {
        name: "x",
        source: "google_maps",
        kind: "people",
        criteria: { query: "dentist" },
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      call(createSavedSearch, ctx, { ...apolloSearch, mode: "auto_import" }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      call(createSavedSearch, ctx, { ...apolloSearch, schedule: "every monday" }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      call(createSavedSearch, ctx, { ...apolloSearch, schedule: "*/5 * * * *" }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      call(createSavedSearch, ctx, { name: "x", source: "leads" }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("stores the query with its kind, the list and the next run", async () => {
    const saved: Any = await call(createSavedSearch, ctx, {
      ...apolloSearch,
      schedule: "0 8 * * 1",
      list_name: "Owners",
    });
    expect(saved).toMatchObject({ kind: "people", mode: "manual", enabled: true });
    expect(saved.query).toEqual({ kind: "people", titles: ["Owner"] });
    expect(saved.list_id).toMatch(/^ls_/);
    expect(new Date(saved.next_run_at).getUTCDay()).toBe(1);
  });
});

describe("schedules", () => {
  it("accepts hourly or slower crons and computes the next run in the workspace timezone", () => {
    expect(() => assertSchedule("0 * * * *", "UTC")).not.toThrow();
    expect(() => assertSchedule("*/30 * * * *", "UTC")).toThrow(/once an hour/);
    const next = nextRunAt("0 8 * * *", "Europe/Berlin", new Date("2026-03-28T12:00:00Z"));
    // The day after the switch to summer time: 08:00 in Berlin is 06:00 UTC.
    expect(next?.toISOString()).toBe("2026-03-29T06:00:00.000Z");
    expect(nextRunAt(null, "UTC", new Date())).toBeNull();
  });
});

describe("saved_searches.run", () => {
  it("manual mode keeps a preview and records the result", async () => {
    const saved: Any = await call(createSavedSearch, ctx, apolloSearch);
    const result: Any = await call(runSavedSearchOp, ctx, { saved_search_id: saved.id });
    expect(result).toMatchObject({ status: "previewed", new_candidates: 2, imported: 0 });
    expect(result.preview_id).toMatch(/^imp_/);
    const [row] = await ctx.db.select().from(saved_searches).where(eq(saved_searches.id, saved.id));
    expect(row?.last_result).toMatchObject({ status: "previewed", preview_id: result.preview_id });
    expect(row?.last_run_at).not.toBeNull();
  });

  it("ask_first creates a lead_import approval that imports on approve", async () => {
    const saved: Any = await call(createSavedSearch, ctx, {
      ...apolloSearch,
      mode: "ask_first",
      list_name: "Approved owners",
    });
    const result: Any = await call(runSavedSearchOp, ctx, { saved_search_id: saved.id });
    expect(result.status).toBe("awaiting_approval");
    const [approval] = await ctx.db.select().from(approvals);
    expect(approval).toMatchObject({ kind: "lead_import", target_id: saved.id });
    expect(approval?.payload).toMatchObject({
      candidate_ids: ["c1", "c2"],
      list_id: saved.list_id,
    });
    expect(ctx.fetch.calls.some((c) => c.url.includes("bulk_match"))).toBe(false);

    const rejected = await leadImportResolver.apply(ctx, approval as Any, {
      decision: "reject",
      decidedBy: { type: "human", id: "tester", name: "Tester" },
    });
    expect(rejected.message).toContain("skipped");

    const applied = await leadImportResolver.apply(ctx, approval as Any, {
      decision: "edit",
      edits: { candidate_ids: ["c1"] },
      decidedBy: { type: "human", id: "tester", name: "Tester" },
    });
    expect(applied.target?.type).toBe("import");
    const imported = await ctx.db.select().from(people);
    expect(imported.map((p) => p.full_name)).toEqual(["Dana Rivers"]);
    const members = await ctx.db.select().from(list_members);
    expect(members).toHaveLength(1);
  });

  it("auto_import stays within the spend cap", async () => {
    const saved: Any = await call(createSavedSearch, ctx, {
      ...apolloSearch,
      mode: "auto_import",
      spend_cap_credits: 1,
    });
    const result: Any = await call(runSavedSearchOp, ctx, { saved_search_id: saved.id });
    expect(result).toMatchObject({ status: "imported", new_candidates: 2, selected: 1 });
    const body = JSON.parse(
      String(ctx.fetch.calls.find((c) => c.url.includes("bulk_match"))?.init?.body),
    );
    expect(body.details).toHaveLength(1);
    expect(await ctx.db.select().from(people)).toHaveLength(1);
  });

  it("auto_import reveals only as many people as the monthly data budget has left", async () => {
    ctx = ctx.with({
      workspace: await seedWorkspace(ctx.db, { settings: { data: { monthly_credit_budget: 5 } } }),
    });
    await ctx.usage.record({ slot: "lead_source", provider: "apollo", operation: "x", credits: 4 });
    const saved: Any = await call(createSavedSearch, ctx, {
      ...apolloSearch,
      mode: "auto_import",
      spend_cap_credits: 10,
    });
    const result: Any = await call(runSavedSearchOp, ctx, { saved_search_id: saved.id });
    expect(result).toMatchObject({ status: "imported", new_candidates: 2, selected: 1 });
    const body = JSON.parse(
      String(ctx.fetch.calls.find((c) => c.url.includes("bulk_match"))?.init?.body),
    );
    expect(body.details).toHaveLength(1);

    expect(result.refusal).toBeNull();

    await ctx.usage.record({ slot: "lead_source", provider: "apollo", operation: "x", credits: 5 });
    const empty: Any = await call(runSavedSearchOp, ctx, { saved_search_id: saved.id });
    expect(empty).toMatchObject({
      selected: 0,
      reason: "budget_exceeded",
      imported: 0,
      refusal: {
        message: expect.stringMatching(
          /^Not enough data budget: needs 1 credit, 0 left this month \(\d+ of 5 used\)\.$/,
        ),
        hint: "Wait until next month, or ask the human to raise settings.data.monthly_credit_budget (openoutbound workspaces update).",
        details: { needed: 1, remaining: 0, budget: 5 },
      },
    });
  });

  it("keeps why a run was skipped or stopped, with the numbers and how to fix it", async () => {
    ctx = ctx.with({
      workspace: await seedWorkspace(ctx.db, { settings: { data: { monthly_credit_budget: 5 } } }),
    });
    const maps: Any = await call(createSavedSearch, ctx, {
      name: "Clinics",
      source: "google_maps",
      criteria: { query: "dentist" },
      max_results: 40,
      spend_cap_credits: 0,
    });
    // The spend cap leaves no room for the first request.
    expect(await call(runSavedSearchOp, ctx, { saved_search_id: maps.id })).toMatchObject({
      status: "skipped",
      reason: "spend_cap",
      refusal: {
        message: "spend_cap_credits is 0, less than the 1 credit a search needs to start.",
        hint: "Raise spend_cap_credits with manage_saved_searches action update.",
        details: { needed: 1, spend_cap_credits: 0 },
      },
    });

    // The spend cap leaves nothing for the reveals after a free search.
    const apollo: Any = await call(createSavedSearch, ctx, {
      ...apolloSearch,
      mode: "auto_import",
      spend_cap_credits: 0,
    });
    expect(await call(runSavedSearchOp, ctx, { saved_search_id: apollo.id })).toMatchObject({
      status: "previewed",
      selected: 0,
      reason: "spend_cap",
      refusal: {
        message:
          "spend_cap_credits is 0 and the search used 0 credits, which leaves nothing to reveal people (1 credit each).",
        hint: "Raise spend_cap_credits with manage_saved_searches action update.",
        details: { spend_cap_credits: 0, credits_used: 0, per_person: 1 },
      },
    });
    expect(ctx.fetch.calls.some((c) => c.url.includes("bulk_match"))).toBe(false);

    // The data budget is used up: the refusal keeps the numbers, in last_result too.
    await ctx.usage.record({ slot: "lead_source", provider: "apollo", operation: "x", credits: 5 });
    await call(updateSavedSearch, ctx, { saved_search_id: maps.id, spend_cap_credits: null });
    const refusal = {
      message: "Not enough data budget: needs at least 1 credit, 0 left this month (5 of 5 used).",
      hint: "Wait until next month, or ask the human to raise settings.data.monthly_credit_budget (openoutbound workspaces update).",
      details: { kind: "data", needed: 1, most: 30, remaining: 0, used: 5, budget: 5 },
    };
    expect(await call(runSavedSearchOp, ctx, { saved_search_id: maps.id })).toMatchObject({
      status: "skipped",
      reason: "budget_exceeded",
      refusal,
    });
    const [row] = await ctx.db.select().from(saved_searches).where(eq(saved_searches.id, maps.id));
    expect(row?.last_result).toMatchObject({ refusal });
    expect(ctx.fetch.calls.some((c) => c.url.includes("places"))).toBe(false);
  });

  it("stops a Google Maps run at its spend cap, and skips it when not even one request fits", async () => {
    // Page 1 has a next page token, so the whole search takes two requests.
    const pages = createFakeFetch([
      {
        match: PLACES,
        method: "POST",
        response: (request) => ({
          json: fixture(
            JSON.parse(String(request.init?.body ?? "{}")).pageToken === "page-token-2"
              ? "places-search-page2"
              : "places-search-page1",
          ),
        }),
      },
    ]);
    ctx.providers.set("lead_source", [
      createGoogleMaps({
        apiKey: "maps-key",
        config: googleMapsConfigSchema.parse({}),
        fetch: pages as unknown as typeof globalThis.fetch,
      }),
    ]);
    const maps: Any = await call(createSavedSearch, ctx, {
      name: "Clinics",
      source: "google_maps",
      criteria: { query: "dentist" },
      max_results: 60,
      spend_cap_credits: 1,
    });
    const capped: Any = await call(runSavedSearchOp, ctx, { saved_search_id: maps.id });
    expect(capped).toMatchObject({ status: "previewed", credits_used: 1, new_candidates: 2 });
    expect(pages.calls).toHaveLength(1);

    await call(updateSavedSearch, ctx, { saved_search_id: maps.id, spend_cap_credits: 0 });
    const zero: Any = await call(runSavedSearchOp, ctx, { saved_search_id: maps.id });
    expect(zero).toMatchObject({ status: "skipped", reason: "spend_cap", credits_used: 0 });

    await call(updateSavedSearch, ctx, { saved_search_id: maps.id, spend_cap_credits: 10 });
    ctx.usage.setOverBudget("data");
    const broke: Any = await call(runSavedSearchOp, ctx, { saved_search_id: maps.id });
    expect(broke).toMatchObject({ status: "skipped", reason: "budget_exceeded" });
    expect(pages.calls).toHaveLength(1);
  });

  it("continues a Google Maps search from the paid page that timed out", async () => {
    let timeouts = 1;
    const pages = createFakeFetch([
      {
        match: PLACES,
        method: "POST",
        response: (request) => {
          const token = JSON.parse(String(request.init?.body ?? "{}")).pageToken;
          if (token !== "page-token-2") return { json: fixture("places-search-page1") };
          if (timeouts > 0) {
            timeouts -= 1;
            throw Object.assign(new Error("The operation was aborted due to timeout"), {
              name: "TimeoutError",
            });
          }
          return { json: fixture("places-search-page2") };
        },
      },
    ]);
    ctx.providers.set("lead_source", [
      createGoogleMaps({
        apiKey: "maps-key",
        config: googleMapsConfigSchema.parse({}),
        fetch: pages as unknown as typeof globalThis.fetch,
      }),
    ]);
    const maps: Any = await call(createSavedSearch, ctx, {
      name: "Clinics",
      source: "google_maps",
      criteria: { query: "dentist" },
      max_results: 60,
    });
    const first: Any = await call(runSavedSearchOp, ctx, { saved_search_id: maps.id });
    // The page that timed out may have been billed, so it is not repeated within the run, but
    // the next run starts at that page instead of from the top.
    expect(first).toMatchObject({
      status: "previewed",
      partial: true,
      credits_used: 1,
      failure: { class: "timeout", retryable: false, scope: "call" },
    });
    expect(first.resume_cursor).toEqual(expect.any(String));

    const second: Any = await call(runSavedSearchOp, ctx, { saved_search_id: maps.id });
    const tokens = pages.calls.map(
      (request) => JSON.parse(String(request.init?.body ?? "{}")).pageToken ?? null,
    );
    expect(tokens).toEqual([null, "page-token-2", "page-token-2"]);
    expect(second).toMatchObject({ partial: false, failure: null, resume_cursor: null });
  });

  it("dry runs compare the spend cap with the most a Google Maps search can cost", async () => {
    ctx = ctx.with({
      workspace: await seedWorkspace(ctx.db, { settings: { data: { monthly_credit_budget: 10 } } }),
    });
    const dryRun = async (id: string): Promise<Any> =>
      call(runSavedSearchOp, ctx.with({ request: { dryRun: true } }), { saved_search_id: id });
    const maps: Any = await call(createSavedSearch, ctx, {
      name: "Clinics",
      source: "google_maps",
      criteria: { query: "dentist" },
      max_results: 40,
      spend_cap_credits: 10,
    });
    // At least 2 requests fit the cap, but a split search can take up to 30.
    const dry = await dryRun(maps.id);
    expect(dry.preview).toMatchObject({
      search_credits: 2,
      max_search_credits: 30,
      spend_cap_credits: 10,
      within_cap: false,
    });
    expect(dry.estimated_cost).toEqual({
      credits: 2,
      note: expect.stringContaining("Returning 40 places takes at least 2 Text Search requests"),
    });
    expect(dry.warnings).toEqual([]);

    await call(updateSavedSearch, ctx, { saved_search_id: maps.id, spend_cap_credits: 30 });
    expect((await dryRun(maps.id)).preview.within_cap).toBe(true);

    await call(updateSavedSearch, ctx, { saved_search_id: maps.id, spend_cap_credits: 1 });
    expect((await dryRun(maps.id)).warnings).toEqual([
      "spend_cap_credits is 1, less than the at least 2 credits this search needs, so the run stops after 1 credit with fewer results. Raise spend_cap_credits or lower max_results with manage_saved_searches action update.",
    ]);
    await call(updateSavedSearch, ctx, { saved_search_id: maps.id, spend_cap_credits: 0 });
    expect((await dryRun(maps.id)).warnings).toEqual([
      "spend_cap_credits is 0, less than the 1 credit a search needs to start, so the run will be skipped (spend_cap). Raise spend_cap_credits with manage_saved_searches action update.",
    ]);

    // 1 left of the data budget: the run stops after one request.
    await ctx.usage.record({ slot: "lead_source", provider: "x", operation: "x", credits: 9 });
    await call(updateSavedSearch, ctx, { saved_search_id: maps.id, spend_cap_credits: null });
    expect((await dryRun(maps.id)).warnings).toEqual([
      "Not enough data budget to finish: needs at least 2 credits, 1 left this month (9 of 10 used), so the real run stops after 1 credit with fewer results. Lower max_results with manage_saved_searches action update, or ask the human to raise settings.data.monthly_credit_budget (openoutbound workspaces update).",
    ]);

    // Apollo people searches are free: a known cost, nothing to warn about.
    const apollo: Any = await call(createSavedSearch, ctx, apolloSearch);
    const plain = await dryRun(apollo.id);
    expect(plain.preview).toMatchObject({ search_credits: 0, max_search_credits: 0 });
    expect(plain.estimated_cost).toEqual({
      credits: 0,
      note: "Apollo people search is free (no emails).",
    });
    expect(plain.warnings).toEqual([]);
    expect(ctx.fetch.calls).toHaveLength(0);
  });

  it("source leads adds new matches to the list", async () => {
    const [list] = await ctx.db
      .insert(lists)
      .values({ workspace_id: ctx.workspace.id, name: "High fit", kind: "static" })
      .returning();
    const saved: Any = await call(createSavedSearch, ctx, {
      name: "High fit",
      source: "leads",
      filter: { min_fit_score: 70 },
      mode: "auto_import",
      list_id: list?.id,
    });
    const before = new Date(ctx.clock.now().getTime() - 60_000);
    await seedPerson(ctx, { fit_score: 80, created_at: before });
    await seedPerson(ctx, { fit_score: 20, created_at: before });
    const first: Any = await call(runSavedSearchOp, ctx, { saved_search_id: saved.id });
    expect(first).toMatchObject({ status: "imported", new_candidates: 1, imported: 1 });
    ctx.clock.advanceBy({ minutes: 1 });
    const second: Any = await call(runSavedSearchOp, ctx, { saved_search_id: saved.id });
    expect(second).toMatchObject({ new_candidates: 0, reason: "no_new_matches" });
  });

  it("source leads in ask_first adds matches to the list only after approval", async () => {
    const [list] = await ctx.db
      .insert(lists)
      .values({ workspace_id: ctx.workspace.id, name: "High fit", kind: "static" })
      .returning();
    const saved: Any = await call(createSavedSearch, ctx, {
      name: "High fit",
      source: "leads",
      filter: { min_fit_score: 70 },
      mode: "ask_first",
      list_id: list?.id,
    });
    const before = new Date(ctx.clock.now().getTime() - 60_000);
    const dana = await seedPerson(ctx, { fit_score: 80, created_at: before });
    const marco = await seedPerson(ctx, { fit_score: 90, created_at: before });
    await seedPerson(ctx, { fit_score: 20, created_at: before });
    const result: Any = await call(runSavedSearchOp, ctx, { saved_search_id: saved.id });
    expect(result).toMatchObject({ status: "awaiting_approval", new_candidates: 2, imported: 0 });
    expect(await ctx.db.select().from(list_members)).toHaveLength(0);
    const [approval] = await ctx.db.select().from(approvals);
    expect(approval).toMatchObject({
      id: result.approval_id,
      kind: "lead_import",
      target_id: saved.id,
    });
    const payload = approval?.payload as Any;
    expect(payload).toMatchObject({ source: "leads", list_id: list?.id });
    expect([...payload.person_ids].sort()).toEqual([dana.id, marco.id].sort());

    const decidedBy = { type: "human", id: "tester", name: "Tester" } as const;
    const rejected = await leadImportResolver.apply(ctx, approval as Any, {
      decision: "reject",
      decidedBy,
    });
    expect(rejected.message).toBe("Nobody was added to the list.");
    expect(await ctx.db.select().from(list_members)).toHaveLength(0);

    const outsider = await seedPerson(ctx, { fit_score: 95 });
    const applied = await leadImportResolver.apply(ctx, approval as Any, {
      decision: "edit",
      edits: { person_ids: [marco.id, outsider.id] },
      decidedBy,
    });
    expect(applied).toMatchObject({ target: { type: "list", id: list?.id }, data: { added: 1 } });
    const members = await ctx.db.select().from(list_members);
    expect(members.map((member) => member.person_id)).toEqual([marco.id]);
  });
});

describe("leads.saved_searches_tick", () => {
  it("enqueues due searches once and skips paused workspaces", async () => {
    const due: Any = await call(createSavedSearch, ctx, { ...apolloSearch, schedule: "0 8 * * *" });
    const later: Any = await call(createSavedSearch, ctx, {
      ...apolloSearch,
      name: "Later",
      schedule: "0 9 * * *",
    });
    await ctx.db
      .update(saved_searches)
      .set({ next_run_at: new Date(ctx.clock.now().getTime() - 1000) })
      .where(eq(saved_searches.id, due.id));
    const job = ctx.jobContext({ name: "leads.saved_searches_tick" });
    expect(await savedSearchTickJob.handler(job, {})).toEqual({ enqueued: 1 });
    expect(ctx.enqueued("leads.saved_search_run").map((j) => j.payload)).toEqual([
      { saved_search_id: due.id },
    ]);
    expect(await savedSearchTickJob.handler(job, {})).toEqual({ enqueued: 0 });
    const [row] = await ctx.db.select().from(saved_searches).where(eq(saved_searches.id, later.id));
    expect(row?.next_run_at).not.toBeNull();

    await ctx.db
      .update(workspaces)
      .set({ status: "paused" })
      .where(eq(workspaces.id, ctx.workspace.id));
    await ctx.reloadWorkspace();
    const paused = ctx.jobContext({ name: "leads.saved_searches_tick" });
    expect(await savedSearchTickJob.handler(paused, {})).toEqual({
      skipped: "workspace_not_active",
    });
  });
});
