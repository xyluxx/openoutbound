import { METRICS, type MetricKey } from "../definitions.js";
import type { Metric } from "../metric.js";
import type {
  AgencyData,
  AgencyMetrics,
  CampaignData,
  CostsData,
  IcpData,
  OverviewData,
  PipelineData,
  Report,
  ReportType,
  SendersData,
  SignalsData,
  StepRow,
} from "../schemas.js";
import { cell, formatChange, formatValue, formatWithChange, table } from "./format.js";

export const REPORT_TITLES: Record<ReportType, string> = {
  overview: "Overview",
  campaign: "Campaigns",
  senders: "Senders",
  signals: "Signal attribution",
  icp: "ICP performance",
  pipeline: "Pipeline",
  costs: "Costs",
  agency: "Agency overview",
};

const pct = (value: number | null) => formatValue(value, "percent");
const num = (value: number | null) => formatValue(value, "count");

/** Compact markdown: a header, the report's tables, notes and the key definitions. */
export function renderMarkdown(
  report: Report,
  options: { summary?: string | null; highlights?: string[] } = {},
): string {
  const compared = report.previous_period !== null;
  const parts = [header(report)];
  if (options.summary) {
    const highlights = (options.highlights ?? []).map((line) => `- ${line}`);
    parts.push([`**Summary:** ${options.summary}`, ...highlights].join("\n"));
  }
  parts.push(body(report, compared));
  if (report.notes.length > 0) {
    parts.push(["**Notes**", ...report.notes.map((note) => `- ${note}`)].join("\n"));
  }
  const keyDefinitions = [
    "reply_rate",
    "positive_rate",
    "bounce_rate",
    "meetings",
    "held_rate",
  ].filter((key) => report.definitions[key]);
  if (keyDefinitions.length > 0) {
    parts.push(
      ["**Definitions**", ...keyDefinitions.map((key) => `- ${report.definitions[key]}`)].join(
        "\n",
      ),
    );
  }
  return `${parts.join("\n\n")}\n`;
}

function header(report: Report): string {
  const scope = report.workspace ? `: ${report.workspace.name}` : "";
  const period = report.period;
  const lines = [
    `## ${REPORT_TITLES[report.type]}${scope}`,
    `${period.label}: ${period.start_date} to ${period.end_date} (${period.timezone})${period.partial ? ", so far" : ""}.`,
  ];
  if (report.previous_period) {
    const previous = report.previous_period;
    lines[1] = `${lines[1]} Compared with ${previous.start_date} to ${previous.end_date}.`;
  }
  return lines.join("\n");
}

function body(report: Report, compared: boolean): string {
  const data = report.data;
  switch (data.type) {
    case "overview":
      return overview(data, compared);
    case "campaign":
      return campaigns(data, compared);
    case "senders":
      return senders(data, compared);
    case "signals":
      return signals(data, compared);
    case "icp":
      return icp(data);
    case "pipeline":
      return pipeline(data, compared);
    case "costs":
      return costs(data, compared);
    case "agency":
      return agency(data, compared);
  }
}

/** Metric / Value / Previous / Change table. */
function metricTable(metrics: Record<string, Metric>, compared: boolean): string {
  const entries = Object.entries(metrics) as Array<[MetricKey, Metric]>;
  if (!compared) {
    return table(
      ["Metric", "Value"],
      entries.map(([key, metric]) => [
        METRICS[key].label,
        formatValue(metric.value, METRICS[key].unit),
      ]),
      [false, true],
    );
  }
  return table(
    ["Metric", "Value", "Previous", "Change"],
    entries.map(([key, metric]) => {
      const unit = METRICS[key].unit;
      return [
        METRICS[key].label,
        formatValue(metric.value, unit),
        formatValue(metric.previous, unit),
        formatChange(metric, unit),
      ];
    }),
    [false, true, true, true],
  );
}

function overview(data: OverviewData, compared: boolean): string {
  const parts = [metricTable(data.metrics, compared)];
  const categories = Object.entries(data.replies_by_category);
  if (categories.length > 0) {
    parts.push(
      `Replies by category: ${categories.map(([category, count]) => `${category} ${count}`).join(", ")}.`,
    );
  }
  return parts.join("\n\n");
}

function campaigns(data: CampaignData, compared: boolean): string {
  if (data.campaigns.length === 0)
    return "_No campaigns are active or had activity in this period._";
  const withChange = (metric: Metric, key: MetricKey) =>
    formatWithChange(metric, METRICS[key].unit, compared);
  const summary = table(
    [
      "Campaign",
      "Status",
      "Contacted",
      "Replied",
      "Positive",
      "Meetings",
      "Reply %",
      "Positive %",
      "Bounce %",
    ],
    data.campaigns.map((campaign) => [
      campaign.name,
      campaign.status,
      withChange(campaign.metrics.contacted, "contacted"),
      withChange(campaign.metrics.replies, "replies"),
      withChange(campaign.metrics.positive_replies, "positive_replies"),
      withChange(campaign.metrics.meetings, "meetings"),
      withChange(campaign.metrics.reply_rate, "reply_rate"),
      withChange(campaign.metrics.positive_rate, "positive_rate"),
      withChange(campaign.metrics.bounce_rate, "bounce_rate"),
    ]),
    [false, false, true, true, true, true, true, true, true],
  );
  const funnels = data.campaigns
    .filter((campaign) => campaign.steps.length > 0)
    .map((campaign) => `### ${cell(campaign.name)}: funnel by step\n${stepTable(campaign.steps)}`);
  const tests = data.campaigns.flatMap((campaign) => {
    const steps = campaign.steps.filter((step) => step.variants.length >= 2);
    return steps.length > 0 ? [`### ${cell(campaign.name)}: A/B tests\n${abTable(steps)}`] : [];
  });
  return [summary, ...funnels, ...tests].join("\n\n");
}

const AB_METRIC_LABELS: Record<NonNullable<StepRow["ab_metric"]>, string> = {
  positive_reply_rate: "Positive %",
  reply_rate: "Reply %",
  meeting_rate: "Meeting %",
};

/** One row per step with variants: the leader, how sure, and meetings by variant. */
function abTable(steps: StepRow[]): string {
  return table(
    ["Step", "Metric", "Leader", "Chance best", "Enough data", "Meetings by variant"],
    steps.map((step) => [
      step.position === null ? step.label : `${step.position}. ${step.label}`,
      step.ab_metric ? AB_METRIC_LABELS[step.ab_metric] : "-",
      step.leader ?? "-",
      step.confidence === null ? "-" : `${Math.round(step.confidence * 100)}%`,
      step.enough_data ? "yes" : "no (50 sends per variant)",
      step.variants.map((variant) => `${variant.variant} ${num(variant.meetings)}`).join(", "),
    ]),
    [false, false, false, true, false, false],
  );
}

function stepTable(steps: StepRow[]): string {
  const bodyRows: string[][] = [];
  for (const step of steps) {
    const label = step.position === null ? step.label : `${step.position}. ${step.label}`;
    bodyRows.push(stepCells(label, step, step.accepted));
    for (const variant of step.variants) {
      bodyRows.push(stepCells(`${label} / variant ${variant.variant}`, variant, null));
    }
  }
  return table(
    [
      "Step",
      "Sent",
      "People",
      "Bounced",
      "Replied",
      "Positive",
      "Reply %",
      "Positive %",
      "Accepted",
    ],
    bodyRows,
    [false, true, true, true, true, true, true, true, true],
  );
}

function stepCells(
  label: string,
  row: Pick<
    StepRow,
    "sent" | "people" | "bounced" | "replies" | "positive_replies" | "reply_rate" | "positive_rate"
  >,
  accepted: number | null,
): string[] {
  return [
    label,
    num(row.sent),
    num(row.people),
    num(row.bounced),
    num(row.replies),
    num(row.positive_replies),
    pct(row.reply_rate),
    pct(row.positive_rate),
    accepted === null ? "-" : num(accepted),
  ];
}

function senders(data: SendersData, compared: boolean): string {
  const parts = [metricTable(data.metrics, compared)];
  parts.push(
    `### Mailboxes\n${table(
      ["Mailbox", "Status", "Sent", "Bounced", "Bounce %", "Replies", "Today / limit"],
      data.mailboxes.map((mailbox) => [
        mailbox.status_reason ? `${mailbox.email} (${mailbox.status_reason})` : mailbox.email,
        mailbox.status,
        num(mailbox.sent),
        num(mailbox.bounced),
        pct(mailbox.bounce_rate),
        num(mailbox.replies),
        `${mailbox.sent_today} / ${mailbox.daily_limit}`,
      ]),
      [false, false, true, true, true, true, true],
    )}`,
  );
  if (data.linkedin_accounts.length > 0) {
    parts.push(
      `### LinkedIn accounts\n${table(
        [
          "Account",
          "Status",
          "Invites",
          "Accepted",
          "Accept %",
          "Messages",
          "Replies",
          "Invites today",
          "Invites week",
        ],
        data.linkedin_accounts.map((account) => [
          account.name ?? account.id,
          account.status,
          num(account.invites_sent),
          num(account.invites_accepted),
          pct(account.acceptance_rate),
          num(account.messages_sent),
          num(account.replies),
          `${account.limits.invites_per_day.used} / ${account.limits.invites_per_day.limit}`,
          `${account.limits.invites_per_week.used} / ${account.limits.invites_per_week.limit}`,
        ]),
        [false, false, true, true, true, true, true, true, true],
      )}`,
    );
  }
  return parts.join("\n\n");
}

function signals(data: SignalsData, compared: boolean): string {
  const parts = [metricTable(data.metrics, compared)];
  parts.push(
    table(
      [
        "Signal",
        "Detected",
        "Messages",
        "People",
        "Replied",
        "Positive",
        "Meetings",
        "Held",
        "Positive %",
        "Lift",
        "Weight (suggested)",
      ],
      data.keys.map((row) => [
        row.name ? `${row.key} (${row.name})` : row.key,
        num(row.detected),
        num(row.messages),
        num(row.people),
        num(row.replies),
        num(row.positive_replies),
        num(row.meetings),
        num(row.meetings_held),
        pct(row.positive_rate),
        formatValue(row.lift, "ratio"),
        `${row.current_weight ?? "-"} (${row.suggested_weight ?? "-"})`,
      ]),
      [false, true, true, true, true, true, true, true, true, true, true],
    ),
  );
  const baseline = data.baseline;
  parts.push(
    `Baseline without signals: ${num(baseline.people)} people, ${num(baseline.replies)} replied, ${num(baseline.positive_replies)} positive (${pct(baseline.positive_rate)}).`,
  );
  return parts.join("\n\n");
}

function icp(data: IcpData): string {
  const perf = (row: {
    contacted: number;
    replies: number;
    positive_replies: number;
    meetings: number;
    reply_rate: number | null;
    positive_rate: number | null;
  }) => [
    num(row.contacted),
    num(row.replies),
    num(row.positive_replies),
    num(row.meetings),
    pct(row.reply_rate),
    pct(row.positive_rate),
  ];
  const headers = ["Contacted", "Replied", "Positive", "Meetings", "Reply %", "Positive %"];
  const right = [false, true, true, true, true, true, true];
  const parts = [
    `### By ICP\n${table(
      ["ICP", ...headers],
      data.icps.map((row) => [row.name, ...perf(row)]),
      right,
    )}`,
    `### By fit tier\n${table(
      ["Tier", ...headers],
      data.tiers.map((row) => [`${row.tier} (${row.fit_range})`, ...perf(row)]),
      right,
    )}`,
  ];
  if (data.criteria.length > 0) {
    parts.push(
      `### By matched criterion\n${table(
        ["Criterion", "Contacted", "Positive", "Positive %"],
        data.criteria.map((row) => [
          row.rule,
          num(row.contacted),
          num(row.positive_replies),
          pct(row.positive_rate),
        ]),
        [false, true, true, true],
      )}`,
    );
  }
  parts.push(`Calibration: ${data.calibration.status}. ${data.calibration.note}`);
  return parts.join("\n\n");
}

function amounts(list: Array<{ currency: string | null; amount: number }>): string {
  if (list.length === 0) return "-";
  return list
    .map(
      (entry) =>
        `${formatValue(entry.amount, "count")}${entry.currency ? ` ${entry.currency}` : ""}`,
    )
    .join(" + ");
}

function pipeline(data: PipelineData, compared: boolean): string {
  const parts = [metricTable(data.metrics, compared)];
  parts.push(
    `### Stages (all opportunities)\n${table(
      ["Stage", "Count", "Value"],
      data.stages.map((row) => [row.stage, num(row.count), amounts(row.value)]),
      [false, true, true],
    )}`,
  );
  parts.push(`Won value in the period: ${amounts(data.won_value)}.`);
  if (data.lost_reasons.length > 0) {
    parts.push(
      `Lost reasons: ${data.lost_reasons.map((row) => `${cell(row.reason)} (${row.count})`).join(", ")}.`,
    );
  }
  if (data.won_by_campaign.length > 0) {
    parts.push(
      `Won by campaign: ${data.won_by_campaign
        .map((row) => `${cell(row.campaign)} ${row.count} (${amounts(row.value)})`)
        .join(", ")}.`,
    );
  }
  return parts.join("\n\n");
}

function costs(data: CostsData, compared: boolean): string {
  const usd = (value: number) => formatValue(value, "usd");
  const parts = [metricTable(data.metrics, compared)];
  parts.push(
    `### By provider\n${table(
      ["Kind", "Provider", "Calls", "Cost", "Credits"],
      data.by_provider.map((row) => [
        row.kind,
        `${row.slot}/${row.provider}`,
        num(row.calls),
        usd(row.cost_usd),
        formatValue(row.credits, "credits"),
      ]),
      [false, false, true, true, true],
    )}`,
  );
  if (data.by_operation.length > 0) {
    parts.push(
      `### Top operations\n${table(
        ["Operation", "Provider", "Calls", "Cost", "Credits"],
        data.by_operation.map((row) => [
          row.operation ?? "-",
          row.provider,
          num(row.calls),
          usd(row.cost_usd),
          formatValue(row.credits, "credits"),
        ]),
        [false, false, true, true, true],
      )}`,
    );
  }
  const ai = data.budget.ai;
  const credits = data.budget.data;
  parts.push(
    [
      `AI budget: ${usd(ai.month_to_date_usd)} used this month${ai.monthly_budget_usd === null ? " (no budget set)" : ` of ${usd(ai.monthly_budget_usd)} (${pct(ai.used_pct)})`}.`,
      `Data budget: ${formatValue(credits.month_to_date_credits, "credits")} credits used this month${credits.monthly_credit_budget === null ? " (no budget set)" : ` of ${formatValue(credits.monthly_credit_budget, "credits")} (${pct(credits.used_pct)})`}.`,
    ].join("\n"),
  );
  return parts.join("\n\n");
}

function agency(data: AgencyData, compared: boolean): string {
  const row = (name: string, metrics: AgencyMetrics, approvals: string, warnings: string) => [
    name,
    formatWithChange(metrics.contacted, "count", compared),
    formatWithChange(metrics.replies, "count", compared),
    formatWithChange(metrics.positive_replies, "count", compared),
    formatWithChange(metrics.meetings, "count", compared),
    pct(metrics.reply_rate.value),
    pct(metrics.positive_rate.value),
    pct(metrics.bounce_rate.value),
    formatValue(metrics.ai_cost_usd.value, "usd"),
    approvals,
    warnings,
  ];
  const bodyRows = data.workspaces.map((workspace) =>
    row(
      `${workspace.name}${workspace.status === "paused" ? " (paused)" : ""}`,
      workspace.metrics,
      num(workspace.pending_approvals),
      num(workspace.warnings),
    ),
  );
  if (data.workspaces.length > 1) {
    bodyRows.push(
      row(
        data.totals_exclude_sandbox ? "**Total (excluding sandbox)**" : "**Total**",
        data.totals,
        "",
        "",
      ),
    );
  }
  return table(
    [
      "Workspace",
      "Contacted",
      "Replied",
      "Positive",
      "Meetings",
      "Reply %",
      "Positive %",
      "Bounce %",
      "AI cost",
      "Approvals",
      "Warnings",
    ],
    bodyRows,
    [false, true, true, true, true, true, true, true, true, true, true],
  );
}
