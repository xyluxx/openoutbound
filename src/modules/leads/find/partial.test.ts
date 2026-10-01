/**
 * Paid batches that fail part way: what the source returned and charged before the failure is
 * kept and recorded, the run is partial with its failure, and the next call continues where it
 * stopped (a search from its resume cursor, an import from the candidates left).
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { type FailureClass, providerFailure } from "../../../core/failures.js";
import type { AnyZodObject, OperationDefinition } from "../../../core/operation.js";
import { imports, people, saved_searches } from "../../../db/schema/index.js";
import type {
  CompanyCandidate,
  LeadSourceProvider,
  PageRequest,
  PersonCandidate,
  SourcePage,
} from "../../../providers/types.js";
import { createTestContext, type TestContext } from "../../../testing/context.js";
import { truncateAll } from "../../../testing/db.js";
import { seedWorkspace } from "../../../testing/factories.js";
import { findLeads, importFoundLeads } from "../operations/find.js";
import {
  createSavedSearch,
  runSavedSearchOp,
  updateSavedSearch,
} from "../operations/saved-searches.js";

async function call<In extends AnyZodObject, Out extends z.ZodType>(
  op: OperationDefinition<In, Out>,
  ctx: TestContext,
  input: unknown,
): Promise<z.output<Out>> {
  return op.output.parse(await op.handler(ctx, op.input.parse(input))) as z.output<Out>;
}

// biome-ignore lint/suspicious/noExplicitAny: test results are checked with expect
type Any = any;

const fail = (provider: string, failureClass: FailureClass, partial?: unknown) =>
  providerFailure({
    provider,
    class: failureClass,
    ...(failureClass === "rate_limited" ? { retryAfterSeconds: 60 } : {}),
    ...(partial === undefined ? {} : { details: { partial } }),
  });

function place(n: number): CompanyCandidate {
  return {
    external_id: `place-${n}`,
    name: `Smile Studio ${n}`,
    domain: `smile${n}.example.com`,
    country: "US",
    source: "google_maps",
  };
}

function person(n: number): PersonCandidate {
  return {
    external_id: `apollo-${n}`,
    first_name: ["Dana", "Marco", "Lena"][n - 1] ?? "Sam",
    last_name: "Rivers",
    title: "Practice Owner",
    country: "US",
    company: { name: `Clinic ${n}`, domain: `clinic${n}.example.com`, source: "apollo" },
    source: "apollo",
  };
}

type Script<T> = Array<SourcePage<T> | Error>;

/** A Google Maps stand-in billing per request: answers search calls from a script. */
function maps(script: Script<CompanyCandidate>) {
  const requests: PageRequest[] = [];
  const provider: LeadSourceProvider = {
    id: "google_maps",
    capabilities: { people: false, companies: true, enrich: false },
    async searchCompanies(_query, page) {
      requests.push(page);
      const answer = script[Math.min(requests.length - 1, script.length - 1)];
      if (!answer || answer instanceof Error) throw answer ?? new Error("no answer");
      return answer;
    },
    async estimate() {
      return { credits: 1, minCredits: 1, maxCredits: 10 };
    },
  };
  return { provider, requests };
}

/** An Apollo stand-in: free people search, reveals answered from a script. */
function apollo(reveals: Array<"ok" | Error>) {
  const revealed: string[][] = [];
  const provider: LeadSourceProvider = {
    id: "apollo",
    capabilities: { people: true, companies: false, enrich: true },
    async searchPeople() {
      return { items: [person(1), person(2), person(3)], creditsUsed: 0 };
    },
    async enrichPeople(candidates) {
      revealed.push(candidates.map((c) => c.external_id ?? ""));
      const answer = reveals[Math.min(revealed.length - 1, reveals.length - 1)] ?? "ok";
      if (answer instanceof Error) throw answer;
      return {
        items: candidates.map((c) => ({
          ...c,
          email: `${c.first_name?.toLowerCase()}@x.example.com`,
        })),
        creditsUsed: candidates.length,
      };
    },
    async estimate({ kind, count }) {
      return { credits: kind === "enrich" ? count : 0 };
    },
  };
  return { provider, revealed };
}

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  ctx = ctx.with({ workspace: await seedWorkspace(ctx.db, { settings: {} }) });
  for (const list of [ctx.recorded.jobs, ctx.recorded.usage, ctx.recorded.events]) list.length = 0;
});

const charged = () => ctx.recorded.usage.map((usage) => usage.credits);

describe("a search that fails after some pages", () => {
  it("keeps the results already paid for, records the credits and returns where to continue", async () => {
    const source = maps([
      fail("google_maps", "rate_limited", {
        items: [place(1), place(2)],
        credits: 3,
        resume: "state-after-3",
      }),
      { items: [place(3)], creditsUsed: 1, nextCursor: null },
    ]);
    ctx.providers.set("lead_source", source.provider);
    const first: Any = await call(findLeads, ctx, {
      source: "google_maps",
      query: "dentist",
      limit: 10,
    });
    expect(first.candidates.map((c: Any) => c.domain)).toEqual([
      "smile1.example.com",
      "smile2.example.com",
    ]);
    expect(first).toMatchObject({
      credits_used: 3,
      next_cursor: "state-after-3",
      failure: { class: "rate_limited", retryable: true, provider: "google_maps" },
    });
    expect(first.warnings.join(" ")).toMatch(/kept the 2 results/);
    expect(charged()).toEqual([3]);

    const next: Any = await call(findLeads, ctx, {
      source: "google_maps",
      query: "dentist",
      limit: 10,
      cursor: first.next_cursor,
    });
    expect(source.requests[1]?.cursor).toBe("state-after-3");
    expect(next).toMatchObject({ failure: null, credits_used: 1 });
    expect(charged()).toEqual([3, 1]);
  });

  it("fails when nothing came back, after recording what was spent", async () => {
    ctx.providers.set(
      "lead_source",
      maps([fail("google_maps", "unavailable", { items: [], credits: 2 })]).provider,
    );
    await expect(
      call(findLeads, ctx, { source: "google_maps", query: "dentist", limit: 10 }),
    ).rejects.toMatchObject({ code: "provider_error" });
    expect(charged()).toEqual([2]);
  });
});

describe("an import whose reveals fail part way", () => {
  it("imports what was revealed, keeps the rest in a new preview and records the credits", async () => {
    const source = apollo([
      fail("apollo", "rate_limited", {
        items: [{ ...person(1), email: "dana@x.example.com" }, null],
        credits: 1,
      }),
      "ok",
    ]);
    ctx.providers.set("lead_source", source.provider);
    const preview: Any = await call(findLeads, ctx, { source: "apollo", titles: ["Owner"] });

    const result: Any = await call(importFoundLeads, ctx, {
      preview_id: preview.preview_id,
      candidate_ids: ["c1", "c2", "c3"],
    });
    expect(result).toMatchObject({
      status: "partial",
      credits_used: 1,
      failure: { class: "rate_limited", retryable: true },
      remaining: { candidates: 1 },
    });
    expect(result.stats.created).toBe(1);
    expect(result.skipped_rows.map((row: Any) => row.reason)).toEqual(["no_match"]);
    expect(charged()).toEqual([1]);
    const stored = await ctx.db.select().from(people);
    expect(stored.map((p) => p.email)).toEqual(["dana@x.example.com"]);
    const [row] = await ctx.db.select().from(imports).where(eq(imports.id, result.import_id));
    expect(row?.status).toBe("partial");
    expect(row?.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "provider_failed" })]),
    );
    expect(ctx.emitted("import.completed").at(-1)?.data.status).toBe("partial");

    // The rest: import the remaining preview; only that candidate is revealed and charged.
    const rest: Any = await call(importFoundLeads, ctx, {
      preview_id: result.remaining.preview_id,
      top_n: 10,
    });
    expect(source.revealed.at(-1)).toEqual(["apollo-3"]);
    expect(rest).toMatchObject({ status: "completed", failure: null, remaining: null });
    expect(charged()).toEqual([1, 1]);
    expect((await ctx.db.select().from(people)).length).toBe(2);
  });

  it("imports nothing and leaves the preview importable when no reveal came back", async () => {
    ctx.providers.set("lead_source", apollo([fail("apollo", "auth_invalid")]).provider);
    const preview: Any = await call(findLeads, ctx, { source: "apollo", titles: ["Owner"] });
    await expect(
      call(importFoundLeads, ctx, {
        preview_id: preview.preview_id,
        candidate_ids: ["c1"],
      }),
    ).rejects.toMatchObject({ code: "provider_error" });
    expect(charged()).toEqual([]);
    const [row] = await ctx.db.select().from(imports).where(eq(imports.id, preview.preview_id));
    expect(row?.status).toBe("previewed");
  });
});

describe("saved searches", () => {
  const savedMaps = { name: "Dentists", source: "google_maps", criteria: { query: "dentist" } };

  it("record a failed run in last_result, without moving last_run_at", async () => {
    ctx.providers.set("lead_source", maps([fail("google_maps", "auth_invalid")]).provider);
    const saved: Any = await call(createSavedSearch, ctx, savedMaps);
    await expect(call(runSavedSearchOp, ctx, { saved_search_id: saved.id })).rejects.toMatchObject({
      code: "provider_error",
    });
    const [row] = await ctx.db.select().from(saved_searches).where(eq(saved_searches.id, saved.id));
    expect(row?.last_run_at).toBeNull();
    expect(row?.last_result).toMatchObject({
      status: "failed",
      reason: "provider_failed",
      failure: { class: "auth_invalid", retryable: false },
      error: { code: "provider_error" },
      credits_used: 0,
      ran_at: ctx.clock.now().toISOString(),
    });
  });

  it("continue a partial search from where it stopped on the next run", async () => {
    const source = maps([
      fail("google_maps", "unavailable", {
        items: [place(1)],
        credits: 2,
        resume: "state-after-2",
      }),
      { items: [place(2)], creditsUsed: 1, nextCursor: null },
      { items: [place(4)], creditsUsed: 1, nextCursor: null },
    ]);
    ctx.providers.set("lead_source", source.provider);
    const saved: Any = await call(createSavedSearch, ctx, savedMaps);

    const first: Any = await call(runSavedSearchOp, ctx, { saved_search_id: saved.id });
    expect(first).toMatchObject({
      status: "previewed",
      partial: true,
      failure: { class: "unavailable" },
      resume_cursor: "state-after-2",
      credits_used: 2,
    });

    const second: Any = await call(runSavedSearchOp, ctx, { saved_search_id: saved.id });
    expect(source.requests[1]?.cursor).toBe("state-after-2");
    expect(second).toMatchObject({ partial: false, failure: null, resume_cursor: null });

    // A clean run starts from the top again.
    await call(runSavedSearchOp, ctx, { saved_search_id: saved.id });
    expect(source.requests[2]?.cursor).toBeUndefined();
  });

  it("forget where a partial search stopped when its criteria change", async () => {
    ctx.providers.set(
      "lead_source",
      maps([fail("google_maps", "timeout", { items: [place(1)], credits: 1, resume: "s-1" })])
        .provider,
    );
    const saved: Any = await call(createSavedSearch, ctx, savedMaps);
    await call(runSavedSearchOp, ctx, { saved_search_id: saved.id });
    const updated: Any = await call(updateSavedSearch, ctx, {
      saved_search_id: saved.id,
      criteria: { query: "orthodontist" },
    });
    expect(updated.last_result).toMatchObject({ resume_cursor: null });
  });
});
