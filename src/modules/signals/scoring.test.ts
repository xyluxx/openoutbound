import { describe, expect, it } from "vitest";
import { ageDays, decayedScore, intentScore, normalizeStrength, signalScore } from "./scoring.js";

describe("decayedScore", () => {
  it.each([
    // weight, strength, age, half-life, expected
    [80, 1, 0, 60, 80],
    [80, 1, 60, 60, 40],
    [80, 1, 120, 60, 20],
    [45, 1, 30, 60, 32], // 45 x 0.7071 = 31.8
    [55, 0.8, 7, 30, 37], // 44 x 0.8506 = 37.4
    [25, 0.5, 3, 21, 11], // 12.5 x 0.9057 = 11.3
    [20, 1, 14, 14, 10],
    [100, 1, 0, 30, 100],
    [60, 0, 0, 45, 0],
    [40, 1, 3650, 60, 0], // ten years later nothing is left
  ])(
    "weight %d strength %d age %d half-life %d -> %d",
    (weight, strength, age, halfLife, expected) => {
      expect(decayedScore({ weight, strength, ageDays: age, halfLifeDays: halfLife })).toBe(
        expected,
      );
    },
  );

  it("clamps to 0-100 and survives bad inputs", () => {
    expect(decayedScore({ weight: 150, strength: 1, ageDays: 0, halfLifeDays: 30 })).toBe(100);
    expect(decayedScore({ weight: -10, strength: 1, ageDays: 0, halfLifeDays: 30 })).toBe(0);
    expect(decayedScore({ weight: 50, strength: 2, ageDays: 0, halfLifeDays: 30 })).toBe(50);
    expect(decayedScore({ weight: 50, strength: 1, ageDays: -5, halfLifeDays: 30 })).toBe(50);
    expect(decayedScore({ weight: 50, strength: 1, ageDays: 1, halfLifeDays: 0 })).toBe(25);
    expect(decayedScore({ weight: 50, strength: Number.NaN, ageDays: 1, halfLifeDays: 10 })).toBe(
      0,
    );
  });
});

describe("signalScore", () => {
  const definition = { weight: 60, half_life_days: 45, min_strength: 0.3 };

  it("scores 0 below min_strength and scores at the boundary", () => {
    expect(signalScore(definition, 0.29, 0)).toBe(0);
    expect(signalScore(definition, 0.3, 0)).toBe(18);
    expect(signalScore(definition, 1, 45)).toBe(30);
  });
});

describe("intentScore", () => {
  it.each([
    { name: "no signals", items: [], expected: 0 },
    { name: "one signal", items: [{ definition_key: "a", score: 40 }], expected: 40 },
    {
      name: "playbook B2B example (32, 37, 11)",
      items: [
        { definition_key: "funding_round", score: 32 },
        { definition_key: "hiring_relevant_roles", score: 37 },
        { definition_key: "website_change", score: 11 },
      ],
      expected: 62,
    },
    {
      name: "playbook local example (29, 40)",
      items: [
        { definition_key: "review_activity", score: 29 },
        { definition_key: "expansion_new_location", score: 40 },
      ],
      expected: 57,
    },
    {
      name: "keeps only the strongest signal per key",
      items: [
        { definition_key: "news_mention", score: 20 },
        { definition_key: "news_mention", score: 10 },
        { definition_key: "news_mention", score: 15 },
      ],
      expected: 20,
    },
    {
      name: "ignores inactive signals (score below 1)",
      items: [
        { definition_key: "a", score: 0 },
        { definition_key: "b", score: 0.4 },
      ],
      expected: 0,
    },
    {
      name: "a full-strength signal saturates",
      items: [
        { definition_key: "a", score: 100 },
        { definition_key: "b", score: 30 },
      ],
      expected: 100,
    },
  ])("$name -> $expected", ({ items, expected }) => {
    expect(intentScore(items)).toBe(expected);
  });

  it("decays: the B2B example 60 days later falls to about 25", () => {
    const later = [
      decayedScore({ weight: 45, strength: 1, ageDays: 90, halfLifeDays: 60 }),
      decayedScore({ weight: 55, strength: 0.8, ageDays: 67, halfLifeDays: 30 }),
      decayedScore({ weight: 25, strength: 0.5, ageDays: 63, halfLifeDays: 21 }),
    ];
    const intent = intentScore(later.map((score, i) => ({ definition_key: `k${i}`, score })));
    expect(intent).toBeGreaterThanOrEqual(22);
    expect(intent).toBeLessThanOrEqual(26);
  });
});

describe("helpers", () => {
  it("computes age in days and never negative", () => {
    const now = new Date("2026-09-19T12:00:00Z");
    expect(ageDays(new Date("2026-09-18T12:00:00Z"), now)).toBe(1);
    expect(ageDays(new Date("2026-09-20T12:00:00Z"), now)).toBe(0);
  });

  it("normalizes strength to two decimals in 0-1", () => {
    expect(normalizeStrength(0.456)).toBe(0.46);
    expect(normalizeStrength(undefined)).toBe(1);
    expect(normalizeStrength(null, 0.5)).toBe(0.5);
    expect(normalizeStrength(-1)).toBe(0);
    expect(normalizeStrength(7)).toBe(1);
  });
});
