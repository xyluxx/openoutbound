import { describe, expect, it } from "vitest";
import {
  type CheckVars as ReplyCheckVars,
  checkOutputSchema as replyCheckOutputSchema,
} from "../../modules/inbox/prompts/check.js";
import { classifyOutputSchema } from "../../modules/inbox/prompts/classify.js";
import { type DraftVars, draftOutputSchema } from "../../modules/inbox/prompts/draft.js";
import {
  buildReplyBody,
  buildReplySubject,
  PROMPT_INJECTION_TEXT,
  type ReplyVars,
} from "../simulator/content.js";
import { buildClassifyAnswer, buildDraftAnswer, buildReplyCheckAnswer } from "./inbox-answers.js";

const replyVars: ReplyVars = {
  prospectFirstName: "Dana",
  senderName: "Sam",
  originalSubject: "quick question for Northwind",
  returnDate: "2026-10-05",
};

function classify(reply: string, subject: string, automated = false) {
  return buildClassifyAnswer(
    {
      company: "Acme Robotics",
      channel: "email",
      today: "2026-09-27",
      automated,
      ourLastMessage: null,
      subject,
      reply,
    },
    { promptId: "inbox.reply.classify" },
  );
}

describe("buildClassifyAnswer against the simulator's own reply texts", () => {
  const subject = buildReplySubject(replyVars.originalSubject, "en");

  it("classifies an interested reply", () => {
    const body = buildReplyBody("interested", replyVars, "en");
    const output = classifyOutputSchema.parse(classify(body, subject));
    expect(output.category).toBe("interested");
    expect(output.sentiment).toBe("positive");
    expect(output.suspicious).toBe(false);
  });

  it("classifies a question reply", () => {
    const body = buildReplyBody("question", replyVars, "en");
    const output = classifyOutputSchema.parse(classify(body, subject));
    expect(output.category).toBe("question");
  });

  it("classifies a not_now reply", () => {
    const body = buildReplyBody("not_now", replyVars, "en");
    const output = classifyOutputSchema.parse(classify(body, subject));
    expect(output.category).toBe("not_now");
  });

  it("classifies an objection reply", () => {
    const body = buildReplyBody("objection", replyVars, "en");
    const output = classifyOutputSchema.parse(classify(body, subject));
    expect(output.category).toBe("objection");
  });

  it("classifies a referral reply", () => {
    const body = buildReplyBody("referral", replyVars, "en");
    const output = classifyOutputSchema.parse(classify(body, subject));
    expect(output.category).toBe("referral");
  });

  it("classifies an out_of_office reply and extracts the return date", () => {
    const body = buildReplyBody("out_of_office", replyVars, "en");
    const output = classifyOutputSchema.parse(classify(body, subject, true));
    expect(output.category).toBe("out_of_office");
    expect(output.return_date).toBe("2026-10-05");
  });

  it("classifies an unsubscribe reply", () => {
    const body = buildReplyBody("unsubscribe", replyVars, "en");
    const output = classifyOutputSchema.parse(classify(body, subject));
    expect(output.category).toBe("unsubscribe");
    expect(output.sentiment).toBe("negative");
  });

  it("classifies a negative reply", () => {
    const body = buildReplyBody("negative", replyVars, "en");
    const output = classifyOutputSchema.parse(classify(body, subject));
    expect(output.category).toBe("negative");
  });

  it("classifies an angry reply as negative", () => {
    const body = buildReplyBody("angry", replyVars, "en");
    const output = classifyOutputSchema.parse(classify(body, subject));
    expect(output.category).toBe("negative");
  });

  it("flags the prompt-injection reply as suspicious", () => {
    const output = classifyOutputSchema.parse(classify(PROMPT_INJECTION_TEXT, subject));
    expect(output.suspicious).toBe(true);
    expect(output.summary.toLowerCase()).not.toContain("api key");
  });

  it("classifies a German out-of-office reply too", () => {
    const body = buildReplyBody("out_of_office", replyVars, "de");
    const output = classifyOutputSchema.parse(classify(body, "AW: quick question", true));
    expect(output.category).toBe("out_of_office");
    expect(output.language).toBe("de");
  });
});

describe("buildClassifyAnswer for privacy requests, proposed times and facts", () => {
  it.each([
    ["Please delete my data from your systems.", "delete"],
    ["Erase everything you store about me, thanks.", "delete"],
    ["What data do you have about me?", "access"],
    ["Where did you get my email address?", "source"],
    ["Where did you get my details from?", "source"],
    ["Where did you get my address?", "source"],
    ["This is a GDPR request.", "delete"],
  ])("detects a privacy request: %s", (text, kind) => {
    const output = classifyOutputSchema.parse(classify(text, "Re: quick question"));
    expect(output.category).toBe("privacy_request");
    expect(output.privacy_kind).toBe(kind);
  });

  it("keeps a plain unsubscribe an unsubscribe", () => {
    const output = classifyOutputSchema.parse(
      classify("Please remove me from your list.", "Re: hi"),
    );
    expect(output.category).toBe("unsubscribe");
    expect(output.privacy_kind).toBeNull();
  });

  it("treats an unsubscribe that asks for deletion as a privacy request", () => {
    const output = classify("Unsubscribe me and delete my data.", "Re: hi");
    expect(output).toMatchObject({ category: "privacy_request", privacy_kind: "delete" });
  });

  it.each([
    ["Tuesday at 3pm works for me.", "Tuesday at 3pm"],
    ["How about Oct 8, 10:00?", "Oct 8, 10:00"],
    ["I could do October 8th at 9:30am.", "October 8th at 9:30am"],
    ["Friday 14:30 would be great.", "Friday 14:30"],
  ])("reads a proposed time: %s", (text, proposed) => {
    const output = classifyOutputSchema.parse(classify(text, "Re: quick question"));
    expect(output.proposed_time).toEqual({ text: proposed, start: null, timezone: null });
  });

  it("finds no proposed time without a day and a time", () => {
    expect(classify("Tuesday works for me.", "Re: hi").proposed_time).toBeNull();
    expect(classify("I am free at 3pm most days.", "Re: hi").proposed_time).toBeNull();
    expect(classify("We may talk again in 2027.", "Re: hi").proposed_time).toBeNull();
  });

  it("never returns facts or a company hold", () => {
    const output = classify("We signed with a competitor until March 2027.", "Re: hi");
    expect(output.facts).toEqual([]);
    expect(output.company_hold).toBeNull();
    expect(output.privacy_kind).toBeNull();
  });
});

describe("buildDraftAnswer", () => {
  const base: DraftVars = {
    senderName: "Sam",
    company: "Acme Robotics",
    language: "en",
    category: "interested",
    prospect: "Name: Dana Reyes",
    whatWeKnow: null,
    grounding: "",
    bookingUrl: null,
    bookingMode: "link",
    proposedTime: null,
    thread: [{ from: "them", subject: null, text: "This looks relevant, tell me more." }],
    instruction: null,
    toneNotes: "",
    rules: [],
    maxWords: 60,
    revision: null,
  };

  it("keeps the thread subject (returns null) and never invents facts", () => {
    const output = draftOutputSchema.parse(buildDraftAnswer(base, {}));
    expect(output.subject).toBeNull();
    expect(output.used_fact_ids).toEqual([]);
    expect(output.body.length).toBeGreaterThan(0);
  });

  it("offers the booking link when one is given", () => {
    const output = buildDraftAnswer({ ...base, bookingUrl: "https://cal.example/sam" }, {});
    expect(output.body).toContain("https://cal.example/sam");
  });

  it("never confirms a proposed time: the link in link mode, a later confirmation otherwise", () => {
    const proposed = { ...base, category: "meeting_request", proposedTime: "Tuesday at 3pm" };
    const withLink = buildDraftAnswer({ ...proposed, bookingUrl: "https://cal.example/sam" }, {});
    expect(withLink.body).toContain("https://cal.example/sam");
    expect(withLink.body).toMatch(/could work/);
    const handoff = buildDraftAnswer({ ...proposed, bookingMode: "handoff" }, {});
    expect(handoff.body).toContain("confirm a time with you shortly");
    expect(handoff.body).not.toMatch(/https?:/);
    const noLink = buildDraftAnswer({ ...base, category: "meeting_request" }, {});
    expect(noLink.body).toContain("confirm one with you shortly");
    for (const output of [withLink, handoff, noLink]) {
      expect(
        buildReplyCheckAnswer(
          {
            category: "meeting_request",
            language: "en",
            prospectMessage: "Tuesday at 3pm?",
            grounding: "",
            bookingUrl: null,
            subject: null,
            body: output.body,
          },
          {},
        ).verdict,
      ).toBe("pass");
    }
  });

  it("offers no meeting and no link in off mode", () => {
    for (const category of ["interested", "meeting_request", "question"]) {
      const output = buildDraftAnswer(
        {
          ...base,
          category,
          bookingMode: "off",
          bookingUrl: "https://cal.example/sam",
          proposedTime: "Friday 10:00",
        },
        {},
      );
      expect(output.body).not.toMatch(/https?:|call|meeting/i);
    }
  });

  it("flags needs_human when the prospect asks if this is a bot", () => {
    const output = buildDraftAnswer(
      { ...base, thread: [{ from: "them", subject: null, text: "Wait, are you a bot?" }] },
      {},
    );
    expect(output.needs_human).toBe(true);
  });
});

describe("buildReplyCheckAnswer", () => {
  const vars: ReplyCheckVars = {
    category: "interested",
    language: "en",
    prospectMessage: "Tell me more.",
    grounding: "",
    bookingUrl: null,
    subject: null,
    body: "Great to hear, what does your week look like for a short call?",
  };

  it("passes a clean reply", () => {
    const output = replyCheckOutputSchema.parse(buildReplyCheckAnswer(vars, {}));
    expect(output.verdict).toBe("pass");
  });

  it("asks for a revision when the body is empty", () => {
    const output = buildReplyCheckAnswer({ ...vars, body: "" }, {});
    expect(output.verdict).toBe("revise");
  });

  it("asks for a revision when the draft confirms a meeting time", () => {
    for (const body of [
      "Tuesday at 3pm works for me, see you then.",
      "Perfect, you are booked for Friday 10:00.",
      "Great, that works for us. The invite is on its way.",
    ]) {
      const output = buildReplyCheckAnswer({ ...vars, body }, {});
      expect(output.verdict).toBe("revise");
      expect(output.issues.map((issue) => issue.code)).toContain("confirms_time");
    }
  });
});
