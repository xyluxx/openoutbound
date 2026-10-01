/**
 * Find-or-create for companies and people with a merge policy. Used by imports, find,
 * enrichment and the create operations, so every path dedupes the same way.
 *
 * Company keys, in order: domain, (name + city) for local businesses, external ids in
 * source_refs. Person keys: email, LinkedIn URL, (full name + company domain), external ids.
 * Merge policies: fill_empty (default) only fills empty fields, overwrite replaces provided
 * fields, skip leaves the existing record alone. Status is never changed by a merge.
 */
import { and, eq, ne, type SQL, sql } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import type { EmailStatus } from "../../core/enums.js";
import {
  type Company,
  type CustomFields,
  companies,
  type NewCompany,
  type NewPerson,
  type Person,
  people,
  type SourceRefs,
} from "../../db/schema/index.js";

export const MERGE_POLICIES = ["fill_empty", "overwrite", "skip"] as const;
export type MergePolicy = (typeof MERGE_POLICIES)[number];

/** created = new row; updated = overwrite changed fields; merged = fill_empty filled fields; unchanged = matched, nothing new. */
export type UpsertOutcome = "created" | "updated" | "merged" | "unchanged";

export interface CompanyFields {
  name?: string | null;
  domain?: string | null;
  website?: string | null;
  linkedin_url?: string | null;
  industry?: string | null;
  description?: string | null;
  employee_count?: number | null;
  employee_range?: string | null;
  revenue_range?: string | null;
  founded_year?: number | null;
  country?: string | null;
  region?: string | null;
  city?: string | null;
  address?: string | null;
  postal_code?: string | null;
  phone?: string | null;
  timezone?: string | null;
  technologies?: string[];
  tags?: string[];
  custom?: CustomFields;
  source?: string | null;
  source_refs?: SourceRefs;
}

export interface PersonFields {
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  title?: string | null;
  seniority?: string | null;
  department?: string | null;
  email?: string | null;
  email_status?: EmailStatus | null;
  email_source?: string | null;
  email_checked_at?: Date | null;
  linkedin_url?: string | null;
  phone?: string | null;
  country?: string | null;
  region?: string | null;
  city?: string | null;
  timezone?: string | null;
  language?: string | null;
  tags?: string[];
  custom?: CustomFields;
  source?: string | null;
  source_refs?: SourceRefs;
}

const COMPANY_SCALARS = [
  "name",
  "domain",
  "website",
  "linkedin_url",
  "industry",
  "description",
  "employee_count",
  "employee_range",
  "revenue_range",
  "founded_year",
  "country",
  "region",
  "city",
  "address",
  "postal_code",
  "phone",
  "timezone",
] as const satisfies ReadonlyArray<keyof CompanyFields & keyof Company>;

const PERSON_SCALARS = [
  "first_name",
  "last_name",
  "full_name",
  "title",
  "seniority",
  "department",
  "linkedin_url",
  "phone",
  "country",
  "region",
  "city",
  "timezone",
  "language",
] as const satisfies ReadonlyArray<keyof PersonFields & keyof Person>;

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

/** Error from a unique index (pg and PGlite report SQLSTATE 23505, possibly wrapped by drizzle). */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    if (typeof current === "object" && (current as { code?: unknown }).code === "23505")
      return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * `<source>_fetched_at` style keys in source_refs hold dates (for example when a Google place
 * id was fetched), not external ids: they never identify a record and are always refreshed.
 */
export function isRefTimestamp(key: string): boolean {
  return key.endsWith("_at");
}

/** External id entries of source_refs (timestamps left out). */
export function externalRefs(refs: SourceRefs | null | undefined): Array<[string, string]> {
  return Object.entries(refs ?? {}).filter(([key, value]) => key && value && !isRefTimestamp(key));
}

function refConditions(
  column: typeof companies.source_refs | typeof people.source_refs,
  refs?: SourceRefs,
): SQL[] {
  return externalRefs(refs).map(([key, value]) => sql`${column} ->> ${key} = ${value}`);
}

// --- Companies -------------------------------------------------------------------------------

/** Existing company for these fields: domain, then name + city, then external ids. */
export async function findCompany(ctx: OpContext, fields: CompanyFields): Promise<Company | null> {
  const workspace = requireWorkspace(ctx);
  if (fields.domain) {
    const [row] = await ctx.db
      .select()
      .from(companies)
      .where(and(eq(companies.workspace_id, workspace.id), eq(companies.domain, fields.domain)));
    if (row) return row;
  }
  if (fields.name && fields.city) {
    const [row] = await ctx.db
      .select()
      .from(companies)
      .where(
        and(
          eq(companies.workspace_id, workspace.id),
          sql`lower(${companies.name}) = lower(${fields.name})`,
          sql`lower(${companies.city}) = lower(${fields.city})`,
        ),
      )
      .limit(1);
    if (row) return row;
  }
  for (const condition of refConditions(companies.source_refs, fields.source_refs)) {
    const [row] = await ctx.db
      .select()
      .from(companies)
      .where(and(eq(companies.workspace_id, workspace.id), condition))
      .limit(1);
    if (row) return row;
  }
  // Same name, nothing else known on either side (rows of one file naming the same company).
  if (fields.name && !fields.domain && !fields.city) {
    const [row] = await ctx.db
      .select()
      .from(companies)
      .where(
        and(
          eq(companies.workspace_id, workspace.id),
          sql`lower(${companies.name}) = lower(${fields.name})`,
          sql`${companies.domain} is null`,
          sql`${companies.city} is null`,
        ),
      )
      .limit(1);
    if (row) return row;
  }
  return null;
}

/** Patch for an existing company under the policy, plus changed field names. */
export function companyPatch(
  existing: Company,
  fields: CompanyFields,
  policy: MergePolicy,
): { patch: Partial<NewCompany>; changes: string[] } {
  const patch: Partial<NewCompany> = {};
  const changes: string[] = [];
  if (policy === "skip") return { patch, changes };
  for (const key of COMPANY_SCALARS) {
    const value = fields[key];
    if (isEmpty(value)) continue;
    const current = existing[key];
    if (policy === "fill_empty" ? isEmpty(current) : current !== value) {
      (patch as Record<string, unknown>)[key] = value;
      changes.push(key);
    }
  }
  mergeArrays(existing.technologies, fields.technologies, "technologies", patch, changes);
  mergeArrays(existing.tags, fields.tags, "tags", patch, changes);
  mergeObject(existing.custom, fields.custom, policy, "custom", patch, changes);
  mergeObject(
    existing.source_refs,
    fields.source_refs,
    "fill_empty",
    "source_refs",
    patch,
    changes,
  );
  return { patch, changes };
}

function mergeArrays(
  current: string[] | null | undefined,
  incoming: string[] | undefined,
  key: "tags" | "technologies",
  patch: Record<string, unknown>,
  changes: string[],
): void {
  if (!incoming?.length) return;
  const existing = current ?? [];
  const lower = new Set(existing.map((v) => v.toLowerCase()));
  const added = incoming.filter((v) => !lower.has(v.toLowerCase()));
  if (added.length === 0) return;
  patch[key] = [...existing, ...added];
  changes.push(key);
}

function mergeObject(
  current: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown> | undefined,
  policy: MergePolicy,
  key: "custom" | "source_refs",
  patch: Record<string, unknown>,
  changes: string[],
): void {
  if (!incoming || Object.keys(incoming).length === 0) return;
  const existing = current ?? {};
  const next: Record<string, unknown> = { ...existing };
  let changed = false;
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined) continue;
    const has = k in existing && !isEmpty(existing[k]);
    const differs = JSON.stringify(existing[k]) !== JSON.stringify(v);
    const refresh = key === "source_refs" && isRefTimestamp(k);
    if (refresh ? differs : policy === "fill_empty" ? !has : differs) {
      next[k] = v;
      changed = true;
    }
  }
  if (changed) {
    patch[key] = next;
    changes.push(key);
  }
}

export interface UpsertOptions {
  policy: MergePolicy;
  /** false = compute the outcome without writing (dry runs). */
  apply: boolean;
  /** For lead.created events. */
  importId?: string | null;
}

/** Finds or creates a company. With `apply: false` nothing is written (company may be null). */
export async function upsertCompany(
  ctx: OpContext,
  fields: CompanyFields,
  options: UpsertOptions,
): Promise<{ company: Company | null; outcome: UpsertOutcome; changes: string[] }> {
  const workspace = requireWorkspace(ctx);
  const existing = await findCompany(ctx, fields);
  if (existing) return mergeCompany(ctx, existing, fields, options);
  if (!fields.name && !fields.domain) return { company: null, outcome: "unchanged", changes: [] };
  if (!options.apply) return { company: null, outcome: "created", changes: [] };
  const values: NewCompany = {
    workspace_id: workspace.id,
    name: fields.name ?? fields.domain ?? "Unknown company",
    technologies: fields.technologies ?? [],
    tags: fields.tags ?? [],
    custom: fields.custom ?? {},
    source_refs: fields.source_refs ?? {},
  };
  for (const key of COMPANY_SCALARS) {
    if (key === "name") continue;
    const value = fields[key];
    if (!isEmpty(value)) (values as Record<string, unknown>)[key] = value;
  }
  if (fields.source) values.source = fields.source;
  try {
    const [company] = await ctx.db.insert(companies).values(values).returning();
    if (!company) throw new Error("insert returned no row");
    await ctx.events.emit("lead.created", {
      subject: { type: "company", id: company.id },
      data: {
        kind: "company",
        id: company.id,
        source: company.source,
        import_id: options.importId ?? null,
      },
    });
    return { company, outcome: "created", changes: [] };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await findCompany(ctx, fields);
    if (!raced) throw error;
    return mergeCompany(ctx, raced, fields, options);
  }
}

async function mergeCompany(
  ctx: OpContext,
  existing: Company,
  fields: CompanyFields,
  options: UpsertOptions,
): Promise<{ company: Company; outcome: UpsertOutcome; changes: string[] }> {
  const { patch, changes } = companyPatch(existing, fields, options.policy);
  if (patch.domain && patch.domain !== existing.domain) {
    const [clash] = await ctx.db
      .select({ id: companies.id })
      .from(companies)
      .where(
        and(
          eq(companies.workspace_id, existing.workspace_id),
          eq(companies.domain, patch.domain),
          ne(companies.id, existing.id),
        ),
      );
    if (clash) {
      delete patch.domain;
      changes.splice(changes.indexOf("domain"), 1);
    }
  }
  if (changes.length === 0) return { company: existing, outcome: "unchanged", changes };
  const outcome: UpsertOutcome = options.policy === "overwrite" ? "updated" : "merged";
  if (!options.apply) return { company: { ...existing, ...patch } as Company, outcome, changes };
  const [updated] = await ctx.db
    .update(companies)
    .set(patch)
    .where(eq(companies.id, existing.id))
    .returning();
  await ctx.events.emit("lead.updated", {
    subject: { type: "company", id: existing.id },
    data: { kind: "company", id: existing.id, changes },
  });
  return { company: updated ?? existing, outcome, changes };
}

// --- People ----------------------------------------------------------------------------------

/** Existing person: email, then LinkedIn URL, then full name + company domain, then external ids. */
export async function findPerson(
  ctx: OpContext,
  fields: PersonFields,
  company?: { id?: string | null; domain?: string | null } | null,
): Promise<Person | null> {
  const workspace = requireWorkspace(ctx);
  if (fields.email) {
    const [row] = await ctx.db
      .select()
      .from(people)
      .where(and(eq(people.workspace_id, workspace.id), eq(people.email, fields.email)));
    if (row) return row;
  }
  if (fields.linkedin_url) {
    const [row] = await ctx.db
      .select()
      .from(people)
      .where(
        and(eq(people.workspace_id, workspace.id), eq(people.linkedin_url, fields.linkedin_url)),
      );
    if (row) return row;
  }
  const fullName =
    fields.full_name ?? ([fields.first_name, fields.last_name].filter(Boolean).join(" ") || null);
  if (fullName && (company?.domain || company?.id)) {
    const byCompany = company.id
      ? sql`${people.company_id} = ${company.id}`
      : sql`exists (select 1 from ${companies} c where c.id = ${people.company_id} and c.domain = ${company.domain})`;
    const [row] = await ctx.db
      .select()
      .from(people)
      .where(
        and(
          eq(people.workspace_id, workspace.id),
          sql`lower(coalesce(${people.full_name}, concat_ws(' ', ${people.first_name}, ${people.last_name}))) = lower(${fullName})`,
          byCompany,
        ),
      )
      .limit(1);
    if (row) return row;
  }
  for (const condition of refConditions(people.source_refs, fields.source_refs)) {
    const [row] = await ctx.db
      .select()
      .from(people)
      .where(and(eq(people.workspace_id, workspace.id), condition))
      .limit(1);
    if (row) return row;
  }
  return null;
}

/** Patch for an existing person under the policy (email moves with its status and source). */
export function personPatch(
  existing: Person,
  fields: PersonFields,
  policy: MergePolicy,
  companyId?: string | null,
): { patch: Partial<NewPerson>; changes: string[] } {
  const patch: Partial<NewPerson> = {};
  const changes: string[] = [];
  if (policy === "skip") return { patch, changes };
  for (const key of PERSON_SCALARS) {
    const value = fields[key];
    if (isEmpty(value)) continue;
    const current = existing[key];
    if (policy === "fill_empty" ? isEmpty(current) : current !== value) {
      (patch as Record<string, unknown>)[key] = value;
      changes.push(key);
    }
  }
  if (
    fields.email &&
    (policy === "fill_empty" ? !existing.email : existing.email !== fields.email)
  ) {
    patch.email = fields.email;
    patch.email_status = fields.email_status ?? "unknown";
    patch.email_source = fields.email_source ?? fields.source ?? null;
    patch.email_checked_at = fields.email_checked_at ?? null;
    changes.push("email");
  } else if (
    fields.email &&
    existing.email === fields.email &&
    fields.email_status &&
    fields.email_status !== "unknown" &&
    (existing.email_status === "unknown" || policy === "overwrite") &&
    existing.email_status !== fields.email_status
  ) {
    patch.email_status = fields.email_status;
    if (fields.email_checked_at) patch.email_checked_at = fields.email_checked_at;
    changes.push("email_status");
  }
  if (
    companyId &&
    (policy === "fill_empty" ? !existing.company_id : existing.company_id !== companyId)
  ) {
    patch.company_id = companyId;
    changes.push("company_id");
  }
  mergeArrays(existing.tags, fields.tags, "tags", patch, changes);
  mergeObject(existing.custom, fields.custom, policy, "custom", patch, changes);
  mergeObject(
    existing.source_refs,
    fields.source_refs,
    "fill_empty",
    "source_refs",
    patch,
    changes,
  );
  return { patch, changes };
}

/** Finds or creates a person. With `apply: false` nothing is written (person may be null). */
export async function upsertPerson(
  ctx: OpContext,
  fields: PersonFields,
  options: UpsertOptions & { company?: Company | null; companyDomain?: string | null },
): Promise<{ person: Person | null; outcome: UpsertOutcome; changes: string[] }> {
  const workspace = requireWorkspace(ctx);
  const company = options.company ?? null;
  const matchCompany =
    company ?? (options.companyDomain ? { domain: options.companyDomain } : null);
  const existing = await findPerson(ctx, fields, matchCompany);
  if (existing) return mergePerson(ctx, existing, fields, options);
  if (!options.apply) return { person: null, outcome: "created", changes: [] };
  const values: NewPerson = {
    workspace_id: workspace.id,
    company_id: company?.id ?? null,
    tags: fields.tags ?? [],
    custom: fields.custom ?? {},
    source_refs: fields.source_refs ?? {},
    email: fields.email ?? null,
    email_status: fields.email ? (fields.email_status ?? "unknown") : "unknown",
    email_source: fields.email ? (fields.email_source ?? fields.source ?? null) : null,
    email_checked_at: fields.email ? (fields.email_checked_at ?? null) : null,
    source: fields.source ?? null,
  };
  for (const key of PERSON_SCALARS) {
    const value = fields[key];
    if (!isEmpty(value)) (values as Record<string, unknown>)[key] = value;
  }
  try {
    const [person] = await ctx.db.insert(people).values(values).returning();
    if (!person) throw new Error("insert returned no row");
    await ctx.events.emit("lead.created", {
      subject: { type: "person", id: person.id },
      data: {
        kind: "person",
        id: person.id,
        source: person.source,
        import_id: options.importId ?? null,
      },
    });
    return { person, outcome: "created", changes: [] };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await findPerson(ctx, fields, matchCompany);
    if (!raced) throw error;
    return mergePerson(ctx, raced, fields, options);
  }
}

async function mergePerson(
  ctx: OpContext,
  existing: Person,
  fields: PersonFields,
  options: UpsertOptions & { company?: Company | null },
): Promise<{ person: Person; outcome: UpsertOutcome; changes: string[] }> {
  const { patch, changes } = personPatch(
    existing,
    fields,
    options.policy,
    options.company?.id ?? null,
  );
  // Never steal a unique email or LinkedIn URL from another person.
  for (const key of ["email", "linkedin_url"] as const) {
    const value = patch[key];
    if (!value) continue;
    const [clash] = await ctx.db
      .select({ id: people.id })
      .from(people)
      .where(
        and(
          eq(people.workspace_id, existing.workspace_id),
          eq(people[key], value),
          ne(people.id, existing.id),
        ),
      );
    if (clash) {
      delete patch[key];
      if (key === "email") {
        delete patch.email_status;
        delete patch.email_source;
        delete patch.email_checked_at;
      }
      changes.splice(changes.indexOf(key), 1);
    }
  }
  if (changes.length === 0) return { person: existing, outcome: "unchanged", changes };
  const outcome: UpsertOutcome = options.policy === "overwrite" ? "updated" : "merged";
  if (!options.apply) return { person: { ...existing, ...patch } as Person, outcome, changes };
  const [updated] = await ctx.db
    .update(people)
    .set(patch)
    .where(eq(people.id, existing.id))
    .returning();
  await ctx.events.emit("lead.updated", {
    subject: { type: "person", id: existing.id },
    data: { kind: "person", id: existing.id, changes },
  });
  return { person: updated ?? existing, outcome, changes };
}
