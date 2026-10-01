/** Workspace-scoped loading of people and companies, and small record updates. */
import { and, eq, inArray } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import type { PersonStatus } from "../../core/enums.js";
import { notFound } from "../../core/errors.js";
import { type Company, companies, type Person, people } from "../../db/schema/index.js";

export async function loadPerson(ctx: OpContext, personId: string): Promise<Person | null> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select()
    .from(people)
    .where(and(eq(people.id, personId), eq(people.workspace_id, workspace.id)));
  return row ?? null;
}

export async function requirePerson(ctx: OpContext, personId: string): Promise<Person> {
  const person = await loadPerson(ctx, personId);
  if (!person) throw notFound("Person", personId);
  return person;
}

export async function loadCompany(ctx: OpContext, companyId: string): Promise<Company | null> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select()
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.workspace_id, workspace.id)));
  return row ?? null;
}

export async function requireCompany(ctx: OpContext, companyId: string): Promise<Company> {
  const company = await loadCompany(ctx, companyId);
  if (!company) throw notFound("Company", companyId);
  return company;
}

/** People by id (only those in the context workspace), in the order found. */
export async function loadPeople(ctx: OpContext, personIds: string[]): Promise<Person[]> {
  const workspace = requireWorkspace(ctx);
  const out: Person[] = [];
  for (let i = 0; i < personIds.length; i += 500) {
    out.push(
      ...(await ctx.db
        .select()
        .from(people)
        .where(
          and(
            eq(people.workspace_id, workspace.id),
            inArray(people.id, personIds.slice(i, i + 500)),
          ),
        )),
    );
  }
  return out;
}

/** Companies by id (only those in the context workspace). */
export async function loadCompanies(ctx: OpContext, companyIds: string[]): Promise<Company[]> {
  const workspace = requireWorkspace(ctx);
  const ids = [...new Set(companyIds)];
  const out: Company[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    out.push(
      ...(await ctx.db
        .select()
        .from(companies)
        .where(
          and(
            eq(companies.workspace_id, workspace.id),
            inArray(companies.id, ids.slice(i, i + 500)),
          ),
        )),
    );
  }
  return out;
}

/** Throws `not_found` when the person is not in the context workspace. */
export async function getPersonWithCompany(
  ctx: OpContext,
  personId: string,
): Promise<{ person: Person; company: Company | null }> {
  const person = await requirePerson(ctx, personId);
  const company = person.company_id ? await loadCompany(ctx, person.company_id) : null;
  return { person, company };
}

/** Sets the person status and emits lead.updated (only when it changed). */
export async function setPersonStatus(
  ctx: OpContext,
  personId: string,
  status: PersonStatus,
): Promise<void> {
  const person = await requirePerson(ctx, personId);
  if (person.status === status) return;
  await ctx.db.update(people).set({ status }).where(eq(people.id, person.id));
  await ctx.events.emit("lead.updated", {
    subject: { type: "person", id: person.id },
    data: { kind: "person", id: person.id, changes: ["status"] },
  });
}

/** "Dana Reyes" / email / id: the best short label for a person. */
export function personLabel(
  person: Pick<Person, "full_name" | "first_name" | "last_name" | "email" | "id">,
): string {
  return (
    person.full_name ??
    ([person.first_name, person.last_name].filter(Boolean).join(" ") || person.email || person.id)
  );
}
