import { describe, expect, it } from "vitest";
import { namesMeetingTime } from "./time-mentions.js";

describe("namesMeetingTime", () => {
  it("finds day names, relative days, dates and clock times", () => {
    for (const text of [
      "Tuesday could work, grab it here.",
      "How about tuesdays?",
      "Does Thu. suit you?",
      "Let's talk tomorrow.",
      "Can we do today?",
      "Sure, 10:00 works.",
      "What about 3pm?",
      "3 p.m. is fine",
      "Say 15 Uhr?",
      "On se voit à 15h30 ?",
      "See you at noon.",
      "Around 4 o'clock.",
      "Shall we meet at 3 then",
      "Could we do it at 4?",
      "The 8th is open.",
      "Oct 8 could work.",
      "8 October works for me.",
      "Am 8. Oktober?",
      "El 8 de octubre.",
      "On 2026-10-08.",
      "Maybe 8/10?",
      "Wie wäre Dienstagnachmittag?",
      "Morgen passt gut.",
      "Mardi ou mercredi ?",
      "¿El miércoles?",
      "Mañana a las 3.",
      "Va bene lunedì?",
      "Kan het donderdag?",
      "Pode ser na segunda-feira?",
    ]) {
      expect(namesMeetingTime(text), text).toBe(true);
    }
  });

  it("finds phrases that settle a meeting", () => {
    for (const text of [
      "Great, see you then.",
      "I'll send an invite for it.",
      "The calendar invitation is on its way.",
      "Talk then!",
      "I have pencilled you in.",
      "Bis dann!",
      "Ich schicke eine Einladung.",
      "Nos vemos pronto.",
    ]) {
      expect(namesMeetingTime(text), text).toBe(true);
    }
  });

  it("leaves replies that only point to the booking link alone", () => {
    for (const text of [
      "Happy to find a time. Grab the slot that suits you here so it lands on both calendars: https://calendly.com/helix-example/30min?utm_content=bk0123456789&utm_source=openoutbound",
      "Thanks for getting back to me. Pick any open slot in this calendar: https://cal.com/helix-example/2026-10-08",
      "Sorry the link gave you trouble. Could you try it once more? https://calendly.com/helix-example/intro",
      "Guten Morgen Dana, hier ist mein Kalender: https://calendly.com/helix-example/intro",
      "Voici mon agenda, choisissez le créneau qui vous convient.",
      "A short 20 minute call would be great, pick what suits you.",
      "We were satisfied with the sunny results of the wedding campaign.",
      "It covers 3 locations and takes 30 minutes to set up.",
      "Pricing starts at 49 EUR per location. Want a quick walkthrough?",
      "We start at 3 locations, then grow.",
    ]) {
      expect(namesMeetingTime(text), text).toBe(false);
    }
  });
});
