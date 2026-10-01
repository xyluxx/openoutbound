/** Which companies a monitor checks (list, explicit ids, ICP fit, all active companies). */
import { and, count, desc, eq, gte, inArray, type SQL, sql } from "drizzle-orm";
import type { OpContext } from "../../../core/context.js";
import { notFound } from "../../../core/errors.js";
import {
  type Company,
  companies,
  icps,
  list_members,
  lists,
  type MonitorTarget,
  people,
} from "../../../db/schema/index.js";

export const DEFAULT_MAX_COMPANIES = 50;
export const HARD_MAX_COMPANIES = 500;
/** Tier C and up (playbook-icp): lower-fit companies get no monitoring by default. */
export const DEFAULT_ICP_MIN_FIT = 50;
const MONITORED_STATUSES = ["active", "customer"] as const;

export interface ResolvedTargets {
  companies: Company[];
  /** Matching companies before the max_companies cap. */
  total: number;
  /** Signal keys of the targeted ICP (used when the monitor lists none). */
  icpSignalKeys: string[];
}

/** Validates that referenced lists, ICPs and companies exist in the workspace. */
export async function assertTargetExists(
  ctx: OpContext,
  workspaceId: string,
  target: MonitorTarget,
): Promise<void> {
  if (target.kind === "list" && target.list_id) {
    const [row] = await ctx.db
      .select({ id: lists.id })
      .from(lists)
      .where(and(eq(lists.workspace_id, workspaceId), eq(lists.id, target.list_id)));
    if (!row) throw notFound("List", target.list_id);
  }
  if (target.kind === "icp" && target.icp_id) {
    const [row] = await ctx.db
      .select({ id: icps.id })
      .from(icps)
      .where(and(eq(icps.workspace_id, workspaceId), eq(icps.id, target.icp_id)));
    if (!row) throw notFound("ICP", target.icp_id);
  }
  if (target.kind === "companies") {
    const ids = [...new Set(target.company_ids ?? [])];
    if (ids.length === 0) return;
    const rows = await ctx.db
      .select({ id: companies.id })
      .from(companies)
      .where(and(eq(companies.workspace_id, workspaceId), inArray(companies.id, ids)));
    const missing = ids.find((id) => !rows.some((row) => row.id === id));
    if (missing) throw notFound("Company", missing);
  }
}

export async function resolveTargets(
  ctx: OpContext,
  workspaceId: string,
  target: MonitorTarget,
  maxCompanies: number,
): Promise<ResolvedTargets> {
  const limit = Math.min(Math.max(1, maxCompanies), HARD_MAX_COMPANIES);
  const conditions: SQL[] = [
    eq(companies.workspace_id, workspaceId),
    inArray(companies.status, [...MONITORED_STATUSES]),
  ];
  let icpSignalKeys: string[] = [];

  switch (target.kind) {
    case "companies": {
      const ids = [...new Set(target.company_ids ?? [])];
      if (ids.length === 0) return { companies: [], total: 0, icpSignalKeys };
      conditions.push(inArray(companies.id, ids));
      break;
    }
    case "list": {
      if (!target.list_id) return { companies: [], total: 0, icpSignalKeys };
      conditions.push(
        inArray(
          companies.id,
          ctx.db
            .select({ id: people.company_id })
            .from(list_members)
            .innerJoin(people, eq(people.id, list_members.person_id))
            .innerJoin(lists, eq(lists.id, list_members.list_id))
            .where(
              and(
                eq(list_members.list_id, target.list_id),
                eq(lists.workspace_id, workspaceId),
                sql`${people.company_id} is not null`,
              ),
            ),
        ),
      );
      break;
    }
    case "icp": {
      if (target.icp_id) {
        const [icp] = await ctx.db
          .select({ signal_keys: icps.signal_keys })
          .from(icps)
          .where(and(eq(icps.workspace_id, workspaceId), eq(icps.id, target.icp_id)));
        icpSignalKeys = icp?.signal_keys ?? [];
      }
      conditions.push(gte(companies.fit_score, target.min_fit ?? DEFAULT_ICP_MIN_FIT));
      break;
    }
    case "all_active": {
      if (target.min_fit !== undefined) conditions.push(gte(companies.fit_score, target.min_fit));
      break;
    }
  }

  const where = and(...conditions);
  const [totalRow] = await ctx.db.select({ value: count() }).from(companies).where(where);
  const rows = await ctx.db
    .select()
    .from(companies)
    .where(where)
    .orderBy(
      sql`${companies.fit_score} desc nulls last`,
      sql`${companies.intent_score} desc nulls last`,
      desc(companies.id),
    )
    .limit(limit);
  return { companies: rows, total: Number(totalRow?.value ?? rows.length), icpSignalKeys };
}
