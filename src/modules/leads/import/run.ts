/**
 * Import pipeline shared by file imports, find imports and saved searches: country and
 * suppression checks, in-file duplicates, company and person upserts with the merge policy,
 * list membership and ICP scoring. Dry runs go through the same steps without writing.
 */
import { and, eq } from "drizzle-orm";
import { actorRef, type OpContext, requireWorkspace } from "../../../core/context.js";
import type { ImportSource } from "../../../core/enums.js";
import { parseWorkspaceSettings, type WorkspaceSettings } from "../../../core/settings.js";
import {
  type Company,
  type Import,
  type ImportRowError,
  type ImportStats,
  imports,
  list_members,
} from "../../../db/schema/index.js";
import { externalRefs, type MergePolicy, upsertCompany, upsertPerson } from "../dedupe.js";
import { scoreAndStoreCompanies, scoreAndStorePeople } from "../icp/apply.js";
import type { ParsedIcp } from "../icp/criteria.js";
import { loadCompanies, loadPeople } from "../records.js";
import { isBlockedRoleAddress } from "../role-address.js";
import {
  findSuppressions,
  matchSuppression,
  type SuppressionCandidate,
  suppressionCandidates,
  suppressionIndex,
} from "../suppressions.js";
import { countryFromEmail } from "../tld-country.js";
import type { NormalizedRow } from "./rows.js";

export const SKIP_REASONS = [
  "duplicate",
  "suppressed",
  "invalid",
  "consent_country",
  "excluded_country",
  "no_website",
  "no_match",
  "role_address",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export interface RowOutcome {
  row: number;
  outcome: "created" | "updated" | "merged" | "skipped" | "failed";
  reason?: SkipReason;
  detail?: string;
  person_id?: string | null;
  company_id?: string | null;
}

export interface ImportTally {
  total: number;
  created: number;
  updated: number;
  merged: number;
  failed: number;
  skipped: Record<SkipReason, number>;
  companies_created: number;
  companies_updated: number;
  /** Rows that were not simply created (skips, merges, failures), capped. */
  outcomes: RowOutcome[];
  /** People created or changed (for list membership and scoring). */
  personIds: string[];
  /** Companies from company-only rows. */
  companyIds: string[];
}

export interface ImportRunOptions {
  /** Label stored on new records (csv, xlsx, apollo, google_maps, ...). */
  source: string;
  mergePolicy: MergePolicy;
  listId: string | null;
  icp: ParsedIcp | null;
  includeConsentCountries: boolean;
  importId: string | null;
}

const MAX_OUTCOMES = 500;

export function emptyTally(): ImportTally {
  return {
    total: 0,
    created: 0,
    updated: 0,
    merged: 0,
    failed: 0,
    skipped: {
      duplicate: 0,
      suppressed: 0,
      invalid: 0,
      consent_country: 0,
      excluded_country: 0,
      no_website: 0,
      no_match: 0,
      role_address: 0,
    },
    companies_created: 0,
    companies_updated: 0,
    outcomes: [],
    personIds: [],
    companyIds: [],
  };
}

/** In-file duplicate keys -> first row number. Keep one per import run. */
export type SeenKeys = Map<string, number>;

function rowKeys(row: NormalizedRow): string[] {
  const keys: string[] = [];
  const person = row.person;
  if (person) {
    if (person.email) keys.push(`email:${person.email}`);
    if (person.linkedin_url) keys.push(`linkedin:${person.linkedin_url}`);
    const name = person.full_name?.toLowerCase();
    const domain = row.company?.domain ?? row.company?.name?.toLowerCase();
    if (name && domain) keys.push(`name:${name}|${domain}`);
  } else if (row.company) {
    if (row.company.domain) keys.push(`company:${row.company.domain}`);
    const ref = externalRefs(row.company.source_refs)[0];
    if (ref) keys.push(`company_ref:${ref[0]}:${ref[1]}`);
    if (!row.company.domain && row.company.name) {
      keys.push(
        `company_name:${row.company.name.toLowerCase()}|${row.company.city?.toLowerCase() ?? ""}`,
      );
    }
  }
  return keys;
}

/** Counts a row outcome (skips and failures by reason) and keeps it for the row notes. */
export function recordOutcome(tally: ImportTally, outcome: RowOutcome): void {
  if (outcome.outcome === "skipped" && outcome.reason) tally.skipped[outcome.reason] += 1;
  if (outcome.outcome === "failed") tally.failed += 1;
  if (outcome.outcome !== "created" && tally.outcomes.length < MAX_OUTCOMES)
    tally.outcomes.push(outcome);
}

function countryCheck(
  row: NormalizedRow,
  settings: WorkspaceSettings,
  includeConsentCountries: boolean,
): RowOutcome | null {
  const recorded = row.person?.country ?? row.company?.country ?? null;
  // Without a recorded country, the email's ccTLD decides the consent rule (not exclusions).
  const fromTld = recorded ? null : countryFromEmail(row.person?.email);
  const country = recorded ?? fromTld;
  if (!country) return null;
  if (recorded && settings.compliance.excluded_countries.includes(recorded)) {
    return {
      row: row.row,
      outcome: "skipped",
      reason: "excluded_country",
      detail: `country ${country} is excluded`,
    };
  }
  const needsConsent =
    row.person?.email &&
    settings.compliance.consent_required_countries.includes(country) &&
    row.person.custom?.consent !== true;
  if (needsConsent && !includeConsentCountries) {
    return {
      row: row.row,
      outcome: "skipped",
      reason: "consent_country",
      detail: fromTld
        ? `country ${country} (from the email domain) requires recorded consent for email`
        : `country ${country} requires recorded consent for email`,
    };
  }
  return null;
}

/**
 * Processes normalized rows. `apply: false` computes the same outcomes without writing.
 * Updates and returns `tally`; `seen` tracks in-file duplicates across batches.
 */
export async function processRows(
  ctx: OpContext,
  rows: NormalizedRow[],
  options: ImportRunOptions,
  apply: boolean,
  tally: ImportTally = emptyTally(),
  seen: SeenKeys = new Map(),
): Promise<ImportTally> {
  const workspace = requireWorkspace(ctx);
  const settings = parseWorkspaceSettings(workspace.settings);

  const candidatesByRow = new Map<number, SuppressionCandidate[]>();
  for (const row of rows) {
    candidatesByRow.set(
      row.row,
      suppressionCandidates({
        email: row.person?.email ?? null,
        linkedin_url: row.person?.linkedin_url ?? null,
        company_domain: row.company?.domain ?? null,
      }),
    );
  }
  const index = suppressionIndex(
    await findSuppressions(ctx.db, workspace.id, [...candidatesByRow.values()].flat()),
  );

  for (const row of rows) {
    tally.total += 1;
    if (row.invalid) {
      recordOutcome(tally, {
        row: row.row,
        outcome: "skipped",
        reason: "invalid",
        detail: row.invalid,
      });
      continue;
    }
    if (isBlockedRoleAddress(row.person?.email)) {
      recordOutcome(tally, {
        row: row.row,
        outcome: "skipped",
        reason: "role_address",
        detail: `${row.person?.email} is a system address that never gets cold email`,
      });
      continue;
    }
    const countrySkip = countryCheck(row, settings, options.includeConsentCountries);
    if (countrySkip) {
      recordOutcome(tally, countrySkip);
      continue;
    }
    const suppression = matchSuppression(index, candidatesByRow.get(row.row) ?? []);
    if (suppression) {
      recordOutcome(tally, {
        row: row.row,
        outcome: "skipped",
        reason: "suppressed",
        detail: `${suppression.type} is suppressed (${suppression.reason})`,
      });
      continue;
    }
    const keys = rowKeys(row);
    const firstRow = keys.map((key) => seen.get(key)).find((n) => n !== undefined);
    if (firstRow !== undefined) {
      recordOutcome(tally, {
        row: row.row,
        outcome: "skipped",
        reason: "duplicate",
        detail: `same lead as row ${firstRow}`,
      });
      continue;
    }
    for (const key of keys) seen.set(key, row.row);

    try {
      await applyRow(ctx, row, options, apply, tally);
    } catch (error) {
      ctx.log.warn({ err: error, row: row.row }, "import row failed");
      recordOutcome(tally, {
        row: row.row,
        outcome: "failed",
        detail: (error as Error).message.slice(0, 200),
      });
    }
  }
  return tally;
}

async function applyRow(
  ctx: OpContext,
  row: NormalizedRow,
  options: ImportRunOptions,
  apply: boolean,
  tally: ImportTally,
): Promise<void> {
  const upsert = { policy: options.mergePolicy, apply, importId: options.importId };
  let company: Company | null = null;
  if (row.company) {
    const result = await upsertCompany(ctx, row.company, upsert);
    company = result.company;
    if (result.outcome === "created") tally.companies_created += 1;
    else if (result.outcome === "updated" || result.outcome === "merged")
      tally.companies_updated += 1;
    if (!row.person) {
      if (result.outcome === "unchanged") {
        recordOutcome(tally, {
          row: row.row,
          outcome: "skipped",
          reason: "duplicate",
          detail: "company already in the database",
          company_id: company?.id ?? null,
        });
        return;
      }
      if (result.outcome === "created") tally.created += 1;
      else if (result.outcome === "updated") tally.updated += 1;
      else tally.merged += 1;
      if (result.outcome !== "created") {
        recordOutcome(tally, {
          row: row.row,
          outcome: result.outcome,
          company_id: company?.id ?? null,
          detail: "company",
        });
      }
      if (company) tally.companyIds.push(company.id);
      return;
    }
  }
  if (!row.person) return;
  const result = await upsertPerson(ctx, row.person, {
    ...upsert,
    company,
    companyDomain: row.company?.domain ?? null,
  });
  const personId = result.person?.id ?? null;
  if (personId) tally.personIds.push(personId);
  switch (result.outcome) {
    case "created":
      tally.created += 1;
      return;
    case "updated":
      tally.updated += 1;
      recordOutcome(tally, {
        row: row.row,
        outcome: "updated",
        person_id: personId,
        detail: result.changes.join(", "),
      });
      return;
    case "merged":
      tally.merged += 1;
      recordOutcome(tally, {
        row: row.row,
        outcome: "merged",
        person_id: personId,
        detail: result.changes.join(", "),
      });
      return;
    case "unchanged":
      recordOutcome(tally, {
        row: row.row,
        outcome: "skipped",
        reason: "duplicate",
        detail: "already in the database",
        person_id: personId,
      });
  }
}

/** Adds people to a list (idempotent) and scores changed people and companies. */
export async function finishRows(
  ctx: OpContext,
  tally: ImportTally,
  options: Pick<ImportRunOptions, "listId" | "icp">,
): Promise<void> {
  const personIds = [...new Set(tally.personIds)];
  if (options.listId && personIds.length) {
    const addedBy = actorRef(ctx.principal);
    for (let i = 0; i < personIds.length; i += 500) {
      await ctx.db
        .insert(list_members)
        .values(
          personIds.slice(i, i + 500).map((person_id) => ({
            list_id: options.listId as string,
            person_id,
            added_by: addedBy,
          })),
        )
        .onConflictDoNothing();
    }
  }
  if (options.icp) {
    for (let i = 0; i < personIds.length; i += 500) {
      await scoreAndStorePeople(
        ctx,
        options.icp,
        await loadPeople(ctx, personIds.slice(i, i + 500)),
      );
    }
    const companyIds = [...new Set(tally.companyIds)];
    for (let i = 0; i < companyIds.length; i += 500) {
      await scoreAndStoreCompanies(
        ctx,
        options.icp,
        await loadCompanies(ctx, companyIds.slice(i, i + 500)),
      );
    }
  }
}

/** Import stats as stored on the imports row. */
export function tallyStats(tally: ImportTally, processed?: number): ImportStats {
  const skipped = Object.values(tally.skipped).reduce((sum, n) => sum + n, 0);
  const stats: ImportStats = {
    total: tally.total,
    created: tally.created,
    updated: tally.updated,
    merged: tally.merged,
    skipped,
    failed: tally.failed,
    suppressed: tally.skipped.suppressed,
    skipped_by_reason: { ...tally.skipped },
    companies_created: tally.companies_created,
    companies_updated: tally.companies_updated,
  };
  if (processed !== undefined) stats.processed = processed;
  return stats;
}

/** Row-level notes for the imports row (skips and failures with reason codes). */
export function tallyErrors(tally: ImportTally): ImportRowError[] {
  return tally.outcomes
    .filter((o) => o.outcome === "skipped" || o.outcome === "failed")
    .map((o) => ({
      row: o.row,
      message: o.detail ?? o.reason ?? o.outcome,
      code: o.reason ?? o.outcome,
    }));
}

/** Tally rebuilt from stored stats (to resume an import job after a retry). */
export function tallyFromStats(stats: ImportStats | null | undefined): ImportTally {
  const tally = emptyTally();
  if (!stats) return tally;
  tally.total = stats.total;
  tally.created = stats.created;
  tally.updated = stats.updated;
  tally.merged = stats.merged ?? 0;
  tally.failed = stats.failed;
  tally.companies_created = stats.companies_created ?? 0;
  tally.companies_updated = stats.companies_updated ?? 0;
  for (const reason of SKIP_REASONS) tally.skipped[reason] = stats.skipped_by_reason?.[reason] ?? 0;
  return tally;
}

/** Marks an import finished and emits import.completed. */
export async function completeImport(
  ctx: OpContext,
  importRow: Import,
  tally: ImportTally,
  status: "completed" | "partial" | "failed",
  extraErrors: ImportRowError[] = [],
): Promise<Import> {
  const stats = tallyStats(tally, tally.total);
  const options = { ...importRow.options };
  delete options.rows;
  delete options.candidates;
  const [updated] = await ctx.db
    .update(imports)
    .set({
      status,
      stats,
      errors: [...extraErrors, ...tallyErrors(tally)].slice(0, 1000),
      options,
      finished_at: ctx.clock.now(),
    })
    .where(and(eq(imports.id, importRow.id), eq(imports.workspace_id, importRow.workspace_id)))
    .returning();
  await ctx.events.emit("import.completed", {
    subject: { type: "import", id: importRow.id },
    data: {
      import_id: importRow.id,
      source: importRow.source,
      status,
      list_id: importRow.list_id,
      stats: {
        created: stats.created,
        updated: stats.updated + (stats.merged ?? 0),
        skipped: stats.skipped,
        failed: stats.failed,
      },
    },
  });
  return updated ?? importRow;
}

/** Creates the imports row for a real (non dry-run) import. */
export async function createImportRow(
  ctx: OpContext,
  values: {
    source: ImportSource;
    status: "running" | "previewed";
    fileName?: string | null;
    mapping?: Record<string, string> | null;
    options?: Record<string, unknown>;
    listId?: string | null;
  },
): Promise<Import> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .insert(imports)
    .values({
      workspace_id: workspace.id,
      source: values.source,
      status: values.status,
      file_name: values.fileName ?? null,
      mapping: values.mapping ?? null,
      options: values.options ?? {},
      list_id: values.listId ?? null,
      created_by: actorRef(ctx.principal),
    })
    .returning();
  if (!row) throw new Error("createImportRow: insert returned no row");
  return row;
}
