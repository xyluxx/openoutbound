import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ResearchBrief } from "../../../db/schema/index.js";
import { type BriefOutput, type BriefVars, briefOutputSchema, briefPrompt } from "./brief.js";

const vars: BriefVars = {
  target: "person",
  today: "2026-09-19",
  language: "en",
  record:
    "Person: Dana Reyes\nTitle: VP Operations\n\nCompany: Lumen Home\nDomain: lumenhome.example.com",
  companyBrief: '{"company":{"summary":"Lighting for small apartments."}}',
  offers: [
    {
      id: "off_01k6a3v0q8x3m2n4p5r6s7t8v9",
      name: "Forecast Pilot",
      summary: "A 30 day pilot.",
      value_props: ["Fewer stockouts"],
    },
  ],
  sources: [
    {
      n: 1,
      url: "https://news.example.com/lumen-home-series-b",
      title: "Lumen Home raises Series B",
      published_at: "2026-09-02",
      kind: "search",
      text: "A $20M round led by an invented fund.",
    },
  ],
};

describe("research.brief prompt", () => {
  it("renders a stable system and user prompt", () => {
    expect(briefPrompt.system(vars)).toMatchSnapshot();
    expect(briefPrompt.user(vars)).toMatchSnapshot();
  });

  it("marks outside text untrusted and handles no sources and no offers", () => {
    const user = briefPrompt.user({ ...vars, sources: [], offers: [], companyBrief: null });
    expect(user).toContain('<untrusted_content source="lead_record">');
    expect(user).toContain("no sources found");
    expect(user).toContain("use offer_id null");
    expect(briefPrompt.system({ ...vars, target: "company" })).toContain("likely buyers");
  });

  it("mirrors the stored ResearchBrief type and converts to JSON Schema", () => {
    expect(() => z.toJSONSchema(briefOutputSchema)).not.toThrow();
    // Compile-time check: a validated output is assignable to the stored brief type.
    const output: BriefOutput = {
      who: { summary: "s", role: null },
      company: { summary: "c" },
      now: [{ fact: "f", source_url: "https://news.example.com/a", date: null }],
      pains: [{ hypothesis: "h", evidence_urls: [] }],
      angles: [{ angle: "a", why: "w", offer_id: null, evidence_urls: [] }],
      recommended_angle: "a",
      confidence: "low",
    };
    const stored: ResearchBrief = output;
    expect(briefOutputSchema.parse(stored)).toEqual(output);
  });
});
