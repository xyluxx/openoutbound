import { describe, expect, it } from "vitest";
import type { ClassifyItemsVars } from "../../modules/signals/prompts/classify-items.js";
import type {
  PromptDefinition,
  WebsiteChangeVars,
} from "../../modules/signals/prompts/classify-website-change.js";
import type { EvaluateCustomVars } from "../../modules/signals/prompts/evaluate-custom.js";
import {
  buildClassifyItemsAnswer,
  buildClassifyWebsiteChangeAnswer,
  buildEvaluateCustomAnswer,
} from "./signals-answers.js";

const hiringDefinition: PromptDefinition = {
  key: "hiring_relevant_roles",
  name: "Hiring relevant roles",
  description: "Posting operations or supply chain roles.",
  instructions: "",
  keywords: ["hiring", "operations manager"],
};

describe("buildClassifyItemsAnswer", () => {
  const vars: ClassifyItemsVars = {
    company: { name: "Northwind", domain: "northwind.example", industry: "logistics" },
    source: "news",
    items: [
      {
        id: "item_1",
        url: "https://news.example/1",
        title: "Northwind is hiring an operations manager",
        date: "2026-08-01",
        snippet: "The role covers supply chain planning.",
        author: null,
      },
      {
        id: "item_2",
        url: "https://news.example/2",
        title: "Northwind repaints its lobby",
        date: null,
        snippet: null,
        author: null,
      },
    ],
    definitions: [hiringDefinition],
    people: [],
  };

  it("matches an item whose text contains a definition keyword", () => {
    const output = buildClassifyItemsAnswer(vars, {});
    expect(output.matches).toHaveLength(1);
    expect(output.matches[0]?.item_id).toBe("item_1");
    expect(output.matches[0]?.definition_key).toBe("hiring_relevant_roles");
    expect(output.matches[0]?.strength).toBeGreaterThan(0);
  });

  it("returns no matches when nothing overlaps a definition's keywords", () => {
    const output = buildClassifyItemsAnswer(
      { ...vars, items: [vars.items[1] as ClassifyItemsVars["items"][number]] },
      {},
    );
    expect(output.matches).toEqual([]);
  });
});

describe("buildClassifyWebsiteChangeAnswer", () => {
  const vars: WebsiteChangeVars = {
    company: { name: "Northwind", domain: "northwind.example", industry: "logistics" },
    changes: [
      {
        index: 0,
        url: "https://northwind.example/careers",
        kind: "careers",
        added: ["Now hiring an operations manager"],
        removed: [],
      },
      {
        index: 1,
        url: "https://northwind.example/blog",
        kind: "blog",
        added: [],
        removed: ["Old post"],
      },
    ],
    definitions: [hiringDefinition],
  };

  it("matches a change whose added lines contain a keyword", () => {
    const output = buildClassifyWebsiteChangeAnswer(vars, {});
    expect(output.matches).toHaveLength(1);
    expect(output.matches[0]?.change).toBe(0);
    expect(output.matches[0]?.evidence_excerpt).toContain("operations manager");
  });

  it("skips a change with no added lines", () => {
    const output = buildClassifyWebsiteChangeAnswer(
      { ...vars, changes: [vars.changes[1] as WebsiteChangeVars["changes"][number]] },
      {},
    );
    expect(output.matches).toEqual([]);
  });
});

describe("buildEvaluateCustomAnswer", () => {
  const vars: EvaluateCustomVars = {
    company: { name: "Northwind", domain: "northwind.example", industry: "logistics" },
    definition: hiringDefinition,
    today: "2026-09-27",
    sources: [
      {
        url: "https://northwind.example/careers",
        title: "Careers",
        text: "We are hiring an operations manager in Denver.",
        published_at: "2026-08-01",
        collector: "website",
      },
    ],
  };

  it("matches and cites the exact source url", () => {
    const output = buildEvaluateCustomAnswer(vars, {});
    expect(output.matched).toBe(true);
    expect(output.evidence_url).toBe("https://northwind.example/careers");
    expect(output.strength).toBeGreaterThan(0);
  });

  it("returns strength 0 and empty strings when nothing matches", () => {
    const output = buildEvaluateCustomAnswer(
      {
        ...vars,
        sources: [
          {
            url: "https://northwind.example/careers",
            title: "Careers",
            text: "Nothing relevant here.",
            published_at: "2026-08-01",
            collector: "website",
          },
        ],
      },
      {},
    );
    expect(output.matched).toBe(false);
    expect(output.strength).toBe(0);
    expect(output.evidence_url).toBe("");
    expect(output.evidence_excerpt).toBe("");
  });
});
