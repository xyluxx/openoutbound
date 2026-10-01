/**
 * Research service: sourced briefs about people and companies. Other modules call these
 * functions (binding signatures from the build plan).
 */
import { type OpContext, requireWorkspace } from "../../core/context.js";
import type { ResearchBriefStatus } from "../../core/enums.js";
import { invalid } from "../../core/errors.js";
import type { ResearchBriefRow } from "../../db/schema/index.js";
import {
  ensurePendingRow,
  freshSince,
  latestBrief,
  researchJobKey,
  STALE_PENDING_MS,
} from "./store.js";
import { loadCompany, loadPerson } from "./targets.js";

export const RESEARCH_JOB = "research.run";
/** Brief statuses a reader can use. */
const USABLE: ResearchBriefStatus[] = ["ready", "partial"];
/** Auto research waits this long so one job covers everyone an import adds at a company. */
export const AUTO_BATCH_DELAY_MS = 60_000;

/**
 * Latest `ready` or `partial` brief row for the person (falling back to the company brief of
 * the person's company when no person brief exists), or for the company. Null when there is
 * none. A partial brief is usable: its gaps say which sources failed.
 */
export async function getLatestBrief(
  ctx: OpContext,
  input: { personId?: string; companyId?: string },
): Promise<ResearchBriefRow | null> {
  const workspace = requireWorkspace(ctx);
  if (input.personId) {
    const own = await latestBrief(ctx.db, workspace.id, { personId: input.personId }, USABLE);
    if (own) return own;
    const loaded = await loadPerson(ctx, input.personId);
    const companyId = loaded?.person.company_id ?? input.companyId;
    if (!companyId) return null;
    return latestBrief(ctx.db, workspace.id, { companyId }, USABLE);
  }
  if (input.companyId) {
    return latestBrief(ctx.db, workspace.id, { companyId: input.companyId }, USABLE);
  }
  throw invalid("Pass personId or companyId.");
}

export interface ResearchPlanItem {
  person_id: string | null;
  company_id: string | null;
  status: "cached" | "queued" | "skipped";
  brief_id: string | null;
  job_id: string | null;
  /** Why it was skipped (not_found, no_company_data). */
  reason: string | null;
}

export interface ResearchPlan {
  items: ResearchPlanItem[];
  jobIds: string[];
  cachedBriefIds: string[];
}

export interface PlanOptions {
  personIds?: string[];
  companyIds?: string[];
  force?: boolean;
  /** Only report what would happen (no rows, no jobs). */
  preview?: boolean;
  /** Auto research: delayed and lower priority, so imports batch per company. */
  auto?: boolean;
}

/**
 * Decides per target: a fresh ready brief is reused ("cached"); otherwise a pending row is
 * created and the company's research job queued (one job per company, singleton key). A fresh
 * partial brief is not cached: the job completes it, asking only the sources that failed.
 */
export async function planResearch(ctx: OpContext, options: PlanOptions): Promise<ResearchPlan> {
  const workspace = requireWorkspace(ctx);
  const now = ctx.clock.now();
  const since = freshSince(now);
  const plan: ResearchPlan = { items: [], jobIds: [], cachedBriefIds: [] };

  const queue = async (
    target: { personId: string | null; companyId: string | null },
    scope: { personId: string | null; companyId: string | null },
  ): Promise<ResearchPlanItem> => {
    const base = { person_id: target.personId, company_id: target.companyId };
    if (!options.force) {
      const fresh = await latestBrief(
        ctx.db,
        workspace.id,
        target.personId ? { personId: target.personId } : { companyId: target.companyId },
        USABLE,
        since,
      );
      if (fresh?.status === "ready") {
        if (!plan.cachedBriefIds.includes(fresh.id)) plan.cachedBriefIds.push(fresh.id);
        return { ...base, status: "cached", brief_id: fresh.id, job_id: null, reason: null };
      }
    }
    if (options.preview) {
      return { ...base, status: "queued", brief_id: null, job_id: null, reason: null };
    }
    const { row } = await ensurePendingRow(ctx.db, workspace.id, target, now);
    const stale = now.getTime() - row.created_at.getTime() > STALE_PENDING_MS;
    const job = await ctx.jobs.enqueue(
      RESEARCH_JOB,
      { company_id: scope.companyId, person_id: scope.companyId ? null : scope.personId },
      {
        singletonKey: researchJobKey(workspace.id, scope),
        priority: options.auto ? -1 : 0,
        ...(options.auto && !stale ? { delayMs: AUTO_BATCH_DELAY_MS } : {}),
      },
    );
    if (!plan.jobIds.includes(job.job_id)) plan.jobIds.push(job.job_id);
    return { ...base, status: "queued", brief_id: row.id, job_id: job.job_id, reason: null };
  };

  for (const personId of [...new Set(options.personIds ?? [])]) {
    const loaded = await loadPerson(ctx, personId);
    if (!loaded) {
      plan.items.push(skipped(personId, null, "not_found"));
      continue;
    }
    const companyId = loaded.person.company_id;
    plan.items.push(
      await queue({ personId, companyId }, { personId: companyId ? null : personId, companyId }),
    );
  }
  for (const companyId of [...new Set(options.companyIds ?? [])]) {
    const company = await loadCompany(ctx, companyId);
    if (!company) {
      plan.items.push(skipped(null, companyId, "not_found"));
      continue;
    }
    if (!company.domain && !company.website && !company.name.trim()) {
      plan.items.push(skipped(null, companyId, "no_company_data"));
      continue;
    }
    plan.items.push(await queue({ personId: null, companyId }, { personId: null, companyId }));
  }
  return plan;
}

function skipped(
  personId: string | null,
  companyId: string | null,
  reason: string,
): ResearchPlanItem {
  return {
    person_id: personId,
    company_id: companyId,
    status: "skipped",
    brief_id: null,
    job_id: null,
    reason,
  };
}

/** Returns fresh cached briefs where available and enqueues research jobs for the rest. */
export async function requestResearch(
  ctx: OpContext,
  input: { personIds?: string[]; companyIds?: string[]; force?: boolean },
): Promise<{ jobIds: string[]; cachedBriefIds: string[] }> {
  const plan = await planResearch(ctx, input);
  return { jobIds: plan.jobIds, cachedBriefIds: plan.cachedBriefIds };
}
