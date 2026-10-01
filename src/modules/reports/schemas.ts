import { z } from "zod";
import {
  CAMPAIGN_STATUSES,
  LINKEDIN_ACCOUNT_STATUSES,
  MAILBOX_STATUSES,
  OPPORTUNITY_STAGES,
  STEP_TYPES,
  WORKSPACE_STATUSES,
} from "../../core/enums.js";

/** Report output shapes (zod), shared by the builders, renderers and operations. */

export const REPORT_TYPES = [
  "overview",
  "campaign",
  "senders",
  "signals",
  "icp",
  "pipeline",
  "costs",
  "agency",
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

/** Agency reports span workspaces, so they cannot be scheduled per workspace. */
export const SCHEDULABLE_REPORT_TYPES = [
  "overview",
  "campaign",
  "senders",
  "signals",
  "icp",
  "pipeline",
  "costs",
] as const satisfies readonly ReportType[];

export const REPORT_FORMATS = ["json", "markdown", "csv"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

const count = z.number();
const percent = z.number().nullable();

export const metricSchema = z.object({
  value: z.number().nullable(),
  previous: z.number().nullable(),
  change: z.number().nullable(),
  change_pct: z.number().nullable(),
});

export const periodSchema = z.object({
  preset: z.string(),
  label: z.string(),
  from: z.string(),
  to: z.string(),
  timezone: z.string(),
  start_date: z.string().describe("First local day (YYYY-MM-DD)"),
  end_date: z.string().describe("Last local day, inclusive (YYYY-MM-DD)"),
  partial: z.boolean().describe("True when the period is still running (ends now)"),
});
export type PeriodOutput = z.infer<typeof periodSchema>;

const moneyAmount = z.object({ currency: z.string().nullable(), amount: z.number() });

// --- overview --------------------------------------------------------------------------------

export const overviewData = z.object({
  type: z.literal("overview"),
  metrics: z.object({
    new_leads: metricSchema,
    enrolled: metricSchema,
    contacted: metricSchema,
    emails_sent: metricSchema,
    linkedin_sent: metricSchema,
    replies: metricSchema,
    positive_replies: metricSchema,
    meetings: metricSchema,
    bounced: metricSchema,
    reply_rate: metricSchema,
    positive_rate: metricSchema,
    bounce_rate: metricSchema,
  }),
  replies_by_category: z
    .record(z.string(), z.number())
    .describe("Distinct people per reply category in the period"),
});
export type OverviewData = z.infer<typeof overviewData>;

// --- campaign --------------------------------------------------------------------------------

const funnelCounts = {
  sent: count,
  people: count,
  bounced: count,
  replies: count,
  positive_replies: count,
  reply_rate: percent,
  positive_rate: percent,
  bounce_rate: percent,
};

export const variantRowSchema = z.object({
  variant: z.string(),
  ...funnelCounts,
  meetings: count.describe(
    "People who got this variant in this step and later booked a meeting (any time up to now)",
  ),
  meeting_rate: percent.describe("meetings / people x 100"),
});
export const stepRowSchema = z.object({
  step_id: z.string().nullable().describe("Null for messages outside the current steps"),
  position: z.number().nullable().describe("1-based step number; null for other messages"),
  type: z.enum(STEP_TYPES).nullable(),
  label: z.string(),
  ...funnelCounts,
  accepted: z.number().nullable().describe("LinkedIn invite steps only"),
  variants: z.array(variantRowSchema),
  ab_metric: z
    .enum(["positive_reply_rate", "reply_rate", "meeting_rate"])
    .nullable()
    .describe("The campaign's ab_test.metric, for steps with variants"),
  leader: z
    .string()
    .nullable()
    .describe(
      "Variant most likely to be the best on ab_metric; null until enough_data (a variant nobody got is never the leader)",
    ),
  confidence: z
    .number()
    .nullable()
    .describe(
      "Probability (0-1) that the leader is the best (Beta-Binomial comparison); null until enough_data",
    ),
  enough_data: z.boolean().describe("Every variant has at least 50 sends"),
});
export type StepRow = z.infer<typeof stepRowSchema>;

export const campaignRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(CAMPAIGN_STATUSES),
  metrics: z.object({
    enrolled: metricSchema,
    contacted: metricSchema,
    emails_sent: metricSchema,
    linkedin_sent: metricSchema,
    replies: metricSchema,
    positive_replies: metricSchema,
    meetings: metricSchema,
    bounced: metricSchema,
    reply_rate: metricSchema,
    positive_rate: metricSchema,
    bounce_rate: metricSchema,
  }),
  enrollments: z.record(z.string(), z.number()).describe("Enrollments by status right now"),
  duplicates: count.describe(
    "Messages of the campaign found to have gone out twice in the period (an earlier try's answer came late, after the engine sent it again); each has a duplicate_send problem",
  ),
  steps: z.array(stepRowSchema),
});
export type CampaignRow = z.infer<typeof campaignRowSchema>;

export const campaignData = z.object({
  type: z.literal("campaign"),
  campaigns: z.array(campaignRowSchema),
  truncated: z.boolean(),
});
export type CampaignData = z.infer<typeof campaignData>;

// --- senders ---------------------------------------------------------------------------------

const limitUse = z.object({ used: count, limit: count });

export const mailboxRowSchema = z.object({
  id: z.string(),
  email: z.string(),
  status: z.enum(MAILBOX_STATUSES),
  status_reason: z.string().nullable(),
  sent: count,
  bounced: count,
  bounce_rate: percent,
  replies: count,
  daily_limit: count,
  sent_today: count,
  limit_used_pct: percent,
  sync_error: z
    .string()
    .nullable()
    .describe("Last reply-sync (IMAP) error; null when the last sync worked"),
});
export type MailboxRow = z.infer<typeof mailboxRowSchema>;

export const linkedinRowSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  provider: z.string(),
  status: z.enum(LINKEDIN_ACCOUNT_STATUSES),
  status_reason: z.string().nullable(),
  invites_sent: count,
  invites_accepted: count,
  acceptance_rate: percent,
  messages_sent: count,
  other_actions: count.describe("Visits, likes and comments"),
  replies: count,
  limits: z.object({
    invites_per_day: limitUse,
    invites_per_week: limitUse,
    messages_per_day: limitUse,
    visits_per_day: limitUse,
    likes_per_day: limitUse,
    comments_per_day: limitUse,
  }),
});
export type LinkedInRow = z.infer<typeof linkedinRowSchema>;

export const sendersData = z.object({
  type: z.literal("senders"),
  metrics: z.object({
    emails_sent: metricSchema,
    bounced: metricSchema,
    bounce_rate: metricSchema,
    linkedin_sent: metricSchema,
    replies: metricSchema,
  }),
  mailboxes: z.array(mailboxRowSchema),
  linkedin_accounts: z.array(linkedinRowSchema),
});
export type SendersData = z.infer<typeof sendersData>;

// --- signals ---------------------------------------------------------------------------------

export const signalRowSchema = z.object({
  key: z.string(),
  name: z.string().nullable(),
  detected: count,
  messages: count,
  people: count,
  replies: count,
  positive_replies: count,
  meetings: count,
  meetings_held: count,
  reply_rate: percent,
  positive_rate: percent,
  meeting_rate: percent,
  lift: z.number().nullable(),
  current_weight: z.number().nullable(),
  suggested_weight: z.number().nullable(),
});
export type SignalRow = z.infer<typeof signalRowSchema>;

export const signalsData = z.object({
  type: z.literal("signals"),
  metrics: z.object({
    detected: metricSchema,
    messages: metricSchema,
    people: metricSchema,
    positive_replies: metricSchema,
  }),
  keys: z.array(signalRowSchema),
  baseline: z
    .object({
      people: count,
      replies: count,
      positive_replies: count,
      reply_rate: percent,
      positive_rate: percent,
    })
    .describe("People contacted without any signal-based message in the period"),
});
export type SignalsData = z.infer<typeof signalsData>;

// --- icp -------------------------------------------------------------------------------------

const performance = {
  contacted: count,
  replies: count,
  positive_replies: count,
  meetings: count,
  reply_rate: percent,
  positive_rate: percent,
};

export const ICP_TIERS = ["A", "B", "C", "D", "unscored"] as const;
export type IcpTier = (typeof ICP_TIERS)[number];

export const icpData = z.object({
  type: z.literal("icp"),
  icps: z.array(z.object({ icp_id: z.string().nullable(), name: z.string(), ...performance })),
  tiers: z.array(z.object({ tier: z.enum(ICP_TIERS), fit_range: z.string(), ...performance })),
  criteria: z.array(
    z.object({
      rule: z.string(),
      contacted: count,
      positive_replies: count,
      positive_rate: percent,
    }),
  ),
  calibration: z.object({
    status: z.enum(["ok", "miscalibrated", "insufficient_data"]),
    note: z.string(),
  }),
});
export type IcpData = z.infer<typeof icpData>;

// --- pipeline --------------------------------------------------------------------------------

export const pipelineData = z.object({
  type: z.literal("pipeline"),
  metrics: z.object({
    new_opportunities: metricSchema,
    meetings: metricSchema,
    meetings_held: metricSchema,
    no_shows: metricSchema,
    meetings_cancelled: metricSchema,
    held_rate: metricSchema,
    qualified_meetings: metricSchema,
    won: metricSchema,
    lost: metricSchema,
    win_rate: metricSchema,
  }),
  stages: z
    .array(z.object({ stage: z.enum(OPPORTUNITY_STAGES), count, value: z.array(moneyAmount) }))
    .describe("All opportunities by current stage (not limited to the period)"),
  won_value: z.array(moneyAmount),
  lost_reasons: z.array(z.object({ reason: z.string(), count })),
  won_by_campaign: z.array(
    z.object({
      campaign_id: z.string().nullable(),
      campaign: z.string(),
      count,
      value: z.array(moneyAmount),
    }),
  ),
});
export type PipelineData = z.infer<typeof pipelineData>;

// --- costs -----------------------------------------------------------------------------------

export const costRowSchema = z.object({
  kind: z.enum(["ai", "data"]),
  slot: z.string(),
  provider: z.string(),
  operation: z.string().nullable(),
  calls: count,
  cost_usd: z.number(),
  credits: z.number(),
});
export type CostRow = z.infer<typeof costRowSchema>;

export const costsData = z.object({
  type: z.literal("costs"),
  metrics: z.object({
    ai_cost_usd: metricSchema,
    data_cost_usd: metricSchema,
    data_credits: metricSchema,
    total_cost_usd: metricSchema,
  }),
  by_provider: z.array(costRowSchema),
  by_operation: z.array(costRowSchema),
  budget: z.object({
    ai: z.object({
      monthly_budget_usd: z.number().nullable(),
      month_to_date_usd: z.number(),
      used_pct: percent,
    }),
    data: z.object({
      monthly_credit_budget: z.number().nullable(),
      month_to_date_credits: z.number(),
      used_pct: percent,
    }),
  }),
  unpriced_calls: count.describe("AI calls without a known price (CLI brains, unknown models)"),
});
export type CostsData = z.infer<typeof costsData>;

// --- agency ----------------------------------------------------------------------------------

export const agencyMetricsSchema = z.object({
  contacted: metricSchema,
  emails_sent: metricSchema,
  linkedin_sent: metricSchema,
  replies: metricSchema,
  positive_replies: metricSchema,
  meetings: metricSchema,
  reply_rate: metricSchema,
  positive_rate: metricSchema,
  bounce_rate: metricSchema,
  ai_cost_usd: metricSchema,
  data_credits: metricSchema,
});
export type AgencyMetrics = z.infer<typeof agencyMetricsSchema>;

export const agencyData = z.object({
  type: z.literal("agency"),
  workspaces: z.array(
    z.object({
      workspace_id: z.string(),
      name: z.string(),
      slug: z.string(),
      status: z.enum(WORKSPACE_STATUSES),
      is_sandbox: z.boolean(),
      metrics: agencyMetricsSchema,
      pending_approvals: count,
      warnings: count.describe("Paused or failing mailboxes and restricted LinkedIn accounts"),
    }),
  ),
  totals: agencyMetricsSchema,
  totals_exclude_sandbox: z
    .boolean()
    .describe("True when totals leave out sandbox workspaces (some real workspaces exist)"),
});
export type AgencyData = z.infer<typeof agencyData>;

// --- report ----------------------------------------------------------------------------------

export const reportDataSchema = z.discriminatedUnion("type", [
  overviewData,
  campaignData,
  sendersData,
  signalsData,
  icpData,
  pipelineData,
  costsData,
  agencyData,
]);
export type ReportData = z.infer<typeof reportDataSchema>;

export const reportWorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
});

/** A built report before formatting. */
export const reportSchema = z.object({
  type: z.enum(REPORT_TYPES),
  generated_at: z.string(),
  workspace: reportWorkspaceSchema.nullable().describe("Null for agency reports"),
  period: periodSchema,
  previous_period: periodSchema.nullable(),
  data: reportDataSchema,
  definitions: z.record(z.string(), z.string()),
  notes: z.array(z.string()),
});
export type Report = z.infer<typeof reportSchema>;

/** Output of reports.get: the report metadata plus exactly one of data, markdown or csv. */
export const reportOutputSchema = reportSchema.omit({ data: true }).extend({
  format: z.enum(REPORT_FORMATS),
  data: reportDataSchema.optional().describe("Structured report (format json)"),
  markdown: z.string().optional().describe("Compact markdown tables (format markdown)"),
  csv: z.string().optional().describe("One CSV table (format csv)"),
});
export type ReportOutput = z.infer<typeof reportOutputSchema>;
