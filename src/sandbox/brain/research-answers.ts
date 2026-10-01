/**
 * Realistic sandbox answers for research.brief and knowledge.bootstrap. Both prompts forbid
 * inventing facts, so every answer here only restates strings already present in the vars
 * (source URLs, page titles, offer names) rather than trying to synthesize new claims.
 */
import type { BootstrapOutput, BootstrapVars } from "../../modules/knowledge/prompts/bootstrap.js";
import type { BriefOutput, BriefVars } from "../../modules/research/prompts/brief.js";
import { pickOne } from "./text.js";

const WHO_SUMMARIES_PERSON: readonly string[] = [
  "Likely one of the people who would notice this kind of problem first, based on their role.",
  "In a role that typically owns or feels this kind of problem day to day.",
];

const WHO_SUMMARIES_COMPANY: readonly string[] = [
  "The operational and revenue leaders here are the likely buyers for this kind of offer.",
  "Buyers here are most likely whoever owns operations or growth for the team.",
];

/** Builds the `research.brief` output: only cites source URLs copied from `vars.sources`. */
export function buildBriefAnswer(vars: BriefVars, _call: unknown): BriefOutput {
  const key = `${vars.target}:${vars.record.slice(0, 80)}`;
  const sources = vars.sources;
  const firstSource = sources[0] ?? null;
  const confidence: BriefOutput["confidence"] =
    sources.length >= 3 ? "high" : sources.length >= 1 ? "medium" : "low";

  const now = sources.slice(0, 3).map((source) => ({
    fact: `${source.title ?? "Update"} (${source.kind.replace(/_/g, " ")})`,
    source_url: source.url,
    date: source.published_at,
  }));

  const pains = firstSource
    ? [
        {
          hypothesis: "May be dealing with the kind of gap our offers are built to close.",
          evidence_urls: [firstSource.url],
        },
      ]
    : [];

  const bestOffer = vars.offers[0] ?? null;
  const angles = bestOffer
    ? [
        {
          angle: `Tie the outreach to ${bestOffer.name}.`,
          why: bestOffer.summary,
          offer_id: bestOffer.id,
          evidence_urls: firstSource ? [firstSource.url] : [],
        },
      ]
    : [];

  return {
    who: {
      summary: pickOne(
        `${key}:who`,
        vars.target === "person" ? WHO_SUMMARIES_PERSON : WHO_SUMMARIES_COMPANY,
      ),
      role: null,
    },
    company: {
      summary:
        sources.length > 0
          ? "What the company does is described in the sources below; treat anything beyond that as unconfirmed."
          : "No fresh sources were found; company details are limited to the lead record.",
    },
    now,
    pains,
    angles,
    recommended_angle: angles[0]?.angle ?? null,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// knowledge.bootstrap
// ---------------------------------------------------------------------------

const EMPTY_ICP_CRITERIA = {
  industries: [] as string[],
  keywords: [] as string[],
  employee_range: { min: null, max: null } as { min: number | null; max: number | null },
  countries: [] as string[],
  regions: [] as string[],
  titles: [] as string[],
  seniorities: [] as string[],
  departments: [] as string[],
  technologies: [] as string[],
  exclusions: { industries: [] as string[], keywords: [] as string[], titles: [] as string[] },
};

function titleKeywords(pages: BootstrapVars["pages"]): string[] {
  const words = pages
    .map((page) => page.title ?? "")
    .join(" ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 3);
  return [...new Set(words)].slice(0, 5);
}

/** Builds the `knowledge.bootstrap` output: derived only from the crawled page titles/text. */
export function buildBootstrapAnswer(vars: BootstrapVars, _call: unknown): BootstrapOutput {
  const firstPage = vars.pages[0] ?? null;
  const keywords = titleKeywords(vars.pages);

  return {
    company_name: null,
    about: firstPage
      ? {
          title: (firstPage.title ?? "About the company").slice(0, 60),
          body: `Based on the ${firstPage.category} page, this is what ${vars.domain} states about itself; treat anything not on the page as unconfirmed.`,
          source_url: firstPage.url,
        }
      : null,
    products: [],
    proof: [],
    objections: [],
    voice: {
      notes: ["Plain, direct sentences.", "Short paragraphs, few adjectives."],
      samples: firstPage ? [firstPage.text.slice(0, 200)] : [],
    },
    offers: [
      {
        name: "Initial offer",
        summary: "A first, low-friction offer to validate interest before anything bigger.",
        details:
          "Refine this from the site content once a person reviews the draft knowledge base.",
        value_props: [],
        cta: "a short call",
        proof_titles: [],
      },
    ],
    icp_suggestions: [
      {
        name: "Primary ICP",
        description: `Companies that match what ${vars.domain}'s own pages describe as their audience.`,
        criteria: { ...EMPTY_ICP_CRITERIA, keywords },
        signal_keys: [],
      },
    ],
    signal_suggestions: [],
  };
}
