import { describe, expect, it } from "vitest";
import { wrapUntrusted } from "../../brain/prompt.js";
import {
  firstIsoDate,
  fitWords,
  parseProspect,
  parseSignals,
  pickOne,
  pickVariant,
} from "./text.js";

function prospectBlock(lines: string[]): string {
  return wrapUntrusted("prospect record", lines.join("\n"));
}

function signalsBlock(lines: string[]): string {
  return wrapUntrusted("signals", lines.join("\n"));
}

describe("parseProspect", () => {
  it("reads the Name, Title and Company lines renderProspect() produces", () => {
    const block = prospectBlock([
      "Name: Dana Reyes",
      "Title: Operations Lead",
      "Company: Northwind Logistics",
      "Company website: northwind.example",
    ]);
    const parsed = parseProspect(block);
    expect(parsed.firstName).toBe("Dana");
    expect(parsed.fullName).toBe("Dana Reyes");
    expect(parsed.company).toBe("Northwind Logistics");
    expect(parsed.companyShort).toBe("Northwind");
    expect(parsed.title).toBe("Operations Lead");
  });

  it("falls back to safe generic words when fields are missing", () => {
    const parsed = parseProspect(prospectBlock(["Title: Owner"]));
    expect(parsed.firstName).toBe("there");
    expect(parsed.company).toBeNull();
    expect(parsed.companyShort).toBe("your team");
  });
});

describe("parseSignals", () => {
  it("reads id, type and title from each signals line", () => {
    const block = signalsBlock([
      "id: sig_1; type: hiring_relevant_roles; title: Hiring an ops lead; evidence: https://x.example/a",
      "id: sig_2; type: funding_round; title: Raised a Series B",
    ]);
    const signals = parseSignals(block);
    expect(signals).toEqual([
      { id: "sig_1", type: "hiring_relevant_roles", title: "Hiring an ops lead" },
      { id: "sig_2", type: "funding_round", title: "Raised a Series B" },
    ]);
  });

  it("returns an empty list for null or empty input", () => {
    expect(parseSignals(null)).toEqual([]);
    expect(parseSignals(signalsBlock([]))).toEqual([]);
  });
});

describe("pickVariant / pickOne", () => {
  it("is deterministic for the same key", () => {
    expect(pickVariant("abc", 5)).toBe(pickVariant("abc", 5));
    expect(pickOne("abc", ["a", "b", "c"])).toBe(pickOne("abc", ["a", "b", "c"]));
  });

  it("stays in range and varies across keys", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 50; i++) {
      const index = pickVariant(`key-${i}`, 4);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(4);
      seen.add(index);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("never returns an out-of-range index for n = 1", () => {
    expect(pickVariant("anything", 1)).toBe(0);
  });
});

describe("firstIsoDate", () => {
  it("extracts the first YYYY-MM-DD date", () => {
    expect(firstIsoDate("back on 2026-10-05, thanks")).toBe("2026-10-05");
  });

  it("returns null when there is no date", () => {
    expect(firstIsoDate("no dates here")).toBeNull();
  });
});

describe("fitWords", () => {
  it("leaves text alone when it already fits", () => {
    expect(fitWords("one two three.", 10)).toBe("one two three.");
  });

  it("drops trailing sentences until the word count fits", () => {
    const body = "First sentence here now. Second sentence follows along. Third one too.";
    const fit = fitWords(body, 6);
    expect(fit).toBe("First sentence here now.");
  });

  it("ignores the limit when it is null", () => {
    const body = "one two three four five six seven eight nine ten.";
    expect(fitWords(body, null)).toBe(body);
  });
});
