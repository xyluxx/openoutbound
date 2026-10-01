import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpenOutboundError } from "../../core/errors.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { seedWorkspace } from "../../testing/factories.js";
import {
  CrawlCache,
  classifyContactLink,
  crawlCompanySite,
  homeUrlOf,
  keepPublishedEmail,
} from "./crawler.js";

// Crawler fixtures use the reserved .test TLD: the email extractor drops example.* addresses.
const HOME = `<html><head><title>Brightsmile Dental Studio | Home</title></head><body>
  <nav><a href="/kontakt">Kontakt</a> <a href="/impressum">Impressum</a> <a href="/team">Unser Team</a>
  <a href="https://social.test/brightsmile">Social</a></nav>
  <main><h1>Welcome</h1><p>Questions? Write to dana.rivers [at] brightsmile [dot] test.</p></main>
  <footer><a href="mailto:info@brightsmile.test?subject=Hi">Mail us</a>
  <p>Website by studio@agency.test</p><p>Automated: noreply@brightsmile.test</p></footer>
</body></html>`;

const CONTACT = `<html><body><main><h1>Kontakt</h1>
  <p>E-Mail: praxis(at)brightsmile.test</p>
  <p>Billing: marco.pellegrini&#64;brightsmile.test</p>
  <p>Private: brightsmile.dental@gmail.com</p>
</main></body></html>`;

const IMPRINT = `<html><body><main><h1>Impressum</h1>
  <p>Brightsmile Dental Studio GmbH<br>Sonnenweg 12<br>10115 Berlin</p>
  <p>Telefon: <a href="tel:+49301234567">030 1234567</a></p>
</main></body></html>`;

const robotsBlocked = () => {
  throw new OpenOutboundError("forbidden", "Blocked by robots.txt", {
    details: { reason: "robots_disallowed" },
  });
};

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
  ctx = ctx.with({ workspace: await seedWorkspace(ctx.db, { settings: {} }) });
});
afterAll(async () => {
  await ctx.close();
});

describe("link classification", () => {
  it.each([
    ["https://brightsmile.test/kontakt", "", "contact"],
    ["https://brightsmile.test/de/impressum.html", "", "imprint"],
    ["https://brightsmile.test/x", "Meet the team", "team"],
    ["https://brightsmile.test/ueber-uns", "", "about"],
    ["https://brightsmile.test/blog", "Blog", null],
  ])("%s (%s) is %s", (url, label, kind) => {
    expect(classifyContactLink(url, label)).toBe(kind);
  });

  it("normalizes home URLs and keeps only own-domain or free-mail addresses", () => {
    expect(homeUrlOf("www.brightsmile.test/about")).toEqual({
      homeUrl: "https://www.brightsmile.test/",
      domain: "brightsmile.test",
    });
    expect(homeUrlOf("not a site")).toBeNull();
    expect(keepPublishedEmail("dana@brightsmile.test", "brightsmile.test")).toBe("personal");
    expect(keepPublishedEmail("dana@berlin.brightsmile.test", "brightsmile.test")).toBe("personal");
    expect(keepPublishedEmail("praxis.sonne@gmail.com", "brightsmile.test")).toBe("role");
    expect(keepPublishedEmail("studio@agency.test", "brightsmile.test")).toBeNull();
    expect(keepPublishedEmail("privacy@brightsmile.test", "brightsmile.test")).toBeNull();
  });
});

describe("crawlCompanySite", () => {
  it("collects published and obfuscated emails with their pages, respecting robots", async () => {
    ctx.fetch.route("https://brightsmile.test/", { body: HOME });
    ctx.fetch.route("https://brightsmile.test/kontakt", { body: CONTACT });
    ctx.fetch.route("https://brightsmile.test/impressum", { body: IMPRINT });
    ctx.fetch.route("https://brightsmile.test/team", robotsBlocked);
    ctx.fetch.route("https://brightsmile.test/about", { status: 404, body: "Not found" });
    const before = ctx.recorded.fetch.length;

    const crawl = await crawlCompanySite(ctx, "https://brightsmile.test");
    expect(crawl?.pages.map((page) => page.kind)).toEqual(["home", "contact", "imprint"]);
    expect(crawl?.emails).toEqual([
      { email: "info@brightsmile.test", kind: "role", page_url: "https://brightsmile.test/" },
      {
        email: "dana.rivers@brightsmile.test",
        kind: "personal",
        page_url: "https://brightsmile.test/",
      },
      {
        email: "praxis@brightsmile.test",
        kind: "role",
        page_url: "https://brightsmile.test/kontakt",
      },
      {
        email: "marco.pellegrini@brightsmile.test",
        kind: "personal",
        page_url: "https://brightsmile.test/kontakt",
      },
      {
        email: "brightsmile.dental@gmail.com",
        kind: "personal",
        page_url: "https://brightsmile.test/kontakt",
      },
    ]);
    expect(crawl?.skipped).toEqual([
      { url: "https://brightsmile.test/team", reason: "robots_disallowed" },
    ]);
    expect(crawl?.business).toMatchObject({
      name: "Brightsmile Dental Studio",
      address: "Sonnenweg 12, 10115 Berlin",
      phone: "+49301234567",
    });
    const urls = ctx.recorded.fetch.slice(before).map((call) => call.url);
    expect(urls).not.toContain("https://social.test/brightsmile");
    expect(
      ctx.recorded.fetch.slice(before).every((call) => call.init?.respectRobots === true),
    ).toBe(true);
  });

  it("stops when the home page is disallowed and crawls each site once per cache", async () => {
    ctx.fetch.route("https://blocked.test/", robotsBlocked);
    const crawl = await crawlCompanySite(ctx, "blocked.test");
    expect(crawl).toMatchObject({
      pages: [],
      emails: [],
      skipped: [{ reason: "robots_disallowed" }],
    });

    ctx.fetch.route("https://once.test/", { body: "<html><body>Hi</body></html>" });
    ctx.fetch.route(/^https:\/\/once\.test\/.+/, { status: 404, body: "" });
    const cache = new CrawlCache(ctx);
    const before = ctx.recorded.fetch.length;
    await cache.get("https://once.test");
    await cache.get("www.once.test");
    const homeCalls = ctx.recorded.fetch
      .slice(before)
      .filter((call) => call.url === "https://once.test/");
    expect(homeCalls).toHaveLength(1);
  });
});
