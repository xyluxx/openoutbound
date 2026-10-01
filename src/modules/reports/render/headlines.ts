import type { Metric } from "../metric.js";
import type { Report } from "../schemas.js";
import { formatValue, formatWithChange } from "./format.js";

const MAX_LINES = 5;

/** Up to 5 short lines with the report's key numbers, for notifications (Slack, email). */
export function headlineLines(report: Report): string[] {
  const compared = report.previous_period !== null;
  const count = (metric: Metric) => formatWithChange(metric, "count", compared);
  const percent = (metric: Metric) => formatWithChange(metric, "percent", compared);
  const usd = (metric: Metric) => formatWithChange(metric, "usd", compared);
  const pct = (value: number | null) => formatValue(value, "percent");
  const data = report.data;
  let lines: string[];
  switch (data.type) {
    case "overview": {
      const m = data.metrics;
      lines = [
        `Contacted ${count(m.contacted)}, new leads ${count(m.new_leads)}`,
        `Replied ${count(m.replies)}, reply rate ${percent(m.reply_rate)}`,
        `Positive ${count(m.positive_replies)}, positive rate ${percent(m.positive_rate)}`,
        `Meetings ${count(m.meetings)}`,
        `Bounce rate ${percent(m.bounce_rate)}`,
      ];
      break;
    }
    case "campaign":
      lines = data.campaigns.map(
        (campaign) =>
          `${campaign.name}: contacted ${campaign.metrics.contacted.value ?? 0}, replied ${campaign.metrics.replies.value ?? 0} (${pct(campaign.metrics.reply_rate.value)}), positive ${campaign.metrics.positive_replies.value ?? 0}, meetings ${campaign.metrics.meetings.value ?? 0}`,
      );
      if (lines.length === 0) lines = ["No campaign activity in this period."];
      break;
    case "senders": {
      const flagged = data.mailboxes.filter((mailbox) => mailbox.status !== "active");
      lines = [
        `Emails sent ${count(data.metrics.emails_sent)}, bounce rate ${percent(data.metrics.bounce_rate)}`,
        `LinkedIn sent ${count(data.metrics.linkedin_sent)}, replies ${count(data.metrics.replies)}`,
        ...flagged.map((mailbox) => `${mailbox.email} is ${mailbox.status}`),
        ...data.linkedin_accounts
          .filter((account) => account.status === "restricted")
          .map((account) => `LinkedIn ${account.name ?? account.id} is restricted`),
      ];
      break;
    }
    case "signals":
      lines = data.keys.map(
        (row) =>
          `${row.key}: ${row.people} people, ${row.positive_replies} positive (${pct(row.positive_rate)}), ${row.meetings} meetings, ${row.meetings_held} held`,
      );
      if (lines.length === 0) lines = ["No signal-based outreach in this period."];
      break;
    case "icp":
      lines = [
        ...data.tiers
          .filter((tier) => tier.contacted > 0)
          .map(
            (tier) =>
              `Tier ${tier.tier}: ${tier.contacted} contacted, ${pct(tier.positive_rate)} positive`,
          ),
        `Calibration: ${data.calibration.note}`,
      ];
      break;
    case "pipeline": {
      const m = data.metrics;
      lines = [
        `New opportunities ${count(m.new_opportunities)}, meetings ${count(m.meetings)}`,
        `Held ${count(m.meetings_held)}, no-shows ${count(m.no_shows)}, held rate ${percent(m.held_rate)}`,
        `Won ${count(m.won)}, lost ${count(m.lost)}, win rate ${percent(m.win_rate)}`,
        ...data.stages.map((stage) => `${stage.stage}: ${stage.count}`),
      ];
      break;
    }
    case "costs":
      lines = [
        `AI ${usd(data.metrics.ai_cost_usd)}, data ${usd(data.metrics.data_cost_usd)} and ${formatWithChange(data.metrics.data_credits, "credits", compared)} credits`,
        data.budget.ai.used_pct === null
          ? "No AI budget set"
          : `AI budget ${pct(data.budget.ai.used_pct)} used this month`,
        data.budget.data.used_pct === null
          ? "No data budget set"
          : `Data budget ${pct(data.budget.data.used_pct)} used this month`,
      ];
      break;
    case "agency":
      lines = data.workspaces.map(
        (workspace) =>
          `${workspace.name}: contacted ${workspace.metrics.contacted.value ?? 0}, positive ${workspace.metrics.positive_replies.value ?? 0}, meetings ${workspace.metrics.meetings.value ?? 0}`,
      );
      break;
  }
  return lines.slice(0, MAX_LINES);
}
