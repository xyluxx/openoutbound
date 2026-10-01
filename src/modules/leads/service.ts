/**
 * Leads service: people, companies, suppression and contactability. The binding functions
 * other modules call (build plan "Cross-module functions"). Implementations live in focused
 * files of this module; this file keeps the public signatures.
 */
import type { OpContext } from "../../core/context.js";
import type { PersonStatus, SuppressionReason, SuppressionType } from "../../core/enums.js";
import type { Company, Person } from "../../db/schema/index.js";
import { checkContactable as checkContactableImpl } from "./contactable.js";
import { resolvePeople as resolvePeopleImpl } from "./filters.js";
import {
  getPersonWithCompany as getPersonWithCompanyImpl,
  setPersonStatus as setPersonStatusImpl,
} from "./records.js";
import { addSuppressionRow } from "./suppressions.js";
import type { ContactableResult, LeadFilter } from "./types.js";

// Lead facts (binding signatures from the upgrade plan; implemented in facts.ts).
export {
  deleteFactsForPerson,
  expireFacts,
  type LeadFact,
  listFacts,
  type RecordFactInput,
  recordFact,
  updateFactStatus,
} from "./facts.js";
// The lead file (binding signatures from the upgrade plan).
export { holdCompany, holdSuggestionKey, releaseCompany } from "./holds.js";
export { buildLeadContext, LEAD_FILE_SOURCE, wrappedLeadContext } from "./lead-context.js";
export { getTimeline, type TimelineEntry } from "./timeline.js";
export type { ContactableResult, LeadFilter } from "./types.js";

/** Throws `not_found` when the person is not in the context workspace. */
export async function getPersonWithCompany(
  ctx: OpContext,
  personId: string,
): Promise<{ person: Person; company: Company | null }> {
  return getPersonWithCompanyImpl(ctx, personId);
}

/**
 * Can we contact this person on this channel right now? Checks every suppression type,
 * person and company status, channel data, email status vs sending settings, and
 * excluded and consent-required countries. A missing person returns `person_not_found`.
 */
export async function checkContactable(
  ctx: OpContext,
  input: { personId: string; channel: "email" | "linkedin" },
): Promise<ContactableResult> {
  return checkContactableImpl(ctx, input);
}

/** Adds a suppression (idempotent on type + value). */
export async function addSuppression(
  ctx: OpContext,
  input: {
    type: SuppressionType;
    value: string;
    reason: SuppressionReason;
    source: string;
    note?: string;
  },
): Promise<void> {
  await addSuppressionRow(ctx, input);
}

/** Person ids from explicit ids, a list and/or a filter (intersection when several are given). */
export async function resolvePeople(
  ctx: OpContext,
  input: { personIds?: string[]; listId?: string; filter?: LeadFilter },
): Promise<string[]> {
  return resolvePeopleImpl(ctx, input);
}

/** Sets the person status and emits lead.updated. */
export async function setPersonStatus(
  ctx: OpContext,
  personId: string,
  status: PersonStatus,
): Promise<void> {
  return setPersonStatusImpl(ctx, personId, status);
}

// --- Helpers (not part of the binding contract): the enrichment module (same owner), and the
// seniority vocabulary, so the knowledge bootstrap suggests ICPs as manage_icp stores them.
export {
  checkContactableMany,
  companyBlockReasons,
  companyOutreachReasons,
  OUTREACH_ONLY_REASONS,
} from "./contactable.js";
export {
  type CompanyFields,
  isUniqueViolation,
  type PersonFields,
  upsertCompany,
  upsertPerson,
} from "./dedupe.js";
export { leadFilterSchema } from "./filters.js";
export { resolveSeniority, SENIORITIES, type Seniority } from "./icp/seniority.js";
// ICP writes recorded in the change log, and ICP summaries (strategy page, undo).
export {
  type IcpFields,
  listIcpSummaries,
  requireIcp,
  updateIcpRecord,
} from "./icp/store.js";
export { addToList } from "./list-members.js";
export {
  buildNames,
  emailDomain,
  isFreeMailDomain,
  normalizeCountry,
  normalizeEmail,
  normalizePhone,
  normalizeWebsite,
} from "./normalize.js";
export { loadCompanies, loadCompany, loadPeople, loadPerson } from "./records.js";
