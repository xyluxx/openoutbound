/**
 * Phrases to avoid, from the copywriting playbook (section 6). Matching is case-insensitive, on
 * word boundaries, after normalizing curly quotes. Workspace rules can add more (see
 * `phrasesFromRules`).
 */
export const BANNED_PHRASES: readonly string[] = [
  "act now",
  "limited time",
  "urgent",
  "100% free",
  "risk-free",
  "guaranteed",
  "no obligation",
  "no strings attached",
  "click here",
  "buy now",
  "order now",
  "special promotion",
  "exclusive deal",
  "once in a lifetime",
  "don't miss out",
  "what are you waiting for",
  "lowest price",
  "best price",
  "save big",
  "earn money",
  "make money",
  "extra income",
  "double your",
  "triple your",
  "100% satisfaction",
  "congratulations",
  "free trial",
  "free consultation",
  "free gift",
  "instant access",
  "limited spots",
  "final notice",
  "last chance",
  "act immediately",
  "this is not spam",
  "dear friend",
  "dear sir/madam",
  "to whom it may concern",
  "as discussed",
  "as promised",
  "per our conversation",
  "following our call",
  "great meeting you",
  "great chatting with you",
  "as you may remember",
  "thanks for your interest",
  "i hope this email finds you well",
  "hope you're doing well",
  "i hope you're having a great week",
  "i trust this message finds you well",
  "i wanted to reach out",
  "i'm reaching out because",
  "i came across your profile",
  "i stumbled upon",
  "in today's fast-paced world",
  "in the ever-evolving landscape",
  "navigate the complexities",
  "delve into",
  "game-changer",
  "cutting-edge",
  "revolutionary",
  "best-in-class",
  "world-class",
  "industry-leading",
  "state-of-the-art",
  "seamless",
  "tailored solutions",
  "elevate your",
  "empower your team",
  "unlock the power",
  "unlock your potential",
  "supercharge",
  "skyrocket",
  "take it to the next level",
  "synergy",
  "synergies",
  "holistic approach",
  "rest assured",
  "look no further",
  "i was impressed by",
  "i love what you're doing",
  "big fan of your work",
  "your impressive growth",
  "i know you're busy",
  "sorry to bother you",
  "just checking in",
  "just following up",
  "just bumping this",
  "bumping this to the top of your inbox",
  "circling back",
  "touching base",
  "did you get my last email",
  "did you see my previous email",
  "per my last email",
  "i haven't heard back",
  "i'll assume you're not interested",
  "should i close your file",
  "do you have 15 minutes",
  "hop on a quick call",
  "jump on a call",
  "can i steal",
  "pick your brain",
  "are you the right person",
];

/** Lowercases, straightens curly quotes and collapses whitespace. */
export function normalizeForMatching(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/\s+/g, " ");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** Phrases from `phrases` found in `text` (word-boundary match). */
export function findPhrases(text: string, phrases: readonly string[]): string[] {
  const haystack = normalizeForMatching(text);
  const hits: string[] = [];
  for (const phrase of phrases) {
    const needle = normalizeForMatching(phrase).trim();
    if (!needle) continue;
    const pattern = new RegExp(`(?<![a-z0-9])${escapeRegExp(needle)}(?![a-z0-9])`, "i");
    if (pattern.test(haystack)) hits.push(phrase);
  }
  return hits;
}

/**
 * Banned phrases stated in writing rules: quoted text in rules that start with avoid, never,
 * don't, do not, no or ban (e.g. `Never say "quick question"` bans "quick question").
 */
export function phrasesFromRules(rules: readonly string[]): string[] {
  const out: string[] = [];
  for (const rule of rules) {
    const normalized = normalizeForMatching(rule).trim();
    if (!/^(avoid|never|don't|do not|no|ban|banned|forbidden)\b/.test(normalized)) continue;
    for (const match of normalized.matchAll(
      /"([^"]{2,80})"|(?:^|\s)'([^']{2,80})'(?=$|\s|[.,;:!?])/g,
    )) {
      const phrase = (match[1] ?? match[2] ?? "").trim();
      if (phrase) out.push(phrase);
    }
  }
  return [...new Set(out)];
}
