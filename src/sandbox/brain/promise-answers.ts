/**
 * Sandbox answer for inbox.reply.promises: finds "I'll send ..." style commitments in our own
 * sent reply with simple patterns and resolves a few relative dates against the send date, so
 * sandbox workspaces get promise tasks without a model.
 */
import {
  MAX_PROMISES,
  type PromisesOutput,
  type PromisesVars,
} from "../../modules/inbox/prompts/promises.js";
import { firstIsoDate } from "./text.js";

const DAY_MS = 86_400_000;
const MAX_WORDS = 15;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** "I'll send ...", "we will share ...", "let me put together ...": our own commitments. */
const COMMITMENT =
  /\b(?:i['’]ll|i will|we['’]ll|we will|let me)\s+(send|share|forward|follow up|introduce|call|put together|prepare|check)\b([^.!?\n]{0,140})/gi;

function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function weekdayOf(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay();
}

/** Days until the next given weekday, strictly after the send date. */
function daysUntil(from: string, weekday: number): number {
  return (weekday - weekdayOf(from) + 7) % 7 || 7;
}

/** The promised day in a phrase, resolved against the send date; null when none is given. */
export function resolvePromiseDate(phrase: string, sentOn: string): string | null {
  const text = phrase.toLowerCase();
  const iso = firstIsoDate(text);
  if (iso) return iso;
  if (/\b(later )?today\b|\bthis afternoon\b/.test(text)) return sentOn;
  if (/\btomorrow\b/.test(text)) return addDays(sentOn, 1);
  if (/\bend of (the |this )?week\b/.test(text)) {
    return addDays(sentOn, (5 - weekdayOf(sentOn) + 7) % 7);
  }
  if (/\bnext week\b/.test(text)) return addDays(sentOn, daysUntil(sentOn, 1));
  for (const [index, name] of WEEKDAYS.entries()) {
    if (new RegExp(`\\b${name}\\b`).test(text)) return addDays(sentOn, daysUntil(sentOn, index));
  }
  return null;
}

function taskText(verb: string, rest: string): string {
  const words = `${verb} ${rest}`
    .replace(/\s+/g, " ")
    .replace(/[,;:]+$/, "")
    .trim()
    .split(" ")
    .slice(0, MAX_WORDS)
    .join(" ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

export function buildPromisesAnswer(vars: PromisesVars, _call: unknown): PromisesOutput {
  const promises: PromisesOutput["promises"] = [];
  for (const match of vars.text.matchAll(COMMITMENT)) {
    const verb = (match[1] ?? "").toLowerCase();
    const rest = (match[2] ?? "").trim();
    if (!rest && verb !== "call" && verb !== "follow up") continue;
    promises.push({ text: taskText(verb, rest), due: resolvePromiseDate(rest, vars.sentOn) });
    if (promises.length >= MAX_PROMISES) break;
  }
  return { promises };
}
