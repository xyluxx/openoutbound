import { z } from "zod";
import {
  CAMPAIGN_GOALS,
  CAMPAIGN_STATUSES,
  CHANNELS,
  EMAIL_STATUSES,
  ENROLLMENT_STATUSES,
  MESSAGE_ACTIONS,
  MESSAGE_STATUSES,
  PERSON_STATUSES,
  REVIEW_LEVELS,
  STEP_TYPES,
} from "../../core/enums.js";
import { isoDateTime } from "../../core/operation.js";
import { parseCampaignSettings } from "../../core/settings.js";
import type {
  Campaign,
  CampaignStats,
  CampaignStep,
  Enrollment,
  Message,
} from "../../db/schema/index.js";
import type { LeadFilter } from "../leads/service.js";

export const EXAMPLE_CAMPAIGN_ID = "cmp_01k6a3v0q8x3m2n4p5r6s7t8v9";
export const EXAMPLE_PERSON_ID = "pe_01k6a3v0q8x3m2n4p5r6s7t8v9";
export const EXAMPLE_LIST_ID = "ls_01k6a3v0q8x3m2n4p5r6s7t8v9";
export const EXAMPLE_MESSAGE_ID = "msg_01k6a3v0q8x3m2n4p5r6s7t8v9";
export const EXAMPLE_OFFER_ID = "off_01k6a3v0q8x3m2n4p5r6s7t8v9";
export const EXAMPLE_MAILBOX_ID = "mbx_01k6a3v0q8x3m2n4p5r6s7t8v9";

/** People filter for enrollment and previews (same fields as leads search). */
export const leadFilterInput = z
  .object({
    query: z.string().max(200).optional().describe("Free text over name, email, title, company"),
    list_id: z.string().optional(),
    status: z.array(z.enum(PERSON_STATUSES)).optional(),
    tags: z.array(z.string()).optional(),
    min_fit_score: z.number().int().min(0).max(100).optional(),
    max_fit_score: z.number().int().min(0).max(100).optional(),
    has_email: z.boolean().optional(),
    email_status: z.array(z.enum(EMAIL_STATUSES)).optional(),
    countries: z.array(z.string().length(2)).optional().describe("ISO-2 country codes"),
    company_ids: z.array(z.string()).optional(),
    signal_keys: z.array(z.string()).optional().describe("Has an active signal of these types"),
    campaign_id: z.string().optional().describe("Enrolled in this campaign"),
    not_in_active_campaign: z.boolean().optional(),
  })
  .describe("People filter (same fields as search_leads)");

export function toLeadFilter(
  filter: z.output<typeof leadFilterInput> | undefined,
): LeadFilter | undefined {
  if (!filter) return undefined;
  const out: LeadFilter = {};
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

const counters = {
  sent: z.number(),
  replies: z.number(),
  positive_replies: z.number(),
  meetings: z.number(),
  bounces: z.number(),
};

export const stepStatsOutput = z.object({
  step_id: z.string(),
  position: z.number(),
  variant: z.string().nullable(),
  ...counters,
});

export const campaignStatsOutput = z.object({
  enrolled: z.number(),
  queued: z.number(),
  active: z.number(),
  completed: z.number(),
  stopped: z.number(),
  failed: z.number(),
  ...counters,
  refreshed_at: z.string().nullable(),
});

export const campaignSummaryOutput = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.enum(CAMPAIGN_STATUSES),
  goal: z.enum(CAMPAIGN_GOALS),
  offer_id: z.string().nullable(),
  icp_id: z.string().nullable(),
  priority: z.number(),
  review_level: z.enum(REVIEW_LEVELS),
  template_key: z.string().nullable(),
  step_count: z.number(),
  stats: campaignStatsOutput,
  created_at: isoDateTime(),
  launched_at: isoDateTime().nullable(),
  completed_at: isoDateTime().nullable(),
});

export const stepOutput = z.object({
  id: z.string(),
  position: z.number(),
  type: z.enum(STEP_TYPES),
  delay_days: z.number(),
  delay_hours: z.number(),
  config: z.record(z.string(), z.unknown()),
});

export const campaignDetailOutput = campaignSummaryOutput.extend({
  settings: z.record(z.string(), z.unknown()).describe("Effective settings (defaults filled)"),
  steps: z.array(stepOutput),
  step_stats: z.array(stepStatsOutput).describe("Counters per step and A/B variant"),
  enrollment_counts: z.record(z.string(), z.number()),
});

export function statsOf(
  stats: CampaignStats | null | undefined,
): z.input<typeof campaignStatsOutput> {
  return {
    enrolled: stats?.enrolled ?? 0,
    queued: stats?.queued ?? 0,
    active: stats?.active ?? 0,
    completed: stats?.completed ?? 0,
    stopped: stats?.stopped ?? 0,
    failed: stats?.failed ?? 0,
    sent: stats?.sent ?? 0,
    replies: stats?.replies ?? 0,
    positive_replies: stats?.positive_replies ?? 0,
    meetings: stats?.meetings ?? 0,
    bounces: stats?.bounces ?? 0,
    refreshed_at: stats?.refreshed_at ?? null,
  };
}

export function toCampaignSummary(
  campaign: Campaign,
  stepCount: number,
  stats?: CampaignStats,
): z.input<typeof campaignSummaryOutput> {
  const settings = parseCampaignSettings(campaign.settings);
  return {
    id: campaign.id,
    name: campaign.name,
    description: campaign.description,
    status: campaign.status,
    goal: campaign.goal,
    offer_id: campaign.offer_id,
    icp_id: campaign.icp_id,
    priority: settings.priority,
    review_level: settings.review_level,
    template_key: campaign.template_key,
    step_count: stepCount,
    stats: statsOf(stats ?? campaign.stats),
    created_at: campaign.created_at,
    launched_at: campaign.launched_at,
    completed_at: campaign.completed_at,
  };
}

export function toStepOutput(step: CampaignStep): z.input<typeof stepOutput> {
  const { type: _type, ...config } = step.config as Record<string, unknown>;
  return {
    id: step.id,
    position: step.position,
    type: step.type,
    delay_days: step.delay_days,
    delay_hours: step.delay_hours,
    config,
  };
}

export const enrollmentOutput = z.object({
  id: z.string(),
  person_id: z.string(),
  person_name: z.string().nullable(),
  status: z.enum(ENROLLMENT_STATUSES),
  current_step: z.number(),
  next_run_at: isoDateTime().nullable(),
  stop_reason: z.string().nullable(),
  paused_until: isoDateTime().nullable(),
  mailbox_id: z.string().nullable(),
  linkedin_account_id: z.string().nullable(),
  enrolled_at: isoDateTime(),
  activated_at: isoDateTime().nullable(),
  completed_at: isoDateTime().nullable(),
});

export function toEnrollmentOutput(
  enrollment: Enrollment,
  personName: string | null,
): z.input<typeof enrollmentOutput> {
  return { ...enrollment, person_name: personName };
}

export const enrollResultOutput = z.object({
  campaign_id: z.string(),
  requested: z.number(),
  enrolled: z.number().describe("New enrollments (queued); in a dry run, how many would be"),
  skipped: z.number(),
  by_reason: z.record(z.string(), z.number()),
  skipped_people: z.array(
    z.object({ person_id: z.string(), name: z.string().nullable(), reasons: z.array(z.string()) }),
  ),
  enrollment_ids: z.array(z.string()),
});

const whyOutput = z
  .object({
    angle: z.string().optional(),
    signal_ids: z.array(z.string()).optional(),
    signal_keys: z.array(z.string()).optional(),
    brief_id: z.string().nullable().optional(),
    knowledge_item_ids: z.array(z.string()).optional(),
    offer_id: z.string().nullable().optional(),
    facts: z.array(z.object({ text: z.string(), source: z.string() })).optional(),
    style: z.string().optional(),
    variant: z.string().nullable().optional(),
    notes: z.string().optional(),
    original: z
      .object({ subject: z.string().nullable(), body: z.string().nullable() })
      .optional()
      .describe("The AI draft before a human or agent edited it"),
  })
  .nullable();

const checkOutputShape = z
  .object({
    passed: z.boolean(),
    verdict: z.enum(["pass", "revise", "fail"]).optional(),
    confidence: z.number().optional(),
    issues: z.array(
      z.object({ code: z.string(), message: z.string(), severity: z.enum(["error", "warning"]) }),
    ),
    revised: z.boolean().optional(),
  })
  .nullable();

export const messageOutput = z.object({
  id: z.string(),
  campaign_id: z.string().nullable(),
  enrollment_id: z.string().nullable(),
  person_id: z.string().nullable(),
  step_id: z.string().nullable(),
  channel: z.enum(CHANNELS),
  action: z.enum(MESSAGE_ACTIONS),
  status: z.enum(MESSAGE_STATUSES),
  subject: z.string().nullable(),
  body_text: z.string().nullable().optional(),
  variant: z.string().nullable(),
  to_address: z.string().nullable(),
  mailbox_id: z.string().nullable(),
  linkedin_account_id: z.string().nullable(),
  why: whyOutput.optional(),
  check: checkOutputShape.optional(),
  error: z.string().nullable(),
  scheduled_for: isoDateTime().nullable(),
  sent_at: isoDateTime().nullable(),
  created_at: isoDateTime(),
});

/** Message for outputs; `detailed` adds body, why and check. */
export function toMessageOutput(
  message: Message,
  detailed: boolean,
): z.input<typeof messageOutput> {
  const base = {
    id: message.id,
    campaign_id: message.campaign_id,
    enrollment_id: message.enrollment_id,
    person_id: message.person_id,
    step_id: message.step_id,
    channel: message.channel,
    action: message.action,
    status: message.status,
    subject: message.subject,
    variant: message.variant,
    to_address: message.to_address,
    mailbox_id: message.mailbox_id,
    linkedin_account_id: message.linkedin_account_id,
    error: message.error,
    scheduled_for: message.scheduled_for,
    sent_at: message.sent_at,
    created_at: message.created_at,
  };
  if (!detailed) return base;
  return {
    ...base,
    body_text: message.body_text,
    why: (message.why as z.input<typeof whyOutput>) ?? null,
    check: (message.check as z.input<typeof checkOutputShape>) ?? null,
  };
}
