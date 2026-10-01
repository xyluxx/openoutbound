/** Background jobs of the enrichment module. */
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { assertBrainReady } from "../../brain/index.js";
import type { JobContext } from "../../core/context.js";
import { defineJob } from "../../core/operation.js";
import { people } from "../../db/schema/index.js";
import { addToList } from "../leads/list-members.js";
import { loadCompanies } from "../leads/records.js";
import { type CompanyContactsResult, findCompanyContacts } from "./contacts.js";
import { teamExtractionPrompt } from "./prompts/team.js";
import {
  type EnrichmentRetry,
  type EnrichmentSummary,
  publicSummary,
  runEnrichment,
} from "./run.js";
import { EnrichmentSession } from "./session.js";
import { ENRICH_MODES } from "./waterfall.js";

export const ENRICH_JOB = "enrichment.run";
export const FIND_CONTACTS_JOB = "enrichment.find_contacts";

/** Follow-up runs the engine schedules by itself for temporary provider failures. */
export const ENRICH_AUTO_RETRIES = 2;
/** Shortest wait before such a follow-up run (longer when the provider asks for it). */
export const ENRICH_RETRY_DELAY_MS = 15 * 60_000;

export const enrichJobPayload = z.object({
  person_ids: z.array(z.string()).max(10_000),
  mode: z.enum(ENRICH_MODES).default("find_and_verify"),
  allow_role_addresses: z.boolean().default(false),
  force: z.boolean().default(false),
  /** Automatic retries before this run (0 for a run someone asked for). */
  retry_round: z.number().int().min(0).default(0),
});
type EnrichJobPayload = z.infer<typeof enrichJobPayload>;

/**
 * Runs the waterfall for many people; resumes after the last finished batch on retries. When
 * a provider failed in a way the engine may repeat (`retryable`: a rate limit, server trouble,
 * a call that never reached the provider) and the people concerned have no settled address, it
 * schedules one follow-up run for just them, at most ENRICH_AUTO_RETRIES times; the follow-up
 * asks only the steps that failed. A paid finder or verifier call that timed out or lost its
 * connection after sending is `retryable: false` (it may already have used credits) and gets
 * no follow-up: the person stays provider_failed until someone enriches them again. A
 * follow-up that another step's failure brings does not ask it again either.
 */
export const enrichJob = defineJob({
  name: ENRICH_JOB,
  payload: enrichJobPayload,
  maxAttempts: 3,
  timeoutMs: 30 * 60_000,
  handler: async (ctx, payload) => {
    if (!ctx.workspace) return { skipped: "no_workspace" };
    let startAt = 0;
    let summary: EnrichmentSummary | undefined;
    if (ctx.job.attempt > 1) {
      const previous = await ctx.jobs.get(ctx.job.id);
      const data = previous?.progress?.data;
      if (typeof data?.processed === "number") {
        startAt = data.processed;
        summary = data.summary as EnrichmentSummary | undefined;
      }
    }
    const total = new Set(payload.person_ids).size;
    const result = await runEnrichment(ctx, payload.person_ids, {
      mode: payload.mode,
      allowRoleAddresses: payload.allow_role_addresses,
      force: payload.force,
      followUp: payload.retry_round > 0,
      operation: ENRICH_JOB,
      jobId: ctx.job.id,
      signal: ctx.job.signal,
      startAt,
      ...(summary ? { summary } : {}),
      onProgress: async (processed, current) => {
        await ctx.setProgress({
          done: processed,
          total,
          stage: "enriching",
          message: `${current.found} found, ${current.verified} verified, ${current.not_found} not found, ${current.provider_failed} provider failed, ${current.skipped} skipped`,
          data: { processed, summary: current },
        });
      },
    });
    result.retry = await scheduleRetry(ctx, payload, result);
    return publicSummary(result);
  },
});

/** Enqueues the follow-up run for the people a retry can help and notes it on each of them. */
async function scheduleRetry(
  ctx: JobContext,
  payload: EnrichJobPayload,
  summary: EnrichmentSummary,
): Promise<EnrichmentRetry | null> {
  const ids = summary.retry_person_ids ?? [];
  // Out of budget: a retry would be cut the same way until the budget resets.
  if (ids.length === 0 || payload.retry_round >= ENRICH_AUTO_RETRIES || summary.budget_exceeded) {
    return null;
  }
  const waitMs = Math.max(ENRICH_RETRY_DELAY_MS, (summary.retry_after_s ?? 0) * 1000);
  const at = new Date(ctx.clock.now().getTime() + waitMs);
  const handle = await ctx.jobs.enqueue(
    ENRICH_JOB,
    {
      person_ids: ids,
      mode: payload.mode,
      allow_role_addresses: payload.allow_role_addresses,
      // The follow-up asks the failed steps again anyway; force would re-ask every finder.
      force: false,
      retry_round: payload.retry_round + 1,
    },
    // One follow-up per run, also when this job is retried after a crash.
    { runAt: at, singletonKey: `${ENRICH_JOB}:retry:${ctx.job.id}` },
  );
  const iso = at.toISOString();
  for (let start = 0; start < ids.length; start += 500) {
    await ctx.db
      .update(people)
      .set({
        enrichment: sql`jsonb_set(coalesce(${people.enrichment}, '{}'::jsonb), '{retry_at}', to_jsonb(${iso}::text))`,
      })
      .where(
        and(
          eq(people.workspace_id, ctx.workspace?.id ?? ""),
          inArray(people.id, ids.slice(start, start + 500)),
        ),
      );
  }
  const retried = new Set(ids);
  for (const result of summary.results) {
    if (retried.has(result.person_id)) result.retry_at = iso;
  }
  return { job_id: handle.job_id, at: iso, people: ids.length };
}

export const findContactsJobPayload = z.object({
  company_ids: z.array(z.string()).max(1_000),
  find_people: z.boolean().default(true),
  create_people: z.boolean().default(true),
  max_people: z.number().int().min(1).max(10).default(3),
  allow_role_addresses: z.boolean().default(false),
  /** Static list for the people created (find imports with a destination list). */
  list_id: z.string().nullable().default(null),
});

export interface FindContactsSummary {
  companies: number;
  done: number;
  skipped: number;
  unreachable: number;
  people_created: number;
  companies_updated: number;
  credits_used: number;
  results: Array<
    Pick<CompanyContactsResult, "company_id" | "status" | "reason" | "filled"> & { people: number }
  >;
}

/**
 * Crawls company websites: fills company facts and (optionally) creates decision makers. With
 * `find_people` it needs a brain: without one it waits before crawling anything. A run after a
 * wait (the agent brain answering a company's team extraction) or a retry continues after the
 * last company it finished, so the addresses it verified (paid) are not verified again.
 */
export const findContactsJob = defineJob({
  name: FIND_CONTACTS_JOB,
  payload: findContactsJobPayload,
  maxAttempts: 3,
  timeoutMs: 30 * 60_000,
  handler: async (ctx, payload) => {
    if (!ctx.workspace) return { skipped: "no_workspace" };
    const ids = [...new Set(payload.company_ids)];
    if (payload.find_people && ids.length > 0) {
      await assertBrainReady(ctx.brain, teamExtractionPrompt, { jobId: ctx.job.id });
    }
    const session = new EnrichmentSession(ctx, { operation: FIND_CONTACTS_JOB, jobId: ctx.job.id });
    const byId = new Map((await loadCompanies(ctx, ids)).map((company) => [company.id, company]));
    const previous = (await ctx.jobs.get(ctx.job.id))?.progress?.data;
    const startAt = typeof previous?.processed === "number" ? previous.processed : 0;
    const summary: FindContactsSummary = {
      companies: 0,
      done: 0,
      skipped: 0,
      unreachable: 0,
      people_created: 0,
      companies_updated: 0,
      credits_used: 0,
      results: [],
      ...(startAt > 0 ? (previous?.summary as FindContactsSummary | undefined) : undefined),
    };
    const creditsBefore = summary.credits_used;
    for (const [index, id] of ids.entries()) {
      if (index < startAt) continue;
      ctx.job.signal.throwIfAborted();
      const company = byId.get(id);
      if (!company) continue;
      const result = await findCompanyContacts(session, company, {
        apply: true,
        findPeople: payload.find_people,
        createPeople: payload.create_people,
        maxPeople: payload.max_people,
        allowRoleAddresses: payload.allow_role_addresses,
      });
      if (payload.list_id) {
        const personIds = result.people
          .map((person) => person.person_id)
          .filter((id): id is string => Boolean(id));
        if (personIds.length > 0) await addToList(ctx, payload.list_id, personIds);
      }
      summary.companies += 1;
      summary[result.status] += 1;
      summary.people_created += result.people.filter((p) => p.outcome === "created").length;
      if (result.filled.length > 0) summary.companies_updated += 1;
      if (summary.results.length < 100) {
        summary.results.push({
          company_id: result.company_id,
          status: result.status,
          reason: result.reason,
          filled: result.filled,
          people: result.people.length,
        });
      }
      summary.credits_used = creditsBefore + session.creditsUsed;
      await ctx.setProgress({
        done: index + 1,
        total: ids.length,
        stage: "crawling",
        message: `${summary.done} crawled, ${summary.people_created} people created`,
        data: { processed: index + 1, summary },
      });
    }
    summary.credits_used = creditsBefore + session.creditsUsed;
    return summary;
  },
});
