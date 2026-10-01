import { z } from "zod";
import { invalid } from "../../../core/errors.js";
import { idSchema } from "../../../core/ids.js";
import { defineOperation } from "../../../core/operation.js";
import type { Workspace } from "../../../db/schema/index.js";
import { resolveWorkspace } from "../../../runtime/workspace-resolution.js";
import { buildReport } from "../build-report.js";
import { assertAgencyAccess } from "../builders/agency.js";
import { PERIOD_PRESETS } from "../period.js";
import { toOutput } from "../render/output.js";
import { REPORT_FORMATS, REPORT_TYPES, reportOutputSchema } from "../schemas.js";

const dateOrDateTime = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

export const getReportInput = z.object({
  type: z
    .enum(REPORT_TYPES)
    .default("overview")
    .describe(
      "overview | campaign (funnel by step and variant) | senders | signals (attribution per signal key) | icp | pipeline | costs | agency (all workspaces; instance admin only)",
    ),
  period: z
    .enum(PERIOD_PRESETS)
    .optional()
    .describe("Preset in the report timezone; default last_7_days (the 7 full days before today)"),
  from: dateOrDateTime
    .optional()
    .describe("Custom start: YYYY-MM-DD (local day start) or ISO datetime; needs to"),
  to: dateOrDateTime
    .optional()
    .describe("Custom end: YYYY-MM-DD (inclusive, the whole day) or ISO datetime (exclusive)"),
  timezone: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "IANA timezone for period boundaries; default the workspace timezone (UTC for agency)",
    ),
  compare: z
    .boolean()
    .default(true)
    .describe("Compare with the previous period (previous, change, change_pct per metric)"),
  format: z
    .enum(REPORT_FORMATS)
    .default("json")
    .describe("json (structured data) | markdown (compact tables) | csv (the main table)"),
  campaign_id: idSchema("cmp")
    .optional()
    .describe("Only with type campaign: one campaign's funnel instead of all active campaigns"),
});

export const getReport = defineOperation({
  id: "reports.get",
  summary: "Get a performance report for a period",
  description:
    "Builds a report for a period with previous-period deltas: overview, campaign (funnel by step and A/B variant), senders (per mailbox and LinkedIn account), signals (reply and meeting attribution per signal key), icp (per ICP, fit tier and criterion), pipeline, costs (AI and data spend, budget use) or agency (all workspaces side by side, instance admin only). Use it to answer how outreach performs and what converts; formats are json, markdown or csv. Not for what needs action now (use get_attention_queue) or one lead or thread (get_lead, list_threads). Metrics follow the `definitions` field of the output, and periods use the workspace timezone unless you pass timezone.",
  effect: "read",
  input: getReportInput,
  output: reportOutputSchema,
  http: { method: "GET", path: "/v1/reports" },
  dryRun: "none",
  idempotent: true,
  workspace: "optional",
  examples: [
    { title: "Last 7 days overview", input: { type: "overview", period: "last_7_days" } },
    {
      title: "One campaign's funnel as markdown",
      input: {
        type: "campaign",
        campaign_id: "cmp_01k6a3v0q8x3m2n4p5r6s7t8v9",
        format: "markdown",
      },
    },
    {
      title: "Signal attribution for a custom range",
      input: { type: "signals", from: "2026-09-01", to: "2026-09-15" },
    },
    { title: "All clients this month", input: { type: "agency", period: "this_month" } },
  ],
  handler: async (ctx, input) => {
    if (input.campaign_id && input.type !== "campaign") {
      throw invalid("campaign_id only works with type campaign.", { type: input.type });
    }
    let workspace: Workspace | null = null;
    if (input.type === "agency") assertAgencyAccess(ctx.principal);
    else {
      // The operation is workspace-optional only for agency: other types resolve like any
      // workspace operation (an instance key without `workspace` gets the only workspace, or an
      // error listing the slugs).
      workspace =
        ctx.workspace ?? (await resolveWorkspace(ctx.db, "required", ctx.principal, null));
    }
    const report = await buildReport(ctx, workspace, {
      type: input.type,
      preset: input.period,
      from: input.from,
      to: input.to,
      timezone: input.timezone,
      compare: input.compare,
      campaignId: input.campaign_id ?? null,
    });
    return toOutput(report, input.format);
  },
});
