/**
 * Company holds: no outreach to anyone at a company until a date (for example "we signed with
 * a competitor until March 2027"). While `hold_until` is in the future, contactability returns
 * `company_on_hold`, which stops new outreach but never an answer to someone who wrote to us.
 * Binding signatures from the upgrade plan (`holdCompany`, `releaseCompany`).
 */
import { and, eq, inArray, ne } from "drizzle-orm";
import { type OpContext, type Principal, requireWorkspace } from "../../core/context.js";
import type { FactSource } from "../../core/enums.js";
import { OpenOutboundError } from "../../core/errors.js";
import { companies, enrollments, lead_facts, people } from "../../db/schema/index.js";
import { pauseEnrollmentsForPerson, resumeEnrollmentsForPerson } from "../campaigns/service.js";
import { isoDateInZone } from "../inbox/dates.js";
import { resolveProblemsFor } from "../problems/service.js";
import { recordFact } from "./facts.js";
import { requireCompany } from "./records.js";

/** Enrollment pause reason while a company is on hold. */
export const COMPANY_HOLD_PAUSE = "company_hold";
/** `source_ref` of the company fact that records a hold. */
export const HOLD_FACT_REF = "company_hold";
/** Longest hold reason kept (the fact text adds the date in front). */
export const HOLD_REASON_MAX = 250;

/** Who wrote a fact through an operation: `agent` for agent principals, `manual` otherwise. */
export function factSourceFor(
  principal: Pick<Principal, "type">,
): Extract<FactSource, "agent" | "manual"> {
  return principal.type === "agent" ? "agent" : "manual";
}

/** Dedupe key of the problem that suggests holding a company. */
export function holdSuggestionKey(companyId: string): string {
  return `company_hold_suggested:${companyId}`;
}

export interface CompanyHoldOutcome {
  changed: boolean;
  hold_until: Date | null;
  reason: string | null;
  /** Enrollments paused (hold) or resumed (release). */
  enrollments: number;
  /** The company fact recording the hold (hold only). */
  fact_id: string | null;
}

function cleanReason(reason: string): string {
  const text = reason.replace(/\s+/g, " ").trim().slice(0, HOLD_REASON_MAX).trim();
  if (!text) {
    throw new OpenOutboundError("validation_failed", "A company hold needs a reason.", {
      hint: 'Say why in plain words, for example "Signed with a competitor until March 2027".',
      details: { field: "reason" },
    });
  }
  return text;
}

/** People at the company with enrollments in these statuses (and this pause reason). */
async function peopleWithEnrollments(
  ctx: OpContext,
  companyId: string,
  statuses: Array<"active" | "waiting_review" | "paused">,
  pauseReason?: string,
): Promise<string[]> {
  const workspace = requireWorkspace(ctx);
  const rows = await ctx.db
    .selectDistinct({ id: enrollments.person_id })
    .from(enrollments)
    .innerJoin(people, eq(people.id, enrollments.person_id))
    .where(
      and(
        eq(enrollments.workspace_id, workspace.id),
        eq(people.workspace_id, workspace.id),
        eq(people.company_id, companyId),
        inArray(enrollments.status, statuses),
        pauseReason ? eq(enrollments.stop_reason, pauseReason) : undefined,
      ),
    );
  return rows.map((row) => row.id);
}

/** Active hold facts of the company other than `keepId`, set to `status`. */
async function closeHoldFacts(
  ctx: OpContext,
  companyId: string,
  status: "corrected" | "expired",
  keepId: string | null,
): Promise<void> {
  const workspace = requireWorkspace(ctx);
  await ctx.db
    .update(lead_facts)
    .set({
      status,
      ...(status === "corrected" && keepId ? { replaced_by: keepId } : {}),
      updated_at: ctx.clock.now(),
    })
    .where(
      and(
        eq(lead_facts.workspace_id, workspace.id),
        eq(lead_facts.scope, "company"),
        eq(lead_facts.company_id, companyId),
        eq(lead_facts.source_ref, HOLD_FACT_REF),
        eq(lead_facts.status, "active"),
        keepId ? ne(lead_facts.id, keepId) : undefined,
      ),
    );
}

/**
 * Puts a company on hold until `until` (details for the operation; `holdCompany` is the
 * binding form). Stores the hold, records a company fact (kind timing, source `agent` for
 * agents, `manual` otherwise, replacing the fact of an earlier hold), pauses the in-progress
 * enrollments of everyone at the company until then, resolves an open hold suggestion and emits
 * `company.hold_changed`. The same hold again changes nothing.
 */
export async function applyCompanyHold(
  ctx: OpContext,
  input: { companyId: string; until: Date; reason: string },
): Promise<CompanyHoldOutcome> {
  const workspace = requireWorkspace(ctx);
  const company = await requireCompany(ctx, input.companyId);
  const reason = cleanReason(input.reason);
  const now = ctx.clock.now();
  if (Number.isNaN(input.until.getTime()) || input.until.getTime() <= now.getTime()) {
    throw new OpenOutboundError("validation_failed", "A company hold must end in the future.", {
      hint: "Pass a later until date; to lift a hold now use manage_leads action release_company.",
      details: { field: "until" },
    });
  }
  if (company.hold_until?.getTime() === input.until.getTime() && company.hold_reason === reason) {
    return {
      changed: false,
      hold_until: company.hold_until,
      reason,
      enrollments: 0,
      fact_id: null,
    };
  }

  await ctx.db
    .update(companies)
    .set({ hold_until: input.until, hold_reason: reason, updated_at: now })
    .where(and(eq(companies.workspace_id, workspace.id), eq(companies.id, company.id)));

  const day = isoDateInZone(input.until, workspace.timezone);
  const fact = await recordFact(ctx, {
    companyId: company.id,
    scope: "company",
    kind: "timing",
    text: `No outreach until ${day}: ${reason}`,
    source: factSourceFor(ctx.principal),
    sourceRef: HOLD_FACT_REF,
    observedAt: now,
    expiresAt: input.until,
  });
  await closeHoldFacts(ctx, company.id, "corrected", fact.id);

  let paused = 0;
  for (const personId of await peopleWithEnrollments(ctx, company.id, [
    "active",
    "waiting_review",
    "paused",
  ])) {
    // A pause that lasts longer (an out-of-office past the hold) keeps its own end.
    paused += await pauseEnrollmentsForPerson(ctx, {
      personId,
      until: input.until,
      reason: COMPANY_HOLD_PAUSE,
      keepLongerPauses: true,
    });
  }
  await resolveProblemsFor(
    ctx,
    { dedupeKey: holdSuggestionKey(company.id) },
    `Company held until ${day}.`,
  );
  await ctx.events.emit("company.hold_changed", {
    subject: { type: "company", id: company.id },
    data: { company_id: company.id, hold_until: input.until.toISOString(), reason },
  });
  return { changed: true, hold_until: input.until, reason, enrollments: paused, fact_id: fact.id };
}

/**
 * Lifts a company hold (details for the operation; `releaseCompany` is the binding form):
 * clears it, marks the hold fact expired, resumes the enrollments paused for the hold and
 * emits `company.hold_changed` with `hold_until` null. A company without a hold (or with one
 * that already ended) changes nothing.
 */
export async function liftCompanyHold(
  ctx: OpContext,
  companyId: string,
): Promise<CompanyHoldOutcome> {
  const workspace = requireWorkspace(ctx);
  const company = await requireCompany(ctx, companyId);
  if (!activeHold(company, ctx.clock.now())) {
    return { changed: false, hold_until: null, reason: null, enrollments: 0, fact_id: null };
  }
  await ctx.db
    .update(companies)
    .set({ hold_until: null, hold_reason: null, updated_at: ctx.clock.now() })
    .where(and(eq(companies.workspace_id, workspace.id), eq(companies.id, company.id)));
  await closeHoldFacts(ctx, company.id, "expired", null);
  let resumed = 0;
  for (const personId of await peopleWithEnrollments(
    ctx,
    company.id,
    ["paused"],
    COMPANY_HOLD_PAUSE,
  )) {
    resumed += await resumeEnrollmentsForPerson(ctx, { personId, reason: COMPANY_HOLD_PAUSE });
  }
  await ctx.events.emit("company.hold_changed", {
    subject: { type: "company", id: company.id },
    data: { company_id: company.id, hold_until: null, reason: null },
  });
  return { changed: true, hold_until: null, reason: null, enrollments: resumed, fact_id: null };
}

/** Puts a company on hold until a date (see `applyCompanyHold`). */
export async function holdCompany(
  ctx: OpContext,
  input: { companyId: string; until: Date; reason: string },
): Promise<{ changed: boolean }> {
  const outcome = await applyCompanyHold(ctx, input);
  return { changed: outcome.changed };
}

/** Lifts a company hold (see `liftCompanyHold`). */
export async function releaseCompany(
  ctx: OpContext,
  companyId: string,
): Promise<{ changed: boolean }> {
  const outcome = await liftCompanyHold(ctx, companyId);
  return { changed: outcome.changed };
}

/** The company's hold while it lasts, or null. */
export function activeHold(
  company: { hold_until: Date | null; hold_reason: string | null },
  now: Date,
): { until: Date; reason: string | null } | null {
  if (!company.hold_until || company.hold_until.getTime() <= now.getTime()) return null;
  return { until: company.hold_until, reason: company.hold_reason };
}
