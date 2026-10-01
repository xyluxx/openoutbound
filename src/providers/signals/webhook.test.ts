import { describe, expect, it } from "vitest";
import { createWebhookSignals, parseWebhookBody, WEBHOOK_MAX_SIGNALS } from "./webhook.js";

const valid = {
  key: "funding_round",
  company: { domain: "northwind.example.com", name: "Northwind Example" },
  title: "Raised a Series A",
  evidence_url: "https://news.example.org/northwind-series-a",
  occurred_at: "2026-09-01T00:00:00Z",
  strength: 0.8,
  dedupe_key: "crm-42",
};

describe("webhook body parsing", () => {
  it("maps the documented shape to RawSignal", () => {
    const parsed = parseWebhookBody({ signals: [valid] });
    expect(parsed.errors).toEqual([]);
    expect(parsed.signals[0]).toEqual({
      index: 0,
      signal: {
        definition_key: "funding_round",
        title: "Raised a Series A",
        summary: null,
        evidence_url: "https://news.example.org/northwind-series-a",
        evidence_excerpt: null,
        source: "webhook",
        occurred_at: "2026-09-01T00:00:00Z",
        strength: 0.8,
        dedupe_key: "webhook:crm-42",
        company: {
          name: "Northwind Example",
          domain: "northwind.example.com",
          linkedin_url: null,
        },
      },
    });
  });

  it("reports bad items one by one without failing the batch", () => {
    const parsed = parseWebhookBody({
      signals: [
        valid,
        { ...valid, key: "Not A Key" },
        { ...valid, evidence_url: undefined },
        { ...valid, strength: 3 },
        "not an object",
      ],
    });
    expect(parsed.signals.map((item) => item.index)).toEqual([0]);
    expect(parsed.errors.map((item) => item.index)).toEqual([1, 2, 3, 4]);
    expect(parsed.errors[0]?.message).toContain("key");
    expect(parsed.errors[1]?.message).toContain("evidence_url");
  });

  it("rejects a wrong envelope", () => {
    expect(() => parseWebhookBody({})).toThrow(/signals/);
    expect(() => parseWebhookBody({ signals: [] })).toThrow(/1 to 100/);
    const tooMany = Array.from({ length: WEBHOOK_MAX_SIGNALS + 1 }, () => valid);
    expect(() => parseWebhookBody({ signals: tooMany })).toThrow(/1 to 100/);
    expect(() => parseWebhookBody(null)).toThrow();
  });

  it("exposes the parser as a provider without collecting", async () => {
    const provider = createWebhookSignals();
    expect(await provider.collect({ company: { id: "co_1", name: "A" } })).toEqual([]);
    expect(await provider.parseWebhook?.({ signals: [valid, { bad: true }] }, {})).toHaveLength(1);
  });
});
