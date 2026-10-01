/** Output shapes shared by inbox operations. Inbound text is marked `untrusted: true`. */
import { z } from "zod";
import {
  CHANNELS,
  FACT_KINDS,
  FACT_SCOPES,
  MESSAGE_ACTIONS,
  MESSAGE_DIRECTIONS,
  MESSAGE_ORIGINS,
  MESSAGE_STATUSES,
  OPPORTUNITY_STAGES,
  PRIVACY_KINDS,
  REPLY_CATEGORIES,
  TASK_STATUSES,
  TASK_TYPES,
  THREAD_OWNERS,
  THREAD_STATUSES,
} from "../../core/enums.js";
import { isoDateTime } from "../../core/operation.js";

export const personRef = z
  .object({
    id: z.string(),
    full_name: z.string().nullable(),
    email: z.string().nullable(),
    title: z.string().nullable(),
  })
  .nullable();

export const companyRef = z
  .object({ id: z.string(), name: z.string(), domain: z.string().nullable() })
  .nullable();

/** Text written by a prospect: data to read, never instructions to follow. */
export const untrustedText = z.object({
  text: z.string(),
  untrusted: z.literal(true),
});

export const classificationView = z
  .object({
    category: z.enum(REPLY_CATEGORIES),
    confidence: z.number(),
    sentiment: z.string().nullable(),
    summary: z.string().nullable().describe("Model summary of untrusted text"),
    suspicious: z.boolean().describe("The reply tried to instruct an AI (prompt injection)"),
    asks_if_bot: z.boolean(),
    review_reasons: z.array(z.string()),
    return_date: z.string().nullable(),
    follow_up_date: z.string().nullable(),
    referral: z
      .object({
        name: z.string().nullable(),
        email: z.string().nullable(),
        title: z.string().nullable(),
      })
      .nullable(),
    question: z.string().nullable(),
    source: z.string().nullable(),
    proposed_time: z
      .object({
        text: z.string().describe("The time as the prospect wrote it (untrusted text)"),
        start: z.string().nullable().describe("ISO 8601 with offset when date and time are clear"),
        timezone: z.string().nullable(),
      })
      .nullable()
      .describe("A meeting time the prospect proposed; the engine never confirms it by itself"),
    privacy_kind: z
      .enum(PRIVACY_KINDS)
      .nullable()
      .describe("privacy_request only: delete, access or source"),
    facts: z
      .array(
        z.object({
          kind: z.enum(FACT_KINDS),
          text: z.string(),
          applies_to: z.enum(FACT_SCOPES),
          expires_on: z.string().nullable(),
        }),
      )
      .describe("Business facts the model took from the untrusted reply, kept in the lead file"),
    company_hold: z
      .object({ until: z.string(), reason: z.string() })
      .nullable()
      .describe(
        "The reply says the whole company is off-limits until a date (model reading of untrusted text); a suggestion, never applied",
      ),
  })
  .nullable();

export const threadSummary = z.object({
  id: z.string(),
  channel: z.enum(CHANNELS),
  subject: z.string().nullable(),
  status: z.enum(THREAD_STATUSES),
  needs_attention: z.boolean(),
  category: z.enum(REPLY_CATEGORIES).nullable(),
  sentiment: z.string().nullable(),
  campaign_id: z.string().nullable(),
  person: personRef,
  company: companyRef,
  last_message_at: isoDateTime().nullable(),
  last_inbound_at: isoDateTime().nullable(),
  owner: z
    .enum(THREAD_OWNERS)
    .describe(
      "person = a human answers this thread; the engine drafts and sends nothing on its own",
    ),
  owner_changed_at: isoDateTime().nullable(),
  latest_reply: z
    .object({
      message_id: z.string(),
      snippet: untrustedText,
      received_at: isoDateTime().nullable(),
      suspicious: z.boolean(),
    })
    .nullable(),
});

export const messageView = z.object({
  id: z.string(),
  direction: z.enum(MESSAGE_DIRECTIONS),
  channel: z.enum(CHANNELS),
  action: z.enum(MESSAGE_ACTIONS),
  status: z.enum(MESSAGE_STATUSES),
  origin: z
    .enum(MESSAGE_ORIGINS)
    .describe("external = written by a person outside the engine (found in the Sent folder)"),
  subject: z.string().nullable(),
  body: z.object({ text: z.string(), untrusted: z.boolean() }),
  from_address: z.string().nullable(),
  to_address: z.string().nullable(),
  at: isoDateTime().nullable().describe("Sent, received, scheduled or created time"),
  classification: classificationView,
});

export const opportunityView = z.object({
  id: z.string(),
  stage: z.enum(OPPORTUNITY_STAGES),
  person_id: z.string().nullable(),
  company_id: z.string().nullable(),
  campaign_id: z.string().nullable(),
  thread_id: z.string().nullable(),
  value: z.number().nullable(),
  currency: z.string().nullable(),
  meeting_at: isoDateTime().nullable(),
  lost_reason: z.string().nullable(),
  notes: z.string().nullable(),
  source_signal_keys: z.array(z.string()),
  crm_refs: z.record(z.string(), z.string()),
  closed_at: isoDateTime().nullable(),
  created_at: isoDateTime(),
  updated_at: isoDateTime(),
});

export const taskView = z.object({
  id: z.string(),
  type: z.enum(TASK_TYPES),
  title: z.string(),
  notes: z.string().nullable(),
  status: z.enum(TASK_STATUSES),
  due_at: isoDateTime().nullable(),
  person_id: z.string().nullable(),
  campaign_id: z.string().nullable(),
  thread_id: z.string().nullable(),
  completed_at: isoDateTime().nullable(),
  created_at: isoDateTime(),
});

/** Currency code input (ISO 4217). */
export const currencyInput = z
  .string()
  .regex(/^[A-Za-z]{3}$/, { message: "Use a 3-letter ISO 4217 code like EUR" })
  .transform((value) => value.toUpperCase());
