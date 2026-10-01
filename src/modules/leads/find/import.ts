/**
 * Imports selected candidates of a find preview. Apollo people are revealed (emails, full
 * names, LinkedIn) only now, only for the selected people, and only on a real run.
 *
 * Reveals that fail part way (`details.partial` of the failure: the answers of the chunks that
 * went through, in order, and the credits spent) still import the people revealed. The import
 * is then `partial`, the failure is noted on it, and the candidates not reached go into a new
 * preview so a later import continues with them alone.
 *
 * Google Maps (see preview.ts): the company is stored with the place id (and when it was
 * fetched) in source_refs, the domain of its website and its country, with the domain as a
 * placeholder name. A website crawl job then fills name, address and phone from the business
 * website; when the crawl cannot run, the name stays the domain.
 */
import { and, eq } from "drizzle-orm";
import { budgetHint } from "../../../core/budget.js";
import { callFailure } from "../../../core/call-failure.js";
import { type BudgetStatus, type OpContext, requireWorkspace } from "../../../core/context.js";
import { notFound, OpenOutboundError } from "../../../core/errors.js";
import { describeFailure, type Failure, partialOf } from "../../../core/failures.js";
import { askToRaiseBudget } from "../../../core/setting-hints.js";
import { type Import, type ImportRowError, imports } from "../../../db/schema/index.js";
import type { CompanyCandidate, CostEstimate, PersonCandidate } from "../../../providers/types.js";
import { requestCompanyContacts, requestEnrichment } from "../../enrichment/service.js";
import type { CompanyFields, MergePolicy, PersonFields } from "../dedupe.js";
import { loadIcp } from "../icp/apply.js";
import { type ImportRunResult, importResult, resolveList } from "../import/import-leads.js";
import type { NormalizedRow } from "../import/rows.js";
import {
  completeImport,
  createImportRow,
  emptyTally,
  finishRows,
  type ImportTally,
  processRows,
  recordOutcome,
  type SkipReason,
} from "../import/run.js";
import {
  buildNames,
  normalizeCompanyLinkedin,
  normalizeCountry,
  normalizeEmail,
  normalizePersonLinkedin,
  normalizePhone,
  normalizeTags,
} from "../normalize.js";
import {
  type FindPreviewOptions,
  findProvider,
  importEstimate,
  isGoogleMaps,
  type StoredCandidate,
} from "./preview.js";
import type { FindCriteria } from "./query.js";

/**
 * Hint when an import costs more than the budget has left: how many candidates fit, or raise
 * the budget.
 */
export function importBudgetHint(status: BudgetStatus, perCandidate: number): string {
  const fit =
    status.remaining !== null && perCandidate > 0 ? Math.floor(status.remaining / perCandidate) : 0;
  if (fit > 0) return budgetHint(status, `Import at most ${fit} (top_n ${fit})`);
  return `Nothing fits in what is left: wait until next month, or ${askToRaiseBudget(status.setting)}.`;
}

export interface CandidateSelection {
  candidateIds?: string[] | undefined;
  topN?: number | undefined;
  minFitScore?: number | undefined;
}

export interface FindImportRequest extends CandidateSelection {
  previewId: string;
  listId?: string | undefined;
  listName?: string | undefined;
  tags?: string[] | undefined;
  mergePolicy: MergePolicy;
  includeConsentCountries: boolean;
  /** People: run the email waterfall for the imported people afterwards. */
  enrich: boolean;
  /** Companies: crawl the websites for the decision makers named there. */
  findPeople: boolean;
  /** Operation or job name for usage records. */
  operation: string;
}

export interface SelectedCandidates {
  selected: StoredCandidate[];
  skipped: Array<{ candidate: StoredCandidate; reason: SkipReason; detail: string }>;
  below_min_fit: number;
}

export interface FindImportResult extends Omit<ImportRunResult, "status"> {
  /** partial: the source failed part way; `remaining` holds the candidates not reached. */
  status: "completed" | "partial";
  credits_used: number;
  enrichment_job_id: string | null;
  contacts_job_id: string | null;
  /** The failure that cut the import short, or null. */
  failure: Failure | null;
  /** The candidates not reached, kept as a new preview to import later; null when none. */
  remaining: { preview_id: string; candidates: number } | null;
}

export interface FindImportPlan {
  preview_id: string;
  source: string;
  kind: string;
  selected: Array<{ candidate_id: string; name: string; fit_score: number | null }>;
  skipped: Array<{ candidate_id: string; reason: string; detail: string }>;
  below_min_fit: number;
  list: { id: string | null; name: string; will_create: boolean } | null;
  follow_up: string[];
  estimate: CostEstimate;
}

function invalid(message: string, hint: string, details?: Record<string, unknown>) {
  return new OpenOutboundError("validation_failed", message, {
    hint,
    ...(details ? { details } : {}),
  });
}

/** The preview row and its options; conflict when it was already imported. */
export async function loadPreview(
  ctx: OpContext,
  previewId: string,
): Promise<{ row: Import; options: FindPreviewOptions }> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select()
    .from(imports)
    .where(and(eq(imports.id, previewId), eq(imports.workspace_id, workspace.id)));
  if (!row) throw notFound("Preview", previewId);
  const options = row.options as Partial<FindPreviewOptions>;
  if (options.find !== true) {
    throw invalid(
      `${previewId} is a file import, not a find preview.`,
      "Pass the preview_id returned by find_leads action search.",
    );
  }
  if (row.status !== "previewed" || !Array.isArray(options.candidates)) {
    throw new OpenOutboundError(
      "conflict",
      `Preview ${previewId} was already imported (${row.status}).`,
      {
        hint: "Run find_leads action search again for fresh candidates, or read the result with imports.get.",
        details: { import_id: row.id, status: row.status },
      },
    );
  }
  return { row, options: options as FindPreviewOptions };
}

function fitOf(candidate: StoredCandidate): number {
  return candidate.fit_score ?? -1;
}

/** Candidates to import: explicit ids, or the best `topN` new ones, above `minFitScore`. */
export function selectCandidates(
  candidates: StoredCandidate[],
  selection: CandidateSelection,
): SelectedCandidates {
  let picked: StoredCandidate[];
  if (selection.candidateIds?.length) {
    const byId = new Map(candidates.map((c) => [c.id, c]));
    const unknown = selection.candidateIds.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      throw invalid(
        `Unknown candidate ids: ${unknown.slice(0, 10).join(", ")}.`,
        "Use candidate_id values from the find_leads search output of this preview.",
        { unknown },
      );
    }
    picked = [...new Set(selection.candidateIds)].map((id) => byId.get(id) as StoredCandidate);
  } else if (selection.topN) {
    picked = candidates
      .filter((c) => !c.existing_id && !c.suppressed)
      .map((candidate, index) => ({ candidate, index }))
      .sort((a, b) => fitOf(b.candidate) - fitOf(a.candidate) || a.index - b.index)
      .map(({ candidate }) => candidate);
  } else {
    throw invalid(
      "Say which candidates to import.",
      "Pass candidate_ids from find_leads, or top_n (optionally with min_fit_score).",
    );
  }
  let belowMinFit = 0;
  if (selection.minFitScore !== undefined) {
    const min = selection.minFitScore;
    const kept = picked.filter((c) => fitOf(c) >= min);
    belowMinFit = picked.length - kept.length;
    picked = kept;
  }
  if (selection.topN) picked = picked.slice(0, selection.topN);
  const out: SelectedCandidates = { selected: [], skipped: [], below_min_fit: belowMinFit };
  for (const candidate of picked) {
    if (candidate.existing_id) {
      out.skipped.push({
        candidate,
        reason: "duplicate",
        detail: `already in the database (${candidate.existing_id})`,
      });
    } else if (candidate.suppressed) {
      out.skipped.push({ candidate, reason: "suppressed", detail: "on the suppression list" });
    } else {
      out.selected.push(candidate);
    }
  }
  return out;
}

/** Display name of a stored candidate (Google previews keep only the domain). */
export function candidateName(candidate: StoredCandidate): string {
  return (
    candidate.person?.full_name ??
    candidate.person?.first_name ??
    candidate.company?.name ??
    candidate.company?.domain ??
    candidate.id
  );
}

function rowNumber(candidate: StoredCandidate): number {
  return Number.parseInt(candidate.id.slice(1), 10) || 0;
}

function validTimezone(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

/** The user's own words for the business type (never Google's categories). */
function industryFromSearch(criteria: FindCriteria): string | null {
  const value = criteria.industries?.[0] ?? criteria.categories?.[0] ?? null;
  return value ? value.replace(/_/g, " ") : null;
}

function googleCompany(
  candidate: StoredCandidate,
  criteria: FindCriteria,
  fetchedAt: Date,
  tags: string[],
): CompanyFields | null {
  const domain = candidate.company?.domain;
  if (!domain || !candidate.external_id) return null;
  return {
    name: domain,
    domain,
    website: `https://${domain}`,
    country: candidate.company?.country ?? null,
    industry: industryFromSearch(criteria),
    tags,
    source: "google_maps",
    source_refs: {
      google_maps: candidate.external_id,
      google_maps_fetched_at: fetchedAt.toISOString(),
    },
  };
}

function companyFields(
  company: Omit<CompanyCandidate, "raw">,
  source: string,
  tags: string[],
): CompanyFields {
  return {
    name: company.name || company.domain || null,
    domain: company.domain ?? null,
    website: company.website ?? (company.domain ? `https://${company.domain}` : null),
    linkedin_url: normalizeCompanyLinkedin(company.linkedin_url ?? null),
    industry: company.industry ?? null,
    description: company.description?.slice(0, 2000) ?? null,
    employee_count: company.employee_count ?? null,
    employee_range: company.employee_range ?? null,
    revenue_range: company.revenue_range ?? null,
    founded_year: company.founded_year ?? null,
    country: normalizeCountry(company.country ?? null),
    region: company.region ?? null,
    city: company.city ?? null,
    address: company.address ?? null,
    postal_code: company.postal_code ?? null,
    phone: normalizePhone(company.phone ?? null),
    timezone: validTimezone(company.timezone),
    technologies: company.technologies ?? [],
    tags,
    source,
    ...(company.external_id ? { source_refs: { [source]: company.external_id } } : {}),
  };
}

function personRow(
  row: number,
  person: PersonCandidate,
  fallbackCompany: Omit<CompanyCandidate, "raw"> | null,
  source: string,
  tags: string[],
  now: Date,
): NormalizedRow {
  const email = normalizeEmail(person.email ?? null);
  const linkedin = normalizePersonLinkedin(person.linkedin_url ?? null);
  const names = buildNames({
    first_name: person.first_name ?? null,
    last_name: person.last_name ?? null,
    full_name: person.full_name ?? null,
  });
  const companySource = person.company ?? fallbackCompany;
  const company = companySource ? companyFields(companySource, source, []) : null;
  const status = email ? (person.email_status ?? "unknown") : null;
  const fields: PersonFields = {
    ...names,
    title: person.title ?? null,
    seniority: person.seniority ?? null,
    department: person.department ?? null,
    email,
    email_status: status,
    email_source: email ? source : null,
    email_checked_at: status && status !== "unknown" ? now : null,
    linkedin_url: linkedin,
    phone: normalizePhone(person.phone ?? null),
    country: normalizeCountry(person.country ?? null),
    region: person.region ?? null,
    city: person.city ?? null,
    timezone: validTimezone(person.timezone),
    tags,
    source,
    ...(person.external_id ? { source_refs: { [source]: person.external_id } } : {}),
  };
  const reachable = email || linkedin || (names.full_name && company?.name);
  return {
    row,
    person: fields,
    company,
    invalid: reachable ? null : "no email, LinkedIn URL or full name with company",
    warnings: [],
  };
}

function skip(tally: ImportTally, candidate: StoredCandidate, reason: SkipReason, detail: string) {
  tally.total += 1;
  recordOutcome(tally, { row: rowNumber(candidate), outcome: "skipped", reason, detail });
}

/** What a real import would do; no provider calls and no writes. */
export async function planFindImport(
  ctx: OpContext,
  request: FindImportRequest,
): Promise<FindImportPlan> {
  const { row, options } = await loadPreview(ctx, request.previewId);
  const selection = selectCandidates(options.candidates, request);
  const { list, willCreate } = await resolveList(
    ctx,
    { list_id: request.listId, list_name: request.listName },
    false,
  );
  const google = isGoogleMaps(options.provider);
  const followUp: string[] = [];
  let estimate: CostEstimate = { credits: 0, note: "Importing these candidates costs no credits." };
  if (options.kind === "people") {
    if (selection.selected.length > 0) {
      const provider = await findProvider(ctx, options.source, options.kind);
      estimate = await importEstimate(provider, options.kind, selection.selected.length);
    }
    if (request.enrich) followUp.push("email waterfall job for the imported people (enrich)");
  } else if (google || request.findPeople) {
    followUp.push(
      request.findPeople
        ? "website crawl job: company details plus the decision makers named there (one fast AI call per company)"
        : "website crawl job: company name, address and phone from each website",
    );
  }
  return {
    preview_id: row.id,
    source: options.source,
    kind: options.kind,
    selected: selection.selected.map((c) => ({
      candidate_id: c.id,
      name: candidateName(c),
      fit_score: c.fit_score,
    })),
    skipped: selection.skipped.map((s) => ({
      candidate_id: s.candidate.id,
      reason: s.reason,
      detail: s.detail,
    })),
    below_min_fit: selection.below_min_fit,
    list: list
      ? { id: list.id, name: list.name, will_create: false }
      : willCreate
        ? { id: null, name: willCreate, will_create: true }
        : null,
    follow_up: followUp,
    estimate,
  };
}

/** Imports the selected candidates of a preview (reveals Apollo people first). */
export async function runFindImport(
  ctx: OpContext,
  request: FindImportRequest,
): Promise<FindImportResult> {
  const workspace = requireWorkspace(ctx);
  const { row, options } = await loadPreview(ctx, request.previewId);
  const selection = selectCandidates(options.candidates, request);
  const google = isGoogleMaps(options.provider);
  const source = options.provider;
  const tags = normalizeTags(request.tags ?? []);
  const now = ctx.clock.now();
  const warnings: string[] = [];
  if (selection.below_min_fit > 0) {
    warnings.push(`${selection.below_min_fit} candidate(s) below min_fit_score were left out.`);
  }

  const { list } = await resolveList(
    ctx,
    { list_id: request.listId, list_name: request.listName },
    true,
  );
  const [claimed] = await ctx.db
    .update(imports)
    .set({ status: "running", list_id: list?.id ?? null })
    .where(
      and(
        eq(imports.id, row.id),
        eq(imports.workspace_id, workspace.id),
        eq(imports.status, "previewed"),
      ),
    )
    .returning();
  if (!claimed) {
    throw new OpenOutboundError("conflict", `Preview ${row.id} is already being imported.`, {
      hint: "Wait for it to finish and read it with imports.get.",
    });
  }

  const tally = emptyTally();
  for (const skipped of selection.skipped)
    skip(tally, skipped.candidate, skipped.reason, skipped.detail);
  const rows: NormalizedRow[] = [];
  let creditsUsed = 0;
  let failure: Failure | null = null;
  // Selected candidates the source did not get to (a reveal that failed part way).
  let notReached: StoredCandidate[] = [];
  try {
    if (options.kind === "people") {
      let revealed: Array<PersonCandidate | null> = selection.selected.map((c) => ({
        ...(c.person as PersonCandidate),
        company: c.company,
        external_id: c.external_id ?? undefined,
        source,
      })) as PersonCandidate[];
      const provider =
        selection.selected.length > 0
          ? await findProvider(ctx, options.source, options.kind)
          : null;
      if (provider?.enrichPeople) {
        const count = selection.selected.length;
        const estimate = await importEstimate(provider, options.kind, count);
        await ctx.usage.assertCanSpend(workspace.id, "data", estimate.credits, {
          hint: (status) => importBudgetHint(status, estimate.credits / count),
        });
        let result: { items: Array<PersonCandidate | null>; creditsUsed: number };
        try {
          result = await provider.enrichPeople(revealed as PersonCandidate[]);
        } catch (error) {
          // Answers of the chunks that went through: candidates[i] for i < items.length.
          const partial = partialOf<PersonCandidate | null>(error);
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
          result = { items: partial.items.slice(0, count), creditsUsed: spent };
          notReached = selection.selected.slice(result.items.length);
        }
        revealed = result.items;
        creditsUsed = result.creditsUsed;
        if (creditsUsed > 0 && !failure) {
          await ctx.usage.record({
            slot: "lead_source",
            provider: provider.id,
            operation: request.operation,
            credits: creditsUsed,
          });
        }
      }
      const reached = selection.selected.length - notReached.length;
      selection.selected.slice(0, reached).forEach((candidate, index) => {
        const person = revealed[index];
        if (!person) {
          skip(tally, candidate, "no_match", `${source} found no match for this person`);
          return;
        }
        rows.push(personRow(rowNumber(candidate), person, candidate.company, source, tags, now));
      });
    } else {
      for (const candidate of selection.selected) {
        if (google) {
          const company = googleCompany(candidate, options.criteria, now, tags);
          if (!company) {
            skip(tally, candidate, "no_website", "the place has no website to take details from");
            continue;
          }
          rows.push({
            row: rowNumber(candidate),
            person: null,
            company,
            invalid: null,
            warnings: [],
          });
        } else if (candidate.company) {
          rows.push({
            row: rowNumber(candidate),
            person: null,
            company: companyFields(candidate.company, source, tags),
            invalid: null,
            warnings: [],
          });
        }
      }
    }
  } catch (error) {
    await ctx.db
      .update(imports)
      .set({ status: "previewed" })
      .where(and(eq(imports.id, row.id), eq(imports.workspace_id, workspace.id)));
    throw error;
  }

  const icp = await loadIcp(ctx, options.icp_id).catch(() => loadIcp(ctx));
  const runOptions = {
    source,
    mergePolicy: request.mergePolicy,
    listId: list?.id ?? null,
    icp,
    includeConsentCountries: request.includeConsentCountries,
    importId: row.id,
  };
  await processRows(ctx, rows, runOptions, true, tally);
  await finishRows(ctx, tally, runOptions);
  let remaining: FindImportResult["remaining"] = null;
  const notes: ImportRowError[] = [];
  if (failure) {
    if (notReached.length > 0) {
      // The rest stays importable on its own, with nothing revealed or charged twice.
      const rest = await createImportRow(ctx, {
        source: row.source,
        status: "previewed",
        options: {
          ...options,
          candidates: notReached,
          next_cursor: null,
          credits_used: 0,
          failure: null,
        } as unknown as Record<string, unknown>,
      });
      remaining = { preview_id: rest.id, candidates: notReached.length };
    }
    const what = `${source} failed part way (${describeFailure(failure)})`;
    const rest = remaining
      ? `; ${remaining.candidates} candidate(s) were not reached: import preview ${remaining.preview_id} with find_leads action import to continue`
      : "";
    warnings.push(`${what}${rest}.`);
    notes.push({ row: 0, code: "provider_failed", message: `${what}${rest}.`.slice(0, 500) });
  }
  const done = await completeImport(
    ctx,
    {
      ...claimed,
      options: {
        ...claimed.options,
        credits_used: options.credits_used + creditsUsed,
        ...(failure ? { failure, remaining_preview_id: remaining?.preview_id ?? null } : {}),
      },
    },
    tally,
    failure ? "partial" : "completed",
    notes,
  );

  let contactsJobId: string | null = null;
  let enrichmentJobId: string | null = null;
  if (options.kind === "companies" && (google || request.findPeople) && tally.companyIds.length) {
    const job = await requestCompanyContacts(ctx, {
      companyIds: tally.companyIds,
      findPeople: request.findPeople,
      listId: list?.id ?? null,
    });
    contactsJobId = job?.jobId ?? null;
  }
  if (options.kind === "people" && request.enrich && tally.personIds.length) {
    const job = await requestEnrichment(ctx, {
      personIds: tally.personIds,
      mode: "find_and_verify",
    });
    enrichmentJobId = job.jobId;
  }
  return {
    ...importResult(done.id, tally, list?.id ?? null, warnings),
    status: failure ? "partial" : "completed",
    credits_used: creditsUsed,
    enrichment_job_id: enrichmentJobId,
    contacts_job_id: contactsJobId,
    failure,
    remaining,
  };
}
