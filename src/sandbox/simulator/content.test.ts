import { describe, expect, it } from "vitest";
import {
  buildBounceEmail,
  buildLinkedInReplyText,
  buildReplyBody,
  buildReplySubject,
  PROMPT_INJECTION_TEXT,
  pickReplyKind,
  REPLY_KIND_MIX,
  replyExtraHeaders,
  SIM_REPLY_KINDS,
} from "./content.js";

describe("REPLY_KIND_MIX", () => {
  it("weights sum to 100 and cover every SimReplyKind exactly once", () => {
    const total = REPLY_KIND_MIX.reduce((sum, entry) => sum + entry.weight, 0);
    expect(total).toBe(100);
    expect(REPLY_KIND_MIX.map((e) => e.kind).sort()).toEqual([...SIM_REPLY_KINDS].sort());
  });
});

describe("pickReplyKind", () => {
  it("is a pure function of its ratio (deterministic)", () => {
    expect(pickReplyKind(0.5)).toBe(pickReplyKind(0.5));
  });

  it("maps ratio 0 to the first kind and a ratio just under 1 to the last kind", () => {
    expect(pickReplyKind(0)).toBe("interested");
    expect(pickReplyKind(0.9999)).toBe("angry");
  });

  it("splits the 0-1 range in proportion to each kind's weight", () => {
    const counts = new Map<string, number>();
    const samples = 10_000;
    for (let i = 0; i < samples; i++) {
      const kind = pickReplyKind(i / samples);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    for (const entry of REPLY_KIND_MIX) {
      const share = (counts.get(entry.kind) ?? 0) / samples;
      expect(share).toBeCloseTo(entry.weight / 100, 2);
    }
  });
});

describe("buildReplyBody", () => {
  it("produces the prompt injection text verbatim, in either language", () => {
    const vars = {
      prospectFirstName: "Dana",
      senderName: "Sam",
      originalSubject: "Quick question",
    };
    expect(buildReplyBody("prompt_injection", vars, "en")).toBe(PROMPT_INJECTION_TEXT);
    expect(buildReplyBody("prompt_injection", vars, "de")).toBe(PROMPT_INJECTION_TEXT);
  });

  it("references the original subject and signs off with the prospect's first name", () => {
    const vars = {
      prospectFirstName: "Dana",
      senderName: "Sam",
      originalSubject: "Cutting fulfillment costs",
    };
    const en = buildReplyBody("interested", vars, "en");
    expect(en).toContain("Cutting fulfillment costs");
    expect(en).toContain("Dana");
    const de = buildReplyBody("interested", vars, "de");
    expect(de).toContain("Cutting fulfillment costs");
  });

  it("includes the return date for out_of_office", () => {
    const body = buildReplyBody(
      "out_of_office",
      {
        prospectFirstName: "Dana",
        senderName: "Sam",
        originalSubject: "Hi",
        returnDate: "2026-10-05",
      },
      "en",
    );
    expect(body).toContain("2026-10-05");
  });
});

describe("buildReplySubject", () => {
  it("prefixes Re: in English and AW: in German, without double-prefixing", () => {
    expect(buildReplySubject("Quick question", "en")).toBe("Re: Quick question");
    expect(buildReplySubject("Quick question", "de")).toBe("AW: Quick question");
    expect(buildReplySubject("Re: Quick question", "en")).toBe("Re: Quick question");
  });
});

describe("replyExtraHeaders", () => {
  it("marks out_of_office as an auto-reply and leaves other kinds alone", () => {
    expect(replyExtraHeaders("out_of_office")).toEqual({ "Auto-Submitted": "auto-replied" });
    expect(replyExtraHeaders("interested")).toEqual({});
  });
});

describe("buildBounceEmail", () => {
  it("names the failed recipient and reads like a hard DSN", () => {
    const bounce = buildBounceEmail("dana@example.com");
    expect(bounce.subject).toMatch(/undelivered/i);
    expect(bounce.text).toContain("dana@example.com");
    expect(bounce.text).toContain("550");
  });
});

describe("buildLinkedInReplyText", () => {
  it("returns a short, non-empty reply", () => {
    expect(buildLinkedInReplyText().length).toBeGreaterThan(0);
  });
});
