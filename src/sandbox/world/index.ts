/**
 * Assembles the sandbox world once, at module load: typed constants built by small deterministic
 * generators (rng.ts, companies.ts, people.ts, signals.ts, pages.ts), combined with the
 * hand-written business content in blueprints.ts. Nothing here touches the database or the
 * clock; `seed.ts` turns these constants into rows. Fit scores come from the real scorer and
 * the workspace's default ICP, so seeded scores match what manage_icp action score computes.
 */
import {
  icpCriteriaSchema,
  icpScoringSchema,
  type ParsedIcp,
} from "../../modules/leads/icp/criteria.js";
import { scoreFit } from "../../modules/leads/icp/score.js";
import type { RawSignal } from "../../providers/types.js";
import { WORKSPACE_BLUEPRINTS, type WorkspaceBlueprint } from "./blueprints.js";
import { buildDentalCompanies, buildEcommerceCompanies, type WorldCompany } from "./companies.js";
import { buildProfilePages, type WorldPage } from "./pages.js";
import { buildDentalPeople, buildEcommercePeople, type WorldPerson } from "./people.js";
import { createRng } from "./rng.js";
import { buildSignalsForCompany, SIGNAL_WEIGHTS } from "./signals.js";

export type { WorkspaceBlueprint } from "./blueprints.js";
export { WORKSPACE_BLUEPRINTS } from "./blueprints.js";
export type { WorldCompany, WorldSegment } from "./companies.js";
export type { WorldPage } from "./pages.js";
export type { WorldPerson } from "./people.js";

const NORTHWIND_TOTAL = 34;
const NORTHWIND_SEEDED = 22;
const BRIGHTSMILE_TOTAL = 30;
const BRIGHTSMILE_SEEDED = 22;

/** Anchors "how many days ago" for signal dates so the world stays recent-looking. */
const SIGNAL_REFERENCE_DATE = new Date("2026-09-27T00:00:00.000Z");

export interface CompanySignal {
  companyKey: string;
  raw: RawSignal;
}

export interface WorkspaceWorld {
  blueprint: WorkspaceBlueprint;
  /** All world companies for this segment (seeded + search-only). */
  companies: WorldCompany[];
  /** All world people for this segment. */
  people: WorldPerson[];
  /** Every company's signals, company included even when not yet seeded. */
  signals: CompanySignal[];
  /** Canned pages (profile + news) the research provider can search and fetch. */
  pages: WorldPage[];
  /** Domain that always verifies as catch_all (a "real" catch-all mail server). */
  catchAllDomain: string;
}

/** The blueprint's default ICP, parsed exactly as manage_icp stores it (strict: throws). */
export function defaultIcpOf(blueprint: WorkspaceBlueprint): ParsedIcp {
  const icp = blueprint.icps.find((candidate) => candidate.is_default) ?? blueprint.icps[0];
  if (!icp) throw new Error(`sandbox world: "${blueprint.slug}" has no ICP`);
  return {
    id: `sandbox:${blueprint.slug}`,
    name: icp.name,
    description: icp.description,
    criteria: icpCriteriaSchema.parse(icp.criteria),
    scoring: icpScoringSchema.parse(icp.scoring),
  };
}

/** Fit score and reasons of every company (company criteria) and person (with the company). */
function scoreWorld(icp: ParsedIcp, companies: WorldCompany[], people: WorldPerson[]): void {
  const byKey = new Map(companies.map((company) => [company.key, company]));
  for (const company of companies) {
    const fit = scoreFit(icp, { company });
    company.fit_score = fit.score;
    company.fit_reasons = fit.reasons;
  }
  for (const person of people) {
    const fit = scoreFit(icp, { person, company: byKey.get(person.companyKey) ?? null });
    person.fit_score = fit.score;
    person.fit_reasons = fit.reasons;
  }
}

function computeIntentScore(signals: RawSignal[]): number {
  if (signals.length === 0) return 0;
  let remainder = 1;
  for (const signal of signals) {
    const weight = SIGNAL_WEIGHTS[signal.definition_key] ?? 30;
    const strength = signal.strength ?? 1;
    remainder *= 1 - Math.min(1, (weight * strength) / 100);
  }
  return Math.round(100 * (1 - remainder));
}

function buildWorkspaceWorld(
  blueprint: WorkspaceBlueprint,
  total: number,
  seededCount: number,
): WorkspaceWorld {
  const rng = createRng(`world:${blueprint.slug}`);
  const companies =
    blueprint.segment === "ecommerce"
      ? buildEcommerceCompanies(rng, total, seededCount)
      : buildDentalCompanies(rng, total, seededCount);

  // A designated catch-all domain among the seeded companies, so the verifier's "catch_all"
  // status is guaranteed to show up rather than left to chance.
  const catchAllCompany = companies[Math.min(3, seededCount - 1)];
  const catchAllDomain = catchAllCompany?.domain ?? companies[0]?.domain ?? "example.com";
  const catchAllDomains = new Set([catchAllDomain]);

  const people = companies.flatMap((company) =>
    blueprint.segment === "ecommerce"
      ? buildEcommercePeople(rng, company, catchAllDomains)
      : buildDentalPeople(rng, company),
  );

  const signals: CompanySignal[] = [];
  const pages: WorldPage[] = [];
  for (const company of companies) {
    pages.push(...buildProfilePages(company));
    const built = buildSignalsForCompany(rng, company, SIGNAL_REFERENCE_DATE);
    pages.push(...built.pages);
    for (const raw of built.signals) signals.push({ companyKey: company.key, raw });
  }

  const scoreByCompany = new Map<string, RawSignal[]>();
  for (const { companyKey, raw } of signals) {
    const list = scoreByCompany.get(companyKey) ?? [];
    list.push(raw);
    scoreByCompany.set(companyKey, list);
  }
  for (const company of companies) {
    company.intent_score = computeIntentScore(scoreByCompany.get(company.key) ?? []);
  }
  scoreWorld(defaultIcpOf(blueprint), companies, people);

  return { blueprint, companies, people, signals, pages, catchAllDomain };
}

/** The whole sandbox world, keyed by workspace slug ("northwind", "brightsmile"). */
export const WORLD: Record<string, WorkspaceWorld> = Object.fromEntries(
  WORKSPACE_BLUEPRINTS.map((blueprint) => [
    blueprint.slug,
    buildWorkspaceWorld(
      blueprint,
      blueprint.slug === "northwind" ? NORTHWIND_TOTAL : BRIGHTSMILE_TOTAL,
      blueprint.slug === "northwind" ? NORTHWIND_SEEDED : BRIGHTSMILE_SEEDED,
    ),
  ]),
);

/** The practice worlds, by the slug their sandbox workspace gets by default. */
export const SANDBOX_WORLD_KEYS = ["northwind", "brightsmile"] as const;
export type SandboxWorldKey = (typeof SANDBOX_WORLD_KEYS)[number];

/**
 * The world behind a sandbox workspace: by its slug, else by the world's workspace name (a
 * sandbox seeded under another slug because a real workspace has the usual one). Null when it
 * matches no world.
 */
export function worldOfWorkspace(row: { slug: string; name: string }): WorkspaceWorld | null {
  return (
    WORLD[row.slug] ??
    Object.values(WORLD).find((world) => world.blueprint.name === row.name) ??
    null
  );
}

/** Every catch-all domain in the world, across workspaces (for the email_verifier provider). */
export const CATCH_ALL_DOMAINS: ReadonlySet<string> = new Set(
  Object.values(WORLD).map((w) => w.catchAllDomain),
);

/** All companies across every workspace world (for providers that are not workspace-scoped). */
export function allCompanies(): WorldCompany[] {
  return Object.values(WORLD).flatMap((w) => w.companies);
}

/** All people across every workspace world. */
export function allPeople(): WorldPerson[] {
  return Object.values(WORLD).flatMap((w) => w.people);
}

/** All canned pages across every workspace world. */
export function allPages(): WorldPage[] {
  return Object.values(WORLD).flatMap((w) => w.pages);
}

/** Looks up which workspace world a company domain belongs to. */
export function findCompanyByDomain(domain: string): WorldCompany | null {
  for (const world of Object.values(WORLD)) {
    const found = world.companies.find((c) => c.domain === domain);
    if (found) return found;
  }
  return null;
}
