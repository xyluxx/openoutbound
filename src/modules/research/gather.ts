/**
 * Source gathering for briefs: the company's own site (safe fetch, robots respected), web
 * search through the configured research provider (news, hiring, person mentions) and the
 * strongest active signals. Every step degrades gracefully and reports a warning instead of
 * failing the brief. Each web search first checks that the data budget has room for it.
 *
 * A provider call that fails is a gap (`failed`, with the failure), so the brief is partial,
 * never ready as if nothing was there. After a failure of the provider's account or of the whole
 * provider, the job stops asking it: the remaining searches are gaps without a call. Searches
 * that answered are kept with their results (`kept`); a later run that completes a partial
 * brief reuses them and asks only what failed.
 */
import { answeredDespiteFailure, callFailure, stopsProvider } from "../../core/call-failure.js";
import type { JobContext } from "../../core/context.js";
import { isOpenOutboundError } from "../../core/errors.js";
import type { Failure } from "../../core/failures.js";
import type {
  Company,
  KeptSearch,
  Person,
  ResearchGap,
  ResearchGaps,
} from "../../db/schema/index.js";
import type { ResearchProvider, SearchOptions } from "../../providers/types.js";
import { crawlSite } from "../knowledge/service.js";
import { getActiveSignals, type SignalWithScore } from "../signals/service.js";
import { personName } from "./targets.js";

export type SourceKind = "website" | "search" | "signal" | "lead_record" | "company_brief";

export interface GatheredSource {
  url: string;
  title: string | null;
  published_at: string | null;
  kind: SourceKind;
  /** Untrusted text from the web or the lead record. */
  text: string;
}

export interface GatherResult {
  sources: GatheredSource[];
  signalIds: string[];
  warnings: string[];
  /** Research provider used for web search, when any. */
  searchProvider: string | null;
  creditsUsed: number;
  /** Provider calls that failed: the brief is partial. */
  failed: ResearchGap[];
  /** Searches that answered, with their results, for a later run that fills the gaps. */
  kept: KeptSearch[];
}

export interface GatherOptions {
  /** The gaps of the partial brief this run completes: kept searches are reused, not paid. */
  fill?: ResearchGaps | null;
  /** Providers the job stopped asking, with the failure (shared by the briefs of one job). */
  stopped?: Map<string, Failure>;
}

const MAX_SIGNALS = 3;
const PAGE_TEXT_CHARS = 2_500;

interface SearchPlan {
  query: string;
  options: SearchOptions;
}

/** A company brief searches for news and for hiring. */
function companySearches(name: string): SearchPlan[] {
  return [
    { query: `"${name}" news`, options: { limit: 5, recencyDays: 180 } },
    { query: `"${name}" hiring jobs`, options: { limit: 4, recencyDays: 90 } },
  ];
}

/** A person brief searches once, for the person (with the company name when known). */
function personSearches(query: string): SearchPlan[] {
  return [{ query, options: { limit: 5 } }];
}

/** Web searches per brief, for cost estimates (at most; a brief without a name searches less). */
export const WEB_SEARCHES = {
  company: companySearches("").length,
  person: personSearches("").length,
} as const;

export async function gatherCompanySources(
  ctx: JobContext,
  company: Company,
  options: GatherOptions = {},
): Promise<GatherResult> {
  const result = emptyResult();
  const site = company.website?.trim() || company.domain?.trim();
  if (site && ctx.workspace?.is_sandbox) {
    await sandboxSite(ctx, result, site, options);
  } else if (site) {
    try {
      const crawl = await crawlSite(ctx, site, {
        maxPages: 4,
        plan: [
          ["about", 1],
          ["blog", 1],
          ["careers", 1],
        ],
        guessPaths: false,
        maxCharsPerPage: PAGE_TEXT_CHARS,
      });
      for (const page of crawl.pages) {
        result.sources.push({
          url: page.url,
          title: page.title,
          published_at: null,
          kind: "website",
          text: page.text,
        });
      }
      if (crawl.pages.length === 0) {
        result.warnings.push(`Could not read ${site} (${crawl.skipped[0]?.reason ?? "no pages"}).`);
      }
    } catch (error) {
      result.warnings.push(`Could not read ${site}: ${message(error)}`);
    }
  } else {
    result.warnings.push("The company has no website or domain; skipped its site.");
  }

  const name = company.name.trim();
  if (name) await searchWeb(ctx, result, companySearches(name), options);
  await addSignals(ctx, result, { companyId: company.id });
  return result;
}

export async function gatherPersonSources(
  ctx: JobContext,
  person: Person,
  company: Company | null,
  options: GatherOptions = {},
): Promise<GatherResult> {
  const result = emptyResult();
  const name = personName(person);
  if (person.linkedin_url) {
    result.sources.push({
      url: person.linkedin_url,
      title: `${name} (LinkedIn profile, from the lead record)`,
      published_at: null,
      kind: "lead_record",
      text: [
        person.title ? `Title: ${person.title}` : null,
        company ? `Company: ${company.name}` : null,
        person.seniority ? `Seniority: ${person.seniority}` : null,
        person.department ? `Department: ${person.department}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }
  if (name && name !== person.email && name !== person.id) {
    const query = company ? `"${name}" "${company.name}"` : `"${name}" ${person.title ?? ""}`;
    await searchWeb(ctx, result, personSearches(query.trim()), options);
  }
  await addSignals(ctx, result, { personId: person.id });
  return result;
}

/**
 * Sandbox workspaces never touch the real network: the company home page comes from the
 * (sandbox) research provider's fetch instead of a crawl.
 */
async function sandboxSite(
  ctx: JobContext,
  result: GatherResult,
  site: string,
  options: GatherOptions,
) {
  const url = /^https?:\/\//i.test(site) ? site : `https://${site}/`;
  const provider = await ctx.providers.tryGet("research").catch(() => null);
  if (!provider?.fetch) {
    result.warnings.push("Sandbox workspace: skipped the company site (no sandbox fetch).");
    return;
  }
  const stopped = options.stopped?.get(provider.id);
  if (stopped) {
    result.failed.push({ source: "website", target: url, failure: stopped });
    return;
  }
  try {
    const page = await provider.fetch(url);
    result.sources.push({
      url: page.url,
      title: page.title ?? null,
      published_at: page.publishedAt ?? null,
      kind: "website",
      text: page.text.slice(0, PAGE_TEXT_CHARS),
    });
  } catch (error) {
    const failure = callFailure(error, provider.id);
    result.failed.push({ source: "website", target: url, failure });
    if (stopsProvider(failure)) options.stopped?.set(provider.id, failure);
    result.warnings.push(`Could not read ${url}: ${message(error)}`);
  }
}

function emptyResult(): GatherResult {
  return {
    sources: [],
    signalIds: [],
    warnings: [],
    searchProvider: null,
    creditsUsed: 0,
    failed: [],
    kept: [],
  };
}

/** Adds search results as sources, skipping URLs already gathered. */
function addResults(result: GatherResult, kept: KeptSearch) {
  const seen = new Set(result.sources.map((source) => source.url));
  for (const item of kept.results) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    result.sources.push({
      url: item.url,
      title: item.title,
      published_at: item.published_at,
      kind: "search",
      text: item.snippet ?? "",
    });
  }
  result.kept.push(kept);
}

async function searchWeb(
  ctx: JobContext,
  result: GatherResult,
  plans: SearchPlan[],
  options: GatherOptions,
) {
  const workspace = ctx.workspace;
  if (!workspace) return;
  const reusable = new Map((options.fill?.kept ?? []).map((kept) => [kept.query, kept]));
  const toAsk = plans.filter((plan) => !reusable.has(plan.query));
  // Searches the partial brief already got are reused for free.
  for (const plan of plans) {
    const kept = reusable.get(plan.query);
    if (kept) addResults(result, kept);
  }
  if (toAsk.length === 0) return;
  let provider: ResearchProvider | null;
  try {
    provider = await ctx.providers.tryGet("research");
  } catch (error) {
    result.warnings.push(`Research provider unavailable: ${message(error)}`);
    return;
  }
  if (!provider) {
    result.warnings.push(
      "No research provider configured: skipped web search (configure parallel, exa, tavily or firecrawl).",
    );
    return;
  }
  const credits = provider.creditsPerCall?.search ?? 1;
  const charge = async () => {
    result.creditsUsed += credits;
    await ctx.usage.record({
      slot: "research",
      provider: provider.id,
      operation: "research.run",
      credits,
      jobId: ctx.job.id,
    });
  };
  for (const [index, plan] of toAsk.entries()) {
    // The job stopped asking this provider (its account or the provider failed): a gap.
    const stopped = options.stopped?.get(provider.id);
    if (stopped) {
      result.failed.push({ source: "search", target: plan.query, failure: stopped });
      continue;
    }
    // Pre-spend check: a search runs only when what is left of the data budget covers it.
    try {
      await ctx.usage.assertCanSpend(workspace.id, "data", credits);
    } catch (error) {
      if (!isOpenOutboundError(error) || error.code !== "budget_exceeded") throw error;
      const skipped = toAsk.length - index;
      result.warnings.push(
        `${error.message} ${
          skipped === plans.length
            ? "Skipped web search."
            : `Skipped the last ${skipped === 1 ? "web search" : `${skipped} web searches`}.`
        }`,
      );
      return;
    }
    result.searchProvider = provider.id;
    try {
      const found = await provider.search(plan.query, plan.options);
      await charge();
      addResults(result, {
        query: plan.query,
        results: found.map((item) => ({
          url: item.url,
          title: item.title,
          snippet: item.snippet ?? null,
          published_at: item.publishedAt ?? null,
        })),
      });
    } catch (error) {
      if (isOpenOutboundError(error) && error.code === "unsupported") {
        result.warnings.push(`Web search failed (${provider.id}): ${message(error)}`);
        break;
      }
      const failure = callFailure(error, provider.id);
      if (answeredDespiteFailure(failure)) await charge();
      result.failed.push({ source: "search", target: plan.query, failure });
      if (stopsProvider(failure)) options.stopped?.set(provider.id, failure);
      result.warnings.push(`Web search failed (${provider.id}): ${message(error)}`);
    }
  }
}

async function addSignals(
  ctx: JobContext,
  result: GatherResult,
  target: { companyId?: string; personId?: string },
) {
  let signals: SignalWithScore[];
  try {
    signals = await getActiveSignals(ctx, { ...target, limit: MAX_SIGNALS });
  } catch (error) {
    result.warnings.push(`Signals unavailable: ${message(error)}`);
    return;
  }
  const seen = new Set(result.sources.map((source) => source.url));
  for (const signal of signals.slice(0, MAX_SIGNALS)) {
    result.signalIds.push(signal.id);
    if (!signal.evidence_url || seen.has(signal.evidence_url)) continue;
    seen.add(signal.evidence_url);
    result.sources.push({
      url: signal.evidence_url,
      title: `Signal (${signal.definition_key}): ${signal.title}`,
      published_at: (signal.occurred_at ?? signal.detected_at)?.toISOString().slice(0, 10) ?? null,
      kind: "signal",
      text: [signal.summary, signal.evidence_excerpt].filter(Boolean).join("\n"),
    });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
