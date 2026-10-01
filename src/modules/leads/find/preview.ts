/**
 * find_leads previews: search a lead source, score the candidates against an ICP, flag the
 * ones already in the database or suppressed, and keep the preview (an imports row with
 * status `previewed`) so selected candidates can be imported later.
 *
 * Google Maps Platform terms: Places content (names, addresses, phones, ratings, reviews)
 * may be shown to the user but not stored. For google_maps previews only the place id, the
 * domain of the business's own website, the country code and the fit score are stored; the
 * names and the rest appear only in the find_leads output. Imports then fill the company from
 * the business website (see find/import.ts).
 */
import { and, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import {
  budgetHint,
  budgetWarning,
  cutShortWarning,
  fitsBudget,
  formatAmount,
} from "../../../core/budget.js";
import { callFailure } from "../../../core/call-failure.js";
import { type BudgetStatus, type OpContext, requireWorkspace } from "../../../core/context.js";
import { OpenOutboundError } from "../../../core/errors.js";
import { describeFailure, type Failure, partialOf } from "../../../core/failures.js";
import { askToRaiseBudget } from "../../../core/setting-hints.js";
import { companies, type Import, people } from "../../../db/schema/index.js";
import type {
  CompanyCandidate,
  CostEstimate,
  LeadSourceProvider,
  PersonCandidate,
  SourcePage,
} from "../../../providers/types.js";
import { loadIcp } from "../icp/apply.js";
import type { ParsedIcp } from "../icp/criteria.js";
import { refineScores } from "../icp/refine.js";
import { scoreFit } from "../icp/score.js";
import { createImportRow } from "../import/run.js";
import { normalizeEmail, normalizePersonLinkedin, normalizeWebsite } from "../normalize.js";
import {
  findSuppressions,
  matchSuppression,
  suppressionCandidates,
  suppressionIndex,
} from "../suppressions.js";
import { assertCriteria, type FindCriteria, toCompanyQuery, toPeopleQuery } from "./query.js";

export const FIND_SOURCES = ["apollo", "google_maps"] as const;
export type FindSource = (typeof FIND_SOURCES)[number];
export const FIND_KINDS = ["people", "companies"] as const;
export type FindKind = (typeof FIND_KINDS)[number];

/** Places content may not be stored (see the file comment); only for the real provider. */
export function isGoogleMaps(providerId: string): boolean {
  return providerId === "google_maps";
}

type StoredPerson = Omit<PersonCandidate, "raw" | "company">;
type StoredCompany = Omit<CompanyCandidate, "raw">;

/** One candidate as kept on the preview row. */
export interface StoredCandidate {
  /** "c1", "c2", ... in preview order. */
  id: string;
  external_id: string | null;
  fit_score: number | null;
  fit_summary: string | null;
  existing_id: string | null;
  suppressed: boolean;
  person: StoredPerson | null;
  company: StoredCompany | null;
}

/** imports.options of a find preview. */
export interface FindPreviewOptions {
  find: true;
  kind: FindKind;
  source: FindSource;
  /** Provider instance that answered (apollo, google_maps or sandbox). */
  provider: string;
  criteria: FindCriteria;
  icp_id: string | null;
  candidates: StoredCandidate[];
  next_cursor: string | null;
  credits_used: number;
  saved_search_id: string | null;
  /** The source failed after returning these candidates; next_cursor continues after them. */
  failure?: Failure | null;
}

export const candidateView = z.object({
  candidate_id: z.string(),
  name: z.string(),
  title: z.string().nullable(),
  company: z.string().nullable(),
  domain: z.string().nullable(),
  location: z.string().nullable(),
  industry: z.string().nullable(),
  employees: z.number().nullable(),
  rating: z.number().nullable().describe("Google rating (shown only, never stored)"),
  has_email: z.boolean().nullable().describe("The source has an email to reveal (Apollo)"),
  fit_score: z.number().nullable(),
  fit_summary: z.string().nullable(),
  in_database: z.boolean(),
  existing_id: z.string().nullable(),
  suppressed: z.boolean(),
});
export type CandidateView = z.infer<typeof candidateView>;

export interface FindRequest {
  source: FindSource;
  kind: FindKind;
  criteria: FindCriteria;
  limit: number;
  cursor?: string | null | undefined;
  icpId?: string | null | undefined;
  savedSearchId?: string | null;
  /** The most the search may spend besides the data budget (a saved search's spend cap). */
  spendCap?: number | null;
  /** Operation or job name for usage records. */
  operation: string;
}

export interface FindResult {
  preview: Import;
  options: FindPreviewOptions;
  views: CandidateView[];
  total_available: number | null;
  credits_used: number;
  import_estimate: CostEstimate;
  warnings: string[];
  /** The source failed after returning these results (kept); null when it did not fail. */
  failure: Failure | null;
}

function invalid(message: string, hint: string): OpenOutboundError {
  return new OpenOutboundError("validation_failed", message, { hint });
}

/** The lead source for a find, checked for the kind of search. */
export async function findProvider(
  ctx: OpContext,
  source: FindSource,
  kind: FindKind,
): Promise<LeadSourceProvider> {
  if (source === "google_maps" && kind === "people") {
    throw invalid(
      "Google Maps finds businesses, not people.",
      "Use kind companies; the import can then find the people on each website (find_people).",
    );
  }
  const provider = await ctx.providers.get("lead_source", { id: source });
  const search = kind === "people" ? provider.searchPeople : provider.searchCompanies;
  if (!search) {
    throw invalid(
      `The ${provider.id} lead source cannot search ${kind}.`,
      kind === "people"
        ? "Use source apollo for people."
        : "Use kind people, or source google_maps for companies.",
    );
  }
  return provider;
}

/** Estimated credits of one search page (0 for free searches; see CostEstimate.maxCredits). */
export async function estimateSearch(
  provider: LeadSourceProvider,
  kind: FindKind,
  count: number,
): Promise<CostEstimate> {
  return (await provider.estimate?.({ kind, count })) ?? { credits: 0 };
}

/** How to spend less on a search (first half of the budget hint). */
export const SEARCH_BUDGET_LOWER = "Ask for fewer results (a lower limit)";

/** What a search needs left to start: one request for a search that stops at the credits left. */
export function creditsToStart(estimate: CostEstimate): number {
  return estimate.minCredits ?? estimate.credits;
}

/** The most a search can cost. */
export function mostCredits(estimate: CostEstimate): number {
  return estimate.maxCredits ?? estimate.credits;
}

/**
 * How to get a refused search to run: spend less (`lower`), or wait when not even the first
 * request of a search that stops at the credits left fits (fewer results would not help).
 */
export function searchBudgetHint(
  status: BudgetStatus,
  estimate: CostEstimate,
  lower = SEARCH_BUDGET_LOWER,
): string {
  return budgetHint(status, estimate.minCredits !== undefined ? "Wait until next month" : lower);
}

/**
 * The dry-run warning for a search and the data budget (null when it fits): refused when it
 * cannot start, cut short when a search that stops at the credits left cannot finish. `lower`
 * says how to spend less, `outcome` what a refused run does.
 */
export function searchBudgetWarning(
  status: BudgetStatus,
  estimate: CostEstimate,
  options: { lower: string; outcome?: string },
): string | null {
  const start = creditsToStart(estimate);
  if (estimate.minCredits !== undefined && fitsBudget(status, start)) {
    return cutShortWarning(status, estimate.credits, budgetHint(status, options.lower));
  }
  return budgetWarning(status, start, {
    hint: searchBudgetHint(status, estimate, options.lower),
    most: mostCredits(estimate),
    ...(options.outcome ? { outcome: options.outcome } : {}),
  });
}

/** The credits a search may spend, and what sets that limit. */
interface CreditCap {
  credits: number;
  by: "budget" | "spend_cap";
}

/** What is left of the data budget or of `spendCap`, whichever is lower (null: no limit). */
async function creditCap(
  ctx: OpContext,
  workspaceId: string,
  spendCap: number | null | undefined,
): Promise<CreditCap | null> {
  const left = (await ctx.usage.budgetStatus(workspaceId, "data")).remaining;
  let cap: CreditCap | null = left === null ? null : { credits: left, by: "budget" };
  if (spendCap !== null && spendCap !== undefined && (cap === null || spendCap < cap.credits)) {
    cap = { credits: spendCap, by: "spend_cap" };
  }
  return cap;
}

/** The warning when the credit cap, not the provider's own limit, ended the page early. */
function stoppedAtCap(
  cap: CreditCap,
  estimate: CostEstimate,
  page: SourcePage<unknown>,
  found: number,
  limit: number,
): string | null {
  const requests = Math.floor(cap.credits);
  if (!page.nextCursor || found >= limit) return null;
  if (requests >= mostCredits(estimate) || page.creditsUsed < requests) return null;
  const spent = formatAmount(page.creditsUsed, "credits");
  return cap.by === "budget"
    ? `The search stopped after ${spent}, all that was left of the monthly data budget, with ${found} of ${limit} results. To get the rest, ${askToRaiseBudget("settings.data.monthly_credit_budget")}, then pass next_cursor.`
    : `The search stopped after ${spent}, the spend cap of this saved search, with ${found} of ${limit} results. Raise spend_cap_credits with manage_saved_searches action update to get more.`;
}

function location(parts: Array<string | null | undefined>): string | null {
  const text = parts.filter(Boolean).join(", ");
  return text || null;
}

function personFacts(person: StoredPerson, company: StoredCompany | null): string {
  return [
    person.title ? `Title: ${person.title}` : "",
    company?.name ? `Company: ${company.name}` : "",
    company?.industry ? `Industry: ${company.industry}` : "",
    company?.employee_count ? `Employees: ${company.employee_count}` : "",
    location([person.city, person.region, person.country])
      ? `Location: ${location([person.city, person.region, person.country])}`
      : "",
    company?.description ? `About: ${company.description.slice(0, 400)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function companyFacts(company: StoredCompany): string {
  return [
    `Company: ${company.name}`,
    company.industry ? `Industry: ${company.industry}` : "",
    company.categories?.length ? `Categories: ${company.categories.join(", ")}` : "",
    company.employee_count ? `Employees: ${company.employee_count}` : "",
    location([company.city, company.region, company.country])
      ? `Location: ${location([company.city, company.region, company.country])}`
      : "",
    company.description ? `About: ${company.description.slice(0, 400)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function stripRaw<T extends { raw?: unknown }>(value: T): Omit<T, "raw"> {
  const { raw: _raw, ...rest } = value;
  return rest;
}

function cleanCompany(company: CompanyCandidate): StoredCompany {
  const clean = stripRaw(company);
  const website = normalizeWebsite(clean.website ?? clean.domain ?? null);
  return { ...clean, domain: website.domain ?? null, website: website.website ?? null };
}

function cleanPerson(person: PersonCandidate): StoredPerson {
  const { company: _company, ...rest } = stripRaw(person);
  return {
    ...rest,
    email: normalizeEmail(rest.email ?? null),
    linkedin_url: normalizePersonLinkedin(rest.linkedin_url ?? null),
  };
}

function hasEmailFlag(candidate: PersonCandidate): boolean | null {
  const raw = candidate.raw as { has_email?: unknown } | undefined;
  if (candidate.email) return true;
  return typeof raw?.has_email === "boolean" ? raw.has_email : null;
}

/** Records already in the workspace: candidate id -> existing person or company id. */
async function knownRecords(
  ctx: OpContext,
  kind: FindKind,
  refKey: string,
  candidates: StoredCandidate[],
): Promise<Map<string, string>> {
  const workspace = requireWorkspace(ctx);
  const found = new Map<string, string>();
  const externalIds = candidates.map((c) => c.external_id).filter((id): id is string => !!id);
  if (kind === "people") {
    const emails = candidates.map((c) => c.person?.email).filter((e): e is string => !!e);
    const linkedins = candidates.map((c) => c.person?.linkedin_url).filter((l): l is string => !!l);
    const conditions: SQL[] = [];
    if (externalIds.length)
      conditions.push(inArray(sql`${people.source_refs} ->> ${refKey}`, externalIds));
    if (emails.length) conditions.push(inArray(people.email, emails));
    if (linkedins.length) conditions.push(inArray(people.linkedin_url, linkedins));
    if (conditions.length === 0) return found;
    const rows = await ctx.db
      .select({
        id: people.id,
        ref: sql<string | null>`${people.source_refs} ->> ${refKey}`,
        email: people.email,
        linkedin_url: people.linkedin_url,
      })
      .from(people)
      .where(and(eq(people.workspace_id, workspace.id), or(...conditions)));
    for (const candidate of candidates) {
      const match = rows.find(
        (row) =>
          (candidate.external_id && row.ref === candidate.external_id) ||
          (candidate.person?.email && row.email === candidate.person.email) ||
          (candidate.person?.linkedin_url && row.linkedin_url === candidate.person.linkedin_url),
      );
      if (match) found.set(candidate.id, match.id);
    }
    return found;
  }
  const domains = candidates.map((c) => c.company?.domain).filter((d): d is string => !!d);
  const conditions: SQL[] = [];
  if (externalIds.length)
    conditions.push(inArray(sql`${companies.source_refs} ->> ${refKey}`, externalIds));
  if (domains.length) conditions.push(inArray(companies.domain, domains));
  if (conditions.length === 0) return found;
  const rows = await ctx.db
    .select({
      id: companies.id,
      ref: sql<string | null>`${companies.source_refs} ->> ${refKey}`,
      domain: companies.domain,
    })
    .from(companies)
    .where(and(eq(companies.workspace_id, workspace.id), or(...conditions)));
  for (const candidate of candidates) {
    const match = rows.find(
      (row) =>
        (candidate.external_id && row.ref === candidate.external_id) ||
        (candidate.company?.domain && row.domain === candidate.company.domain),
    );
    if (match) found.set(candidate.id, match.id);
  }
  return found;
}

async function flagSuppressed(ctx: OpContext, candidates: StoredCandidate[]): Promise<void> {
  const workspace = requireWorkspace(ctx);
  const byId = new Map(
    candidates.map((c) => [
      c.id,
      suppressionCandidates({
        email: c.person?.email ?? null,
        linkedin_url: c.person?.linkedin_url ?? null,
        company_domain: c.company?.domain ?? null,
      }),
    ]),
  );
  const index = suppressionIndex(
    await findSuppressions(ctx.db, workspace.id, [...byId.values()].flat()),
  );
  for (const candidate of candidates) {
    candidate.suppressed = matchSuppression(index, byId.get(candidate.id) ?? []) !== null;
  }
}

function score(icp: ParsedIcp | null, candidate: StoredCandidate) {
  if (!icp) return null;
  const company = candidate.company;
  return scoreFit(icp, {
    person: candidate.person
      ? {
          title: candidate.person.title ?? null,
          seniority: candidate.person.seniority ?? null,
          department: candidate.person.department ?? null,
          email: candidate.person.email ?? null,
          country: candidate.person.country ?? null,
          region: candidate.person.region ?? null,
          city: candidate.person.city ?? null,
        }
      : null,
    company: company
      ? {
          name: company.name,
          domain: company.domain ?? null,
          industry: company.industry ?? company.categories?.[0] ?? null,
          description: company.description ?? null,
          employee_count: company.employee_count ?? null,
          employee_range: company.employee_range ?? null,
          country: company.country ?? null,
          region: company.region ?? null,
          city: company.city ?? null,
          technologies: company.technologies ?? [],
          status: "active",
        }
      : null,
  });
}

function view(
  candidate: StoredCandidate,
  source: PersonCandidate | CompanyCandidate,
): CandidateView {
  const person = candidate.person;
  const company = candidate.company;
  const base = {
    candidate_id: candidate.id,
    fit_score: candidate.fit_score,
    fit_summary: candidate.fit_summary,
    in_database: candidate.existing_id !== null,
    existing_id: candidate.existing_id,
    suppressed: candidate.suppressed,
    industry: company?.industry ?? null,
    employees: company?.employee_count ?? null,
    domain: company?.domain ?? null,
  };
  if (person) {
    return {
      ...base,
      name: person.full_name ?? person.first_name ?? "(no name)",
      title: person.title ?? null,
      company: company?.name ?? null,
      location: location([person.city, person.region, person.country]),
      rating: null,
      has_email: hasEmailFlag(source as PersonCandidate),
    };
  }
  return {
    ...base,
    name: company?.name ?? "(no name)",
    title: null,
    company: null,
    location: location([company?.city, company?.region, company?.country]),
    rating: company?.rating ?? null,
    has_email: null,
  };
}

/** Google candidates as stored: place id, website domain, country and the derived fit. */
function storedForGoogle(candidate: StoredCandidate): StoredCandidate {
  const company = candidate.company;
  return {
    ...candidate,
    company: company
      ? {
          name: company.domain ?? "",
          domain: company.domain ?? null,
          website: company.domain ? `https://${company.domain}` : null,
          country: company.country ?? null,
          source: company.source,
        }
      : null,
  };
}

/**
 * Runs one search page and stores the preview. Checks the data budget when the page costs
 * credits and records the credits used. The provider gets what is left of the budget (or of
 * the spend cap) as `maxCredits`: a Google Maps search stops there and returns a cursor, so it
 * is refused only when not even its first request fits ("needs at least 1 credit").
 *
 * A search that fails after some paid pages (`details.partial` of the failure) keeps what came
 * back: the results become the preview, the credits spent are recorded, the resume value is
 * the next cursor and `failure` says what happened. With nothing back it fails, after recording
 * any credits spent.
 */
export async function runFind(ctx: OpContext, request: FindRequest): Promise<FindResult> {
  const workspace = requireWorkspace(ctx);
  assertCriteria(request.criteria);
  const provider = await findProvider(ctx, request.source, request.kind);
  const warnings: string[] = [];
  const estimate = await estimateSearch(provider, request.kind, request.limit);
  await ctx.usage.assertCanSpend(workspace.id, "data", creditsToStart(estimate), {
    hint: (status) => searchBudgetHint(status, estimate),
    most: mostCredits(estimate),
  });
  const cap = await creditCap(ctx, workspace.id, request.spendCap);

  const pageRequest = {
    limit: request.limit,
    ...(request.cursor ? { cursor: request.cursor } : {}),
    ...(cap ? { maxCredits: cap.credits } : {}),
  };
  let page: SourcePage<PersonCandidate | CompanyCandidate>;
  let failure: Failure | null = null;
  try {
    page =
      request.kind === "people"
        ? await (provider.searchPeople as NonNullable<LeadSourceProvider["searchPeople"]>)(
            toPeopleQuery(request.criteria),
            pageRequest,
          )
        : await (provider.searchCompanies as NonNullable<LeadSourceProvider["searchCompanies"]>)(
            toCompanyQuery(request.criteria),
            pageRequest,
          );
  } catch (error) {
    const partial = partialOf<PersonCandidate | CompanyCandidate>(error);
    const spent = partial?.credits ?? 0;
    if (spent > 0) {
      await ctx.usage.record({
        slot: "lead_source",
        provider: provider.id,
        operation: request.operation,
        credits: spent,
      });
    }
    if (!partial || partial.items.length === 0) throw error;
    failure = callFailure(error, provider.id);
    const resume = typeof partial.resume === "string" ? partial.resume : null;
    page = { items: partial.items, creditsUsed: spent, nextCursor: resume };
    warnings.push(
      `The search failed part way (${describeFailure(failure)}); kept the ${partial.items.length} results it returned${
        resume ? ". Pass next_cursor to continue from where it stopped." : "."
      }`,
    );
  }
  if (!failure && page.creditsUsed > 0) {
    await ctx.usage.record({
      slot: "lead_source",
      provider: provider.id,
      operation: request.operation,
      credits: page.creditsUsed,
    });
  }

  // Candidates in page order, one per external id.
  const seen = new Set<string>();
  const sources: Array<PersonCandidate | CompanyCandidate> = [];
  for (const item of page.items as Array<PersonCandidate | CompanyCandidate>) {
    if (item.external_id) {
      if (seen.has(item.external_id)) continue;
      seen.add(item.external_id);
    }
    sources.push(item);
    if (sources.length >= request.limit) break;
  }
  const stopped =
    !failure && cap && stoppedAtCap(cap, estimate, page, sources.length, request.limit);
  if (stopped) warnings.push(stopped);
  const candidates: StoredCandidate[] = sources.map((item, index) => {
    const isPerson = request.kind === "people";
    const person = isPerson ? cleanPerson(item as PersonCandidate) : null;
    const companySource = isPerson ? (item as PersonCandidate).company : (item as CompanyCandidate);
    return {
      id: `c${index + 1}`,
      external_id: item.external_id ?? null,
      fit_score: null,
      fit_summary: null,
      existing_id: null,
      suppressed: false,
      person,
      company: companySource ? cleanCompany(companySource) : null,
    };
  });

  const icp = await loadIcp(ctx, request.icpId ?? null);
  if (!icp) warnings.push("No ICP yet, so candidates have no fit score: add one with manage_icp.");
  const disqualified = new Set<string>();
  for (const candidate of candidates) {
    const fit = score(icp, candidate);
    candidate.fit_score = fit?.score ?? null;
    candidate.fit_summary = fit?.summary ?? null;
    if (fit?.disqualified) disqualified.add(candidate.id);
  }
  if (icp?.scoring.ai_refinement.enabled && candidates.length > 0) {
    try {
      const refined = await refineScores(
        ctx,
        icp,
        candidates.map((c) => ({
          id: c.id,
          score: c.fit_score,
          disqualified: disqualified.has(c.id),
          facts: c.person
            ? personFacts(c.person, c.company)
            : c.company
              ? companyFacts(c.company)
              : "",
        })),
      );
      for (const candidate of candidates) {
        const refinement = refined.get(candidate.id);
        if (!refinement) continue;
        candidate.fit_score = refinement.score;
        candidate.fit_summary =
          `${candidate.fit_summary ?? ""}; AI: ${refinement.reason.detail ?? ""}`
            .replace(/^; /, "")
            .slice(0, 400);
      }
    } catch (error) {
      warnings.push(`AI refinement skipped: ${(error as Error).message.slice(0, 200)}`);
    }
  }

  const existing = await knownRecords(ctx, request.kind, provider.id, candidates);
  for (const candidate of candidates) candidate.existing_id = existing.get(candidate.id) ?? null;
  await flagSuppressed(ctx, candidates);

  const views = candidates.map((candidate, index) => view(candidate, sources[index] as never));
  const google = isGoogleMaps(provider.id);
  if (google) {
    const noWebsite = candidates.filter((c) => !c.company?.domain).length;
    if (noWebsite > 0) {
      warnings.push(
        `${noWebsite} place(s) have no website and cannot be imported (company details come from the website).`,
      );
    }
  }
  const options: FindPreviewOptions = {
    find: true,
    kind: request.kind,
    source: request.source,
    provider: provider.id,
    criteria: request.criteria,
    icp_id: icp?.id ?? null,
    candidates: google ? candidates.map(storedForGoogle) : candidates,
    next_cursor: page.nextCursor ?? null,
    credits_used: page.creditsUsed,
    saved_search_id: request.savedSearchId ?? null,
    failure,
  };
  const preview = await createImportRow(ctx, {
    source: request.source,
    status: "previewed",
    options: options as unknown as Record<string, unknown>,
  });
  return {
    preview,
    options,
    views,
    total_available: page.total ?? null,
    credits_used: page.creditsUsed,
    import_estimate: await importEstimate(provider, request.kind, candidates.length),
    warnings,
    failure,
  };
}

/** Credits to import `count` candidates (Apollo reveals emails per matched person). */
export async function importEstimate(
  provider: LeadSourceProvider,
  kind: FindKind,
  count: number,
): Promise<CostEstimate> {
  if (kind !== "people" || !provider.enrichPeople || count === 0) {
    return { credits: 0, note: "Importing these candidates costs no credits." };
  }
  return (
    (await provider.estimate?.({ kind: "enrich", count })) ?? {
      credits: count,
      note: "Up to 1 credit per selected person.",
    }
  );
}
