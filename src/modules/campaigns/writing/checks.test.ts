import { describe, expect, it } from "vitest";
import { findPhrases, phrasesFromRules } from "./banned-phrases.js";
import {
  countWords,
  type DeterministicCheckInput,
  hasErrors,
  runDeterministicChecks,
  SUBJECT_MAX_WORDS,
  SUBJECT_MIN_WORDS,
  sanitizeDraft,
} from "./checks.js";
import { type WritingVars, writeEmailOutput, writeEmailPrompt } from "./prompts.js";
import { extractSlots, fillSlots, numberSlots, renderTemplate } from "./render.js";

const LONG_DASH = String.fromCharCode(0x2014);
const ROCKET = String.fromCodePoint(0x1f680);

function input(overrides: Partial<DeterministicCheckInput> = {}): DeterministicCheckInput {
  return {
    kind: "email",
    subject: "missed calls at lunch",
    body: "Hi Dana, saw the new Austin location opening next month. Front desks in new locations often miss calls while the team settles in. Would it help to see how other groups handle the lunch rush?",
    firstTouch: true,
    mode: "new_thread",
    maxWords: 90,
    minWords: null,
    maxChars: null,
    linksAllowed: 0,
    extraPhrases: [],
    aiWritten: false,
    ...overrides,
  };
}

const codes = (overrides: Partial<DeterministicCheckInput>) =>
  runDeterministicChecks(input(overrides)).map((issue) => issue.code);

describe("renderTemplate", () => {
  it("fills known variables, fallbacks and custom fields", () => {
    const result = renderTemplate(
      "Hi {{first_name}}, {{company|your team}} in {{ city }} ({{custom.segment}})",
      { first_name: "Dana", city: "Austin", custom: { segment: "dental" } },
    );
    expect(result).toEqual({
      text: "Hi Dana, your team in Austin (dental)",
      missing: [],
      unknown: [],
    });
  });

  it("reports missing and unknown variables and leaves them in place", () => {
    const result = renderTemplate("Hi {{first_name}} at {{favorite_color}}", {});
    expect(result.missing).toEqual(["first_name"]);
    expect(result.unknown).toEqual(["favorite_color"]);
    expect(result.text).toBe("Hi {{first_name}} at {{favorite_color}}");
  });
});

describe("slots", () => {
  it("extracts, numbers and fills [[ai: ...]] slots in order", () => {
    const template = "Hi Dana, [[ai: one line about their news]] Also [[ai:a question]]";
    expect(extractSlots(template)).toEqual([
      { index: 0, instruction: "one line about their news" },
      { index: 1, instruction: "a question" },
    ]);
    expect(numberSlots(template)).toBe(
      "Hi Dana, [[slot 0: one line about their news]] Also [[slot 1: a question]]",
    );
    expect(
      fillSlots(
        template,
        new Map([
          [0, "Congrats on the Austin opening."],
          [1, "Worth a look?"],
        ]),
      ),
    ).toBe("Hi Dana, Congrats on the Austin opening. Also Worth a look?");
    expect(fillSlots(template, new Map([[1, "Worth a look?"]]))).toContain("[[ai:");
  });
});

describe("phrases", () => {
  it("matches banned phrases on word boundaries with curly quotes normalized", () => {
    expect(findPhrases("Can we hop on a quick call?", ["hop on a quick call"])).toEqual([
      "hop on a quick call",
    ]);
    expect(findPhrases("Don’t miss out on this", ["don't miss out"])).toEqual(["don't miss out"]);
    expect(findPhrases("the urgently needed fix", ["urgent"])).toEqual([]);
  });

  it("reads banned phrases from writing rules", () => {
    expect(
      phrasesFromRules([
        'Never say "quick question"',
        "Avoid 'circle back' in follow-ups",
        'Mention "Austin" when relevant',
      ]),
    ).toEqual(["quick question", "circle back"]);
  });
});

describe("runDeterministicChecks", () => {
  it("passes a clean first touch", () => {
    expect(runDeterministicChecks(input())).toEqual([]);
  });

  it("enforces word limits and the AI-only minimum", () => {
    expect(codes({ maxWords: 20 })).toContain("too_long");
    expect(codes({ body: "Short note here?", minWords: 35 })).not.toContain("too_short");
    expect(codes({ body: "Short note here?", minWords: 35, aiWritten: true })).toContain(
      "too_short",
    );
    expect(codes({ kind: "invite_note", body: "x".repeat(201), maxChars: 200 })).toContain(
      "too_long",
    );
  });

  it("checks subjects on new threads only", () => {
    expect(codes({ subject: "" })).toContain("subject_missing");
    expect(codes({ subject: "one two three four five six seven" })).toContain("subject_length");
    expect(codes({ subject: "Re: missed calls" })).toContain("subject_fake_reply");
    expect(codes({ subject: "Quick Thoughts About Growth" })).toContain("subject_case");
    expect(codes({ subject: "", mode: "reply" })).not.toContain("subject_missing");
  });

  it("holds subjects to the same 2-5 words the writing prompt asks for", () => {
    const lengthIssue = (overrides: Partial<DeterministicCheckInput>) =>
      runDeterministicChecks(input(overrides)).find((issue) => issue.code === "subject_length");
    expect(lengthIssue({ subject: "missed calls at maple grove" })).toBeUndefined();
    expect(lengthIssue({ subject: "forecast calls" })).toBeUndefined();
    expect(lengthIssue({ subject: "missed calls at the maple grove" })).toMatchObject({
      severity: "error",
      message: "Subject has 6 words; keep it to 2-5 words.",
    });
    // An AI-written one-word subject is revised; a subject you wrote yourself is only flagged.
    expect(lengthIssue({ subject: "hello", aiWritten: true })).toMatchObject({ severity: "error" });
    const own = runDeterministicChecks(input({ subject: "hello" }));
    expect(own.find((issue) => issue.code === "subject_length")?.severity).toBe("warning");
    expect(hasErrors(own)).toBe(false);

    const range = `${SUBJECT_MIN_WORDS}-${SUBJECT_MAX_WORDS} words`;
    expect(range).toBe("2-5 words");
    expect(writeEmailOutput.shape.subject.description).toContain(range);
    expect(writeEmailPrompt.system({} as WritingVars)).toContain(`Subjects: ${range}`);
  });

  it("does not read German noun capitals as headline case", () => {
    expect(codes({ subject: "kurze Frage zu Brightline", language: "de" })).not.toContain(
      "subject_case",
    );
    expect(codes({ subject: "Eine Idee für Brightline", language: "de-AT" })).not.toContain(
      "subject_case",
    );
    expect(codes({ subject: "Quick Thoughts About Growth", language: "en" })).toContain(
      "subject_case",
    );
  });

  it("flags banned phrases, including workspace rules", () => {
    expect(codes({ body: "Do you have 15 minutes this week?" })).toContain("banned_phrase");
    expect(
      codes({ body: "Quick question about the new location?", extraPhrases: ["quick question"] }),
    ).toContain("banned_phrase");
  });

  it("flags unresolved variables, slots and placeholders", () => {
    expect(codes({ body: "Hi {{first_name}}, a note?" })).toContain("unresolved_variable");
    expect(codes({ body: "Hi Dana, [[ai: hook]] ok?" })).toContain("unresolved_variable");
    expect(codes({ body: "Hi Dana, how is [Company] doing?" })).toContain("placeholder");
  });

  it("limits links (none in a first touch by default)", () => {
    expect(codes({ body: "See https://example.com/demo for more?" })).toContain("links");
    expect(
      codes({ body: "See https://example.com/demo for more?", linksAllowed: 1 }),
    ).not.toContain("links");
  });

  it("flags punctuation and style problems", () => {
    expect(codes({ body: "Great news!" })).toContain("exclamation");
    expect(codes({ body: "One? Two?" })).toContain("multiple_questions");
    expect(codes({ body: `We can help ${LONG_DASH} fast.` })).toContain("long_dash");
    expect(codes({ body: `Nice work ${ROCKET} there.` })).toContain("emoji");
    const multiple = runDeterministicChecks(input({ body: "One? Two?", firstTouch: false }));
    expect(multiple.find((issue) => issue.code === "multiple_questions")?.severity).toBe("warning");
  });

  it("rejects numbers not found in the evidence for AI drafts", () => {
    const body = "Groups like yours cut missed calls by 38% in a month. Worth a look?";
    expect(
      codes({ body, aiWritten: true, evidenceText: "Harbor cut missed calls by 38 %" }),
    ).not.toContain("unsupported_number");
    expect(codes({ body, aiWritten: true, evidenceText: "No numbers here" })).toContain(
      "unsupported_number",
    );
  });

  it("requires facts to cite a provided source and signals to be provided", () => {
    const issues = runDeterministicChecks(
      input({
        facts: [
          { text: "Opened in Austin", source: "https://news.example.com/austin" },
          { text: "Raised money", source: "" },
          { text: "Hiring", source: "https://made-up.example.org" },
        ],
        allowedSources: new Set(["https://news.example.com/austin", "record"]),
        signalsUsed: ["sig_known", "sig_invented"],
        allowedSignalIds: new Set(["sig_known"]),
      }),
    );
    expect(issues.map((issue) => issue.code)).toEqual([
      "unsourced_fact",
      "unknown_source",
      "unknown_signal",
    ]);
    expect(hasErrors(issues)).toBe(true);
  });
});

describe("helpers", () => {
  it("counts words and sanitizes long dashes", () => {
    expect(countWords("Hi Dana , - two words?")).toBe(4);
    expect(sanitizeDraft(`Fast ${LONG_DASH} and simple${LONG_DASH}ish  `)).toBe(
      "Fast, and simple-ish",
    );
  });
});
