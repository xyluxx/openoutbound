import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { requireWorkspace } from "../../../core/context.js";
import { OpenOutboundError } from "../../../core/errors.js";
import { idSchema } from "../../../core/ids.js";
import { defineOperation, dryRun, dryRunOutput } from "../../../core/operation.js";
import { enrollments } from "../../../db/schema/index.js";
import { resolvePeople } from "../../leads/service.js";
import { IN_PROGRESS, stopEnrollments } from "../control.js";
import { enrollPeople, MAX_ENROLL_BATCH } from "../enrollment.js";
import { loadCampaign } from "../repo.js";
import {
  EXAMPLE_CAMPAIGN_ID,
  EXAMPLE_LIST_ID,
  EXAMPLE_PERSON_ID,
  enrollResultOutput,
  leadFilterInput,
  toLeadFilter,
} from "../schemas.js";

const campaignId = idSchema("cmp").describe("Campaign id (cmp_...)");

export const enrollLeads = defineOperation({
  id: "campaigns.enroll",
  summary: "Enroll leads into a campaign with compliance checks",
  description:
    "Adds people (explicit ids, a list and/or a filter) to a campaign as queued enrollments; the sequencer starts up to daily_new_leads of them per day once the campaign is active. Every person is checked: already enrolled, one active campaign per person, rest days after an earlier campaign, contact cap per company, missing data for the first step and contactability (suppressions, status, countries, email verification). Run with dry_run: true first to see counts and skip reasons without enrolling. Skipped people are listed with reasons (first 100).",
  effect: "write",
  input: z.object({
    campaign_id: campaignId,
    person_ids: z.array(z.string()).max(MAX_ENROLL_BATCH).optional(),
    list_id: z.string().optional().describe("Enroll the members of this list"),
    filter: leadFilterInput.optional(),
    max: z
      .number()
      .int()
      .min(1)
      .max(MAX_ENROLL_BATCH)
      .default(1000)
      .describe("Most people to consider from the selection (default 1000)"),
  }),
  output: z.union([
    enrollResultOutput,
    dryRunOutput(enrollResultOutput.omit({ enrollment_ids: true })),
  ]),
  http: { method: "POST", path: "/v1/campaigns/:campaign_id/enroll" },
  dryRun: "supported",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Enroll a list",
      input: { campaign_id: EXAMPLE_CAMPAIGN_ID, list_id: EXAMPLE_LIST_ID },
    },
    {
      title: "Enroll high-fit leads with email",
      input: {
        campaign_id: EXAMPLE_CAMPAIGN_ID,
        filter: { min_fit_score: 70, has_email: true, not_in_active_campaign: true },
        max: 200,
      },
    },
  ],
  handler: async (ctx, input) => {
    await loadCampaign(ctx, input.campaign_id);
    if (!input.person_ids?.length && !input.list_id && !input.filter) {
      throw new OpenOutboundError("validation_failed", "Say who to enroll.", {
        hint: "Pass person_ids, list_id or filter (for example { min_fit_score: 70, has_email: true }).",
      });
    }
    const ids =
      input.list_id || input.filter
        ? await resolvePeople(ctx, {
            ...(input.person_ids?.length ? { personIds: input.person_ids } : {}),
            ...(input.list_id ? { listId: input.list_id } : {}),
            ...(input.filter ? { filter: toLeadFilter(input.filter) ?? {} } : {}),
          })
        : (input.person_ids ?? []);
    const warnings: string[] = [];
    const selected = ids.slice(0, input.max);
    if (ids.length > input.max) {
      warnings.push(
        `${ids.length} people matched; only the first ${input.max} were considered (raise max).`,
      );
    }
    const outcome = await enrollPeople(ctx, {
      campaignId: input.campaign_id,
      personIds: selected,
      dryRun: ctx.request.dryRun,
    });
    if (ctx.request.dryRun) {
      const { enrollment_ids: _ids, dry_run: _dry, ...preview } = outcome;
      return dryRun(preview, { warnings });
    }
    const { dry_run: _dry, ...result } = outcome;
    return result;
  },
});

export const unenrollLeads = defineOperation({
  id: "campaigns.unenroll",
  summary: "Remove people from a campaign (their enrollments stop)",
  description:
    "Stops the enrollments of these people in the campaign (reason unenrolled): pending drafts and approvals are cancelled and nothing more is sent to them in this campaign. Use it to pull someone out by hand. To stop someone everywhere (they replied, asked to stop) the inbox and suppressions handle it; add a suppression with manage_suppressions when they must never be contacted again.",
  effect: "write",
  input: z.object({
    campaign_id: campaignId,
    person_ids: z.array(z.string()).min(1).max(MAX_ENROLL_BATCH),
  }),
  output: z.object({ campaign_id: z.string(), stopped: z.number(), not_running: z.number() }),
  http: { method: "POST", path: "/v1/campaigns/:campaign_id/unenroll" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Remove one",
      input: { campaign_id: EXAMPLE_CAMPAIGN_ID, person_ids: [EXAMPLE_PERSON_ID] },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    await loadCampaign(ctx, input.campaign_id);
    const ids = [...new Set(input.person_ids)];
    const rows = await ctx.db
      .select({ id: enrollments.id })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.workspace_id, workspace.id),
          eq(enrollments.campaign_id, input.campaign_id),
          inArray(enrollments.person_id, ids),
          inArray(enrollments.status, IN_PROGRESS),
        ),
      );
    const stopped = await stopEnrollments(ctx, rows, "unenrolled");
    return { campaign_id: input.campaign_id, stopped, not_running: ids.length - stopped };
  },
});
