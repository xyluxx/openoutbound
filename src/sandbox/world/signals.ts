/**
 * World signals: job postings, funding rounds, new exec hires, website changes and tech
 * adoption, each with a dated evidence URL on an example.com host. Definition keys and default
 * weights match the built-in catalog (playbook-signals.md); `score` is computed the same way the
 * signals module will (weight x strength, decay applied on read).
 */
import type { RawSignal } from "../../providers/types.js";
import type { WorldCompany } from "./companies.js";
import { slugify } from "./names.js";
import type { WorldPage } from "./pages.js";
import type { Rng } from "./rng.js";

/** Default weight per signal key (0-100), from the built-in catalog. */
export const SIGNAL_WEIGHTS: Record<string, number> = {
  hiring_relevant_roles: 55,
  funding_round: 45,
  new_exec_hire: 60,
  tech_adopted: 40,
  website_change: 25,
};

interface SignalKind {
  key: keyof typeof SIGNAL_WEIGHTS;
  build(
    rng: Rng,
    company: WorldCompany,
    occurredAt: string,
  ): { signal: RawSignal; page: WorldPage };
}

function isoDaysAgo(reference: Date, daysAgo: number): string {
  return new Date(reference.getTime() - daysAgo * 86_400_000).toISOString();
}

const ECOMMERCE_ROLES_FOR_JOBS = ["Supply Chain Analyst", "Demand Planner", "Operations Manager"];
const EXEC_TITLES = ["VP of Operations", "Chief Supply Chain Officer", "Head of Fulfillment"];
const TECH_TOOLS = ["NetSuite", "Klaviyo", "ShipBob", "Recharge"];

const kinds: SignalKind[] = [
  {
    key: "hiring_relevant_roles",
    build: (rng, company, occurredAt) => {
      const role =
        company.segment === "ecommerce"
          ? rng.pick(ECOMMERCE_ROLES_FOR_JOBS)
          : "Front Desk / Treatment Coordinator";
      const url = `https://${company.domain}/careers/${slugify(role)}`;
      const excerpt = `${company.name} is hiring a ${role} to help the team scale operations.`;
      return {
        signal: {
          definition_key: "hiring_relevant_roles",
          title: `${company.name} is hiring a ${role}`,
          summary: excerpt,
          evidence_url: url,
          evidence_excerpt: excerpt,
          source: "job_boards",
          occurred_at: occurredAt,
          strength: 0.8,
        },
        page: {
          url,
          title: `Careers - ${role} at ${company.name}`,
          text: `${excerpt} Apply on the ${company.name} careers page.`,
          publishedAt: occurredAt,
          companyKey: company.key,
        },
      };
    },
  },
  {
    key: "funding_round",
    build: (rng, company, occurredAt) => {
      const stage = rng.pick(["seed", "Series A", "Series B"]);
      const amount = rng.pick(["$3.5M", "$8M", "$14M", "$22M"]);
      const slug = slugify(company.name);
      const url = `https://news.example.com/${slug}-raises-${slugify(stage)}`;
      const excerpt = `${company.name} raised a ${amount} ${stage} round to expand fulfillment and grow the team.`;
      return {
        signal: {
          definition_key: "funding_round",
          title: `${company.name} raises ${amount} (${stage})`,
          summary: excerpt,
          evidence_url: url,
          evidence_excerpt: excerpt,
          source: "news_gdelt",
          occurred_at: occurredAt,
          strength: 1,
        },
        page: {
          url,
          title: `${company.name} raises ${amount} ${stage}`,
          text: `${excerpt} The company plans to use the funding to invest in operations and demand planning.`,
          publishedAt: occurredAt,
          companyKey: company.key,
        },
      };
    },
  },
  {
    key: "new_exec_hire",
    build: (rng, company, occurredAt) => {
      const title = rng.pick(EXEC_TITLES);
      const slug = slugify(company.name);
      const url = `https://news.example.com/${slug}-names-new-${slugify(title)}`;
      const excerpt = `${company.name} named a new ${title} to lead the next stage of growth.`;
      return {
        signal: {
          definition_key: "new_exec_hire",
          title: `${company.name} names a new ${title}`,
          summary: excerpt,
          evidence_url: url,
          evidence_excerpt: excerpt,
          source: "news_gdelt",
          occurred_at: occurredAt,
          strength: 0.9,
        },
        page: {
          url,
          title: `${company.name} names a new ${title}`,
          text: `${excerpt} The role reports directly to the founding team.`,
          publishedAt: occurredAt,
          companyKey: company.key,
        },
      };
    },
  },
  {
    key: "tech_adopted",
    build: (rng, company, occurredAt) => {
      const tool = rng.pick(TECH_TOOLS);
      const slug = slugify(company.name);
      const url = `https://news.example.com/${slug}-selects-${slugify(tool)}`;
      const excerpt = `${company.name} selected ${tool} to support its operations stack.`;
      return {
        signal: {
          definition_key: "tech_adopted",
          title: `${company.name} adopts ${tool}`,
          summary: excerpt,
          evidence_url: url,
          evidence_excerpt: excerpt,
          source: "tech_detect",
          occurred_at: occurredAt,
          strength: 0.7,
        },
        page: {
          url,
          title: `${company.name} adopts ${tool}`,
          text: `${excerpt} Job postings and site fingerprints both point to the new tool.`,
          publishedAt: occurredAt,
          companyKey: company.key,
        },
      };
    },
  },
  {
    key: "website_change",
    build: (_rng, company, occurredAt) => {
      const url = `https://${company.domain}/pricing`;
      const excerpt = `${company.name} changed its pricing page.`;
      return {
        signal: {
          definition_key: "website_change",
          title: `${company.name} changed its pricing page`,
          summary: excerpt,
          evidence_url: url,
          evidence_excerpt: excerpt,
          source: "website_changes",
          occurred_at: occurredAt,
          strength: 0.6,
        },
        page: {
          url,
          title: `Pricing - ${company.name}`,
          text: `${excerpt} The new page reorganizes plans and adds a new tier.`,
          publishedAt: occurredAt,
          companyKey: company.key,
        },
      };
    },
  },
];

/**
 * One or two signals for a company, plus the canned pages backing their evidence URLs. `reference`
 * anchors "how many days ago" so signals stay recent no matter when the sandbox is seeded.
 */
export function buildSignalsForCompany(
  rng: Rng,
  company: WorldCompany,
  reference: Date,
): { signals: RawSignal[]; pages: WorldPage[] } {
  if (company.status === "competitor") return { signals: [], pages: [] };
  const count = rng.int(1, 2);
  const chosen = rng.pickN(kinds, count);
  const signals: RawSignal[] = [];
  const pages: WorldPage[] = [];
  for (const kind of chosen) {
    const occurredAt = isoDaysAgo(reference, rng.int(2, 45));
    const { signal, page } = kind.build(rng, company, occurredAt);
    signals.push(signal);
    pages.push(page);
  }
  return { signals, pages };
}
