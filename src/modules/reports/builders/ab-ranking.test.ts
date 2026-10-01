import { describe, expect, it } from "vitest";
import { AB_MIN_SENDS, rankVariants, type VariantCounts } from "./ab-ranking.js";

function variant(key: string, people: number, counts: Partial<VariantCounts> = {}): VariantCounts {
  return {
    variant: key,
    sent: people,
    people,
    replies: 0,
    positive_replies: 0,
    meetings: 0,
    ...counts,
  };
}

describe("A/B ranking", () => {
  it("names the leader with the probability that it is the best", () => {
    const ranking = rankVariants(
      [
        variant("A", 60, { positive_replies: 12, replies: 14 }),
        variant("B", 60, { positive_replies: 3, replies: 20 }),
      ],
      "positive_reply_rate",
    );
    expect(ranking.leader).toBe("A");
    expect(ranking.confidence).toBeGreaterThan(0.95);
    expect(ranking.confidence).toBeLessThanOrEqual(1);
    expect(ranking.enough_data).toBe(true);
  });

  it("ranks on the campaign's metric", () => {
    const rows = [
      variant("A", 60, { positive_replies: 12, replies: 14, meetings: 1 }),
      variant("B", 60, { positive_replies: 3, replies: 20, meetings: 9 }),
    ];
    expect(rankVariants(rows, "reply_rate").leader).toBe("B");
    expect(rankVariants(rows, "meeting_rate").leader).toBe("B");
    expect(rankVariants(rows, "positive_reply_rate").leader).toBe("A");
  });

  it("gives the same answer every time and in any input order", () => {
    const rows = [
      variant("B", 60, { positive_replies: 7 }),
      variant("A", 62, { positive_replies: 6 }),
      variant("C", 58, { positive_replies: 8 }),
    ];
    const first = rankVariants(rows, "positive_reply_rate");
    expect(rankVariants(rows, "positive_reply_rate")).toEqual(first);
    expect(rankVariants([...rows].reverse(), "positive_reply_rate")).toEqual(first);
    expect(first.leader).toBe("C");
    expect(first.confidence).toBeGreaterThan(0.3);
    expect(first.confidence).toBeLessThan(0.8);
    const confidence = first.confidence ?? 0;
    expect(Math.round(confidence * 100) / 100).toBe(confidence);
  });

  it("is close to a coin flip for equal variants", () => {
    const ranking = rankVariants(
      [variant("A", 80, { positive_replies: 8 }), variant("B", 80, { positive_replies: 8 })],
      "positive_reply_rate",
    );
    expect(ranking.confidence).toBeGreaterThanOrEqual(0.45);
    expect(ranking.confidence).toBeLessThanOrEqual(0.55);
  });

  it(`needs at least ${AB_MIN_SENDS} sends per variant for enough_data`, () => {
    const almost = rankVariants(
      [variant("A", AB_MIN_SENDS), variant("B", AB_MIN_SENDS - 1)],
      "positive_reply_rate",
    );
    expect(almost.enough_data).toBe(false);
    const enough = rankVariants(
      [variant("A", AB_MIN_SENDS), variant("B", AB_MIN_SENDS)],
      "positive_reply_rate",
    );
    expect(enough.enough_data).toBe(true);
  });

  it("names no leader for a variant nobody got, nor before every variant has enough sends", () => {
    // A variant nobody got has a flat prior: ranked, it would lead the two that did poorly.
    const unsent = rankVariants(
      [
        variant("A", 100, { positive_replies: 2 }),
        variant("B", 100, { positive_replies: 1 }),
        variant("C", 0),
      ],
      "positive_reply_rate",
    );
    expect(unsent).toEqual({ leader: null, confidence: null, enough_data: false });
    const early = rankVariants(
      [variant("A", 60, { positive_replies: 12 }), variant("B", AB_MIN_SENDS - 1)],
      "positive_reply_rate",
    );
    expect(early).toEqual({ leader: null, confidence: null, enough_data: false });
  });

  it("has no leader with one variant or before anyone got one", () => {
    expect(rankVariants([variant("A", 90)], "positive_reply_rate")).toEqual({
      leader: null,
      confidence: null,
      enough_data: false,
    });
    expect(rankVariants([variant("A", 0), variant("B", 0)], "positive_reply_rate")).toEqual({
      leader: null,
      confidence: null,
      enough_data: false,
    });
  });

  it("caps successes at the people reached (replies to older sends)", () => {
    const ranking = rankVariants(
      [
        variant("A", 2, { sent: AB_MIN_SENDS, positive_replies: 5 }),
        variant("B", 2, { sent: AB_MIN_SENDS }),
      ],
      "positive_reply_rate",
    );
    expect(ranking.leader).toBe("A");
    expect(ranking.confidence).toBeLessThan(1);
  });
});
