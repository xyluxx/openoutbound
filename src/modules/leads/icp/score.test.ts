import { describe, expect, it } from "vitest";
import { icpCriteriaSchema, icpScoringSchema, type ParsedIcp } from "./criteria.js";
import { phraseMatches, type ScoreCompany, type ScorePerson, scoreFit } from "./score.js";
import { inferSeniority, resolveSeniority } from "./seniority.js";

function icp(criteria: Record<string, unknown>, scoring: Record<string, unknown> = {}): ParsedIcp {
  return {
    id: "icp_test",
    name: "Test",
    description: null,
    criteria: icpCriteriaSchema.parse(criteria),
    scoring: icpScoringSchema.parse(scoring),
  };
}

const company = (over: Partial<ScoreCompany> = {}): ScoreCompany => ({
  name: "Harbor Dental Group",
  domain: "harbor.example.com",
  industry: "Dental practices",
  description: "Family dentistry with three locations",
  employee_count: 25,
  employee_range: null,
  country: "US",
  region: "TX",
  city: "Austin",
  technologies: ["WordPress"],
  status: "active",
  ...over,
});

const person = (over: Partial<ScorePerson> = {}): ScorePerson => ({
  title: "Practice Manager",
  seniority: null,
  department: null,
  email: "dana@harbor.example.com",
  country: "US",
  region: null,
  city: null,
  ...over,
});

const dental = icp({
  industries: ["dental"],
  titles: ["practice manager", "owner"],
  seniorities: ["manager", "owner"],
  employee_range: { min: 5, max: 50 },
  countries: ["United States"],
});

describe("scoreFit", () => {
  it("gives full points when every criterion matches, with reasons", () => {
    const result = scoreFit(dental, { person: person(), company: company() });
    expect(result.score).toBe(100);
    expect(result.disqualified).toBe(false);
    expect(result.reasons.map((r) => r.rule)).toEqual([
      "industry",
      "employees",
      "geography",
      "title",
      "seniority",
    ]);
    expect(result.reasons.every((r) => r.matched)).toBe(true);
    expect(result.reasons[0]?.detail).toBe('industry matches "dental" (25/25)');
  });

  it("gives partial and zero points and explains misses", () => {
    const result = scoreFit(dental, {
      person: person({ title: "Director of Marketing", country: "CA" }),
      company: company({ employee_count: 90, country: "CA" }),
    });
    // industry 25 + employees 7.5 + geography 0 + title 0 + seniority 0 (director vs manager is 2 off)
    expect(result.score).toBe(Math.round((100 * 32.5) / 80));
    expect(result.summary).toContain("missed");
    const geography = result.reasons.find((r) => r.rule === "geography");
    expect(geography).toMatchObject({ matched: false, points: 0 });
  });

  it("scores unknown values at the unknown share", () => {
    const result = scoreFit(icp({ industries: ["dental"], titles: ["owner"] }), {
      person: person({ title: null }),
      company: company({ industry: null, name: "", description: null, technologies: [] }),
    });
    // 0.4 x 25 + 0.4 x 20 = 18 of 45
    expect(result.score).toBe(40);
    expect(result.reasons.map((r) => r.detail)).toEqual([
      "industry unknown (10/25)",
      "title unknown (8/20)",
    ]);
    expect(result.summary).toBe("unknown industry, title");
  });

  it("treats a company with no industry as unknown, not as a wrong industry", () => {
    // A CSV row or an Apollo preview: a company name only, and a perfect title.
    const ops = icp({ industries: ["e-commerce"], titles: ["vp operations"] });
    const result = scoreFit(ops, {
      person: person({ title: "VP of Operations" }),
      company: company({
        name: "Saltmarsh Apparel",
        industry: null,
        description: null,
        technologies: [],
      }),
    });
    // industry 0.4 x 25 = 10 (not 0) + title 20 = 30 of 45
    expect(result.score).toBe(67);
    expect(result.reasons.find((r) => r.rule === "industry")).toEqual({
      rule: "industry",
      points: 10,
      matched: false,
      detail: "industry unknown (10/25)",
    });
    expect(result.summary).toBe("title matched; unknown industry");

    // A known industry that is not a target is still a miss.
    const wrong = scoreFit(ops, {
      person: person({ title: "VP of Operations" }),
      company: company({ industry: "Dental practices" }),
    });
    expect(wrong.reasons.find((r) => r.rule === "industry")).toMatchObject({
      points: 0,
      detail: 'industry "Dental practices" is not a target (0/25)',
    });
    expect(wrong.summary).toBe("title matched; missed industry");
  });

  it("disqualifies on exclusions and hard limits", () => {
    const strict = icp({
      industries: ["dental"],
      employee_limits: { max: 100 },
      exclude: { titles: ["intern"], free_mail: true },
    });
    expect(
      scoreFit(strict, { person: person({ title: "Dental Intern" }), company: company() }),
    ).toMatchObject({
      score: 0,
      disqualified: true,
    });
    expect(scoreFit(strict, { company: company({ employee_count: 500 }) }).disqualified).toBe(true);
    expect(scoreFit(strict, { company: company({ status: "customer" }) }).disqualified).toBe(true);
    expect(
      scoreFit(strict, { person: person({ email: "dana@gmail.com" }), company: company() })
        .reasons[0]?.rule,
    ).toBe("exclude_free_mail");
  });

  it("scores companies alone on company criteria only", () => {
    const result = scoreFit(dental, { company: company() });
    expect(result.score).toBe(100);
    expect(result.reasons.map((r) => r.rule)).toEqual(["industry", "employees", "geography"]);
  });

  it("falls back to the company name for industry and uses secondary markets", () => {
    const local = icp({ industries: ["dental"], countries: ["DE"], countries_secondary: ["AT"] });
    const result = scoreFit(local, {
      company: company({
        industry: null,
        description: null,
        name: "Zahnarzt Dental Studio",
        country: "AT",
      }),
    });
    expect(result.reasons.find((r) => r.rule === "industry")?.matched).toBe(true);
    expect(result.reasons.find((r) => r.rule === "geography")?.points).toBe(5);
  });

  it("returns null when no criteria apply", () => {
    expect(scoreFit(icp({}), { company: company() }).score).toBeNull();
    expect(scoreFit(icp({ titles: ["owner"] }), { company: company() }).score).toBeNull();
  });
});

describe("matching helpers", () => {
  it("matches phrases across abbreviations and plurals", () => {
    expect(phraseMatches("Vice President, Operations", "vp operations")).toBe(true);
    expect(phraseMatches("VP of Ops", "vp operations")).toBe(true);
    expect(phraseMatches("Dentists", "dentist")).toBe(true);
    expect(phraseMatches("E-Commerce", "ecommerce")).toBe(true);
    expect(phraseMatches("Head of Supply Chain", "supply chain")).toBe(true);
    expect(phraseMatches("Marketing Manager", "sales manager")).toBe(false);
    expect(phraseMatches(null, "x")).toBe(false);
  });

  it("infers seniority from titles", () => {
    expect(inferSeniority("VP of Operations")).toBe("vp");
    expect(inferSeniority("Vice President, Sales")).toBe("vp");
    expect(inferSeniority("Managing Director")).toBe("c_suite");
    expect(inferSeniority("Owner & Principal Dentist")).toBe("owner");
    expect(inferSeniority("Co-Founder")).toBe("founder");
    expect(inferSeniority("Head of Supply Chain")).toBe("head");
    expect(inferSeniority("Practice Manager")).toBe("manager");
    expect(inferSeniority("Dental Hygienist")).toBeNull();
    expect(resolveSeniority("C-Level", null)).toBe("c_suite");
    expect(resolveSeniority(null, "Senior Analyst")).toBe("senior");
  });
});
