/**
 * Maps signal subjects (ids, domains, emails, LinkedIn URLs, names) to companies and people of
 * the workspace. Webhooks and ingest may create a company from a domain; people are never
 * created here.
 */
import { and, eq, sql } from "drizzle-orm";
import type { OpContext } from "../../core/context.js";
import { notFound, OpenOutboundError } from "../../core/errors.js";
import { type Company, companies, type Person, people } from "../../db/schema/index.js";
import { normalizeDomain, normalizeLinkedinUrl } from "../../lib/web/extract.js";
import type { RawSignal } from "../../providers/types.js";

export interface SubjectInput {
  companyId?: string | null | undefined;
  personId?: string | null | undefined;
  company?: RawSignal["company"];
  person?: RawSignal["person"];
}

export interface SubjectOptions {
  /** Create a company when none matches and a domain is known (webhook, ingest). */
  createCompanies?: boolean;
  /** Use the person's company when no company is given (default true). */
  linkPersonCompany?: boolean;
}

export interface ResolvedSubject {
  company: Company | null;
  person: Person | null;
  /** True when a company was created from the domain. */
  createdCompany: boolean;
}

async function companyById(ctx: OpContext, workspaceId: string, id: string) {
  const [row] = await ctx.db
    .select()
    .from(companies)
    .where(and(eq(companies.workspace_id, workspaceId), eq(companies.id, id)));
  return row ?? null;
}

async function personById(ctx: OpContext, workspaceId: string, id: string) {
  const [row] = await ctx.db
    .select()
    .from(people)
    .where(and(eq(people.workspace_id, workspaceId), eq(people.id, id)));
  return row ?? null;
}

async function findPerson(
  ctx: OpContext,
  workspaceId: string,
  input: SubjectInput,
): Promise<Person | null> {
  const explicitId = input.personId ?? input.person?.id;
  if (explicitId) {
    const row = await personById(ctx, workspaceId, explicitId);
    if (!row) throw notFound("Person", explicitId);
    return row;
  }
  const email = input.person?.email?.trim().toLowerCase();
  if (email) {
    const [row] = await ctx.db
      .select()
      .from(people)
      .where(and(eq(people.workspace_id, workspaceId), eq(people.email, email)));
    if (row) return row;
  }
  const linkedin = input.person?.linkedin_url
    ? normalizeLinkedinUrl(input.person.linkedin_url)
    : null;
  if (linkedin) {
    const [row] = await ctx.db
      .select()
      .from(people)
      .where(and(eq(people.workspace_id, workspaceId), eq(people.linkedin_url, linkedin)));
    if (row) return row;
  }
  return null;
}

async function findCompany(
  ctx: OpContext,
  workspaceId: string,
  input: SubjectInput,
): Promise<Company | null> {
  const explicitId = input.companyId ?? input.company?.id;
  if (explicitId) {
    const row = await companyById(ctx, workspaceId, explicitId);
    if (!row) throw notFound("Company", explicitId);
    return row;
  }
  const domain = input.company?.domain ? normalizeDomain(input.company.domain) : null;
  if (domain) {
    const [row] = await ctx.db
      .select()
      .from(companies)
      .where(and(eq(companies.workspace_id, workspaceId), eq(companies.domain, domain)));
    if (row) return row;
  }
  const linkedin = input.company?.linkedin_url
    ? normalizeLinkedinUrl(input.company.linkedin_url)
    : null;
  if (linkedin) {
    const [row] = await ctx.db
      .select()
      .from(companies)
      .where(and(eq(companies.workspace_id, workspaceId), eq(companies.linkedin_url, linkedin)));
    if (row) return row;
  }
  const name = input.company?.name?.trim();
  if (name) {
    const rows = await ctx.db
      .select()
      .from(companies)
      .where(
        and(
          eq(companies.workspace_id, workspaceId),
          sql`lower(${companies.name}) = ${name.toLowerCase()}`,
        ),
      )
      .limit(2);
    // Only an unambiguous name match counts.
    if (rows.length === 1) return rows[0] ?? null;
  }
  return null;
}

async function createCompanyFromDomain(
  ctx: OpContext,
  workspaceId: string,
  domain: string,
  name: string | null,
): Promise<{ company: Company; created: boolean }> {
  const [inserted] = await ctx.db
    .insert(companies)
    .values({
      workspace_id: workspaceId,
      name: name || domain,
      domain,
      website: `https://${domain}`,
      source: "signals",
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) {
    await ctx.events.emit("lead.created", {
      workspaceId,
      subject: { type: "company", id: inserted.id },
      data: { kind: "company", id: inserted.id, source: "signals", import_id: null },
    });
    return { company: inserted, created: true };
  }
  // Lost a race with another insert: use the existing row.
  const [existing] = await ctx.db
    .select()
    .from(companies)
    .where(and(eq(companies.workspace_id, workspaceId), eq(companies.domain, domain)));
  if (!existing) throw new Error(`Company for ${domain} vanished during insert`);
  return { company: existing, created: false };
}

/**
 * Resolves who a signal is about. Explicit ids must exist in the workspace (`not_found`
 * otherwise). Throws `validation_failed` when nothing matches.
 */
export async function resolveSubject(
  ctx: OpContext,
  workspaceId: string,
  input: SubjectInput,
  options: SubjectOptions = {},
): Promise<ResolvedSubject> {
  const person = await findPerson(ctx, workspaceId, input);
  let company = await findCompany(ctx, workspaceId, input);
  let createdCompany = false;
  if (!company && person?.company_id && options.linkPersonCompany !== false) {
    company = await companyById(ctx, workspaceId, person.company_id);
  }
  if (!company && !person && options.createCompanies) {
    const domain = input.company?.domain ? normalizeDomain(input.company.domain) : null;
    if (domain) {
      const result = await createCompanyFromDomain(
        ctx,
        workspaceId,
        domain,
        input.company?.name?.trim() || null,
      );
      company = result.company;
      createdCompany = result.created;
    }
  }
  if (!company && !person) {
    throw new OpenOutboundError(
      "validation_failed",
      "No company or person in this workspace matches the signal.",
      {
        hint: "Pass company.id, company.domain (a new company is created from the domain on ingest), person.email or person.linkedin_url.",
        details: { field: "company" },
      },
    );
  }
  return { company, person, createdCompany };
}
