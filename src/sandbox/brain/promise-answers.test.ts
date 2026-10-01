import { describe, expect, it } from "vitest";
import { type PromisesVars, promisesOutputSchema } from "../../modules/inbox/prompts/promises.js";
import { buildPromisesAnswer, resolvePromiseDate } from "./promise-answers.js";

/** Tuesday. */
const SENT_ON = "2026-09-22";

function vars(text: string): PromisesVars {
  return {
    company: "Brightline Answering",
    channel: "email",
    sentOn: SENT_ON,
    weekday: "Tuesday",
    timeZone: "America/Chicago",
    subject: "Re: front desk coverage",
    text,
  };
}

describe("buildPromisesAnswer", () => {
  it("finds our commitments and resolves relative dates against the send date", () => {
    const output = promisesOutputSchema.parse(
      buildPromisesAnswer(
        vars(
          "Thanks Dana. I'll send the case study for dental groups on Monday. We will share pricing tomorrow. Let me know what works.",
        ),
        {},
      ),
    );
    expect(output.promises).toEqual([
      { text: "Send the case study for dental groups on Monday", due: "2026-09-28" },
      { text: "Share pricing tomorrow", due: "2026-09-23" },
    ]);
  });

  it("returns no promises for a reply without commitments", () => {
    expect(buildPromisesAnswer(vars("Sounds good, talk soon. Let me know."), {})).toEqual({
      promises: [],
    });
  });

  it("keeps at most three", () => {
    const text =
      "I'll send the deck. I'll send the pricing. I'll send the references. I'll send a video.";
    expect(buildPromisesAnswer(vars(text), {}).promises).toHaveLength(3);
  });
});

describe("resolvePromiseDate", () => {
  it.each([
    ["by the end of the week", "2026-09-25"],
    ["next week", "2026-09-28"],
    ["on Tuesday", "2026-09-29"],
    ["later today", SENT_ON],
    ["before 2026-10-02", "2026-10-02"],
    ["soon", null],
  ])("%s -> %s", (phrase, due) => {
    expect(resolvePromiseDate(phrase, SENT_ON)).toBe(due);
  });
});
