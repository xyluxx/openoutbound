/**
 * LeadFilter -> SQL conditions on `people`, shared by search, smart lists, exports and
 * campaign enrollment (`resolvePeople`).
 */
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { EMAIL_STATUSES, PERSON_STATUSES } from "../../core/enums.js";
import { notFound } from "../../core/errors.js";
import { companies, lists, people } from "../../db/schema/index.js";
import { normalizeCountry } from "./countries.js";
import type { LeadFilter } from "./types.js";

/** Zod shape of LeadFilter for operation inputs (snake_case, all optional). */
export const leadFilterSchema = z.object({
  query: z
    .string()
    .max(200)
    .optional()
    .describe("Free text; every word must match name, email, title or company name"),
  list_id: z.string().optional().describe("Only people in this list (static or smart)"),
  status: z.array(z.enum(PERSON_STATUSES)).optional(),
  tags: z.array(z.string()).optional().describe("Has at least one of these tags"),
  min_fit_score: z.number().int().min(0).max(100).optional(),
  max_fit_score: z.number().int().min(0).max(100).optional(),
  has_email: z.boolean().optional(),
  email_status: z.array(z.enum(EMAIL_STATUSES)).optional(),
  countries: z
    .array(z.string())
    .optional()
    .describe("ISO-2 codes or names (person country, else company country)"),
  company_ids: z.array(z.string()).optional(),
  signal_keys: z
    .array(z.string())
    .optional()
    .describe("Has an active signal with one of these definition keys"),
  campaign_id: z.string().optional().describe("Enrolled in this campaign (any status)"),
  not_in_active_campaign: z.boolean().optional(),
});

const ACTIVE_ENROLLMENT = sql.raw(`('queued', 'active', 'paused', 'waiting_review')`);
const MAX_SMART_DEPTH = 3;

function likePattern(word: string): string {
  return `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function sqlList(values: string[]): SQL {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

/**
 * SQL conditions for the filter (workspace condition included). Smart lists referenced by
 * `list_id` expand into their own filter (up to 3 levels deep).
 */
export async function leadFilterConditions(
  ctx: OpContext,
  filter: LeadFilter,
  depth = 0,
): Promise<SQL[]> {
  const workspace = requireWorkspace(ctx);
  const conditions: SQL[] = [eq(people.workspace_id, workspace.id)];

  if (filter.query?.trim()) {
    for (const word of filter.query.trim().split(/\s+/).slice(0, 8)) {
      const pattern = likePattern(word);
      conditions.push(sql`(
        concat_ws(' ', ${people.full_name}, ${people.first_name}, ${people.last_name}, ${people.email}, ${people.title}) ilike ${pattern}
        or exists (select 1 from ${companies} c where c.id = ${people.company_id} and c.name ilike ${pattern})
      )`);
    }
  }

  if (filter.list_id) {
    const [list] = await ctx.db
      .select()
      .from(lists)
      .where(and(eq(lists.id, filter.list_id), eq(lists.workspace_id, workspace.id)));
    if (!list) throw notFound("List", filter.list_id);
    if (list.kind === "smart") {
      if (depth >= MAX_SMART_DEPTH) {
        conditions.push(sql`false`);
      } else {
        const inner = (list.filter ?? {}) as LeadFilter;
        conditions.push(...(await leadFilterConditions(ctx, inner, depth + 1)));
      }
    } else {
      conditions.push(
        sql`exists (select 1 from list_members lm where lm.list_id = ${list.id} and lm.person_id = ${people.id})`,
      );
    }
  }

  if (filter.status?.length) conditions.push(inArray(people.status, filter.status));
  if (filter.tags?.length) {
    const tags = filter.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean);
    if (tags.length) conditions.push(sql`${people.tags} && array[${sqlList(tags)}]::text[]`);
  }
  if (filter.min_fit_score !== undefined)
    conditions.push(gte(people.fit_score, filter.min_fit_score));
  if (filter.max_fit_score !== undefined)
    conditions.push(lte(people.fit_score, filter.max_fit_score));
  if (filter.has_email === true) conditions.push(isNotNull(people.email));
  if (filter.has_email === false) conditions.push(isNull(people.email));
  if (filter.email_status?.length)
    conditions.push(inArray(people.email_status, filter.email_status));

  if (filter.countries?.length) {
    const codes = filter.countries
      .map((country) => normalizeCountry(country))
      .filter((code): code is string => Boolean(code));
    if (codes.length === 0) {
      conditions.push(sql`false`);
    } else {
      conditions.push(sql`(
        ${people.country} in (${sqlList(codes)})
        or (${people.country} is null and exists (
          select 1 from ${companies} c where c.id = ${people.company_id} and c.country in (${sqlList(codes)})
        ))
      )`);
    }
  }

  if (filter.company_ids?.length) conditions.push(inArray(people.company_id, filter.company_ids));

  if (filter.signal_keys?.length) {
    conditions.push(sql`exists (
      select 1 from signals s
      where s.workspace_id = ${people.workspace_id}
        and s.status <> 'dismissed'
        and s.definition_key in (${sqlList(filter.signal_keys)})
        and (s.person_id = ${people.id} or (s.company_id is not null and s.company_id = ${people.company_id}))
    )`);
  }

  if (filter.campaign_id) {
    conditions.push(
      sql`exists (select 1 from enrollments e where e.person_id = ${people.id} and e.campaign_id = ${filter.campaign_id})`,
    );
  }
  if (filter.not_in_active_campaign) {
    conditions.push(
      sql`not exists (select 1 from enrollments e where e.person_id = ${people.id} and e.status in ${ACTIVE_ENROLLMENT})`,
    );
  }
  return conditions;
}

/**
 * Person ids from explicit ids, a list and/or a filter (intersection when several are
 * given). Ids outside the workspace are dropped. Nothing given returns an empty list.
 */
export async function resolvePeople(
  ctx: OpContext,
  input: { personIds?: string[]; listId?: string; filter?: LeadFilter },
): Promise<string[]> {
  if (input.personIds === undefined && input.listId === undefined && input.filter === undefined) {
    return [];
  }
  if (input.personIds !== undefined && input.personIds.length === 0) return [];
  const filter: LeadFilter = { ...(input.filter ?? {}) };
  const conditions = await leadFilterConditions(ctx, filter);
  if (input.listId) {
    conditions.push(...(await leadFilterConditions(ctx, { list_id: input.listId })));
  }
  const out: string[] = [];
  const ids = input.personIds ? [...new Set(input.personIds)] : [undefined];
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = input.personIds ? (ids.slice(i, i + 1000) as string[]) : null;
    const where = chunk ? and(...conditions, inArray(people.id, chunk)) : and(...conditions);
    const rows = await ctx.db
      .select({ id: people.id })
      .from(people)
      .where(where)
      .orderBy(asc(people.created_at), asc(people.id));
    out.push(...rows.map((row) => row.id));
    if (!input.personIds) break;
  }
  return out;
}
