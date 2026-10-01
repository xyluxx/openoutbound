import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectAutoReply, extractReturnDate, isBulkMail } from "./auto-reply.js";
import { isBounce, parseBounce } from "./dsn.js";
import { parseRawEmail } from "./parse.js";
import { isUnsubscribeRequest, stripQuotedReply } from "./reply-text.js";
import { isWarmupEmail } from "./warmup.js";

const RECEIVED = new Date("2026-09-21T15:10:00Z");

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

async function parsed(name: string, withRaw = true) {
  const email = await parseRawEmail(fixture(name), "mbx_test", RECEIVED);
  if (!withRaw) delete email.raw;
  return email;
}

describe("DSN bounces", () => {
  it.each([
    ["gmail-bounce.eml", "5.1.1", "nobody@harbor.example.com", "<orig-gmail@brand.example.com>"],
    [
      "outlook-bounce.eml",
      "5.1.10",
      "ghost@bluefield.example.com",
      "<orig-outlook@brand.example.com>",
    ],
    ["postfix-bounce.eml", "5.1.1", "gone@summit.example.org", "<orig-postfix@brand.example.com>"],
  ])("parses %s as a hard bounce", async (name, status, recipient, original) => {
    const email = await parsed(name);
    expect(isBounce(email)).toBe(true);
    expect(parseBounce(email)).toMatchObject({
      action: "failed",
      status,
      bounceType: "hard",
      recipient,
      originalMessageId: original,
      senderRejection: null,
    });
  });

  it("tells rejections of the sender apart from address failures", () => {
    const blocked = parseBounce({
      from: "MAILER-DAEMON@mail.example.org",
      subject: "Undelivered Mail Returned to Sender",
      headers: {},
      text: "Final-Recipient: rfc822; dana@harbor.example.com\nAction: failed\nStatus: 5.7.1\nDiagnostic-Code: smtp; 554 5.7.1 Service unavailable; client host [192.0.2.10]\n blocked using zen.spamhaus.org\n",
    });
    expect(blocked).toMatchObject({
      status: "5.7.1",
      responseCode: 554,
      senderRejection: "rejected",
    });
    // Legacy bounce without a delivery-status part: the server's answer line decides.
    const legacy = parseBounce({
      from: "MAILER-DAEMON@mail.example.org",
      subject: "failure notice",
      headers: {},
      text: "Hi. This is the qmail-send program.\n<dana@harbor.example.com>:\n192.0.2.20 does not like recipient.\nRemote host said: 550 5.7.26 Unauthenticated email is not accepted\nGiving up on 192.0.2.20.\n",
    });
    expect(legacy).toMatchObject({ status: "5.7.26", senderRejection: "blocked" });
  });

  it("parses an Exchange NDR without a delivery-status part", async () => {
    const email = await parsed("exchange-bounce.eml");
    expect(isBounce(email)).toBe(true);
    expect(parseBounce(email)).toMatchObject({
      status: "5.1.1",
      bounceType: "hard",
      originalMessageId: "<orig-exchange@brand.example.com>",
    });
  });

  it("treats delayed notices as soft", async () => {
    const email = await parsed("postfix-delayed.eml");
    expect(isBounce(email)).toBe(true);
    expect(parseBounce(email)).toMatchObject({
      action: "delayed",
      status: "4.4.1",
      bounceType: "soft",
      recipient: "slow@cedar.example.org",
      originalMessageId: "<orig-delayed@brand.example.com>",
    });
  });

  it("still reads status and recipient from the parsed text without the raw source", async () => {
    const email = await parsed("gmail-bounce.eml", false);
    expect(parseBounce(email)).toMatchObject({
      status: "5.1.1",
      bounceType: "hard",
      recipient: "nobody@harbor.example.com",
    });
  });

  it("keeps message-too-big bounces soft: the address is fine", () => {
    for (const status of ["5.2.3", "5.3.4"]) {
      const tooBig = parseBounce({
        from: "MAILER-DAEMON@mail.example.org",
        subject: "Undelivered Mail Returned to Sender",
        headers: {},
        text: `Final-Recipient: rfc822; dana@harbor.example.com\nAction: failed\nStatus: ${status}\nDiagnostic-Code: smtp; 552 ${status} Message size exceeds fixed maximum message size\n`,
      });
      expect(tooBig, status).toMatchObject({ status, bounceType: "soft", senderRejection: null });
    }
  });

  it("keeps mailbox-full bounces soft and ignores normal replies", () => {
    const full = parseBounce({
      from: "MAILER-DAEMON@mail.example.org",
      subject: "Undelivered Mail Returned to Sender",
      headers: {},
      text: "Final-Recipient: rfc822; full@cedar.example.org\nAction: failed\nStatus: 5.2.2\n",
    });
    expect(full.bounceType).toBe("soft");
    expect(
      isBounce({
        from: "Dana <dana@harbor.example.com>",
        subject: "Re: Undeliverable?",
        headers: {},
        text: "Status: 5.1.1 is what your system said.",
      }),
    ).toBe(false);
  });
});

describe("auto-replies", () => {
  const base = { text: "", headers: {}, receivedAt: RECEIVED };

  it.each([
    [
      "Automatic reply: Quick question",
      "I am out of the office and back on October 5, 2026.",
      "2026-10-05",
    ],
    [
      "Abwesenheitsnotiz: Quick question",
      "Ich bin im Urlaub und ab dem 12.10.2026 wieder im Büro.",
      "2026-10-12",
    ],
    [
      "Réponse automatique : Quick question",
      "Je suis absent du bureau, de retour le 7 octobre.",
      "2026-10-07",
    ],
    [
      "Respuesta automática: Quick question",
      "Estoy de vacaciones hasta el 2 de octubre.",
      "2026-10-02",
    ],
  ])("detects %s with its return date", (subject, text, returnDate) => {
    const reply = detectAutoReply({ ...base, subject, text });
    expect(reply).toMatchObject({ outOfOffice: true, returnDate, signal: "subject" });
  });

  it("detects auto-reply headers", () => {
    expect(
      detectAutoReply({
        ...base,
        subject: "Re: Quick question",
        headers: { "auto-submitted": "auto-replied" },
      })?.signal,
    ).toBe("header auto-submitted");
    expect(
      detectAutoReply({ ...base, subject: "Hi", headers: { "x-autoreply": "yes" } })?.signal,
    ).toBe("header x-autoreply");
    expect(
      detectAutoReply({ ...base, subject: "Hi", headers: { precedence: "auto_reply" } })?.signal,
    ).toBe("header precedence");
    expect(
      detectAutoReply({ ...base, subject: "Re: Hi", headers: { "auto-submitted": "no" } }),
    ).toBeNull();
  });

  it("never treats a human reply that mentions a holiday as automatic", () => {
    expect(
      detectAutoReply({
        ...base,
        subject: "Re: Quick question",
        text: "I'm on holiday until Monday but this sounds interesting, call me then.",
      }),
    ).toBeNull();
  });

  it("extracts return dates only when they make sense", () => {
    expect(extractReturnDate("Back on Monday.", RECEIVED)).toBe("2026-09-28");
    expect(extractReturnDate("Out until 10/02.", RECEIVED)).toBe("2026-10-02");
    expect(extractReturnDate("Thanks for your email on Monday.", RECEIVED)).toBeNull();
    expect(extractReturnDate("I was away on 2025-01-05.", RECEIVED)).toBeNull();
    expect(extractReturnDate("No dates here.", RECEIVED)).toBeNull();
    expect(extractReturnDate("Back on January 4.", RECEIVED)).toBe("2027-01-04");
  });

  it("recognizes bulk mail", () => {
    expect(isBulkMail({ "list-id": "<news.example.com>" })).toBe(true);
    expect(isBulkMail({ precedence: "bulk" })).toBe(true);
    expect(isBulkMail({})).toBe(false);
  });
});

describe("warmup filter", () => {
  it("matches warmup headers, tags and custom patterns", () => {
    const base = { subject: "Quick sync", text: "Hello there", headers: {} };
    expect(isWarmupEmail({ ...base, headers: { "x-lemwarm": "1" } })).toBe(true);
    expect(isWarmupEmail({ ...base, headers: { "x-acme-warmup-id": "7" } })).toBe(true);
    expect(isWarmupEmail({ ...base, text: "Sent with warmbox" })).toBe(true);
    expect(isWarmupEmail({ ...base, subject: "Quick sync W7X2" }, ["w7x2"])).toBe(true);
    expect(
      isWarmupEmail({ ...base, headers: { "x-custom-tag": "a" } }, ["header:x-custom-tag"]),
    ).toBe(true);
    expect(isWarmupEmail(base, ["zzz9"])).toBe(false);
  });
});

describe("reply text", () => {
  it("keeps only the new part of a reply", () => {
    const text =
      "Sounds good, send details.\n\nOn Mon, Sep 21, 2026 at 10:00 AM Sam <sam@brand.example.com> wrote:\n> Hi Dana\n> Worth a chat?";
    expect(stripQuotedReply(text)).toBe("Sounds good, send details.");
    expect(stripQuotedReply("Yes\n-- \nDana Reyes\nHarbor Dental")).toBe("Yes");
  });

  it.each([
    ["Re: Quick question", "Unsubscribe"],
    ["Re: Quick question", "Please remove me from your list."],
    ["Re: Quick question", "stop"],
    ["Re: Quick question", "Bitte austragen, danke."],
    ["unsubscribe", ""],
  ])("detects the unsubscribe request %s / %s", (subject, text) => {
    expect(isUnsubscribeRequest(subject, text)).toBe(true);
  });

  it("leaves longer messages to the classifier", () => {
    expect(
      isUnsubscribeRequest(
        "Re: Quick question",
        "Can we stop the current vendor contract first and talk next month about moving the clinics over?",
      ),
    ).toBe(false);
    expect(isUnsubscribeRequest("Re: Quick question", "Sounds great, what does it cost?")).toBe(
      false,
    );
  });
});
