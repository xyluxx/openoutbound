import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OpenOutboundError } from "../../../core/errors.js";
import { page_snapshots, signal_definitions } from "../../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../../testing/context.js";
import { seedCompany } from "../../../testing/factories.js";
import { collectorRun, html, robotsDisallowed } from "../test-helpers.js";
import { diffLines, discoverKeyPages, normalizeForDiff } from "./pages.js";
import { createWebsiteChangesCollector, definitionPageUrls } from "./website-changes.js";

const collector = createWebsiteChangesCollector();
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

const homeHtml = (footer: string, extra = "") =>
  html(`
    <nav><a href="/pricing">Pricing</a> <a href="/careers">Careers</a> <a href="/about/team">Team</a>
    <a href="https://twitter.example.org/x">X</a></nav>
    <main><h1>Inventory forecasting for DTC brands</h1><p>Plan stock with confidence.</p>${extra}</main>
    <div>${footer}</div>`);

const pricingHtml = (plan: string) =>
  html(`<main><h1>Pricing</h1><p>${plan}</p><p>Updated on September 3, 2026</p></main>`);

describe("website_changes collector", () => {
  it("baselines, ignores noise and classifies a meaningful change once", async () => {
    const company = await seedCompany(ctx, {
      domain: "wc-one.example.com",
      website: "https://wc-one.example.com",
    });
    const base = "https://wc-one.example.com";
    let footer = "© 2025 Northwind. All rights reserved. Last updated 2025-01-01";
    let plan = "Contact us for pricing";
    ctx.fetch.route(`${base}/`, () => ({ body: homeHtml(footer) }));
    ctx.fetch.route(`${base}/pricing`, () => ({ body: pricingHtml(plan) }));
    ctx.fetch.route(`${base}/careers`, { status: 404, body: "not found" });
    ctx.fetch.route(`${base}/about/team`, (request) => {
      if (request.init?.respectRobots) throw robotsDisallowed(request.url);
      return { body: html("<p>team</p>") };
    });

    const first = await collector.collect(await collectorRun(ctx, company));
    expect(first.signals).toEqual([]);
    expect(first.brainCalls).toBe(0);
    expect(first.notes.join(" ")).toMatch(/careers returned 404/);
    expect(first.notes.join(" ")).toMatch(/team skipped \(robots_disallowed\)/);
    const snapshots = await ctx.db
      .select()
      .from(page_snapshots)
      .where(eq(page_snapshots.company_id, company.id));
    expect(snapshots.map((s) => s.url).sort()).toEqual([`${base}/`, `${base}/pricing`]);

    // Only noise changes on the home page, a real change on pricing.
    footer = "© 2026 Northwind. All rights reserved. Last updated 2026-09-18";
    plan = "Pro plan: $49 per month";
    ctx.brain.on("signals.website_change.classify", (vars: { changes: unknown[] }) => {
      expect(vars.changes).toHaveLength(1);
      return {
        matches: [
          {
            change: 0,
            definition_key: "website_change",
            strength: 0.8,
            title: "Published pricing: Pro plan at $49 per month",
            summary: "Pricing moved from contact-us to public prices.",
            evidence_excerpt: "Pro plan: $49 per month",
          },
          {
            change: 0,
            definition_key: "not_a_definition",
            strength: 1,
            title: "x",
            summary: "",
            evidence_excerpt: "",
          },
        ],
      };
    });
    const second = await collector.collect(await collectorRun(ctx, company));
    expect(second.brainCalls).toBe(1);
    expect(second.signals).toEqual([
      expect.objectContaining({
        definition_key: "website_change",
        evidence_url: `${base}/pricing`,
        evidence_excerpt: "Pro plan: $49 per month",
        strength: 0.8,
        source: "website_changes",
      }),
    ]);
    const call = ctx.recorded.brain[0];
    expect(call?.user).toContain("<untrusted_content");
    expect(call?.user).toContain("Pro plan: $49 per month");
    expect(call?.user).not.toContain("2026-09-18");

    // Nothing changed since: no brain call.
    const third = await collector.collect(await collectorRun(ctx, company));
    expect(third.brainCalls).toBe(0);
    expect(third.signals).toEqual([]);
  });

  it("keeps the change for the next run when classification fails", async () => {
    const company = await seedCompany(ctx, {
      domain: "wc-two.example.com",
      website: "https://wc-two.example.com",
    });
    const base = "https://wc-two.example.com";
    let body = "<p>Clinics in Austin</p>";
    ctx.fetch.route(`${base}/`, () => ({ body: html(`<main>${body}</main>`) }));
    await collector.collect(await collectorRun(ctx, company));

    body = "<p>Clinics in Austin and Dallas (opening soon)</p>";
    ctx.brain.on("signals.website_change.classify", () => {
      throw new OpenOutboundError("budget_exceeded", "AI budget used up");
    });
    await expect(collector.collect(await collectorRun(ctx, company))).rejects.toMatchObject({
      code: "budget_exceeded",
    });
    const [snapshot] = await ctx.db
      .select()
      .from(page_snapshots)
      .where(
        and(eq(page_snapshots.workspace_id, ctx.workspace.id), eq(page_snapshots.url, `${base}/`)),
      );
    expect(snapshot?.text).toContain("Clinics in Austin");
    expect(snapshot?.text).not.toContain("Dallas");

    ctx.brain.on("signals.website_change.classify", {
      matches: [
        {
          change: 0,
          definition_key: "expansion_new_location",
          strength: 1,
          title: "Opening a clinic in Dallas",
          summary: "New location announced.",
          evidence_excerpt: "Clinics in Austin and Dallas (opening soon)",
        },
      ],
    });
    const retry = await collector.collect(await collectorRun(ctx, company));
    expect(retry.signals.map((s) => s.definition_key)).toEqual(["expansion_new_location"]);
  });

  it("skips companies without a website", async () => {
    const company = await seedCompany(ctx, { domain: null, website: null });
    const out = await collector.collect(await collectorRun(ctx, company));
    expect(out.notes).toEqual(["website_changes: company has no website"]);
  });
});

describe("page helpers", () => {
  it("normalizes away dates, times, copyright and cookie lines", () => {
    const lines = normalizeForDiff(
      [
        "Pro plan $49",
        "Posted on March 3, 2026 at 10:15 am",
        "© 2026 Example Inc.",
        "We use cookies to improve your experience",
        "Updated 3 days ago",
        "Pro plan $49",
        "",
      ].join("\n"),
    );
    expect(lines).toEqual(["Pro plan $49", "Posted on <date> at <time>", "Updated <ago>"]);
  });

  it("diffs lines as sets", () => {
    expect(diffLines(["a", "b", "c"], ["c", "b", "d"])).toEqual({ added: ["d"], removed: ["a"] });
    expect(diffLines(["a", "b"], ["b", "a"])).toEqual({ added: [], removed: [] });
  });

  it("discovers key pages on the same site only", () => {
    const pages = discoverKeyPages(
      html(`<a href="/plans">Plans</a><a href="https://jobs.example.org/careers">Careers</a>
        <a href="https://wc.example.com/our-locations/">Find us</a><a href="/leadership">Leadership</a>`),
      "https://wc.example.com/",
      "wc.example.com",
    );
    expect(pages).toEqual([
      { kind: "pricing", url: "https://wc.example.com/plans" },
      { kind: "locations", url: "https://wc.example.com/our-locations/" },
      { kind: "team", url: "https://wc.example.com/leadership" },
    ]);
  });

  it("watches custom definition pages but leaves judging them to custom evaluation", async () => {
    const company = await seedCompany(ctx, {
      domain: "wc-custom.example.com",
      website: "https://wc-custom.example.com",
    });
    await ctx.db.insert(signal_definitions).values({
      workspace_id: ctx.workspace.id,
      key: "opened_new_office",
      name: "Opened a new office",
      description: "The company lists a new office location.",
      kind: "custom",
      detection: {
        collectors: ["website_changes"],
        keywords: [],
        instructions: "A new office appears on the offices page.",
        urls: ["/offices"],
      },
      weight: 50,
      half_life_days: 30,
      min_strength: 0.5,
    });
    const base = "https://wc-custom.example.com";
    let offices = "Berlin";
    ctx.fetch.route(`${base}/`, { body: html("<main><h1>Welcome</h1></main>") });
    ctx.fetch.route(`${base}/offices`, () => ({ body: html(`<main><p>${offices}</p></main>`) }));
    await collector.collect(await collectorRun(ctx, company));
    offices = "Berlin</p><p>Lisbon";
    let classifiedKeys: string[] = [];
    ctx.brain.on(
      "signals.website_change.classify",
      (vars: { definitions: Array<{ key: string }> }) => {
        classifiedKeys = vars.definitions.map((definition) => definition.key);
        return { matches: [] };
      },
    );
    const second = await collector.collect(await collectorRun(ctx, company));
    expect(classifiedKeys).not.toContain("opened_new_office");
    expect(classifiedKeys).toContain("website_change");
    expect(
      second.evidence.some(
        (item) => item.url === `${base}/offices` && item.text.includes("Lisbon"),
      ),
    ).toBe(true);
  });

  it("resolves definition URLs on the company site", () => {
    expect(
      definitionPageUrls(
        ["/trust", "https://{domain}/security", "https://other.example.org/x", "not a url"],
        "https://wc.example.com/",
        "wc.example.com",
      ),
    ).toEqual(["https://wc.example.com/trust", "https://wc.example.com/security"]);
  });
});
