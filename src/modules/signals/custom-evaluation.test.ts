import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { signal_definitions } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { seedCompany } from "../../testing/factories.js";
import { PageCache } from "./collectors/pages.js";
import type { EvidenceItem } from "./collectors/types.js";
import {
  evaluateCustomDefinition,
  evidenceForDefinition,
  gatherSandboxUrlEvidence,
  gatherUrlEvidence,
  resolveDefinitionUrls,
} from "./custom-evaluation.js";
import { html, robotsDisallowed } from "./test-helpers.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(() => {
  ctx.recorded.brain.length = 0;
});

async function customDefinition(
  key: string,
  detection: Partial<typeof signal_definitions.$inferInsert.detection> = {},
) {
  const [row] = await ctx.db
    .insert(signal_definitions)
    .values({
      workspace_id: ctx.workspace.id,
      key,
      name: "Hiring a first SDR",
      description: "Company is hiring its first sales development rep.",
      kind: "custom",
      weight: 50,
      half_life_days: 30,
      min_strength: 0.5,
      detection: {
        collectors: ["job_boards"],
        keywords: ["SDR", "BDR"],
        instructions: "A job post in the last 45 days for a first or founding SDR.",
        urls: [],
        ...detection,
      },
    })
    .returning();
  if (!row) throw new Error("insert failed");
  return row;
}

const jobEvidence: EvidenceItem[] = [
  {
    url: "https://jobs.example.org/acme/founding-sdr",
    title: "Founding SDR",
    text: "Founding SDR | Sales | Remote. Be our first sales development hire.",
    published_at: "2026-09-10T00:00:00.000Z",
    collector: "job_boards",
  },
  {
    url: "https://acme-news.example.org/post",
    title: "Unrelated news",
    text: "A news item",
    collector: "news_gdelt",
  },
];

describe("evaluateCustomDefinition", () => {
  it("records a match that cites a collected source, then skips unchanged evidence", async () => {
    const company = await seedCompany(ctx, { name: "Acme Robotics" });
    const definition = await customDefinition("first_sdr_hire");
    ctx.brain.on("signals.custom.evaluate", (vars: { sources: Array<{ url: string }> }) => {
      expect(vars.sources.map((s) => s.url)).toEqual([
        "https://jobs.example.org/acme/founding-sdr",
      ]);
      return {
        matched: true,
        strength: 1,
        evidence_url: "https://jobs.example.org/acme/founding-sdr/",
        evidence_excerpt: "Be our first sales development hire.",
        summary: "They are hiring their first SDR.",
      };
    });
    const result = await evaluateCustomDefinition(ctx, {
      company,
      definition,
      evidence: jobEvidence,
    });
    expect(result).toMatchObject({
      status: "matched",
      brainCalls: 1,
      signal: {
        definition_key: "first_sdr_hire",
        title: "Hiring a first SDR",
        evidence_url: "https://jobs.example.org/acme/founding-sdr",
        evidence_excerpt: "Be our first sales development hire.",
        occurred_at: "2026-09-10T00:00:00.000Z",
        source: "job_boards",
        strength: 1,
      },
    });
    expect(ctx.recorded.brain[0]?.options?.tier).toBe("fast");
    expect(ctx.recorded.brain[0]?.user).toContain("<untrusted_content");

    const again = await evaluateCustomDefinition(ctx, {
      company,
      definition,
      evidence: jobEvidence,
    });
    expect(again).toMatchObject({ status: "unchanged", brainCalls: 0 });
    const forced = await evaluateCustomDefinition(ctx, {
      company,
      definition,
      evidence: jobEvidence,
      force: true,
    });
    expect(forced.status).toBe("matched");
  });

  it("discards answers whose evidence URL was not provided", async () => {
    const company = await seedCompany(ctx);
    const definition = await customDefinition("first_sdr_hire_b", { tier: "standard" });
    ctx.brain.on("signals.custom.evaluate", {
      matched: true,
      strength: 0.9,
      evidence_url: "https://made-up.example.net/job",
      evidence_excerpt: "x",
      summary: "x",
    });
    const result = await evaluateCustomDefinition(ctx, {
      company,
      definition,
      evidence: jobEvidence,
    });
    expect(result).toMatchObject({ status: "discarded", brainCalls: 1 });
    expect(result.signal).toBeUndefined();
    expect(ctx.recorded.brain[0]?.options?.tier).toBe("standard");
  });

  it("returns no_match and no_evidence without recording anything", async () => {
    const company = await seedCompany(ctx);
    const definition = await customDefinition("first_sdr_hire_c");
    ctx.brain.on("signals.custom.evaluate", {
      matched: false,
      strength: 0,
      evidence_url: "",
      evidence_excerpt: "",
      summary: "",
    });
    expect(
      (await evaluateCustomDefinition(ctx, { company, definition, evidence: jobEvidence })).status,
    ).toBe("no_match");
    const onlyNews = jobEvidence.filter((item) => item.collector === "news_gdelt");
    expect(
      await evaluateCustomDefinition(ctx, { company, definition, evidence: onlyNews }),
    ).toMatchObject({ status: "no_evidence", brainCalls: 0 });
  });
});

describe("definition URLs", () => {
  it("resolves paths, templates and absolute URLs, then fetches them politely", async () => {
    const company = await seedCompany(ctx, {
      domain: "ce-urls.example.com",
      website: "https://ce-urls.example.com",
    });
    const definition = await customDefinition("trust_page", {
      collectors: ["website_changes"],
      urls: ["/trust", "https://{domain}/security", "https://expo.example.org/exhibitors", "nope"],
    });
    expect(resolveDefinitionUrls(definition, company)).toEqual([
      "https://ce-urls.example.com/trust",
      "https://ce-urls.example.com/security",
      "https://expo.example.org/exhibitors",
    ]);
    ctx.fetch.route("https://ce-urls.example.com/trust", {
      body: html("<h1>Trust</h1><p>SOC 2 audit in progress</p>"),
    });
    ctx.fetch.route("https://ce-urls.example.com/security", { status: 404, body: "" });
    ctx.fetch.route("https://expo.example.org/exhibitors", (request) => {
      throw robotsDisallowed(request.url);
    });
    const notes: string[] = [];
    const items = await gatherUrlEvidence(new PageCache(ctx.fetch), definition, company, notes);
    expect(items).toEqual([
      expect.objectContaining({ url: "https://ce-urls.example.com/trust", collector: "url" }),
    ]);
    expect(items[0]?.text).toContain("SOC 2 audit in progress");
    expect(notes).toEqual([
      "trust_page: https://ce-urls.example.com/security returned 404",
      "trust_page: https://expo.example.org/exhibitors skipped (robots_disallowed)",
    ]);
    // URL evidence always counts, whatever collectors the definition lists.
    expect(evidenceForDefinition(definition, [...jobEvidence, ...items]).map((i) => i.url)).toEqual(
      ["https://ce-urls.example.com/trust"],
    );
  });
});

describe("definition URLs in sandbox workspaces", () => {
  it("reads them from the sandbox pages and notes the ones it has no page for", async () => {
    const company = await seedCompany(ctx, {
      domain: "ce-sandbox.example.com",
      website: "https://ce-sandbox.example.com",
    });
    const definition = await customDefinition("sandbox_pages", { urls: ["/about", "/locations"] });
    const pages: Record<string, { url: string; title: string; text: string }> = {
      "https://ce-sandbox.example.com/about": {
        url: "https://ce-sandbox.example.com/about",
        title: "About",
        text: "We are hiring our first SDR.",
      },
    };
    ctx.providers.set("research", {
      id: "sandbox",
      search: async () => [],
      fetch: async (url: string) => {
        const page = pages[url];
        if (!page) throw new Error(`No sandbox page for ${url}.`);
        return page;
      },
    });
    try {
      const fetchesBefore = ctx.recorded.fetch.length;
      const notes: string[] = [];
      const items = await gatherSandboxUrlEvidence(ctx, definition, company, notes);
      expect(items).toEqual([
        expect.objectContaining({
          url: "https://ce-sandbox.example.com/about",
          text: "We are hiring our first SDR.",
          collector: "url",
        }),
      ]);
      expect(notes).toEqual([
        "sandbox_pages: https://ce-sandbox.example.com/locations is not a sandbox page",
      ]);
      expect(ctx.recorded.fetch).toHaveLength(fetchesBefore);

      ctx.providers.set("research", null);
      const none: string[] = [];
      expect(await gatherSandboxUrlEvidence(ctx, definition, company, none)).toEqual([]);
      expect(none).toEqual(["sandbox_pages: urls skipped (no sandbox pages to read)"]);
    } finally {
      ctx.providers.set("research", null);
    }
  });
});
