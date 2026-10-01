import { describe, expect, it } from "vitest";
import type { ReplyClassification } from "../../db/schema/index.js";
import { classificationView } from "./schemas.js";
import { toClassificationView } from "./thread-operations.js";

describe("toClassificationView", () => {
  it("shows the proposed time, privacy kind, facts and hold suggestion", () => {
    const view = classificationView.parse(
      toClassificationView({
        category: "privacy_request",
        confidence: 0.95,
        summary: "Asks us to delete their data; budget review in November.",
        source: "model",
        proposed_time: {
          text: "Thursday at 3pm",
          start: "2026-09-24T15:00:00-05:00",
          timezone: "America/Chicago",
        },
        privacy_kind: "delete",
        facts: [
          {
            kind: "timing",
            text: "Budget review in November.",
            applies_to: "company",
            expires_on: "2026-11-30",
          },
        ],
        company_hold: { until: "2027-03-01", reason: "Signed with a competitor." },
      } as ReplyClassification),
    );
    expect(view).toMatchObject({
      proposed_time: {
        text: "Thursday at 3pm",
        start: "2026-09-24T15:00:00-05:00",
        timezone: "America/Chicago",
      },
      privacy_kind: "delete",
      facts: [
        {
          kind: "timing",
          text: "Budget review in November.",
          applies_to: "company",
          expires_on: "2026-11-30",
        },
      ],
      company_hold: { until: "2027-03-01", reason: "Signed with a competitor." },
    });
  });

  it("fills the new fields for classifications stored before them", () => {
    const view = classificationView.parse(
      toClassificationView({ category: "interested", confidence: 0.9 } as ReplyClassification),
    );
    expect(view).toMatchObject({
      proposed_time: null,
      privacy_kind: null,
      facts: [],
      company_hold: null,
    });
    expect(toClassificationView(null)).toBeNull();
  });

  it("describes prospect-derived fields as untrusted", () => {
    const shape = classificationView.unwrap().shape;
    expect(shape.facts.description).toContain("untrusted");
    expect(shape.company_hold.description).toContain("untrusted");
    expect(shape.proposed_time.unwrap().shape.text.description).toContain("untrusted");
  });
});
