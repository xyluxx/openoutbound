import { describe, expect, it } from "vitest";
import {
  extractEmails,
  extractLinks,
  extractMeta,
  htmlToText,
  normalizeDomain,
  normalizeLinkedinUrl,
  splitName,
} from "./extract.js";

const PAGE = `<!doctype html>
<html lang="en-US">
<head>
  <title> Harbor Dental | Family dentistry </title>
  <meta name="description" content="Family dentistry in Austin.">
  <meta property="og:site_name" content="Harbor Dental">
  <link rel="canonical" href="/about/">
  <link rel="alternate" type="application/rss+xml" href="/feed.xml">
  <link rel="alternate" type="application/atom+xml" href="https://harbor.example.com/atom.xml">
  <link rel="alternate" hreflang="de" href="/de/">
  <style>.x { color: red }</style>
</head>
<body>
  <header><nav><a href="/">Home</a></nav></header>
  <main>
    <h1>About   us</h1>
    <p>We care for <b>families</b>&nbsp;since 1998.</p>
    <ul><li>Cleanings</li><li>Implants</li></ul>
    <a href="/team#dentists">Our team</a>
    <a href="https://harbor.example.com/team">Team again</a>
    <a href="mailto:frontdesk@harbordental.test">Email us</a>
    <a href="tel:+15125550100">Call</a>
    <a href="javascript:void(0)">Nothing</a>
    <script>var secret = "ignore me";</script>
  </main>
  <footer>Copyright Harbor Dental</footer>
</body>
</html>`;

describe("htmlToText", () => {
  it("keeps readable content on separate lines and drops chrome", () => {
    const { title, text } = htmlToText(PAGE);
    expect(title).toBe("Harbor Dental | Family dentistry");
    expect(text.split("\n")).toEqual([
      "About us",
      "We care for families since 1998.",
      "Cleanings",
      "Implants",
      "Our team Team again Email us Call Nothing",
    ]);
    expect(text).not.toContain("ignore me");
    expect(text).not.toContain("Copyright");
  });

  it("truncates to maxChars", () => {
    expect(htmlToText("<p>abcdefghij</p>", { maxChars: 4 }).text).toBe("abcd");
    expect(htmlToText("plain text only").title).toBeNull();
  });
});

describe("extractLinks", () => {
  it("returns absolute, deduplicated http(s) links", () => {
    const links = extractLinks(PAGE, "https://harbor.example.com/about/");
    expect(links.map((l) => l.url)).toEqual([
      "https://harbor.example.com/",
      "https://harbor.example.com/team",
    ]);
    expect(links[1]?.text).toBe("Our team");
  });

  it("honors <base href> and rel", () => {
    const links = extractLinks(
      '<base href="https://cdn.example.org/x/"><a rel="nofollow" href="page">P</a>',
      "https://a.example.com",
    );
    expect(links).toEqual([{ url: "https://cdn.example.org/x/page", text: "P", rel: "nofollow" }]);
  });
});

describe("extractMeta", () => {
  it("reads title, description, canonical, feeds, site name and language", () => {
    expect(extractMeta(PAGE, "https://harbor.example.com/about/")).toEqual({
      title: "Harbor Dental | Family dentistry",
      description: "Family dentistry in Austin.",
      canonical: "https://harbor.example.com/about/",
      feeds: ["https://harbor.example.com/feed.xml", "https://harbor.example.com/atom.xml"],
      ogSiteName: "Harbor Dental",
      language: "en-US",
    });
  });

  it("returns nulls when nothing is there", () => {
    expect(extractMeta("<p>hi</p>", "https://x.example.com")).toEqual({
      title: null,
      description: null,
      canonical: null,
      feeds: [],
      ogSiteName: null,
      language: null,
    });
  });
});

describe("extractEmails", () => {
  it("finds mailto, plain and obfuscated addresses", () => {
    const html = `
      <a href="mailto:Front.Desk@HarborDental.test?subject=Hi">Mail</a>
      <p>Billing: billing [at] harbordental [dot] test</p>
      <p>Owner: dana(at)harbordental.test, also dana(at)harbordental.test</p>
      <p>Press: press at harbordental dot test</p>
      <p>Entity: info&#64;harbordental.test</p>
      <img src="logo@2x.png"> placeholder: you@example.com, name@domain.com
      <script>Sentry.init({dsn:"https://abc@o123.ingest.sentry.io/1"})</script>`;
    expect(extractEmails(html)).toEqual([
      "front.desk@harbordental.test",
      "billing@harbordental.test",
      "dana@harbordental.test",
      "press@harbordental.test",
      "info@harbordental.test",
    ]);
  });

  it("works on plain text", () => {
    expect(extractEmails("Write to Office@Clinic.test.")).toEqual(["office@clinic.test"]);
  });
});

describe("normalizeDomain", () => {
  it("normalizes URLs, domains and emails", () => {
    expect(normalizeDomain("https://www.Harbor-Dental.test:8080/about?x=1")).toBe(
      "harbor-dental.test",
    );
    expect(normalizeDomain("WWW.harbor.test")).toBe("harbor.test");
    expect(normalizeDomain("dana@Harbor.test")).toBe("harbor.test");
    expect(normalizeDomain("sub.harbor.co.uk/path")).toBe("sub.harbor.co.uk");
  });

  it("rejects non-domains", () => {
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain("localhost")).toBeNull();
    expect(normalizeDomain("192.168.0.1")).toBeNull();
    expect(normalizeDomain("not a domain")).toBeNull();
  });
});

describe("normalizeLinkedinUrl", () => {
  it("canonicalizes people and company URLs", () => {
    expect(normalizeLinkedinUrl("https://de.linkedin.com/in/Dana-Reyes/?trk=abc")).toBe(
      "https://www.linkedin.com/in/dana-reyes",
    );
    expect(normalizeLinkedinUrl("linkedin.com/in/dana-reyes/details/experience/")).toBe(
      "https://www.linkedin.com/in/dana-reyes",
    );
    expect(normalizeLinkedinUrl("http://www.linkedin.com/company/harbor-dental/about/")).toBe(
      "https://www.linkedin.com/company/harbor-dental",
    );
    expect(normalizeLinkedinUrl("https://www.linkedin.com/in/j%C3%B6rg-m")).toBe(
      "https://www.linkedin.com/in/j%C3%B6rg-m",
    );
  });

  it("rejects other URLs", () => {
    expect(normalizeLinkedinUrl("https://www.linkedin.com/feed/")).toBeNull();
    expect(normalizeLinkedinUrl("https://example.com/in/dana")).toBeNull();
    expect(normalizeLinkedinUrl("https://linkedin.com.evil.test/in/dana")).toBeNull();
  });
});

describe("splitName", () => {
  it("handles common shapes", () => {
    expect(splitName("Dana Reyes")).toEqual({ first_name: "Dana", last_name: "Reyes" });
    expect(splitName("  Dr. Dana   Reyes, DDS ")).toEqual({
      first_name: "Dana",
      last_name: "Reyes",
    });
    expect(splitName("Reyes, Dana")).toEqual({ first_name: "Dana", last_name: "Reyes" });
    expect(splitName("Maria de la Cruz")).toEqual({ first_name: "Maria", last_name: "de la Cruz" });
    expect(splitName("Omar Haddad Jr.")).toEqual({ first_name: "Omar", last_name: "Haddad" });
    expect(splitName("Cher")).toEqual({ first_name: "Cher", last_name: null });
    expect(splitName("")).toEqual({ first_name: null, last_name: null });
  });
});
