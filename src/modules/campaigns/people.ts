import { and, eq, inArray } from "drizzle-orm";
import type { OpContext } from "../../core/context.js";
import { requireWorkspace } from "../../core/context.js";
import { notFound } from "../../core/errors.js";
import { type Company, companies, type Person, people } from "../../db/schema/index.js";

/** Person plus company, read directly (workspace-scoped). */
export interface PersonWithCompany {
  person: Person;
  company: Company | null;
}

export async function loadPeople(
  ctx: OpContext,
  personIds: readonly string[],
): Promise<Map<string, PersonWithCompany>> {
  const workspace = requireWorkspace(ctx);
  const out = new Map<string, PersonWithCompany>();
  if (personIds.length === 0) return out;
  const unique = [...new Set(personIds)];
  const rows: Person[] = [];
  for (let i = 0; i < unique.length; i += 500) {
    rows.push(
      ...(await ctx.db
        .select()
        .from(people)
        .where(
          and(eq(people.workspace_id, workspace.id), inArray(people.id, unique.slice(i, i + 500))),
        )),
    );
  }
  const companyIds = [...new Set(rows.map((row) => row.company_id).filter((id) => id !== null))];
  const companyRows =
    companyIds.length === 0
      ? []
      : await ctx.db
          .select()
          .from(companies)
          .where(and(eq(companies.workspace_id, workspace.id), inArray(companies.id, companyIds)));
  const byId = new Map(companyRows.map((company) => [company.id, company]));
  for (const person of rows) {
    out.set(person.id, {
      person,
      company: person.company_id ? (byId.get(person.company_id) ?? null) : null,
    });
  }
  return out;
}

export async function loadPerson(ctx: OpContext, personId: string): Promise<PersonWithCompany> {
  const found = (await loadPeople(ctx, [personId])).get(personId);
  if (!found) throw notFound("Person", personId);
  return found;
}

export function displayName(person: Person): string {
  return (
    person.full_name?.trim() ||
    [person.first_name, person.last_name].filter(Boolean).join(" ").trim() ||
    person.email ||
    person.id
  );
}
