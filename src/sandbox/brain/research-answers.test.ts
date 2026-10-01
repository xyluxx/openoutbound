import { describe, expect, it } from "vitest";
import {
  type BootstrapVars,
  bootstrapOutputSchema,
} from "../../modules/knowledge/prompts/bootstrap.js";
import { type BriefVars, briefOutputSchema } from "../../modules/research/prompts/brief.js";
import { buildBootstrapAnswer, buildBriefAnswer } from "./research-answers.js";

function briefVars(overrides: Partial<BriefVars> = {}): BriefVars {
  return {
    target: "person",
    today: "2026-09-27",
    language: "en",
    record: "Name: Dana Reyes\nCompany: Northwind Logistics",
    companyBrief: null,
    offers: [
      {
        id: "of_1",
        name: "Forecast Copilot",
        summary: "Cuts manual forecasting work.",
        value_props: [],
      },
    ],
    sources: [
      {
        n: 1,
        url: "https://news.example/northwind-raises-series-b",
        title: "Northwind raises a Series B",
        published_at: "2026-08-01",
        kind: "search",
        text: "Northwind Logistics raised a Series B round.",
      },
    ],
    ...overrides,
  };
}

describe("buildBriefAnswer", () => {
  it("only cites source URLs copied from vars.sources", () => {
    const vars = briefVars();
    const output = briefOutputSchema.parse(buildBriefAnswer(vars, {}));
    const allowed = new Set(vars.sources.map((s) => s.url));
    for (const fact of output.now) expect(allowed.has(fact.source_url)).toBe(true);
    for (const pain of output.pains)
      for (const url of pain.evidence_urls) expect(allowed.has(url)).toBe(true);
    for (const angle of output.angles)
      for (const url of angle.evidence_urls) expect(allowed.has(url)).toBe(true);
  });

  it("only uses an offer id that was actually given", () => {
    const vars = briefVars();
    const output = buildBriefAnswer(vars, {});
    const allowedOffers = new Set(vars.offers.map((o) => o.id));
    for (const angle of output.angles) {
      if (angle.offer_id !== null) expect(allowedOffers.has(angle.offer_id)).toBe(true);
    }
  });

  it("reports low confidence and no `now` facts when there are no sources", () => {
    const vars = briefVars({ sources: [] });
    const output = briefOutputSchema.parse(buildBriefAnswer(vars, {}));
    expect(output.confidence).toBe("low");
    expect(output.now).toEqual([]);
  });

  it("reports high confidence with several sources", () => {
    const many = briefVars({
      sources: [1, 2, 3].map((n) => ({
        n,
        url: `https://news.example/item-${n}`,
        title: `Item ${n}`,
        published_at: "2026-08-01",
        kind: "search" as const,
        text: "Some text.",
      })),
    });
    const output = buildBriefAnswer(many, {});
    expect(output.confidence).toBe("high");
  });
});

describe("buildBootstrapAnswer", () => {
  function bootstrapVars(overrides: Partial<BootstrapVars> = {}): BootstrapVars {
    return {
      domain: "acme.example",
      language: "en",
      pages: [
        {
          url: "https://acme.example/about",
          category: "about",
          title: "About Acme",
          text: "Acme helps teams ship faster.",
        },
      ],
      ...overrides,
    };
  }

  it("produces a schema-valid draft with a source_url copied from a real page", () => {
    const vars = bootstrapVars();
    const output = bootstrapOutputSchema.parse(buildBootstrapAnswer(vars, {}));
    expect(output.about?.source_url).toBe(vars.pages[0]?.url);
    expect(output.offers.length).toBeGreaterThan(0);
    expect(output.icp_suggestions.length).toBeGreaterThan(0);
  });

  it("returns about: null when there are no pages", () => {
    const output = buildBootstrapAnswer(bootstrapVars({ pages: [] }), {});
    expect(output.about).toBeNull();
  });
});
