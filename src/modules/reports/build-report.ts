import type { OpContext } from "../../core/context.js";
import { OpenOutboundError } from "../../core/errors.js";
import type { Workspace } from "../../db/schema/index.js";
import { buildAgency } from "./builders/agency.js";
import { buildCampaign } from "./builders/campaign.js";
import type { BuildArgs, Built } from "./builders/common.js";
import { buildCosts } from "./builders/costs.js";
import { buildIcp } from "./builders/icp.js";
import { buildOverview } from "./builders/overview.js";
import { buildPipeline } from "./builders/pipeline.js";
import { buildSenders } from "./builders/senders.js";
import { buildSignals } from "./builders/signals.js";
import { definitionsFor } from "./definitions.js";
import {
  type Period,
  type PeriodPreset,
  periodDates,
  type ResolvedPeriods,
  resolvePeriods,
} from "./period.js";
import type { PeriodOutput, Report, ReportData, ReportType } from "./schemas.js";
import { isValidTimeZone } from "./timezone.js";

export interface ReportRequest {
  type: ReportType;
  preset?: PeriodPreset | undefined;
  from?: string | undefined;
  to?: string | undefined;
  /** IANA zone; default: the workspace timezone (UTC for agency reports). */
  timezone?: string | undefined;
  compare: boolean;
  campaignId?: string | null | undefined;
}

/** The report timezone: explicit input, else the workspace's, else UTC. */
export function reportTimeZone(requested: string | undefined, workspace: Workspace | null): string {
  if (requested !== undefined) {
    if (!isValidTimeZone(requested)) {
      throw new OpenOutboundError("validation_failed", `Unknown timezone "${requested}".`, {
        hint: "Pass an IANA timezone such as Europe/Berlin or America/New_York, or omit timezone to use the workspace timezone.",
      });
    }
    return requested;
  }
  if (workspace && isValidTimeZone(workspace.timezone)) return workspace.timezone;
  return "UTC";
}

/** Resolves the request's period in the report timezone. */
export function reportPeriods(
  request: Pick<ReportRequest, "preset" | "from" | "to" | "timezone">,
  workspace: Workspace | null,
  now: Date,
): ResolvedPeriods {
  return resolvePeriods(
    { preset: request.preset, from: request.from, to: request.to },
    now,
    reportTimeZone(request.timezone, workspace),
  );
}

export function periodOutput(period: Period): PeriodOutput {
  return {
    preset: period.preset,
    label: period.label,
    from: period.from.toISOString(),
    to: period.to.toISOString(),
    timezone: period.timezone,
    ...periodDates(period),
    partial: period.partial,
  };
}

/**
 * Builds one report. Agency reports need `workspace: null` and an access check by the caller
 * (`assertAgencyAccess`); every other type needs a workspace.
 */
export async function buildReport(
  ctx: OpContext,
  workspace: Workspace | null,
  request: ReportRequest,
): Promise<Report> {
  const now = ctx.clock.now();
  const periods = reportPeriods(request, request.type === "agency" ? null : workspace, now);
  const previous = request.compare ? periods.previous : null;
  let built: Built<ReportData>;
  if (request.type === "agency") {
    built = await buildAgency({ db: ctx.db, current: periods.current, previous, now });
  } else {
    if (!workspace) {
      throw new OpenOutboundError(
        "validation_failed",
        `The ${request.type} report needs a workspace.`,
        {
          hint: "Pass `workspace` (id or slug) or use a workspace API key; only type agency spans all workspaces.",
        },
      );
    }
    const args: BuildArgs = {
      ctx,
      db: ctx.db,
      workspace,
      current: periods.current,
      previous,
      now,
      campaignId: request.campaignId ?? null,
    };
    built = await buildWorkspaceReport(request.type, args);
  }
  return {
    type: request.type,
    generated_at: now.toISOString(),
    workspace:
      request.type === "agency" || !workspace
        ? null
        : { id: workspace.id, name: workspace.name, slug: workspace.slug },
    period: periodOutput(periods.current),
    previous_period: previous ? periodOutput(previous) : null,
    data: built.data,
    definitions: definitionsFor(built.metrics),
    notes: built.notes,
  };
}

function buildWorkspaceReport(
  type: Exclude<ReportType, "agency">,
  args: BuildArgs,
): Promise<Built<ReportData>> {
  switch (type) {
    case "overview":
      return buildOverview(args);
    case "campaign":
      return buildCampaign(args);
    case "senders":
      return buildSenders(args);
    case "signals":
      return buildSignals(args);
    case "icp":
      return buildIcp(args);
    case "pipeline":
      return buildPipeline(args);
    case "costs":
      return buildCosts(args);
  }
}
