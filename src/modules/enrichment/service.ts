/**
 * Enrichment service: email finding and verification. The binding functions other modules
 * call (build plan "Cross-module functions"), plus helpers the leads module uses.
 */
import type { OpContext } from "../../core/context.js";
import type { EmailStatus } from "../../core/enums.js";
import { notFound } from "../../core/errors.js";
import { loadPerson } from "../leads/records.js";
import { ENRICH_JOB, FIND_CONTACTS_JOB } from "./jobs.js";
import { runEnrichment } from "./run.js";

/** Enqueues the enrichment waterfall for these people. */
export async function requestEnrichment(
  ctx: OpContext,
  input: { personIds: string[]; mode: "find_and_verify" | "verify_only" },
): Promise<{ jobId: string }> {
  const handle = await ctx.jobs.enqueue(ENRICH_JOB, {
    person_ids: [...new Set(input.personIds)],
    mode: input.mode,
  });
  return { jobId: handle.job_id };
}

/** Verifies the current email of the person with the configured verifier and stores the result. */
export async function verifyEmailNow(ctx: OpContext, personId: string): Promise<EmailStatus> {
  const person = await loadPerson(ctx, personId);
  if (!person) throw notFound("Person", personId);
  const summary = await runEnrichment(ctx, [personId], {
    mode: "verify_only",
    operation: "enrichment.verify_now",
  });
  return summary.results[0]?.email_status ?? person.email_status;
}

/**
 * Enqueues website crawls for companies: fills empty name, address and phone from each site
 * and, with `findPeople`, creates the decision makers named there (added to `listId` when
 * given). Returns null when there is nothing to crawl.
 */
export async function requestCompanyContacts(
  ctx: OpContext,
  input: { companyIds: string[]; findPeople: boolean; listId?: string | null },
): Promise<{ jobId: string } | null> {
  const companyIds = [...new Set(input.companyIds)];
  if (companyIds.length === 0) return null;
  const handle = await ctx.jobs.enqueue(FIND_CONTACTS_JOB, {
    company_ids: companyIds,
    find_people: input.findPeople,
    create_people: input.findPeople,
    list_id: input.listId ?? null,
  });
  return { jobId: handle.job_id };
}
