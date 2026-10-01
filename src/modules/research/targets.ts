/** Loads the people and companies being researched (people through the leads service). */
import { and, eq } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { isOpenOutboundError } from "../../core/errors.js";
import { type Company, companies, type Person } from "../../db/schema/index.js";
import { getPersonWithCompany } from "../leads/service.js";

export async function loadCompany(ctx: OpContext, companyId: string): Promise<Company | null> {
  const workspace = requireWorkspace(ctx);
  const [company] = await ctx.db
    .select()
    .from(companies)
    .where(and(eq(companies.workspace_id, workspace.id), eq(companies.id, companyId)));
  return company ?? null;
}

/** Person and company, or null when the person is not in this workspace. */
export async function loadPerson(
  ctx: OpContext,
  personId: string,
): Promise<{ person: Person; company: Company | null } | null> {
  try {
    return await getPersonWithCompany(ctx, personId);
  } catch (error) {
    if (isOpenOutboundError(error) && error.code === "not_found") return null;
    throw error;
  }
}

export function personName(person: Person): string {
  return (
    person.full_name?.trim() ||
    [person.first_name, person.last_name].filter(Boolean).join(" ").trim() ||
    person.email ||
    person.id
  );
}
