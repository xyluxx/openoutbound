import { describe, expect, it } from "vitest";
import {
  chunkText,
  htmlToDrafts,
  MAX_CHUNK_CHARS,
  markdownToDrafts,
  splitMarkdownSections,
  textToDrafts,
} from "./chunk.js";

const paragraph = (n: number, words = 40) =>
  `${Array.from({ length: words }, (_, i) => `word${n}x${i}`).join(" ")}.`;

describe("splitMarkdownSections", () => {
  it("splits by headings and keeps content before the first heading untitled", () => {
    const sections = splitMarkdownSections(
      "Intro line.\n\n# Product\nForecasts demand.\n\n## Pricing\nFlat fee.\n",
    );
    expect(sections).toEqual([
      { title: null, body: "Intro line." },
      { title: "Product", body: "Forecasts demand." },
      { title: "Pricing", body: "Flat fee." },
    ]);
  });

  it("folds an empty heading into the next title and ignores headings in code fences", () => {
    const sections = splitMarkdownSections(
      "# Product\n## **Pricing**\nFlat fee.\n```\n# not a heading\n```\n",
    );
    expect(sections).toHaveLength(1);
    expect(sections[0]?.title).toBe("Product: Pricing");
    expect(sections[0]?.body).toContain("# not a heading");
  });

  it("returns nothing for empty input", () => {
    expect(splitMarkdownSections("  \n\n ")).toEqual([]);
  });
});

describe("chunkText", () => {
  it("keeps short text in one chunk", () => {
    expect(chunkText("Short text.")).toEqual(["Short text."]);
    expect(chunkText("   ")).toEqual([]);
  });

  it("splits long text at paragraph boundaries into chunks of about 1,500 characters", () => {
    const text = Array.from({ length: 12 }, (_, i) => paragraph(i)).join("\n\n");
    const chunks = chunkText(text);
    expect(chunks.length).toBe(3);
    expect(chunks[0]?.length).toBeGreaterThan(1_000);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
      expect(chunk.startsWith("word")).toBe(true);
    }
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
  });

  it("splits one huge paragraph by sentences and words without exceeding the max", () => {
    const sentences = Array.from({ length: 80 }, (_, i) => `Sentence number ${i} is here.`).join(
      " ",
    );
    const noSpaces = "x".repeat(5_000);
    for (const text of [sentences, noSpaces]) {
      const chunks = chunkText(text);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
  });
});

describe("drafts", () => {
  it("markdown: one item per section, long sections as numbered parts", () => {
    const long = Array.from({ length: 10 }, (_, i) => paragraph(i)).join("\n\n");
    const drafts = markdownToDrafts(`# About\nWe forecast demand.\n\n# Case study\n${long}`);
    expect(drafts[0]).toEqual({ title: "About", body: "We forecast demand." });
    const parts = drafts.slice(1);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]?.title).toBe("Case study (part 1)");
    expect(parts.at(-1)?.title).toBe(`Case study (part ${parts.length})`);
  });

  it("text: uses the given title or the first line", () => {
    expect(textToDrafts("Hello world.\nMore.", { title: "Greeting" })[0]?.title).toBe("Greeting");
    expect(textToDrafts("Hello world.\nMore.")[0]?.title).toBe("Hello world.");
  });

  it("html: drops chrome and scripts, splits by headings", () => {
    const html = `<html><head><title>Northwind</title><script>track()</script></head>
      <body><nav><a href="/">Home</a> Menu</nav>
      <h1>Forecast Pilot</h1><p>Plan stock with <b>confidence</b>.</p>
      <h2>Results</h2><ul><li>31% fewer stockouts</li><li>Less dead stock</li></ul>
      <footer>Copyright Northwind</footer></body></html>`;
    const drafts = htmlToDrafts(html);
    expect(drafts.map((d) => d.title)).toEqual(["Forecast Pilot", "Results"]);
    expect(drafts[0]?.body).toBe("Plan stock with confidence.");
    expect(drafts[1]?.body).toContain("- 31% fewer stockouts");
    const all = drafts.map((d) => d.body).join(" ");
    expect(all).not.toContain("track()");
    expect(all).not.toContain("Menu");
    expect(all).not.toContain("Copyright");
  });
});
