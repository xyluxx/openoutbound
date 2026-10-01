import { describe, expect, it } from "vitest";
import { detectPrivacyRequest, inferPrivacyKind } from "./privacy-phrases.js";

describe("detectPrivacyRequest", () => {
  it.each([
    "Please delete my data.",
    "Delete all my personal data you have.",
    "Erase my details from your systems, thank you.",
    "Please remove my data from your database.",
    "Kindly delete my email address and never write again.",
    "Delete all the personal data you hold about me.",
    "Please delete everything you have on me.",
    "Delete me from your database.",
    "I am exercising my right to be forgotten.",
    "Under GDPR I invoke my right to erasure.",
    "Unsubscribe me and delete my data",
    "Stop emailing me. And remove my details from your records.",
    "This is a formal GDPR deletion request.",
    "Löschen Sie bitte alle meine Daten.",
    "Bitte meine Daten umgehend löschen.",
    "Ich bestehe auf Löschung meiner personenbezogenen Daten.",
    "Ich mache mein Recht auf Löschung geltend.",
    "Loeschen Sie meine Kontaktdaten.",
  ])("asks for deletion: %j", (text) => {
    expect(detectPrivacyRequest(text)).toBe("delete");
  });

  it.each([
    "What data do you have on me?",
    "What personal information does your company hold about me?",
    "Please send me a copy of my data.",
    "Send a copy of the data you hold about me.",
    "This is a data subject access request.",
    "I am making a subject access request under GDPR.",
    "Welche Daten haben Sie über mich gespeichert?",
    "Ich bitte um Auskunft über meine gespeicherten Daten.",
  ])("asks what we hold: %j", (text) => {
    expect(detectPrivacyRequest(text)).toBe("access");
  });

  it.each([
    "Where did you get my email?",
    "Where did you get my email address from?",
    "where did you find my contact details",
    "How did you get my details?",
    "Where do you have my number from?",
    "Where did you get this email address? Remove me.",
    "Woher haben Sie meine E-Mail-Adresse?",
    "Wie sind Sie an meine Daten gekommen?",
  ])("asks where we got their details: %j", (text) => {
    expect(detectPrivacyRequest(text)).toBe("source");
  });

  it("prefers delete, then access, then source when a reply asks several things", () => {
    expect(
      detectPrivacyRequest("Where did you get my email? What data do you have on me? Delete it."),
    ).toBe("access");
    expect(detectPrivacyRequest("Where did you get my email address? Please delete my data.")).toBe(
      "delete",
    );
  });

  it("treats a declared request without a kind as delete or source", () => {
    expect(detectPrivacyRequest("Consider this email a GDPR request.")).toBe("source");
    expect(detectPrivacyRequest("This is a GDPR request: remove everything.")).toBe("delete");
    expect(detectPrivacyRequest("I want to know my rights under GDPR.")).toBe("source");
  });

  it.each([
    // Plain opt-outs stay unsubscribes.
    "Remove me",
    "Please remove me from your mailing list.",
    "Remove me from your database.",
    "Stop emailing me.",
    "Unsubscribe",
    "Bitte austragen",
    // Questions and statements that are not requests about their own data.
    "Is your tool GDPR compliant?",
    "We need a GDPR-compliant DPA before we can proceed.",
    "Do you support the right to be forgotten for our customers?",
    "What data do you need from us to get started?",
    "What data do you store, and where is it hosted?",
    "Can I delete my data later if we cancel?",
    "If we sign up, how do I remove my data at the end?",
    "Please don't delete my data, I still want the newsletter.",
    "I do not want you to delete my details yet.",
    "Can you send me a copy of the data sheet?",
    "How did you even get my address? Leave me alone.",
    "Where did you get the idea for this product?",
    "Kann ich meine Daten später löschen?",
    "Bitte meine Daten nicht löschen.",
    "",
  ])("ignores %j", (text) => {
    expect(detectPrivacyRequest(text)).toBeNull();
  });

  it("reads each line as its own clause", () => {
    expect(detectPrivacyRequest("Can we talk next week\nAlso delete my data")).toBe("delete");
  });
});

describe("inferPrivacyKind", () => {
  it("uses the detected kind when there is one", () => {
    expect(inferPrivacyKind("What data do you have on me?")).toBe("access");
  });

  it("falls back to delete when the text asks to remove data, else source", () => {
    expect(inferPrivacyKind("GDPR. Remove me from everything.")).toBe("delete");
    expect(inferPrivacyKind("Bitte alles löschen.")).toBe("delete");
    expect(inferPrivacyKind("GDPR!")).toBe("source");
    expect(inferPrivacyKind("")).toBe("source");
  });
});
