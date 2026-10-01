import type { Metric } from "../metric.js";
import type {
  AgencyData,
  CampaignData,
  CostsData,
  IcpData,
  PipelineData,
  Report,
  SendersData,
  SignalsData,
} from "../schemas.js";

type CsvValue = string | number | boolean | null | undefined;

/**
 * One CSV value (RFC 4180). Text that a spreadsheet would run as a formula (= + - @ tab CR at
 * the start) is prefixed with an apostrophe, since names and reasons come from data.
 */
export function csvValue(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function csvTable(headers: string[], body: CsvValue[][]): string {
  return `${[headers, ...body].map((row) => row.map(csvValue).join(",")).join("\r\n")}\r\n`;
}

/** The report's main table as CSV (one table per report type). */
export function renderCsv(report: Report): string {
  const data = report.data;
  switch (data.type) {
    case "overview":
      return metricsCsv(data.metrics);
    case "campaign":
      return campaignCsv(data);
    case "senders":
      return sendersCsv(data);
    case "signals":
      return signalsCsv(data);
    case "icp":
      return icpCsv(data);
    case "pipeline":
      return pipelineCsv(data);
    case "costs":
      return costsCsv(data);
    case "agency":
      return agencyCsv(data);
  }
}

function metricsCsv(metrics: Record<string, Metric>): string {
  return csvTable(
    ["metric", "value", "previous", "change", "change_pct"],
    Object.entries(metrics).map(([key, metric]) => [
      key,
      metric.value,
      metric.previous,
      metric.change,
      metric.change_pct,
    ]),
  );
}

function campaignCsv(data: CampaignData): string {
  return csvTable(
    [
      "campaign_id",
      "campaign",
      "status",
      "step",
      "step_type",
      "variant",
      "sent",
      "people",
      "bounced",
      "replies",
      "positive_replies",
      "accepted",
      "reply_rate",
      "positive_rate",
      "bounce_rate",
    ],
    data.campaigns.flatMap((campaign) =>
      campaign.steps.flatMap((step) => {
        const base = [campaign.id, campaign.name, campaign.status, step.position, step.type];
        const rows = step.variants.length > 0 ? step.variants : [{ ...step, variant: "" }];
        return rows.map((row) => [
          ...base,
          row.variant,
          row.sent,
          row.people,
          row.bounced,
          row.replies,
          row.positive_replies,
          step.variants.length > 0 ? null : step.accepted,
          row.reply_rate,
          row.positive_rate,
          row.bounce_rate,
        ]);
      }),
    ),
  );
}

function sendersCsv(data: SendersData): string {
  return csvTable(
    [
      "sender_type",
      "sender_id",
      "name",
      "status",
      "sent",
      "bounced",
      "bounce_rate",
      "replies",
      "invites_sent",
      "invites_accepted",
      "messages_sent",
      "daily_limit",
      "sent_today",
    ],
    [
      ...data.mailboxes.map((row) => [
        "mailbox",
        row.id,
        row.email,
        row.status,
        row.sent,
        row.bounced,
        row.bounce_rate,
        row.replies,
        null,
        null,
        null,
        row.daily_limit,
        row.sent_today,
      ]),
      ...data.linkedin_accounts.map((row) => [
        "linkedin",
        row.id,
        row.name,
        row.status,
        row.invites_sent + row.messages_sent + row.other_actions,
        null,
        null,
        row.replies,
        row.invites_sent,
        row.invites_accepted,
        row.messages_sent,
        row.limits.invites_per_day.limit,
        row.limits.invites_per_day.used,
      ]),
    ],
  );
}

function signalsCsv(data: SignalsData): string {
  return csvTable(
    [
      "key",
      "name",
      "detected",
      "messages",
      "people",
      "replies",
      "positive_replies",
      "meetings",
      "meetings_held",
      "reply_rate",
      "positive_rate",
      "meeting_rate",
      "lift",
      "current_weight",
      "suggested_weight",
    ],
    [
      ...data.keys.map((row) => [
        row.key,
        row.name,
        row.detected,
        row.messages,
        row.people,
        row.replies,
        row.positive_replies,
        row.meetings,
        row.meetings_held,
        row.reply_rate,
        row.positive_rate,
        row.meeting_rate,
        row.lift,
        row.current_weight,
        row.suggested_weight,
      ]),
      [
        "(no signal)",
        "Baseline",
        null,
        null,
        data.baseline.people,
        data.baseline.replies,
        data.baseline.positive_replies,
        null,
        null,
        data.baseline.reply_rate,
        data.baseline.positive_rate,
        null,
        null,
        null,
        null,
      ],
    ],
  );
}

function icpCsv(data: IcpData): string {
  return csvTable(
    [
      "group",
      "key",
      "name",
      "contacted",
      "replies",
      "positive_replies",
      "meetings",
      "reply_rate",
      "positive_rate",
    ],
    [
      ...data.icps.map((row) => [
        "icp",
        row.icp_id,
        row.name,
        row.contacted,
        row.replies,
        row.positive_replies,
        row.meetings,
        row.reply_rate,
        row.positive_rate,
      ]),
      ...data.tiers.map((row) => [
        "tier",
        row.tier,
        row.fit_range,
        row.contacted,
        row.replies,
        row.positive_replies,
        row.meetings,
        row.reply_rate,
        row.positive_rate,
      ]),
      ...data.criteria.map((row) => [
        "criterion",
        row.rule,
        row.rule,
        row.contacted,
        null,
        row.positive_replies,
        null,
        null,
        row.positive_rate,
      ]),
    ],
  );
}

function pipelineCsv(data: PipelineData): string {
  return csvTable(
    ["stage", "count", "value", "currency"],
    data.stages.flatMap((row) =>
      row.value.length === 0
        ? [[row.stage, row.count, null, null]]
        : row.value.map((entry, index) => [
            row.stage,
            index === 0 ? row.count : null,
            entry.amount,
            entry.currency,
          ]),
    ),
  );
}

function costsCsv(data: CostsData): string {
  return csvTable(
    ["kind", "slot", "provider", "operation", "calls", "cost_usd", "credits"],
    data.by_operation.map((row) => [
      row.kind,
      row.slot,
      row.provider,
      row.operation,
      row.calls,
      row.cost_usd,
      row.credits,
    ]),
  );
}

function agencyCsv(data: AgencyData): string {
  return csvTable(
    [
      "workspace_id",
      "workspace",
      "status",
      "is_sandbox",
      "contacted",
      "emails_sent",
      "linkedin_sent",
      "replies",
      "positive_replies",
      "meetings",
      "reply_rate",
      "positive_rate",
      "bounce_rate",
      "ai_cost_usd",
      "data_credits",
      "pending_approvals",
      "warnings",
    ],
    data.workspaces.map((row) => [
      row.workspace_id,
      row.name,
      row.status,
      row.is_sandbox,
      row.metrics.contacted.value,
      row.metrics.emails_sent.value,
      row.metrics.linkedin_sent.value,
      row.metrics.replies.value,
      row.metrics.positive_replies.value,
      row.metrics.meetings.value,
      row.metrics.reply_rate.value,
      row.metrics.positive_rate.value,
      row.metrics.bounce_rate.value,
      row.metrics.ai_cost_usd.value,
      row.metrics.data_credits.value,
      row.pending_approvals,
      row.warnings,
    ]),
  );
}
