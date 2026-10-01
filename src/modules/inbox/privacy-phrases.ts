/**
 * Deterministic detection of privacy requests in a reply's own text (quoted history removed),
 * in English and German like the unsubscribe precheck: asking to delete their data, to see the
 * data we hold, or where we got their details. A request that also asks to unsubscribe is still
 * a privacy request (the privacy action does everything an unsubscribe does). Plain "remove me",
 * "remove me from your list" or "stop emailing me" is not one.
 *
 * Conservative on purpose: the phrases name the writer's own data ("my data", "about me"), and a
 * match is ignored when it is negated ("don't delete my data") or asks about the writer's own
 * abilities ("can I delete my data later?"). Legal words (GDPR, right to be forgotten) only count
 * in the first person ("my right to be forgotten") or in a declared request ("this is a GDPR
 * request"), so a compliance question such as "is your tool GDPR compliant?" stays with the model.
 */
import type { PrivacyKind } from "../../core/enums.js";

const EN_DATA_NOUNS =
  "(?:personal\\s+|contact\\s+|private\\s+)?(?:data|details|information|info|records?)";
const DE_DATA_NOUNS =
  "(?:pers(?:ö|oe)nlichen\\s+|personenbezogenen\\s+)?(?:daten|kontaktdaten|informationen|angaben)";
const EN_SOURCE_NOUNS =
  "(?:e-?mail(?:\\s+address)?|address|contact\\s+(?:details|info|information|data)|details|information|info|data|name|(?:phone\\s+)?number)";
const DE_SOURCE_NOUNS =
  "(?:e-?mail(?:-?adresse)?|adresse|daten|kontaktdaten|informationen|angaben|(?:telefon)?nummer)";

/** Erasure: delete, erase or remove the writer's data. */
const DELETE_PATTERNS: RegExp[] = [
  new RegExp(
    `\\b(?:delete|erase|wipe|purge|destroy)\\s+(?:all\\s+|any\\s+)?(?:of\\s+)?my\\s+(?:${EN_DATA_NOUNS}|e-?mail\\s+address)\\b`,
  ),
  new RegExp(`\\bremove\\s+(?:all\\s+|any\\s+)?(?:of\\s+)?my\\s+${EN_DATA_NOUNS}\\b`),
  /\b(?:delete|erase|remove|wipe|purge|destroy)\s+(?:all|any|every|everything|anything)\s+(?:of\s+)?(?:the\s+)?(?:personal\s+)?(?:(?:data|information|details|info|records?)\s+)?(?:that\s+)?you\s+(?:have|hold|store|keep|process)\s+(?:on|about|of)\s+me\b/,
  /\b(?:delete|erase|purge)\s+me\s+(?:completely\s+|entirely\s+|permanently\s+)?from\s+(?:all\s+(?:of\s+)?)?(?:your|any\s+of\s+your)\s+(?:databases?|data\s*bases?|records|systems?|crm|files)\b/,
  /\bmy\s+right\s+to\s+(?:be\s+forgotten|erasure)\b/,
  new RegExp(
    `\\b(?:l(?:ö|oe)schen|entfernen)\\s+sie\\s+(?:bitte\\s+)?(?:umgehend\\s+|sofort\\s+)?(?:alle\\s+)?meine\\s+${DE_DATA_NOUNS}\\b`,
  ),
  new RegExp(
    `\\bmeine\\s+${DE_DATA_NOUNS}\\s+(?:bitte\\s+)?(?:umgehend\\s+|sofort\\s+)?(?:l(?:ö|oe)schen|entfernen)\\b`,
  ),
  new RegExp(`\\bl(?:ö|oe)schung\\s+(?:aller\\s+)?meiner\\s+${DE_DATA_NOUNS}\\b`),
  /\bmein(?:em)?\s+recht\s+auf\s+(?:l(?:ö|oe)schung|vergessenwerden|vergessen\s+werden)\b/,
  /\bl(?:ö|oe)sch(?:ungs)?(?:antrag|ersuchen)\b/,
];

/** Access: what data we hold about the writer, or a copy of it. */
const ACCESS_PATTERNS: RegExp[] = [
  /\bwhat\s+(?:personal\s+|kind\s+of\s+|other\s+)?(?:data|information|info|details)\s+(?:do|does)\s+(?:you|your\s+(?:company|team|firm))\s+(?:have|hold|store|keep|process)\s+(?:on|about|of)\s+me\b/,
  /\b(?:data\s+subject\s+access|subject\s+access)\s+request\b/,
  /\bcopy\s+of\s+(?:all\s+)?(?:my|the\s+personal|my\s+personal)\s+(?:data|information|details)\b/,
  /\bcopy\s+of\s+(?:all\s+)?(?:the\s+)?(?:data|information|details)\s+(?:that\s+)?you\s+(?:have|hold|store|keep)\s+(?:on|about)\s+me\b/,
  /\bmy\s+right\s+of\s+access\b/,
  new RegExp(
    `\\bwelche\\s+${DE_DATA_NOUNS}\\s+(?:haben|speichern|verarbeiten)\\s+sie\\s+(?:(?:ü|ue)ber\\s+mich|von\\s+mir|zu\\s+mir|zu\\s+meiner\\s+person)\\b`,
  ),
  /\bauskunft\s+(?:(?:ü|ue)ber|zu)\s+(?:alle\s+)?(?:meine|meiner|mich|mir|die\s+(?:(?:ü|ue)ber\s+mich|zu\s+mir|von\s+mir))\b/,
  /\bmein(?:em)?\s+recht\s+auf\s+auskunft\b/,
  /\bauskunfts(?:ersuchen|antrag)\b/,
];

/** Source: where or how we got the writer's details. */
const SOURCE_PATTERNS: RegExp[] = [
  new RegExp(
    `\\bwhere\\s+(?:did|do|have)\\s+you\\s+(?:get|got|have|find|found|obtain|obtained|source|sourced|buy|bought)\\s+(?:my\\s+${EN_SOURCE_NOUNS}|this\\s+e-?mail\\s+address)\\b`,
  ),
  new RegExp(
    `\\bhow\\s+(?:did|do)\\s+you\\s+(?:get|find|obtain|come\\s+by|come\\s+across)\\s+my\\s+${EN_SOURCE_NOUNS}\\b`,
  ),
  /\bwhat\s+(?:is|was)\s+(?:the|your)\s+source\s+of\s+my\s+(?:data|details|information|e-?mail|contact)/,
  new RegExp(`\\bwoher\\s+(?:haben|kennen)\\s+sie\\s+meine\\s+${DE_SOURCE_NOUNS}\\b`),
  new RegExp(`\\bwoher\\s+stammen\\s+meine\\s+${DE_SOURCE_NOUNS}\\b`),
  new RegExp(`\\bwie\\s+sind\\s+sie\\s+an\\s+meine\\s+${DE_SOURCE_NOUNS}\\s+gekommen\\b`),
];

/** A request declared as such ("this is a formal GDPR request", "my rights under GDPR"). */
const DECLARED_PATTERNS: RegExp[] = [
  /\b(?:this\s+is|consider\s+this(?:\s+(?:e-?mail|message))?(?:\s+as)?|treat\s+this(?:\s+(?:e-?mail|message))?\s+as|i\s+am\s+(?:making|submitting|sending)|i'm\s+(?:making|submitting|sending)|i\s+(?:hereby\s+)?(?:make|submit))\s+(?:a|an|my)\s+(?:formal\s+)?(?:gdpr\s+|dsgvo\s+|ccpa\s+)?(?:privacy|gdpr|data\s+protection|erasure|deletion)\s+request\b/,
  /\bmy\s+rights?\s+under\s+(?:the\s+)?(?:uk\s+)?(?:gdpr|dsgvo|ccpa)\b/,
  /\b(?:datenschutz|dsgvo)-?(?:anfrage|antrag|ersuchen)\b/,
];

/** Words that ask to remove data, used when a request names no kind. */
const REMOVAL_WORDS =
  /\b(?:delete|deletion|erase|erasure|remove|removal|wipe|purge|forget|forgotten|l(?:ö|oe)schen|l(?:ö|oe)schung|entfernen)\b/;

/** The clause before a match ends with a negation ("don't", "do not want you to", "nicht"). */
const NEGATED =
  /\b(?:don't|dont|do\s+not|does\s+not|doesn't|did\s+not|didn't|not|never|no\s+need\s+to|nicht|nie|keine?)\s+(?:\S+\s+){0,3}$/;
/** The clause asks about the writer's own abilities or a condition ("can I", "if we", "kann ich"). */
const SELF_QUESTION =
  /\b(?:can|could|may|might|will|would|should|do|does|did|if|when|how|whether|once)\s+(?:i|we|users?|customers?|clients?|one)\b|\b(?:kann|k(?:ö|oe)nnen|darf|d(?:ü|ue)rfen|wie|wenn|falls|ob)\s+(?:ich|wir|man)\b/;

const withGlobal = (pattern: RegExp) =>
  new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);

/** Most specific first: with several asks, delete wins over access, and access over source. */
const KIND_PATTERNS: Array<[PrivacyKind, RegExp[]]> = [
  ["delete", DELETE_PATTERNS.map(withGlobal)],
  ["access", ACCESS_PATTERNS.map(withGlobal)],
  ["source", SOURCE_PATTERNS.map(withGlobal)],
];
const DECLARED = DECLARED_PATTERNS.map(withGlobal);

/** Lowercase, straight apostrophes, single spaces; line breaks are kept (they end a clause). */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’`´]/g, "'")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n[\s]*/g, "\n")
    .trim();
}

/** The clause before a position: from the last sentence, clause or line break. */
function clauseBefore(text: string, index: number): string {
  const before = text.slice(Math.max(0, index - 120), index);
  let cut = -1;
  for (const mark of [".", "!", "?", ",", ";", ":", "\n"]) {
    cut = Math.max(cut, before.lastIndexOf(mark));
  }
  return before.slice(cut + 1);
}

/** True when the pattern matches at least once without being negated or a self question. */
function requested(text: string, pattern: RegExp): boolean {
  for (const match of text.matchAll(pattern)) {
    const clause = clauseBefore(text, match.index);
    if (NEGATED.test(clause) || SELF_QUESTION.test(clause)) continue;
    return true;
  }
  return false;
}

function specificKind(text: string): PrivacyKind | null {
  for (const [kind, patterns] of KIND_PATTERNS) {
    if (patterns.some((pattern) => requested(text, pattern))) return kind;
  }
  return null;
}

/**
 * What a reply's own text asks about its writer's data, or null when it is not a privacy
 * request. With several asks, delete wins over access, and access over source; a declared
 * request that names no kind is `delete` when it asks to remove data, else `source`.
 */
export function detectPrivacyRequest(ownText: string): PrivacyKind | null {
  const text = normalize(ownText);
  if (!text) return null;
  const kind = specificKind(text);
  if (kind) return kind;
  if (DECLARED.some((pattern) => requested(text, pattern))) {
    return REMOVAL_WORDS.test(text) ? "delete" : "source";
  }
  return null;
}

/**
 * The kind of a privacy request whose classification named none (a model answer without
 * `privacy_kind`, or a human override): the detected kind, else `delete` when the text asks to
 * remove data, else `source`.
 */
export function inferPrivacyKind(ownText: string): PrivacyKind {
  const text = normalize(ownText);
  return specificKind(text) ?? (REMOVAL_WORDS.test(text) ? "delete" : "source");
}
