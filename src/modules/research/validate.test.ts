import { describe, expect, it } from "vitest";
import type { BriefOutput } from "./prompts/brief.js";
import { BRIEF_LIMITS, urlKey, validateBrief } from "./validate.js";

const today = new Date("2026-09-19T12:00:00Z");
const NEWS = "https://news.example.com/lumen-home-series-b";
const SITE = "https://lumenhome.example.com/about";

function raw(overrides: Partial<BriefOutput> = {}): BriefOutput {
  return {
    who: { summary: " Dana runs operations. ", role: " VP Operations " },
    company: { summary: "Lighting for small apartments." },
    now: [
      {
        fact: "Raised a Series B.",
        source_url: "https://www.news.example.com/lumen-home-series-b/",
        date: "2026-09-02",
      },
      {
        fact: "Opened in Mars.",
        source_url: "https://invented.example.net/mars",
        date: "2026-09-10",
      },
      { fact: "Founded in 2019.", source_url: `${SITE}#team`, date: null },
      { fact: "Future event.", source_url: SITE, date: "2027-05-01" },
    ],
    pains: [
      {
        hypothesis: "Stockouts during expansion.",
        evidence_urls: [NEWS, "https://invented.example.net/x"],
      },
      { hypothesis: "  ", evidence_urls: [] },
    ],
    angles: [
      {
        angle: "Forecast the new warehouse",
        why: "Expansion",
        offer_id: "off_real",
        evidence_urls: [NEWS, NEWS],
      },
      {
        angle: "Generic pitch",
        why: "none",
        offer_id: "off_invented",
        evidence_urls: ["ftp://x.example.com"],
      },
    ],
    recommended_angle: "forecast the new  warehouse",
    confidence: "high",
    ...overrides,
  };
}

const input = { sourceUrls: [NEWS, SITE], activeOfferIds: ["off_real"], today };

describe("validateBrief", () => {
  it("drops facts and evidence URLs that were not among the gathered sources", () => {
    const { brief, stats } = validateBrief(raw(), input);
    expect(brief.now.map((fact) => fact.fact)).toEqual([
      "Raised a Series B.",
      "Founded in 2019.",
      "Future event.",
    ]);
    expect(brief.now[0]?.source_url).toBe(NEWS);
    expect(brief.now[1]?.source_url).toBe(SITE);
    expect(brief.now[2]?.date).toBeNull();
    expect(stats.dropped_facts).toBe(1);
    expect(brief.pains).toEqual([
      { hypothesis: "Stockouts during expansion.", evidence_urls: [NEWS] },
    ]);
    expect(brief.angles[0]).toMatchObject({ offer_id: "off_real", evidence_urls: [NEWS] });
    expect(brief.angles[1]).toMatchObject({ offer_id: null, evidence_urls: [] });
    expect(stats.dropped_urls).toBe(2);
    expect(stats.dropped_offer_refs).toBe(1);
    expect(brief.recommended_angle).toBe("Forecast the new warehouse");
    expect(brief.who).toEqual({ summary: "Dana runs operations.", role: "VP Operations" });
    expect(brief.confidence).toBe("high");
  });

  it("lowers confidence when every fact was unsourced or nothing was gathered", () => {
    const unsourced = raw({
      now: [{ fact: "Made up.", source_url: "https://invented.example.net", date: null }],
    });
    expect(validateBrief(unsourced, input).brief.confidence).toBe("low");
    expect(validateBrief(raw({ now: [] }), { ...input, sourceUrls: [] }).brief.confidence).toBe(
      "low",
    );
  });

  it("falls back to the first angle and caps list sizes", () => {
    const many = raw({
      recommended_angle: "something else",
      now: Array.from({ length: 12 }, (_, i) => ({
        fact: `Fact ${i}`,
        source_url: NEWS,
        date: `2026-08-${String(i + 1).padStart(2, "0")}`,
      })),
      angles: Array.from({ length: 6 }, (_, i) => ({
        angle: `Angle ${i}`,
        why: "why",
        offer_id: null,
        evidence_urls: [],
      })),
    });
    const { brief } = validateBrief(many, input);
    expect(brief.now).toHaveLength(BRIEF_LIMITS.now);
    expect(brief.now[0]?.fact).toBe("Fact 11");
    expect(brief.angles).toHaveLength(BRIEF_LIMITS.angles);
    expect(brief.recommended_angle).toBe("Angle 0");
    expect(validateBrief(raw({ angles: [] }), input).brief.recommended_angle).toBeNull();
  });

  it("normalizes URLs for comparison", () => {
    expect(urlKey("https://WWW.Example.com/a/?q=1#frag")).toBe("example.com/a?q=1");
    expect(urlKey("https://example.com/a")).toBe(urlKey("http://example.com/a/"));
    expect(urlKey("mailto:x@example.com")).toBeNull();
    expect(urlKey("not a url")).toBeNull();
  });
});
