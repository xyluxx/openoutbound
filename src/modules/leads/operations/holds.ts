/** Company hold operations: hold a whole company until a date, or lift the hold. */
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { type OpContext, requireWorkspace } from "../../../core/context.js";
import { OpenOutboundError } from "../../../core/errors.js";
import { idSchema } from "../../../core/ids.js";
import { defineOperation, isoDateTime } from "../../../core/operation.js";
import { problems } from "../../../db/schema/index.js";
import { isIsoDate, zonedMidnight } from "../../inbox/dates.js";
import { applyCompanyHold, holdSuggestionKey, liftCompanyHold } from "../holds.js";
import { EXAMPLE } from "./shapes.js";

/** Longest hold, to catch typos in the year. */
const MAX_HOLD_DAYS = 5 * 366;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;

/** A date (00:00 in the workspace timezone) or an ISO 8601 time with offset. */
function parseUntil(ctx: OpContext, value: string): Date {
  const workspace = requireWorkspace(ctx);
  const raw = value.trim();
  let until: Date | null = null;
  if (isIsoDate(raw)) until = zonedMidnight(raw, workspace.timezone);
  else if (ISO_DATE_TIME.test(raw)) until = new Date(raw);
  if (!until || Number.isNaN(until.getTime())) {
    throw new OpenOutboundError("validation_failed", `"${raw}" is not a date.`, {
      hint: "Pass until as YYYY-MM-DD (the hold ends at 00:00 in the workspace timezone) or an ISO 8601 time with offset.",
      details: { field: "until" },
    });
  }
  const now = ctx.clock.now();
  if (until.getTime() <= now.getTime()) {
    throw new OpenOutboundError("validation_failed", "A company hold must end in the future.", {
      hint: "Pass a later until date; to lift a hold now use manage_leads action release_company.",
      details: { field: "until" },
    });
  }
  if (until.getTime() - now.getTime() > MAX_HOLD_DAYS * 86_400_000) {
    throw new OpenOutboundError("validation_failed", "A company hold can last at most 5 years.", {
      hint: "Check the year in until; for a company that should never be contacted, set its status to do_not_contact with manage_leads action update_company.",
      details: { field: "until" },
    });
  }
  return until;
}

/** The reason an open hold suggestion for the company gives (from a reply), if any. */
async function suggestedReason(ctx: OpContext, companyId: string): Promise<string | null> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select({ data: problems.data })
    .from(problems)
    .where(
      and(
        eq(problems.workspace_id, workspace.id),
        eq(problems.dedupe_key, holdSuggestionKey(companyId)),
        ne(problems.status, "resolved"),
      ),
    )
    .limit(1);
  const reason = (row?.data as { reason?: unknown } | null | undefined)?.reason;
  return typeof reason === "string" && reason.trim() ? reason.trim() : null;
}

const holdView = z
  .object({ until: isoDateTime(), reason: z.string().nullable() })
  .nullable()
  .describe("The hold while it lasts, or null");

export const holdCompanyOp = defineOperation({
  id: "leads.hold_company",
  summary: "Stop all outreach to a company until a date",
  description:
    "Puts a whole company on hold until a date: nobody there gets campaign messages until then (answers to people who write to us still go out), their running sequences pause until the hold ends, and a company fact records the hold with its reason. Pass the reason in the common reason field; without one, the reason of an open company_hold_suggested problem for the company is used, and that problem is resolved. Use it when a reply or the CRM says the company is off-limits for a while, for example a competitor contract until March 2027. Not for a single person (pause or stop their enrollment) or a permanent block (set the company status do_not_contact with update_company); holding again with a new date or reason replaces the hold.",
  effect: "write",
  input: z.object({
    company_id: idSchema("co"),
    until: z
      .string()
      .min(10)
      .max(40)
      .describe(
        "YYYY-MM-DD (the hold ends at 00:00 in the workspace timezone) or an ISO 8601 time with offset",
      ),
  }),
  output: z.object({
    company_id: z.string(),
    changed: z.boolean().describe("False when the company already had this hold"),
    hold: holdView,
    enrollments_paused: z.number().int(),
    fact_id: z.string().nullable(),
  }),
  http: { method: "POST", path: "/v1/companies/:company_id/hold" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Competitor contract until March",
      input: { company_id: EXAMPLE.company, until: "2027-03-01" },
    },
  ],
  handler: async (ctx, input) => {
    const until = parseUntil(ctx, input.until);
    const reason = ctx.request.reason?.trim() || (await suggestedReason(ctx, input.company_id));
    if (!reason) {
      throw new OpenOutboundError("validation_failed", "A company hold needs a reason.", {
        hint: 'Pass reason, for example "Signed with a competitor until March 2027".',
        details: { field: "reason" },
      });
    }
    const outcome = await applyCompanyHold(ctx, { companyId: input.company_id, until, reason });
    return {
      company_id: input.company_id,
      changed: outcome.changed,
      hold: outcome.hold_until ? { until: outcome.hold_until, reason: outcome.reason } : null,
      enrollments_paused: outcome.enrollments,
      fact_id: outcome.fact_id,
    };
  },
});

export const releaseCompanyOp = defineOperation({
  id: "leads.release_company",
  summary: "Lift a company hold",
  description:
    "Ends a company hold now: outreach to the company is allowed again, sequences paused for the hold resume, and the hold fact is marked expired. Use it when the reason for the hold is gone, for example the competitor contract ended early. Not for companies with status do_not_contact, competitor or customer (change the status with update_company). A company without a hold changes nothing.",
  effect: "write",
  input: z.object({ company_id: idSchema("co") }),
  output: z.object({
    company_id: z.string(),
    changed: z.boolean().describe("False when the company had no hold"),
    enrollments_resumed: z.number().int(),
  }),
  http: { method: "POST", path: "/v1/companies/:company_id/release" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Lift a hold early", input: { company_id: EXAMPLE.company } }],
  handler: async (ctx, input) => {
    const outcome = await liftCompanyHold(ctx, input.company_id);
    return {
      company_id: input.company_id,
      changed: outcome.changed,
      enrollments_resumed: outcome.enrollments,
    };
  },
});

export const holdOperations = [holdCompanyOp, releaseCompanyOp];
