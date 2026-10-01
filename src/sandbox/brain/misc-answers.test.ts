import { describe, expect, it } from "vitest";
import { type DraftPostVars, draftPostSchema } from "../../modules/content/prompts/draft-post.js";
import type { TeamExtractionVars } from "../../modules/enrichment/prompts/team.js";
import type { IcpRefineVars } from "../../modules/leads/prompts/icp-refine.js";
import type { ImportMappingVars } from "../../modules/leads/prompts/import-mapping.js";
import {
  type ReportSummaryVars,
  reportSummarySchema,
} from "../../modules/reports/prompts/summary.js";
import {
  buildDraftPostAnswer,
  buildIcpRefineAnswer,
  buildImportMappingAnswer,
  buildReportSummaryAnswer,
  buildTeamExtractionAnswer,
} from "./misc-answers.js";

describe("buildReportSummaryAnswer", () => {
  const vars: ReportSummaryVars = {
    workspace: "Acme Robotics",
    report_type: "weekly",
    period: "2026-09-20 to 2026-09-27",
    report_json: JSON.stringify({ sent: 120, replies: 20, reply_rate: "16.7%" }),
  };

  it("only uses numbers in the highlights that are present in the report JSON", () => {
    const output = reportSummarySchema.parse(buildReportSummaryAnswer(vars, {}));
    // Highlights are built only from parsed report_json fields, so every number in them must
    // appear verbatim in the source JSON (the summary sentence may also name the period, which
    // is a real input too, just not one that comes from report_json).
    const numbersMentioned = output.highlights.join(" ").match(/-?\d+(\.\d+)?%?/g) ?? [];
    expect(numbersMentioned.length).toBeGreaterThan(0);
    for (const number of numbersMentioned) expect(vars.report_json).toContain(number);
    expect(output.summary.length).toBeGreaterThan(0);
  });

  it("says the data is thin when nothing numeric is found", () => {
    const output = buildReportSummaryAnswer({ ...vars, report_json: "{}" }, {});
    expect(output.highlights).toEqual(["No numeric highlights found in this report."]);
  });
});

describe("buildDraftPostAnswer", () => {
  const vars: DraftPostVars = {
    company_name: "Acme Robotics",
    language: "en",
    tone_notes: "",
    pillar: null,
    pillars: ["Operations", "Forecasting"],
    topic: "manual forecasting",
    instructions: null,
    grounding: "We help ops teams cut manual forecasting work.",
    fact_index: ["[kn_1] Cuts manual forecasting time"],
    voice_samples: [],
    recent_posts: [],
    count: 2,
    length: "short",
  };

  it("writes the requested number of distinct, schema-valid posts", () => {
    const output = draftPostSchema.parse(buildDraftPostAnswer(vars, {}));
    expect(output.posts).toHaveLength(2);
    const bodies = new Set(output.posts.map((p) => p.body));
    expect(bodies.size).toBe(2);
    for (const post of output.posts) {
      expect(
        post.knowledge_item_ids.every((id) => vars.fact_index.some((line) => line.includes(id))),
      ).toBe(true);
    }
  });
});

describe("buildImportMappingAnswer", () => {
  const vars: ImportMappingVars = {
    columns: [
      { header: "Row Number", samples: ["1", "2"] },
      { header: "Email Address", samples: ["a@example.com"] },
      { header: "Favorite Color", samples: ["blue"] },
    ],
    fields: [
      { field: "email", meaning: "Work email address" },
      { field: "first_name", meaning: "First name" },
    ],
  };

  it("ignores row-number-like columns and maps a recognizable one", () => {
    const output = buildImportMappingAnswer(vars, {});
    expect(output.mappings.find((m) => m.header === "Row Number")?.field).toBe("ignore");
    expect(output.mappings.find((m) => m.header === "Email Address")?.field).toBe("email");
  });

  it("falls back to custom for an unrecognized column", () => {
    const output = buildImportMappingAnswer(vars, {});
    expect(output.mappings.find((m) => m.header === "Favorite Color")?.field).toBe("custom");
  });

  it("never maps the same allowed field twice", () => {
    const twoEmailColumns: ImportMappingVars = {
      columns: [
        { header: "Email", samples: ["a@example.com"] },
        { header: "Email Address", samples: ["b@example.com"] },
      ],
      fields: [{ field: "email", meaning: "Work email address" }],
    };
    const output = buildImportMappingAnswer(twoEmailColumns, {});
    const emailMappings = output.mappings.filter((m) => m.field === "email");
    expect(emailMappings.length).toBeLessThanOrEqual(1);
  });
});

describe("buildIcpRefineAnswer", () => {
  it("never adjusts a score (uses 0 when unsure, as the prompt requires)", () => {
    const vars: IcpRefineVars = {
      icpName: "Primary ICP",
      icpDescription: null,
      criteria: "industry: logistics",
      maxAdjust: 20,
      candidates: [
        { id: "cand_1", score: 60, facts: "Logistics company, 80 employees." },
        { id: "cand_2", score: 40, facts: "Marketing agency." },
      ],
    };
    const output = buildIcpRefineAnswer(vars, {});
    expect(output.adjustments).toHaveLength(2);
    for (const adjustment of output.adjustments) expect(adjustment.delta).toBe(0);
  });
});

describe("buildTeamExtractionAnswer", () => {
  it("extracts a name and title that appear together on a page, with email only if adjacent", () => {
    const vars: TeamExtractionVars = {
      company: "Acme Robotics",
      domain: "acme.example",
      pages: [
        {
          url: "https://acme.example/team",
          kind: "team",
          text: "Jane Doe, CEO. Contact jane@acme.example for press.\n\nAlex Kim, Head of Sales.",
        },
      ],
    };
    const output = buildTeamExtractionAnswer(vars, {});
    const jane = output.people.find((p) => p.full_name === "Jane Doe");
    expect(jane?.decision_maker).toBe(true);
    expect(jane?.email).toBe("jane@acme.example");
    const alex = output.people.find((p) => p.full_name === "Alex Kim");
    expect(alex?.email).toBeNull();
  });

  it("returns no people when the page names no one", () => {
    const vars: TeamExtractionVars = {
      company: "Acme Robotics",
      domain: "acme.example",
      pages: [
        {
          url: "https://acme.example/about",
          kind: "about",
          text: "We build robots for warehouses.",
        },
      ],
    };
    expect(buildTeamExtractionAnswer(vars, {}).people).toEqual([]);
  });
});
