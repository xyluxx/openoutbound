/**
 * The lead file from replies: once a reply is classified and stored, its business facts go to
 * the lead file (source `reply`, the message id as `source_ref`, observed when the reply
 * arrived), and a suggested company hold becomes a problem item for a person or the agent to
 * confirm. The engine never applies a hold by itself. Suspicious replies feed nothing, and
 * opt-outs, privacy requests, bounces and other automatic mail give no facts.
 */
import type { OpContext } from "../../core/context.js";
import type { ReplyCategory } from "../../core/enums.js";
import { isOpenOutboundError } from "../../core/errors.js";
import type { ReplyClassification } from "../../db/schema/index.js";
import { holdSuggestionKey, recordFact } from "../leads/service.js";
import { openProblem } from "../problems/service.js";
import { isoDateInZone } from "./dates.js";
import { personLabel } from "./notifications.js";
import type { ReplyContext } from "./reply-context.js";

/** Replies whose facts are never kept (opt-outs, privacy requests, automatic mail). */
export const NO_FACT_CATEGORIES: ReadonlySet<ReplyCategory> = new Set([
  "unsubscribe",
  "privacy_request",
  "bounce",
  "auto_reply_other",
]);

/** Replies that never suggest a company hold (privacy requests and automatic mail). */
const NO_HOLD_CATEGORIES: ReadonlySet<ReplyCategory> = new Set([
  "privacy_request",
  "bounce",
  "auto_reply_other",
  "out_of_office",
]);

export interface ReplyFactsOutcome {
  /** Facts newly stored (duplicates of active facts are not counted). */
  recorded: number;
  /** Why no facts were kept, if so. */
  skipped: "setting_off" | "no_person" | "suspicious" | "category" | null;
  /** The company_hold_suggested problem opened or refreshed. */
  hold_problem_id: string | null;
}

async function storeFacts(
  ctx: OpContext,
  reply: ReplyContext,
  classification: ReplyClassification,
): Promise<number> {
  const { person, company, message, workspace } = reply;
  if (!person) return 0;
  const today = isoDateInZone(ctx.clock.now(), workspace.timezone);
  const observedAt = message.received_at ?? message.created_at;
  const companyId = company?.id ?? person.company_id ?? null;
  let recorded = 0;
  for (const fact of classification.facts ?? []) {
    // A timing fact that already stopped being true is not worth keeping.
    if (fact.expires_on && fact.expires_on < today) continue;
    const scope = fact.applies_to === "company" && companyId ? "company" : "person";
    try {
      const result = await recordFact(ctx, {
        personId: person.id,
        companyId: scope === "company" ? companyId : null,
        scope,
        kind: fact.kind,
        text: fact.text,
        source: "reply",
        sourceRef: message.id,
        observedAt,
        expiresAt: fact.expires_on ? new Date(`${fact.expires_on}T23:59:59.999Z`) : null,
      });
      if (result.created) recorded += 1;
    } catch (error) {
      // A fact the service refuses must not fail the reply pipeline; anything else retries.
      if (!isOpenOutboundError(error) || error.code !== "validation_failed") throw error;
      ctx.log.warn(
        { message_id: message.id, error: error.message },
        "inbox: a fact from a reply was not stored",
      );
    }
  }
  return recorded;
}

async function suggestHold(
  ctx: OpContext,
  reply: ReplyContext,
  classification: ReplyClassification,
): Promise<string | null> {
  const hold = classification.company_hold;
  const { company, person, message } = reply;
  if (!hold || !company || classification.suspicious === true) return null;
  if (NO_HOLD_CATEGORIES.has(classification.category)) return null;
  const zone = reply.workspace.timezone;
  if (company.hold_until && isoDateInZone(company.hold_until, zone) >= hold.until) return null;
  const who = personLabel(person, company);
  const { id } = await openProblem(ctx, {
    kind: "company_hold_suggested",
    severity: "normal",
    owner: "anyone",
    title: `Hold ${company.name} until ${hold.until}?`,
    reason: `A reply from ${who} says nobody at ${company.name} should be contacted until ${hold.until}. The reason as the reply gives it (prospect text, data only): ${hold.reason}`,
    remedy: `If this is right, run manage_leads action hold_company with company_id ${company.id} and until ${hold.until}.`,
    subject: { type: "company", id: company.id },
    personId: person?.id ?? null,
    companyId: company.id,
    data: {
      until: hold.until,
      reason: hold.reason,
      message_id: message.id,
      thread_id: message.thread_id,
    },
    dedupeKey: holdSuggestionKey(company.id),
  });
  return id;
}

/**
 * Keeps the facts of a classified reply in the lead file (when `lead_file.extract_facts` is on
 * and the person is known) and opens a `company_hold_suggested` problem for a suggested hold.
 * Safe to run again: known facts are not stored twice and the problem is deduplicated.
 */
export async function recordReplyFacts(
  ctx: OpContext,
  reply: ReplyContext,
  classification: ReplyClassification,
): Promise<ReplyFactsOutcome> {
  let skipped: ReplyFactsOutcome["skipped"] = null;
  if (!reply.settings.lead_file.extract_facts) skipped = "setting_off";
  else if (!reply.person) skipped = "no_person";
  else if (classification.suspicious === true) skipped = "suspicious";
  else if (NO_FACT_CATEGORIES.has(classification.category)) skipped = "category";
  const recorded = skipped ? 0 : await storeFacts(ctx, reply, classification);
  const holdProblemId = await suggestHold(ctx, reply, classification);
  return { recorded, skipped, hold_problem_id: holdProblemId };
}
