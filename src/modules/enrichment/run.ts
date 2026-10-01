/**
 * Bulk enrichment over person ids: batches of people with their companies and contactability
 * reasons, the waterfall per person, one `enrichment.completed` event per person, and a
 * compact summary with each person's steps and the provider failures of the run. People a
 * retry can help (a failure the engine may repeat by itself, no settled address) are collected
 * for the job, which schedules the retry.
 */
import type { OpContext } from "../../core/context.js";
import type { FailureClass } from "../../core/failures.js";
import type { EnrichmentFailedStep, Person } from "../../db/schema/index.js";
import { checkContactableMany } from "../leads/contactable.js";
import { loadCompanies, loadPeople } from "../leads/records.js";
import { EnrichmentSession } from "./session.js";
import { type EnrichMode, type EnrichOutcome, enrichPerson, storeBudgetSkip } from "./waterfall.js";

export const ENRICH_BATCH = 25;
/** Per-person results kept in summaries (counts cover everyone). */
const MAX_RESULTS = 100;

/** Failed provider calls of a run, grouped by step, provider and class. */
export interface EnrichmentFailureCount {
  step: EnrichmentFailedStep["step"];
  provider: string;
  class: FailureClass;
  retryable: boolean;
  /** People whose run had this failure. */
  people: number;
}

/** The follow-up run the job scheduled for people whose failure a retry can fix. */
export interface EnrichmentRetry {
  job_id: string;
  /** ISO time it runs. */
  at: string;
  people: number;
}

export interface EnrichmentSummary {
  total: number;
  found: number;
  verified: number;
  kept: number;
  not_found: number;
  skipped: number;
  provider_failed: number;
  credits_used: number;
  budget_exceeded: boolean;
  skipped_by_reason: Record<string, number>;
  failures: EnrichmentFailureCount[];
  /** Set by the job: the automatic retry, or null when none was scheduled. */
  retry: EnrichmentRetry | null;
  results: Array<
    Pick<
      EnrichOutcome,
      | "person_id"
      | "status"
      | "email"
      | "email_status"
      | "provider"
      | "reason"
      | "steps"
      | "failed"
      | "retry_at"
    >
  >;
  /** Internal, kept for resuming the job: people a retry can help. Not in results. */
  retry_person_ids?: string[];
  /** Internal: the longest wait a failed provider asked for, in seconds. */
  retry_after_s?: number;
}

export function emptySummary(): EnrichmentSummary {
  return {
    total: 0,
    found: 0,
    verified: 0,
    kept: 0,
    not_found: 0,
    skipped: 0,
    provider_failed: 0,
    credits_used: 0,
    budget_exceeded: false,
    skipped_by_reason: {},
    failures: [],
    retry: null,
    results: [],
  };
}

/**
 * True when the engine should ask again by itself: a call failed in a way it may repeat
 * (`retryable`; not a paid call that may already have used credits) and the person has no
 * valid or catch-all address yet.
 */
export function retryCanHelp(outcome: EnrichOutcome): boolean {
  return (
    outcome.status !== "skipped" &&
    outcome.email_status !== "valid" &&
    outcome.email_status !== "catch_all" &&
    outcome.failed.some((entry) => entry.failure.retryable)
  );
}

function add(summary: EnrichmentSummary, outcome: EnrichOutcome): void {
  summary.total += 1;
  summary[outcome.status] += 1;
  summary.credits_used += outcome.credits_used;
  if (outcome.status === "skipped" && outcome.reason) {
    summary.skipped_by_reason[outcome.reason] =
      (summary.skipped_by_reason[outcome.reason] ?? 0) + 1;
  }
  const counted = new Set<string>();
  for (const { step, provider, failure } of outcome.failed) {
    const key = `${step}:${provider}:${failure.class}`;
    if (counted.has(key)) continue;
    counted.add(key);
    const entry = summary.failures.find(
      (f) => f.step === step && f.provider === provider && f.class === failure.class,
    );
    if (entry) entry.people += 1;
    else {
      summary.failures.push({
        step,
        provider,
        class: failure.class,
        retryable: failure.retryable,
        people: 1,
      });
    }
  }
  if (retryCanHelp(outcome)) {
    summary.retry_person_ids = [...(summary.retry_person_ids ?? []), outcome.person_id];
    for (const { failure } of outcome.failed) {
      if (failure.retryable && failure.retry_after_s !== undefined) {
        summary.retry_after_s = Math.max(summary.retry_after_s ?? 0, failure.retry_after_s);
      }
    }
  }
  if (summary.results.length < MAX_RESULTS) {
    const { person_id, status, email, email_status, provider, reason, steps, failed, retry_at } =
      outcome;
    summary.results.push({
      person_id,
      status,
      email,
      email_status,
      provider,
      reason,
      steps,
      failed,
      retry_at,
    });
  }
}

/** The summary without the fields kept only for resuming. */
export function publicSummary(summary: EnrichmentSummary): EnrichmentSummary {
  const { retry_person_ids: _ids, retry_after_s: _wait, ...rest } = summary;
  return rest;
}

export interface RunEnrichmentOptions {
  mode: EnrichMode;
  allowRoleAddresses?: boolean;
  /**
   * Ask the finders again for people looked up in the last RECHECK_DAYS days (a risky or
   * unknown address, or no address found).
   */
  force?: boolean;
  /** An automatic follow-up run: steps whose failure is not retryable are not asked again. */
  followUp?: boolean;
  /** Operation or job name for usage rows. */
  operation: string;
  jobId?: string | null;
  /** Called after each batch with the number of ids processed so far. */
  onProgress?: (processed: number, summary: EnrichmentSummary) => Promise<void>;
  signal?: AbortSignal;
  /** Continue a previous attempt: skip the first `startAt` ids. */
  startAt?: number;
  summary?: EnrichmentSummary;
}

/** Enriches people in order; stops spending (and skips the rest) once the data budget is used. */
export async function runEnrichment(
  ctx: OpContext,
  personIds: string[],
  options: RunEnrichmentOptions,
): Promise<EnrichmentSummary> {
  const session = new EnrichmentSession(ctx, {
    operation: options.operation,
    jobId: options.jobId ?? null,
  });
  // A summary saved by an older version lacks the newer counters.
  const summary = { ...emptySummary(), ...options.summary };
  const ids = [...new Set(personIds)];
  for (let start = options.startAt ?? 0; start < ids.length; start += ENRICH_BATCH) {
    options.signal?.throwIfAborted();
    const batchIds = ids.slice(start, start + ENRICH_BATCH);
    const persons = await loadPeople(ctx, batchIds);
    const byId = new Map(persons.map((person) => [person.id, person]));
    const companyIds = persons.map((p) => p.company_id).filter((id): id is string => Boolean(id));
    const companyById = new Map((await loadCompanies(ctx, companyIds)).map((c) => [c.id, c]));
    const reasons = await checkContactableMany(
      ctx,
      persons.map((p) => p.id),
      "email",
    );
    for (const id of batchIds) {
      const person = byId.get(id);
      if (!person) continue;
      const company = person.company_id ? (companyById.get(person.company_id) ?? null) : null;
      const outcome = session.budgetExceeded
        ? await budgetSkip(session, person)
        : await enrichPerson(session, person, company, reasons.get(id)?.reasons ?? [], {
            mode: options.mode,
            allowRoleAddresses: options.allowRoleAddresses ?? false,
            force: options.force ?? false,
            followUp: options.followUp ?? false,
          });
      add(summary, outcome);
      await emitCompleted(ctx, outcome);
    }
    if (session.budgetExceeded) summary.budget_exceeded = true;
    await options.onProgress?.(Math.min(ids.length, start + ENRICH_BATCH), summary);
  }
  return summary;
}

/** A person the run reached after the data budget was used up: skipped, and stored so. */
async function budgetSkip(session: EnrichmentSession, person: Person): Promise<EnrichOutcome> {
  await storeBudgetSkip(session, person);
  return {
    person_id: person.id,
    status: "skipped",
    email: person.email,
    email_status: person.email_status,
    provider: null,
    credits_used: 0,
    reason: "budget_exceeded",
    steps: [],
    failed: [],
    retry_at: null,
  };
}

async function emitCompleted(ctx: OpContext, outcome: EnrichOutcome): Promise<void> {
  await ctx.events.emit("enrichment.completed", {
    subject: { type: "person", id: outcome.person_id },
    data: {
      person_id: outcome.person_id,
      email: outcome.email,
      email_status: outcome.email_status,
      provider: outcome.status === "found" ? outcome.provider : null,
      status: outcome.status,
      credits_used: outcome.credits_used,
    },
  });
}
