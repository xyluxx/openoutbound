/**
 * Campaigns service: enrollment control used by the inbox and other modules, plus enrollment
 * and stats helpers for automations and reports.
 */
import type { OpContext } from "../../core/context.js";
import type { CampaignStats } from "../../db/schema/index.js";
import { pauseForPerson, resumeForPerson, stopForPerson } from "./control.js";
import { type EnrollOutcome, enrollPeople as enrollPeopleImpl } from "./enrollment.js";
import { computeCampaignStats } from "./stats.js";

/**
 * Stops the person's active, paused and waiting enrollments (and, with companyWide, those of
 * everyone at the same company). Cancels their pending messages and approvals. Returns the count.
 *
 * Reasons follow the campaign stop rules: "replied" (stop.on_reply; colleagues follow
 * stop.on_company_reply and stop with "company_replied"), "meeting_booked" (stop.on_meeting);
 * any other reason ("unsubscribed", "bounced", "negative", "not_interested", "wrong_person",
 * "manual", ...) always stops. A reply that the rules say not to stop on resumes the enrollment
 * paused while the reply waited for classification.
 */
export async function stopEnrollmentsForPerson(
  ctx: OpContext,
  input: { personId: string; reason: string; companyWide?: boolean },
): Promise<number> {
  return stopForPerson(ctx, input);
}

/**
 * Pauses the person's active enrollments until a date (for example an out-of-office return).
 * The sequencer resumes them automatically at `until`; scheduled messages are held.
 */
export async function pauseEnrollmentsForPerson(
  ctx: OpContext,
  input: { personId: string; until: Date; reason: string; keepLongerPauses?: boolean },
): Promise<number> {
  return pauseForPerson(ctx, input);
}

/**
 * Resumes enrollments paused for the person (for example after a reply was classified as
 * harmless). With `reason`, only those paused for that reason (for example "company_hold").
 */
export async function resumeEnrollmentsForPerson(
  ctx: OpContext,
  input: { personId: string; reason?: string },
): Promise<number> {
  return resumeForPerson(ctx, input);
}

// Campaign edits recorded in the change log (strategy undo, A/B winners), and the campaign
// with its parsed settings and ordered steps.
export { applyCampaignUpdate, type CampaignUpdate } from "./operations/campaigns.js";
export { type LoadedCampaign, loadCampaign } from "./repo.js";
// Which channel a step uses and whether AI writes it (workspace readiness reads both).
export { stepChannel, stepUsesAi } from "./steps.js";
export type { EnrollOutcome };

/**
 * Enrolls people into a campaign with every compliance check (used by automations and the
 * `enrollment` approval). New enrollments start `queued`; the sequencer activates them.
 */
export async function enrollPeople(
  ctx: OpContext,
  input: { campaignId: string; personIds: string[]; source?: string; dryRun?: boolean },
): Promise<EnrollOutcome> {
  return enrollPeopleImpl(ctx, input);
}

/** Fresh counters for a campaign (overall and per step and A/B variant), for reports. */
export async function getCampaignStats(ctx: OpContext, campaignId: string): Promise<CampaignStats> {
  return computeCampaignStats(ctx, campaignId);
}
