import { describe, expect, it } from "vitest";
import { wrapUntrusted } from "../../brain/prompt.js";
import {
  countWords,
  hasErrors,
  runDeterministicChecks,
} from "../../modules/campaigns/writing/checks.js";
import {
  type CheckVars,
  checkOutput,
  type FillSlotsVars,
  fillSlotsOutput,
  type TeachVars,
  teachOutput,
  type WritingVars,
  writeEmailOutput,
  writeLinkedInOutput,
} from "../../modules/campaigns/writing/prompts.js";
import { extractSlots, fillSlots, renderTemplate } from "../../modules/campaigns/writing/render.js";
import type { FakeBrainCall } from "../../providers/brain/fake.js";
import {
  buildEmailCheckAnswer,
  buildFillSlotsAnswer,
  buildTeachAnswer,
  buildWriteEmailAnswer,
  buildWriteLinkedInAnswer,
} from "./writing-answers.js";

function call(promptId: string): FakeBrainCall {
  return { promptId, system: "", user: "", model: "fake-standard", tier: "standard", attempt: 1 };
}

function prospect(name: string, title: string, company: string): string {
  return wrapUntrusted(
    "prospect record",
    [`Name: ${name}`, `Title: ${title}`, `Company: ${company}`].join("\n"),
  );
}

function signals(entries: Array<{ id: string; type: string; title: string }>): string | null {
  if (entries.length === 0) return null;
  return wrapUntrusted(
    "signals",
    entries.map((s) => `id: ${s.id}; type: ${s.type}; title: ${s.title}; age_days: 3`).join("\n"),
  );
}

function baseVars(overrides: Partial<WritingVars> = {}): WritingVars {
  return {
    channel: "email",
    kind: "email",
    language: "en",
    first_touch: true,
    mode: "new_thread",
    max_words: 80,
    max_chars: null,
    links_allowed: 0,
    goal: "book short calls with operations leaders",
    instructions: ["Keep it short."],
    rules: [],
    sender: { name: "Sam Rivera", company: "Acme Robotics" },
    grounding: "We help operations teams cut manual forecasting work.",
    prospect: prospect("Dana Reyes", "Operations Lead", "Northwind Logistics"),
    brief: null,
    signals: signals([{ id: "sig_1", type: "hiring_relevant_roles", title: "Hiring an ops lead" }]),
    history: null,
    lead_context: null,
    post: null,
    revision: null,
    ...overrides,
  };
}

function checkEmail(vars: WritingVars, output: ReturnType<typeof buildWriteEmailAnswer>) {
  const issues = runDeterministicChecks({
    kind: "email",
    subject: output.subject,
    body: output.body,
    firstTouch: vars.first_touch,
    mode: vars.mode,
    maxWords: vars.max_words,
    minWords: vars.first_touch ? 35 : null,
    maxChars: vars.max_chars,
    linksAllowed: vars.links_allowed,
    extraPhrases: [],
    aiWritten: true,
    facts: output.facts_used,
    allowedSources: new Set(["record"]),
    signalsUsed: output.signals_used,
    allowedSignalIds: new Set(["sig_1"]),
    evidenceText: vars.grounding,
  });
  expect(hasErrors(issues)).toBe(false);
  return issues;
}

describe("buildWriteEmailAnswer", () => {
  it("passes the deterministic checks for a first-touch email, with a signal", () => {
    const vars = baseVars({ max_words: 90 });
    const output = writeEmailOutput.parse(
      buildWriteEmailAnswer(vars, call("campaign.email.write")),
    );
    checkEmail(vars, output);
    expect(countWords(output.body)).toBeGreaterThanOrEqual(35);
    expect(output.body).toContain("Dana");
    expect(output.body).toContain("Northwind");
    // Signal phrases are -ing forms: "Northwind has been hiring ...", never "Northwind hiring ...".
    expect(output.body).toMatch(/Northwind has been [a-z]+ing /);
    expect(output.signals_used).toEqual(["sig_1"]);
    expect(output.facts_used).toEqual([]);
  });

  it("passes the deterministic checks for a first touch with no active signal", () => {
    const vars = baseVars({ max_words: 70, signals: null });
    const output = writeEmailOutput.parse(
      buildWriteEmailAnswer(vars, call("campaign.email.write")),
    );
    checkEmail(vars, output);
    expect(countWords(output.body)).toBeGreaterThanOrEqual(35);
    expect(output.signals_used).toEqual([]);
  });

  it("passes the deterministic checks for every known first-touch max_words", () => {
    for (const maxWords of [70, 80, 90]) {
      const vars = baseVars({ max_words: maxWords });
      const output = writeEmailOutput.parse(
        buildWriteEmailAnswer(vars, call("campaign.email.write")),
      );
      checkEmail(vars, output);
      expect(countWords(output.body)).toBeLessThanOrEqual(maxWords);
    }
  });

  it("passes the deterministic checks for a follow-up (reply mode, no minimum)", () => {
    for (const maxWords of [30, 40, 50, 60]) {
      const vars = baseVars({ first_touch: false, mode: "reply", max_words: maxWords });
      const output = writeEmailOutput.parse(
        buildWriteEmailAnswer(vars, call("campaign.email.write")),
      );
      const issues = runDeterministicChecks({
        kind: "email",
        subject: output.subject,
        body: output.body,
        firstTouch: false,
        mode: "reply",
        maxWords,
        minWords: null,
        maxChars: null,
        linksAllowed: 1,
        extraPhrases: [],
        aiWritten: true,
        facts: output.facts_used,
        allowedSources: new Set(["record"]),
        signalsUsed: output.signals_used,
        allowedSignalIds: new Set(["sig_1"]),
        evidenceText: vars.grounding,
      });
      expect(hasErrors(issues)).toBe(false);
    }
  });

  it("writes a short German body without falling back to English", () => {
    const vars = baseVars({ language: "de" });
    const output = writeEmailOutput.parse(
      buildWriteEmailAnswer(vars, call("campaign.email.write")),
    );
    checkEmail(vars, output);
    expect(output.body).toMatch(/[äöüß]|Blick|für/i);
    expect(output.subject).toMatch(/^(kurze Frage zu|eine Idee für|kurze Idee)/);
  });

  it("is deterministic for the same vars and call", () => {
    const vars = baseVars();
    const first = buildWriteEmailAnswer(vars, call("campaign.email.write"));
    const second = buildWriteEmailAnswer(vars, call("campaign.email.write"));
    expect(second).toEqual(first);
  });

  it("varies wording across different leads", () => {
    const bodies = new Set<string>();
    const companies = [
      "Northwind Logistics",
      "Brightsmile Dental",
      "Acme Robotics",
      "Vantage Freight",
    ];
    for (const company of companies) {
      const vars = baseVars({ prospect: prospect("Alex Kim", "Owner", company) });
      bodies.add(buildWriteEmailAnswer(vars, call("campaign.email.write")).body);
    }
    expect(bodies.size).toBeGreaterThan(1);
  });

  it("never contains an em dash", () => {
    const vars = baseVars();
    const output = buildWriteEmailAnswer(vars, call("campaign.email.write"));
    expect(output.body).not.toContain(String.fromCharCode(0x2014));
    expect(output.subject).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("buildWriteLinkedInAnswer", () => {
  it("keeps the invite note within the character limit and passes schema", () => {
    const vars = baseVars({
      channel: "linkedin",
      kind: "invite_note",
      max_words: null,
      max_chars: 200,
    });
    const output = writeLinkedInOutput.parse(
      buildWriteLinkedInAnswer(vars, call("campaign.linkedin.write")),
    );
    expect(output.text.length).toBeLessThanOrEqual(200);
    expect(output.text).not.toContain("?");
  });

  it("keeps a connection message under 60 words", () => {
    const vars = baseVars({ channel: "linkedin", kind: "message", max_words: 60 });
    const output = writeLinkedInOutput.parse(
      buildWriteLinkedInAnswer(vars, call("campaign.linkedin.write")),
    );
    expect(countWords(output.text)).toBeLessThanOrEqual(60);
  });

  it("keeps a comment between 20 and 60 words, with no link or tagging", () => {
    const vars = baseVars({
      channel: "linkedin",
      kind: "comment",
      max_words: 60,
      first_touch: false,
    });
    const output = writeLinkedInOutput.parse(
      buildWriteLinkedInAnswer(vars, call("campaign.linkedin.write")),
    );
    const words = countWords(output.text);
    expect(words).toBeGreaterThanOrEqual(20);
    expect(words).toBeLessThanOrEqual(60);
    expect(output.text).not.toContain("http");
    expect(output.text).not.toContain("@");
  });
});

describe("buildFillSlotsAnswer", () => {
  it("fills every slot and the reconstituted template passes the deterministic checks", () => {
    const raw =
      "Hi {{first_name}},\n\n[[ai: Reference {{company}} recently hiring for an operations or supply chain role, and introduce forecast accuracy as the fix for stockouts and overstock. Two short sentences.]]\n\nWorth a quick look?";
    // The real pipeline resolves {{variables}} before extracting [[ai: ...]] slots
    // (src/modules/campaigns/writing/pipeline.ts writeDraft()); mirror that order here.
    const template = renderTemplate(raw, {
      first_name: "Dana",
      company: "Northwind Logistics",
    }).text;
    const vars: FillSlotsVars = {
      ...baseVars({ max_words: 90 }),
      template,
      slots: extractSlots(template),
    };
    const output = fillSlotsOutput.parse(
      buildFillSlotsAnswer(vars, call("campaign.email.fill_slots")),
    );
    expect(output.values).toHaveLength(vars.slots.length);
    expect(output.values.every((v) => v.missing === false)).toBe(true);
    // fillSlots() re-matches the original [[ai: ...]] markers; numberSlots() output is only
    // ever shown to the brain in the prompt (see FillSlotsVars.template), never fed back in.
    const filled = fillSlots(template, new Map(output.values.map((v) => [v.index, v.text])));
    const issues = runDeterministicChecks({
      kind: "email",
      subject: "quick idea",
      body: filled,
      firstTouch: true,
      mode: "new_thread",
      maxWords: 200,
      minWords: 35,
      maxChars: null,
      linksAllowed: 0,
      extraPhrases: [],
      aiWritten: true,
      allowedSources: new Set(),
      allowedSignalIds: new Set(["sig_1"]),
      evidenceText: vars.grounding,
    });
    expect(hasErrors(issues)).toBe(false);
  });

  it("returns as many values as there are slots even with an unfamiliar instruction", () => {
    const template = "[[ai: Say something encouraging about their recent expansion.]]";
    const vars: FillSlotsVars = {
      ...baseVars(),
      template,
      slots: extractSlots(template),
    };
    const output = buildFillSlotsAnswer(vars, call("campaign.email.fill_slots"));
    expect(output.values).toHaveLength(1);
    expect(output.values[0]?.text.length).toBeGreaterThan(0);
  });
});

describe("buildEmailCheckAnswer", () => {
  const vars: CheckVars = {
    channel: "email",
    kind: "email",
    first_touch: true,
    language: "en",
    max_words: 80,
    subject: "quick idea",
    body: "Body text.",
    grounding: "",
    evidence: "",
    rules: [],
    deterministic_issues: [],
  };

  it("passes with high confidence when there are no deterministic issues", () => {
    const output = checkOutput.parse(buildEmailCheckAnswer(vars, call("campaign.email.check")));
    expect(output.verdict).toBe("pass");
    expect(output.confidence).toBeGreaterThan(0.7);
  });

  it("asks for a revision when a deterministic issue was found", () => {
    const output = checkOutput.parse(
      buildEmailCheckAnswer(
        { ...vars, deterministic_issues: ["too_long: Body has 120 words; the limit is 80."] },
        call("campaign.email.check"),
      ),
    );
    expect(output.verdict).toBe("revise");
  });
});

describe("buildTeachAnswer", () => {
  it("derives one rule per corrected note", () => {
    const vars: TeachVars = {
      existing_rules: [],
      corrections: [
        { original: "Hi!", corrected: "Hi.", note: "Never use exclamation marks." },
        { original: null, corrected: null, note: null },
      ],
    };
    const output = teachOutput.parse(buildTeachAnswer(vars, call("campaign.teach")));
    expect(output.rules).toHaveLength(1);
    expect(output.rules[0]).toContain("exclamation marks");
  });

  it("skips a note that repeats an existing rule", () => {
    const vars: TeachVars = {
      existing_rules: ["Keep in mind: never use exclamation marks."],
      corrections: [{ original: "Hi!", corrected: "Hi.", note: "never use exclamation marks." }],
    };
    const output = buildTeachAnswer(vars, call("campaign.teach"));
    expect(output.rules).toHaveLength(0);
  });
});
