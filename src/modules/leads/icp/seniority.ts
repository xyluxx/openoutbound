/** Seniority vocabulary (Apollo style) and inference from job titles. */

export const SENIORITIES = [
  "owner",
  "founder",
  "c_suite",
  "partner",
  "vp",
  "head",
  "director",
  "manager",
  "senior",
  "entry",
  "intern",
] as const;
export type Seniority = (typeof SENIORITIES)[number];

/** Decision level, higher = more senior. Owner, founder and C-level share the top level. */
export const SENIORITY_RANK: Record<Seniority, number> = {
  owner: 8,
  founder: 8,
  c_suite: 8,
  partner: 7,
  vp: 6,
  head: 5,
  director: 5,
  manager: 3,
  senior: 2,
  entry: 1,
  intern: 0,
};

const RULES: Array<[Seniority, RegExp]> = [
  ["owner", /\b(owner|co-owner|proprietor|inhaber(in)?|propri[eé]taire)\b/],
  ["founder", /\b(co-?founder|founder|founding partner|gr[uü]nder(in)?|fondateur)\b/],
  ["vp", /\b(vp|svp|evp|avp|vice[- ]president|vice[- ]pres)\b/],
  [
    "c_suite",
    /\b(ceo|cto|cfo|coo|cmo|cro|cio|ciso|cpo|cco|chief|president|managing director|gesch[aä]ftsf[uü]hrer(in)?|general manager)\b/,
  ],
  ["partner", /\bpartner\b/],
  ["head", /\bhead\b/],
  ["director", /\b(director|direktor(in)?|directeur|directora?)\b/],
  ["intern", /\b(intern|internship|trainee|werkstudent(in)?|praktikant(in)?|apprentice)\b/],
  ["manager", /\b(manager|managerin|mgr|lead|leiter(in)?|supervisor|team lead)\b/],
  ["senior", /\b(senior|sr|principal|staff)\b/],
  ["entry", /\b(junior|jr|assistant|associate|coordinator|specialist|representative|analyst)\b/],
];

/** Seniority guessed from a title ("VP of Operations" -> vp). Null when nothing fits. */
export function inferSeniority(title: string | null | undefined): Seniority | null {
  if (!title) return null;
  const text = title.toLowerCase().replace(/[.,/&()]+/g, " ");
  for (const [seniority, pattern] of RULES) {
    if (pattern.test(text)) return seniority;
  }
  return null;
}

/** A stored seniority (any vocabulary) mapped to ours, falling back to the title. */
export function resolveSeniority(
  seniority: string | null | undefined,
  title: string | null | undefined,
): Seniority | null {
  const value = seniority
    ?.toLowerCase()
    .trim()
    .replace(/[\s-]+/g, "_");
  if (value) {
    if ((SENIORITIES as readonly string[]).includes(value)) return value as Seniority;
    if (value === "c_level" || value === "executive" || value === "cxo") return "c_suite";
    if (value === "vice_president") return "vp";
    if (value === "junior") return "entry";
  }
  return inferSeniority(title);
}
