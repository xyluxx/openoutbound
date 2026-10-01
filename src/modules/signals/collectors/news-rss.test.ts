import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "../../../testing/context.js";
import { seedCompany, seedPerson } from "../../../testing/factories.js";
import { collectorRun, html, robotsDisallowed } from "../test-helpers.js";
import {
  buildGdeltQuery,
  createNewsGdeltCollector,
  gdeltDateTime,
  parseGdeltArticles,
  parseSeenDate,
  searchableName,
} from "./news-gdelt.js";
import { createRssCollector, parseFeed } from "./rss.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

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

describe("GDELT helpers", () => {
  it("builds a quoted name + domain query in English and the country language", () => {
    expect(
      buildGdeltQuery({
        name: 'Northwind "Analytics", Inc.',
        domain: "northwind.example.com",
        website: null,
        country: "DE",
      }),
    ).toBe(
      '("Northwind Analytics" OR "northwind.example.com") (sourcelang:english OR sourcelang:german)',
    );
    expect(
      buildGdeltQuery({ name: "Cedar Labs", domain: null, website: null, country: "US" }),
    ).toBe('"Cedar Labs" sourcelang:english');
    expect(buildGdeltQuery({ name: "AB", domain: null, website: null, country: null })).toBeNull();
    expect(searchableName("Summit Dental GmbH")).toBe("Summit Dental");
  });

  it("parses dates and articles defensively", () => {
    expect(gdeltDateTime(new Date("2026-09-19T12:00:00Z"))).toBe("20260919120000");
    expect(parseSeenDate("20260917T081500Z")).toBe("2026-09-17T08:15:00.000Z");
    expect(parseSeenDate("garbage")).toBeNull();
    const articles = parseGdeltArticles(JSON.parse(fixture("gdelt-artlist.json")));
    expect(articles.map((a) => a.url)).toEqual([
      "https://business-news.example.org/2026/09/northwind-analytics-raises-series-b",
      "https://sports.example.org/northwind-rovers-win",
      "https://old-news.example.org/northwind-2025",
    ]);
    expect(parseGdeltArticles({ nope: 1 })).toEqual([]);
  });
});

describe("news_gdelt collector", () => {
  it("keeps recent articles the brain ties to the company", async () => {
    const company = await seedCompany(ctx, {
      name: "Northwind Analytics",
      domain: "gd-one.example.com",
    });
    ctx.fetch.route(/api\.gdeltproject\.org/, { json: JSON.parse(fixture("gdelt-artlist.json")) });
    ctx.brain.on(
      "signals.items.classify",
      (vars: { items: Array<{ id: string; url: string }> }) => {
        expect(vars.items.map((item) => item.url)).not.toContain(
          "https://old-news.example.org/northwind-2025",
        );
        return {
          matches: [
            {
              item_id: "i1",
              definition_key: "news_mention",
              strength: 0.4,
              title: "Series B coverage",
              summary: "",
              evidence_excerpt: "",
            },
            {
              item_id: "i1",
              definition_key: "funding_round",
              strength: 1,
              title: "Raised a $30M Series B",
              summary: "Funds go to the forecasting platform.",
              evidence_excerpt: "Northwind Analytics raises $30M Series B",
            },
            {
              item_id: "i9",
              definition_key: "funding_round",
              strength: 1,
              title: "Invented item",
              summary: "",
              evidence_excerpt: "",
            },
          ],
        };
      },
    );
    const collector = createNewsGdeltCollector({ minIntervalMs: 0 });
    const out = await collector.collect(await collectorRun(ctx, company));
    expect(out.brainCalls).toBe(1);
    expect(out.signals).toEqual([
      expect.objectContaining({
        definition_key: "funding_round",
        evidence_url:
          "https://business-news.example.org/2026/09/northwind-analytics-raises-series-b",
        occurred_at: "2026-09-17T08:15:00.000Z",
        source: "news_gdelt",
        strength: 1,
      }),
    ]);
    const request = ctx.recorded.fetch.find((call) => call.url.includes("gdeltproject"));
    const url = new URL(request?.url ?? "");
    expect(url.searchParams.get("query")).toBe(
      '("Northwind Analytics" OR "gd-one.example.com") sourcelang:english',
    );
    expect(url.searchParams.get("startdatetime")).toBe("20260820120000");
    expect(ctx.recorded.brain[0]?.user).toContain("<untrusted_content");
  });

  it("spaces calls, backs off on 429 and survives plain-text answers", async () => {
    const company = await seedCompany(ctx, {
      name: "Bluefield Supply",
      domain: "gd-two.example.com",
    });
    const sleeps: number[] = [];
    const collector = createNewsGdeltCollector({
      minIntervalMs: 5000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    ctx.fetch.route(/api\.gdeltproject\.org/, { status: 429, body: "slow down" });
    const limited = await collector.collect(await collectorRun(ctx, company));
    expect(limited.notes).toEqual(["news_gdelt: rate limited by GDELT, skipped"]);
    ctx.fetch.route(/api\.gdeltproject\.org/, {
      body: "Your search contained phrases that are too short.",
    });
    const text = await collector.collect(await collectorRun(ctx, company));
    expect(text.notes).toEqual(["news_gdelt: unreadable response (not_json)"]);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(50_000);
  });
});

describe("parseFeed", () => {
  it("reads RSS, Atom and JSON Feed", () => {
    const rss = parseFeed(fixture("feed-rss.xml"), "https://rss-one.example.com/blog/feed.xml");
    expect(rss).toEqual([
      {
        id: "post-101",
        url: "https://rss-one.example.com/blog/rebuilt-demand-planning",
        title: "Why we rebuilt our demand planning from scratch",
        date: "2026-09-15T09:00:00.000Z",
        snippet: "Our COO on the stockouts that cost us a quarter.",
        author: "Mei Chen",
      },
      expect.objectContaining({ url: "https://rss-one.example.com/blog/holiday-hours" }),
    ]);
    const atom = parseFeed(fixture("feed-atom.xml"), "https://cedar.example.com/feed");
    expect(atom[0]).toMatchObject({
      url: "https://cedar.example.com/news/second-clinic",
      author: "Tomas Novak",
      date: "2026-09-10T08:00:00.000Z",
    });
    const json = parseFeed(
      JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        items: [{ id: "1", url: "/p/1", title: "Hello", date_published: "2026-09-01T00:00:00Z" }],
      }),
      "https://json.example.com/feed.json",
    );
    expect(json[0]).toMatchObject({ url: "https://json.example.com/p/1", title: "Hello" });
    expect(parseFeed("not a feed", "https://x.example.com")).toEqual([]);
    expect(parseFeed("{broken", "https://x.example.com")).toEqual([]);
  });
});

describe("rss collector", () => {
  it("classifies only new items and remembers what it saw", async () => {
    const company = await seedCompany(ctx, {
      domain: "rss-one.example.com",
      website: "https://rss-one.example.com",
    });
    await seedPerson(ctx, { company_id: company.id, full_name: "Mei Chen", title: "COO" });
    ctx.fetch.route("https://rss-one.example.com/", {
      body: html(
        "<p>Home</p>",
        '<link rel="alternate" type="application/rss+xml" href="/blog/feed.xml">',
      ),
    });
    let feed = fixture("feed-rss.xml");
    ctx.fetch.route("https://rss-one.example.com/blog/feed.xml", () => ({
      body: feed,
      headers: { "content-type": "application/rss+xml" },
    }));
    const collector = createRssCollector();
    ctx.brain.on(
      "signals.items.classify",
      (vars: { items: Array<{ id: string }>; people: unknown[] }) => {
        expect(vars.people).toEqual([{ name: "Mei Chen", title: "COO" }]);
        return {
          matches: [
            {
              item_id: vars.items[0]?.id ?? "i1",
              definition_key: "leadership_content",
              strength: 0.9,
              title: "COO wrote about stockouts",
              summary: "",
              evidence_excerpt: "Our COO on the stockouts that cost us a quarter.",
            },
          ],
        };
      },
    );

    // First run: only items inside the look-back window (the June post is too old).
    const first = await collector.collect(await collectorRun(ctx, company));
    expect(ctx.recorded.brain).toHaveLength(1);
    expect(first.signals.map((s) => s.evidence_url)).toEqual([
      "https://rss-one.example.com/blog/rebuilt-demand-planning",
    ]);

    const second = await collector.collect(await collectorRun(ctx, company));
    expect(second.signals).toEqual([]);
    expect(ctx.recorded.brain).toHaveLength(1);

    feed = feed.replace(
      "<item>",
      `<item><title>Meet our new VP of Operations</title><link>https://rss-one.example.com/blog/new-vp</link><guid>post-102</guid><pubDate>Fri, 18 Sep 2026 09:00:00 GMT</pubDate></item><item>`,
    );
    await collector.collect(await collectorRun(ctx, company));
    expect(ctx.recorded.brain).toHaveLength(2);
    const vars = ctx.recorded.brain[1]?.vars as { items: Array<{ url: string }> } | undefined;
    expect(vars?.items.map((i) => i.url)).toEqual(["https://rss-one.example.com/blog/new-vp"]);
  });

  it("notes missing feeds and robots refusals", async () => {
    const company = await seedCompany(ctx, {
      domain: "rss-two.example.com",
      website: "https://rss-two.example.com",
    });
    ctx.fetch.route("https://rss-two.example.com/", { body: html("<p>No feed</p>") });
    const collector = createRssCollector();
    expect((await collector.collect(await collectorRun(ctx, company))).notes).toEqual([
      "rss: no feed linked from the home page",
    ]);
    ctx.fetch.route("https://rss-two.example.com/", {
      body: html("", '<link rel="alternate" type="application/atom+xml" href="/feed.atom">'),
    });
    ctx.fetch.route("https://rss-two.example.com/feed.atom", (request) => {
      throw robotsDisallowed(request.url);
    });
    const out = await collector.collect(await collectorRun(ctx, company));
    expect(out.notes).toEqual([
      "rss: https://rss-two.example.com/feed.atom skipped (robots_disallowed)",
    ]);
  });
});
