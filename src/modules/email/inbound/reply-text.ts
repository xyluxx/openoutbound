/** Reply text helpers: strip quoted history and signatures, detect unsubscribe requests. */

const QUOTE_HEADERS = [
  /^on .{3,200}\bwrote:\s*$/i,
  /^on .{3,200}$/i, // "On Mon, ... <x@y>" when "wrote:" wraps to the next line
  /^am .{3,200}\bschrieb .{0,200}:\s*$/i,
  /^le .{3,200}\ba (é|e)crit\s*:\s*$/i,
  /^el .{3,200}\bescribi(ó|o):\s*$/i,
  /^-{2,}\s*(original message|ursprüngliche nachricht|message d'origine|mensaje original)\s*-{2,}/i,
  /^_{8,}\s*$/,
  /^(from|von|de|sent|gesendet|envoyé|enviado)\s*:\s.+/i,
];

/** The new part of a reply: text before quoted history, without `>` lines or the signature. */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === "--" || line === "-- ") break;
    if (/^(sent from my|gesendet von meinem|envoyé de mon|enviado desde mi)\b/i.test(line)) break;
    const next = (lines[i + 1] ?? "").trim();
    const isHeader = QUOTE_HEADERS.some((pattern, index) =>
      index === 1 ? pattern.test(line) && /^wrote:\s*$/i.test(next) : pattern.test(line),
    );
    if (isHeader) break;
    if (line.startsWith(">")) continue;
    kept.push(lines[i] ?? "");
  }
  return kept.join("\n").trim();
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const POLITENESS =
  /\b(please|pls|thanks|thank you|thx|bitte|danke|merci|svp|s'il vous plait|por favor|gracias)\b/g;

/** Whole-message requests (after removing politeness words). */
const EXACT = new Set([
  "stop",
  "stop it",
  "stop emailing",
  "stop emailing me",
  "stop emails",
  "stop sending",
  "stop sending emails",
  "remove",
  "remove me",
  "unsubscribe",
  "unsubscribe me",
  "unsub",
  "opt out",
  "optout",
  "abmelden",
  "austragen",
  "entfernen",
  "desabonner",
  "desinscrire",
  "retirer",
  "baja",
  "de baja",
  "darme de baja",
]);

/** Phrases that mean "unsubscribe" wherever they appear in a short reply. */
const PHRASES = [
  "unsubscribe",
  "remove me",
  "take me off",
  "opt out",
  "opt me out",
  "do not contact",
  "don't contact",
  "dont contact",
  "do not email",
  "don't email",
  "no more emails",
  "stop emailing",
  "stop sending",
  "abmelden",
  "abbestellen",
  "austragen",
  "keine weiteren e mails",
  "keine e mails mehr",
  "keine emails mehr",
  "desabonner",
  "desinscrire",
  "ne plus recevoir",
  "darse de baja",
  "darme de baja",
  "dar de baja",
  "no me escriban",
];

/**
 * True for short replies that ask to stop ("unsubscribe", "remove me", "stop", "bitte
 * austragen") or a mailto unsubscribe (subject "unsubscribe"). Long messages never count, so a
 * question that happens to contain "stop" is left to the reply classifier.
 */
export function isUnsubscribeRequest(subject: string, text: string): boolean {
  const body = normalize(stripQuotedReply(text));
  const words = body ? body.split(" ").length : 0;
  const subjectText = normalize(subject.replace(/^\s*((re|aw|sv|fw|fwd|wg)\s*:\s*)+/i, ""));
  if (EXACT.has(subjectText.replace(POLITENESS, "").trim()) && words <= 12) return true;
  if (words === 0 || words > 12) return false;
  const core = body.replace(POLITENESS, "").replace(/\s+/g, " ").trim();
  if (EXACT.has(core)) return true;
  const padded = ` ${body} `;
  return PHRASES.some((phrase) => padded.includes(` ${phrase} `));
}
