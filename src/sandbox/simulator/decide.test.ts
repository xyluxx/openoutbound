import { describe, expect, it } from "vitest";
import {
  BOUNCE_RATE_FOR_INVALID,
  decideEmailOutcome,
  decideLinkedInAccept,
  decideLinkedInMessageReply,
  FIRST_TOUCH_REPLY_RATE,
  LINKEDIN_MESSAGE_REPLY_RATE,
  outOfOfficeReturnDate,
  simulatedDelayMs,
} from "./decide.js";

const SAMPLE_SIZE = 1000;

function samplePairs(prefix: string, n: number): Array<{ personId: string; messageId: string }> {
  return Array.from({ length: n }, (_, i) => ({
    personId: `${prefix}_pe_${i}`,
    messageId: `${prefix}_msg_${i}`,
  }));
}

/** Brute-forces a (personId, messageId) pair whose decision matches `want`. */
function findEmailOutcome(
  prefix: string,
  emailStatus: "valid" | "invalid",
  want: (outcome: ReturnType<typeof decideEmailOutcome>) => boolean,
): { personId: string; messageId: string } {
  const personId = `${prefix}_pe`;
  for (let i = 0; i < 20_000; i++) {
    const messageId = `${prefix}_msg_${i}`;
    const outcome = decideEmailOutcome({ personId, messageId, emailStatus });
    if (want(outcome)) return { personId, messageId };
  }
  throw new Error(`no (personId, messageId) found matching the wanted outcome for ${prefix}`);
}

describe("decideEmailOutcome: determinism", () => {
  it("is a pure function of (personId, messageId, emailStatus)", () => {
    const input = { personId: "pe_1", messageId: "msg_1", emailStatus: "valid" as const };
    expect(decideEmailOutcome(input)).toEqual(decideEmailOutcome(input));
  });
});

describe("decideEmailOutcome: distribution over 1,000 simulated sends", () => {
  it("replies at roughly FIRST_TOUCH_REPLY_RATE for non-invalid addresses, never bouncing", () => {
    const pairs = samplePairs("valid", SAMPLE_SIZE);
    let replies = 0;
    for (const { personId, messageId } of pairs) {
      const outcome = decideEmailOutcome({ personId, messageId, emailStatus: "valid" });
      expect(outcome.kind).not.toBe("bounce");
      if (outcome.kind === "reply") replies++;
    }
    const rate = replies / SAMPLE_SIZE;
    expect(rate).toBeGreaterThan(FIRST_TOUCH_REPLY_RATE - 0.06);
    expect(rate).toBeLessThan(FIRST_TOUCH_REPLY_RATE + 0.06);
  });

  it("the reply-kind mix roughly matches the brief's weights among those who reply", () => {
    const pairs = samplePairs("mix", 6000);
    const counts = new Map<string, number>();
    let replies = 0;
    for (const { personId, messageId } of pairs) {
      const outcome = decideEmailOutcome({ personId, messageId, emailStatus: "valid" });
      if (outcome.kind === "reply") {
        replies++;
        counts.set(outcome.replyKind, (counts.get(outcome.replyKind) ?? 0) + 1);
      }
    }
    expect(replies).toBeGreaterThan(500);
    // interested (25%) should be the largest bucket, angry (2%) among the smallest.
    const interested = counts.get("interested") ?? 0;
    const angry = counts.get("angry") ?? 0;
    expect(interested / replies).toBeGreaterThan(0.15);
    expect(angry / replies).toBeLessThan(0.08);
  });

  it("only bounces (never replies) for addresses marked invalid, at roughly BOUNCE_RATE_FOR_INVALID", () => {
    const pairs = samplePairs("invalid", SAMPLE_SIZE);
    let bounces = 0;
    for (const { personId, messageId } of pairs) {
      const outcome = decideEmailOutcome({ personId, messageId, emailStatus: "invalid" });
      expect(outcome.kind).not.toBe("reply");
      if (outcome.kind === "bounce") bounces++;
    }
    const rate = bounces / SAMPLE_SIZE;
    expect(rate).toBeGreaterThan(0);
    expect(rate).toBeLessThan(BOUNCE_RATE_FOR_INVALID + 0.04);
  });
});

describe("decideEmailOutcome: prompt injection is produced verbatim for the right seed", () => {
  it("finds a seed that decides prompt_injection and it round-trips through the mix", () => {
    const { personId, messageId } = findEmailOutcome(
      "inject",
      "valid",
      (o) => o.kind === "reply" && o.replyKind === "prompt_injection",
    );
    const outcome = decideEmailOutcome({ personId, messageId, emailStatus: "valid" });
    expect(outcome).toEqual({ kind: "reply", replyKind: "prompt_injection" });
  });
});

describe("decideLinkedInAccept", () => {
  it("is deterministic per person and accepts roughly 35% of a large sample", () => {
    let accepted = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) {
      const personId = `li_pe_${i}`;
      const result = decideLinkedInAccept(personId);
      expect(decideLinkedInAccept(personId)).toBe(result);
      if (result) accepted++;
    }
    expect(accepted / n).toBeGreaterThan(0.28);
    expect(accepted / n).toBeLessThan(0.42);
  });
});

describe("decideLinkedInMessageReply", () => {
  it("is deterministic and replies roughly LINKEDIN_MESSAGE_REPLY_RATE of the time", () => {
    let replied = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) {
      const personId = `li_msg_pe_${i}`;
      const messageId = `li_msg_${i}`;
      const result = decideLinkedInMessageReply(personId, messageId);
      expect(decideLinkedInMessageReply(personId, messageId)).toBe(result);
      if (result) replied++;
    }
    const rate = replied / n;
    expect(rate).toBeGreaterThan(LINKEDIN_MESSAGE_REPLY_RATE - 0.06);
    expect(rate).toBeLessThan(LINKEDIN_MESSAGE_REPLY_RATE + 0.06);
  });
});

describe("simulatedDelayMs", () => {
  it("is always between 2 and 30 simulated minutes, and deterministic", () => {
    for (let i = 0; i < 200; i++) {
      const personId = `pe_delay_${i}`;
      const messageId = `msg_delay_${i}`;
      const delay = simulatedDelayMs(personId, messageId);
      expect(delay).toBeGreaterThanOrEqual(2 * 60_000);
      expect(delay).toBeLessThanOrEqual(30 * 60_000);
      expect(simulatedDelayMs(personId, messageId)).toBe(delay);
    }
  });
});

describe("outOfOfficeReturnDate", () => {
  it("returns a date 5-10 days after now", () => {
    const now = new Date("2026-09-27T00:00:00.000Z");
    for (let i = 0; i < 50; i++) {
      const date = outOfOfficeReturnDate(`pe_${i}`, `msg_${i}`, now);
      const days = (new Date(date).getTime() - now.getTime()) / 86_400_000;
      expect(days).toBeGreaterThanOrEqual(5);
      expect(days).toBeLessThanOrEqual(10);
    }
  });
});
