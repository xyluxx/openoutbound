import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { OpenOutboundError } from "../../core/errors.js";
import type { AnyZodObject, OperationDefinition } from "../../core/operation.js";
import { knowledge_items, offers } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { createIcp } from "../leads/operations/icps.js";
import { SENIORITIES } from "../leads/service.js";
import type { BootstrapSummary } from "./bootstrap.js";
import { classifyLink, homeUrlFor } from "./crawl.js";
import { bootstrapJob } from "./jobs.js";
import { approveSuggestions } from "./operations/approve.js";
import { bootstrapKnowledge } from "./operations/ingest.js";
import { type BootstrapOutput, SENIORITY_HINT } from "./prompts/bootstrap.js";
import { buildGroundingPack } from "./service.js";

const SITE = "https://northwind.example.com";

const page = (title: string, body: string, links = "") =>
  `<html><head><title>${title}</title></head><body><nav>${links}</nav><h1>${title}</h1>${body}<footer>Footer text</footer></body></html>`;

const HOME_LINKS = [
  '<a href="/about">About us</a>',
  '<a href="/products/forecasting">Forecasting</a>',
  '<a href="/products/replenishment">Replenishment</a>',
  '<a href="/pricing">Pricing</a>',
  '<a href="/customers">Customers</a>',
  '<a href="/customers/lumen-home">Lumen Home story</a>',
  '<a href="/blog">Blog</a>',
  '<a href="/blog/why-forecasts-fail">Why forecasts fail</a>',
  '<a href="https://partner.example.org/about">Partner</a>',
  '<a href="https://social.example.net/northwind">Social</a>',
  '<a href="/privacy">Privacy</a>',
].join("");

function routeSite(ctx: TestContext) {
  const html = (body: string) => ({ headers: { "content-type": "text/html" }, body });
  ctx.fetch.route(
    `${SITE}/`,
    html(page("Northwind Analytics", "<p>Inventory forecasting for DTC brands.</p>", HOME_LINKS)),
  );
  ctx.fetch.route(`${SITE}/about`, html(page("About", "<p>Founded by supply chain people.</p>")));
  ctx.fetch.route(
    `${SITE}/products/forecasting`,
    html(page("Forecasting", "<p>Daily SKU forecasts.</p>")),
  );
  ctx.fetch.route(
    `${SITE}/products/replenishment`,
    html(page("Replenishment", "<p>Purchase order suggestions.</p>")),
  );
  ctx.fetch.route(`${SITE}/pricing`, () => {
    throw new OpenOutboundError("forbidden", "robots.txt disallows this URL", {
      details: { reason: "robots_disallowed" },
    });
  });
  ctx.fetch.route(`${SITE}/customers`, html(page("Customers", "<p>Brands we help.</p>")));
  ctx.fetch.route(
    `${SITE}/customers/lumen-home`,
    html(page("Lumen Home", "<p>Cut stockouts by 31%.</p>")),
  );
  ctx.fetch.route(`${SITE}/blog`, html(page("Blog", "<p>Notes on demand planning.</p>")));
}

function brainOutput(overrides: Partial<BootstrapOutput> = {}): BootstrapOutput {
  return {
    company_name: "Northwind Analytics",
    about: {
      title: "About Northwind",
      body: "Inventory forecasting for direct-to-consumer brands.",
      source_url: `${SITE}/about`,
    },
    products: [
      {
        title: "Forecasting",
        body: "Daily SKU-level demand forecasts.",
        source_url: `${SITE}/products/forecasting`,
      },
      {
        title: "Replenishment",
        body: "Purchase order suggestions.",
        source_url: "https://invented.example.net/page",
      },
    ],
    proof: [
      {
        kind: "case_study",
        title: "Lumen Home cut stockouts 31%",
        body: "Lumen Home cut stockouts by 31%.",
        source_url: `${SITE}/customers/lumen-home`,
      },
    ],
    objections: [
      {
        objection: "We already forecast in spreadsheets",
        answer: "Spreadsheets miss daily SKU changes; the pilot runs next to them.",
        source_url: null,
      },
    ],
    voice: {
      notes: ["Short sentences", "Plain words"],
      samples: ["Stock that sells. No guesswork."],
    },
    offers: [
      {
        name: "Forecast Pilot",
        summary: "A 30 day pilot on your own data.",
        details: "We connect your store and forecast every SKU.",
        value_props: ["Fewer stockouts", " "],
        cta: "Open to a 20 minute walkthrough?",
        proof_titles: ["Lumen Home cut stockouts 31%"],
      },
    ],
    icp_suggestions: [
      {
        name: "DTC brands",
        description: "Growing direct-to-consumer brands with many SKUs.",
        criteria: {
          industries: ["E-commerce", "e-commerce", "Consumer goods"],
          keywords: ["dtc"],
          employee_range: { min: 20, max: 500 },
          countries: ["us", "GB", "Germany"],
          regions: [],
          titles: ["VP Operations", "Head of Supply Chain"],
          seniorities: ["vp", "head"],
          departments: ["operations"],
          technologies: ["Shopify"],
          exclusions: { industries: [], keywords: [], titles: ["Intern"] },
        },
        signal_keys: ["hiring_relevant_roles", "Funding Round"],
      },
    ],
    signal_suggestions: [
      {
        key: "hiring_relevant_roles",
        name: "Hiring planners",
        why: "Open demand planner roles show the gap.",
        custom_rule: null,
      },
      {
        key: "Stockout complaints",
        name: "Stockout complaints",
        why: "Reviews mention items out of stock.",
        custom_rule: "Two or more reviews in 60 days mention out of stock items.",
      },
      {
        key: "hiring_relevant_roles",
        name: "Duplicate",
        why: "dup",
        custom_rule: null,
      },
    ],
    ...overrides,
  };
}

async function call<In extends AnyZodObject, Out extends z.ZodType>(
  op: OperationDefinition<In, Out>,
  ctx: TestContext,
  input: unknown,
): Promise<z.output<Out>> {
  return op.output.parse(await op.handler(ctx, op.input.parse(input))) as z.output<Out>;
}

async function runJob(ctx: TestContext, input: { website: string; max_pages?: number }) {
  return (await bootstrapJob.handler(ctx.jobContext(), input)) as BootstrapSummary;
}

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

describe("crawl helpers", () => {
  it("normalizes websites and classifies links", () => {
    expect(homeUrlFor("Northwind.example.com/path")).toEqual({
      homeUrl: "https://northwind.example.com/",
      domain: "northwind.example.com",
    });
    expect(homeUrlFor("http://www.northwind.example.com").homeUrl).toBe(
      "http://www.northwind.example.com/",
    );
    expect(() => homeUrlFor("not a site")).toThrow(OpenOutboundError);
    expect(classifyLink(`${SITE}/en/about-us`, "")).toBe("about");
    expect(classifyLink(`${SITE}/case-studies/acme`, "")).toBe("customers");
    expect(classifyLink(`${SITE}/x`, "Pricing")).toBe("pricing");
    expect(classifyLink(`${SITE}/blog/some-post`, "Read more")).toBeNull();
  });
});

describe("knowledge.bootstrap", () => {
  it("queues one job per website", async () => {
    const ctx = await createTestContext({ db });
    const first = await call(bootstrapKnowledge, ctx, { website: "northwind.example.com" });
    const second = await call(bootstrapKnowledge, ctx, {
      website: "https://northwind.example.com/",
    });
    expect(first).toMatchObject({ status: "queued", website: `${SITE}/`, deduplicated: false });
    expect(second).toMatchObject({ job_id: first.job_id, deduplicated: true });
  });

  it("crawls same-domain pages with robots, drafts once and saves suggestions", async () => {
    const ctx = await createTestContext({ db, settings: { ai: { language: "en" } } });
    routeSite(ctx);
    ctx.brain.on("knowledge.bootstrap", brainOutput());

    const summary = await runJob(ctx, { website: "northwind.example.com" });

    const fetched = ctx.recorded.fetch.map((request) => request.url);
    expect(fetched.every((url) => url.startsWith(SITE))).toBe(true);
    expect(ctx.recorded.fetch.every((request) => request.init?.respectRobots === true)).toBe(true);
    expect(fetched).not.toContain(`${SITE}/blog/why-forecasts-fail`);
    expect(summary.pages.map((p) => p.category)).toEqual([
      "home",
      "about",
      "product",
      "product",
      "customers",
      "customers",
      "blog",
    ]);
    expect(summary.skipped).toEqual([{ url: `${SITE}/pricing`, reason: "robots_disallowed" }]);

    expect(ctx.recorded.brain).toHaveLength(1);
    const call0 = ctx.recorded.brain[0];
    expect(call0?.user).toContain(`<untrusted_content source="${SITE}/about">`);
    expect(call0?.user).not.toContain("Footer text");
    expect(call0?.system).toContain("untrusted_content");

    expect(summary.items).toMatchObject({ created: 7, updated: 0, already_known: 0 });
    const items = await ctx.db
      .select()
      .from(knowledge_items)
      .where(eq(knowledge_items.workspace_id, ctx.workspace.id));
    expect(items.every((item) => item.status === "suggested")).toBe(true);
    expect(items.every((item) => item.tags.includes("bootstrap:northwind.example.com"))).toBe(true);
    const replenishment = items.find((item) => item.title === "Replenishment");
    expect(replenishment?.source_ref).toBe(`${SITE}/`);
    expect(items.map((item) => item.kind).sort()).toEqual(
      [
        "about",
        "case_study",
        "objection",
        "product",
        "product",
        "voice_sample",
        "voice_sample",
      ].sort(),
    );

    const [offer] = await ctx.db
      .select()
      .from(offers)
      .where(eq(offers.workspace_id, ctx.workspace.id));
    const proof = items.find((item) => item.kind === "case_study");
    expect(offer).toMatchObject({
      name: "Forecast Pilot",
      status: "archived",
      suggested: true,
      is_default: false,
      value_props: ["Fewer stockouts"],
      proof_item_ids: [proof?.id],
    });

    expect(summary.icp_suggestions[0]?.criteria).toMatchObject({
      industries: ["E-commerce", "Consumer goods"],
      countries: ["US", "GB"],
      employee_range: { min: 20, max: 500 },
    });
    expect(summary.icp_suggestions[0]?.signal_keys).toEqual([
      "hiring_relevant_roles",
      "funding_round",
    ]);
    expect(summary.signal_suggestions).toEqual([
      {
        key: "hiring_relevant_roles",
        kind: "builtin",
        name: "Hiring planners",
        why: "Open demand planner roles show the gap.",
        custom_rule: null,
      },
      {
        key: "stockout_complaints",
        kind: "custom",
        name: "Stockout complaints",
        why: "Reviews mention items out of stock.",
        custom_rule: "Two or more reviews in 60 days mention out of stock items.",
      },
    ]);

    // Suggestions never reach prompts before approval.
    const pack = await buildGroundingPack(ctx, { query: "forecasting" });
    expect(pack.facts).toEqual([]);
    expect(pack.offer).toBeNull();
  });

  it("suggests ICPs in the manage_icp create shape, exclusions and seniorities included", async () => {
    const ctx = await createTestContext({ db });
    routeSite(ctx);
    const base = brainOutput().icp_suggestions[0];
    if (!base) throw new Error("fixture has no ICP suggestion");
    ctx.brain.on(
      "knowledge.bootstrap",
      brainOutput({
        icp_suggestions: [
          {
            ...base,
            name: "DTC brands",
            criteria: {
              ...base.criteria,
              employee_range: { min: null, max: null },
              seniorities: ["VP", "Head", "C-level", "Founder", "people leaders", "vp"],
              exclusions: {
                industries: ["Marketplace"],
                keywords: ["dropshipping"],
                titles: ["Intern", "x".repeat(150)],
              },
            },
          },
        ],
      }),
    );

    const summary = await runJob(ctx, { website: "northwind.example.com" });
    expect(summary.icp_suggestions).toHaveLength(1);
    for (const suggestion of summary.icp_suggestions) {
      // Passed as is to manage_icp action create: valid, and nothing is dropped.
      const parsed = createIcp.input.parse(suggestion);
      expect(parsed).toMatchObject(suggestion);
      expect(parsed.criteria?.exclude).toMatchObject({
        industries: ["Marketplace"],
        keywords: ["dropshipping"],
        titles: ["Intern"],
      });
      expect(parsed.criteria?.seniorities).toEqual(["vp", "head", "c_suite", "founder"]);
      expect(suggestion.criteria).not.toHaveProperty("employee_range");
      expect(suggestion.criteria).not.toHaveProperty("exclusions");
    }
    // The prompt lists manage_icp's seniority vocabulary without importing the leads module.
    expect(SENIORITY_HINT.split(", ")).toEqual([...SENIORITIES]);
  });

  it("is idempotent per website and never touches approved items", async () => {
    const ctx = await createTestContext({ db });
    routeSite(ctx);
    ctx.brain.on("knowledge.bootstrap", brainOutput());
    await runJob(ctx, { website: "northwind.example.com" });

    const again = await runJob(ctx, { website: "https://northwind.example.com/" });
    expect(again.items).toMatchObject({ created: 0, updated: 0, unchanged: 7, archived: 0 });
    expect(again.offers).toMatchObject({ created: 0, unchanged: 1 });

    const about = await ctx.db
      .select()
      .from(knowledge_items)
      .where(
        and(
          eq(knowledge_items.workspace_id, ctx.workspace.id),
          eq(knowledge_items.title, "About Northwind"),
        ),
      );
    const [offer] = await ctx.db
      .select()
      .from(offers)
      .where(eq(offers.workspace_id, ctx.workspace.id));
    const approved = await call(approveSuggestions, ctx, {
      item_ids: [about[0]?.id],
      offer_ids: [offer?.id],
    });
    expect(approved).toMatchObject({
      activated_item_ids: [about[0]?.id],
      activated_offer_ids: [offer?.id],
      skipped: [],
    });
    const [active] = await ctx.db
      .select()
      .from(offers)
      .where(eq(offers.id, offer?.id ?? ""));
    expect(active).toMatchObject({ status: "active", suggested: false, is_default: true });

    const base = brainOutput();
    ctx.brain.on(
      "knowledge.bootstrap",
      brainOutput({
        products: [{ ...base.products[0], body: "Daily forecasts per SKU and store." } as never],
      }),
    );
    const third = await runJob(ctx, { website: "northwind.example.com" });
    expect(third.items).toMatchObject({ created: 0, updated: 1, already_known: 1, archived: 1 });
    expect(third.offers).toMatchObject({ created: 0, already_known: 1 });
    const all = await ctx.db
      .select()
      .from(knowledge_items)
      .where(eq(knowledge_items.workspace_id, ctx.workspace.id));
    expect(all.filter((item) => item.title === "About Northwind")).toHaveLength(1);
    expect(all.filter((item) => item.status !== "archived")).toHaveLength(6);

    const skipped = await call(approveSuggestions, ctx, { item_ids: [about[0]?.id] });
    expect(skipped.skipped).toEqual([{ id: about[0]?.id, reason: "already_active" }]);
  });

  it("never keeps more than 8 pages", async () => {
    const ctx = await createTestContext({ db });
    const html = (title: string) => ({
      headers: { "content-type": "text/html" },
      body: page(title, `<p>${title} text.</p>`),
    });
    const extra = Array.from({ length: 6 }, (_, i) => `/products/p${i}`)
      .concat(Array.from({ length: 6 }, (_, i) => `/customers/c${i}`))
      .concat(["/about", "/pricing", "/blog", "/careers", "/team"]);
    ctx.fetch.route(`${SITE}/`, {
      headers: { "content-type": "text/html" },
      body: page(
        "Home",
        "<p>Welcome.</p>",
        extra.map((path) => `<a href="${path}">${path.slice(1)}</a>`).join(""),
      ),
    });
    for (const path of extra) ctx.fetch.route(`${SITE}${path}`, html(path));
    ctx.brain.on("knowledge.bootstrap", brainOutput());
    const summary = await runJob(ctx, { website: "northwind.example.com" });
    expect(summary.pages).toHaveLength(8);
    expect(ctx.recorded.fetch).toHaveLength(8);
    expect(summary.pages.map((p) => p.category)).toEqual([
      "home",
      "about",
      "product",
      "product",
      "pricing",
      "customers",
      "customers",
      "blog",
    ]);
  });

  it("respects max_pages and fails clearly when the home page cannot be read", async () => {
    const ctx = await createTestContext({ db });
    routeSite(ctx);
    ctx.brain.on("knowledge.bootstrap", brainOutput());
    const small = await runJob(ctx, { website: "northwind.example.com", max_pages: 3 });
    expect(small.pages).toHaveLength(3);

    const blocked = await createTestContext({ db });
    blocked.fetch.route("https://blocked.example.com/", () => {
      throw new OpenOutboundError("forbidden", "robots", {
        details: { reason: "robots_disallowed" },
      });
    });
    await expect(runJob(blocked, { website: "blocked.example.com" })).rejects.toMatchObject({
      code: "forbidden",
      hint: expect.stringContaining("ingest"),
    });
    expect(blocked.recorded.brain).toHaveLength(0);
  });
});
