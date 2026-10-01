import { describe, expect, it } from "vitest";
import {
  buildDedupeKey,
  canonicalEvidenceUrl,
  clip,
  internalEvidenceUrl,
  requireEvidenceUrl,
} from "./evidence.js";

describe("canonicalEvidenceUrl", () => {
  it.each([
    [
      "https://News.Example.com/a/b/?utm_source=x&b=2&a=1#top",
      "https://news.example.com/a/b?a=1&b=2",
    ],
    ["http://example.com:80/", "http://example.com"],
    ["https://example.com", "https://example.com"],
    ["https://example.com/jobs/", "https://example.com/jobs"],
    ["  https://example.com/x?fbclid=1  ", "https://example.com/x"],
    ["openoutbound://messages/msg_1", "openoutbound://messages/msg_1"],
  ])("%s -> %s", (input, expected) => {
    expect(canonicalEvidenceUrl(input)).toBe(expected);
  });

  it.each([
    [""],
    [null],
    ["not a url"],
    ["javascript:alert(1)"],
    ["ftp://example.com/file"],
    ["https://user:pass@example.com/"],
    ["openoutbound://"],
    [`https://example.com/${"a".repeat(2100)}`],
  ])("rejects %s", (input) => {
    expect(canonicalEvidenceUrl(input)).toBeNull();
  });

  it("throws an actionable error when required", () => {
    expect(() => requireEvidenceUrl(undefined)).toThrow(/needs an evidence_url/);
    try {
      requireEvidenceUrl("nope");
    } catch (error) {
      expect(error).toMatchObject({ code: "validation_failed" });
      expect((error as { hint?: string }).hint).toMatch(/evidence_url/);
    }
  });
});

describe("buildDedupeKey", () => {
  it("uses the subject and the canonical URL by default", () => {
    expect(
      buildDedupeKey({
        definitionKey: "funding_round",
        companyId: "co_1",
        personId: null,
        evidenceUrl: "https://example.com/news",
      }),
    ).toBe("funding_round:co_1:https://example.com/news");
    expect(
      buildDedupeKey({
        definitionKey: "job_change",
        companyId: "co_1",
        personId: "pe_1",
        evidenceUrl: "https://example.com/x",
      }),
    ).toBe("job_change:pe_1:https://example.com/x");
  });

  it("prefers a provided key and hashes long keys", () => {
    expect(
      buildDedupeKey({
        definitionKey: "k",
        companyId: "co_1",
        personId: null,
        evidenceUrl: "https://example.com",
        provided: "predictleads:job:1",
      }),
    ).toBe("k:predictleads:job:1");
    const long = buildDedupeKey({
      definitionKey: "k",
      companyId: "co_1",
      personId: null,
      evidenceUrl: `https://example.com/${"x".repeat(500)}`,
    });
    expect(long).toMatch(/^k:h:[0-9a-f]{64}$/);
  });
});

describe("helpers", () => {
  it("builds internal references and clips text", () => {
    expect(internalEvidenceUrl("messages", "msg_1")).toBe("openoutbound://messages/msg_1");
    expect(clip("  a   b  ", 10)).toBe("a b");
    expect(clip("", 10)).toBeNull();
    expect(clip("abcdefghijkl", 6)).toBe("abc...");
  });
});
