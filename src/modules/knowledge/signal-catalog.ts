/**
 * Keys of the built-in signal catalog (spec 11.7) with one-line meanings. The signals module
 * owns the definitions; knowledge only uses the keys to validate bootstrap suggestions.
 */
export const BUILTIN_SIGNALS: Record<string, string> = {
  job_change: "A known contact started at a new company that fits the ICP",
  new_exec_hire: "A new leader was hired in the buying function",
  funding_round: "Funding was announced or filed",
  hiring_relevant_roles: "Open roles name the problem, tool category or team we serve",
  headcount_growth: "Headcount or a key team grew fast",
  tech_adopted: "A tool we integrate with, complement or depend on appeared",
  tech_removed: "A tool we replace or complement disappeared",
  website_change: "Meaningful change to pricing, product, careers, locations or leadership pages",
  expansion_new_location: "New office, clinic, store, country or region",
  news_mention: "Press coverage that implies change (launch, award, partnership)",
  leadership_content: "A decision maker talked publicly about a problem we address",
  engagement_with_us: "The person or company knowingly interacted with us",
  competitor_mention: "Uses, evaluates or complains publicly about a competitor",
  event_attendance: "Exhibiting, sponsoring, speaking or attending a relevant event",
  review_activity: "Public reviews point to a problem we solve",
};

export const BUILTIN_SIGNAL_KEYS = Object.keys(BUILTIN_SIGNALS);

/** snake_case key from free text ("Pricing made public" -> "pricing_made_public"). */
export function toSignalKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "s_$1")
    .slice(0, 60);
}
