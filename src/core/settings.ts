import { z } from "zod";
import {
  BOOKING_MODES,
  MODEL_TIERS,
  REPLY_CATEGORIES,
  REVIEW_LEVELS,
  type ReplyCategory,
  STEP_TYPES,
  type StepType,
  TASK_TYPES,
} from "./enums.js";

/**
 * Settings schemas with defaults (spec section 8).
 *
 * Storage rule: jsonb columns store only what the user set (the `...Input` types); always read
 * them through `parseWorkspaceSettings` / `parseCampaignSettings` / `parseStepConfig`, which
 * fill defaults. That way improved defaults reach existing workspaces.
 *
 * Nested objects use `.prefault({})` so their inner defaults apply when the object is omitted.
 */

const isoDate = z.iso.date().describe("Date as YYYY-MM-DD");
const countryCode = z
  .string()
  .regex(/^[A-Z]{2}$/, { message: "Use an ISO 3166-1 alpha-2 code like DE" })
  .describe("ISO 3166-1 alpha-2 country code");
/** ISO weekday numbers: 1 = Monday ... 7 = Sunday. */
const weekday = z.number().int().min(1).max(7);
const hour = z.number().int().min(0).max(24);

// --- Replies ---------------------------------------------------------------------------------

/**
 * What the inbox does when a reply is classified into a category. Every category also runs its
 * built-in bookkeeping (stop rules, statuses, attention queue); the action picks the response.
 * - suppress: add to suppressions and stop every enrollment (unsubscribe)
 * - privacy: suppress everywhere, stop everything and open an urgent privacy problem with its
 *   deadline (privacy_request)
 * - mark_invalid: mark the email invalid and stop (bounce)
 * - pause_until_return: pause enrollments until the return date + 1 day (out of office)
 * - approve_referral: request approval to add and enroll the referred contact
 * - stop_and_suggest: stop and suggest a better contact (wrong person)
 * - stop_and_follow_up: stop, create a follow-up task in 90 days, draft a reply for review
 * - opportunity_and_draft: create an opportunity, notify now, draft a reply with the booking link
 * - draft_reply: draft a reply for review
 * - auto_reply: draft and send without review, only when the checker is confident
 * - notify_human: stop and notify a human, no draft
 * - human: put the thread in the attention queue
 * - ignore: do nothing beyond bookkeeping
 */
export const REPLY_ACTIONS = [
  "suppress",
  "privacy",
  "mark_invalid",
  "pause_until_return",
  "approve_referral",
  "stop_and_suggest",
  "stop_and_follow_up",
  "opportunity_and_draft",
  "draft_reply",
  "auto_reply",
  "notify_human",
  "human",
  "ignore",
] as const;
export type ReplyAction = (typeof REPLY_ACTIONS)[number];

export interface ReplyRule {
  action: ReplyAction;
  /** Locked rules cannot be changed by users or agents (safety and compliance). */
  locked: boolean;
}

/** Default reply handling per category (spec 11.11). Locked rules are enforced on parse. */
export const DEFAULT_REPLY_RULES: Record<ReplyCategory, ReplyRule> = {
  interested: { action: "opportunity_and_draft", locked: false },
  meeting_request: { action: "opportunity_and_draft", locked: false },
  question: { action: "draft_reply", locked: false },
  objection: { action: "draft_reply", locked: false },
  not_now: { action: "stop_and_follow_up", locked: false },
  referral: { action: "approve_referral", locked: false },
  wrong_person: { action: "stop_and_suggest", locked: false },
  out_of_office: { action: "pause_until_return", locked: false },
  unsubscribe: { action: "suppress", locked: true },
  privacy_request: { action: "privacy", locked: true },
  bounce: { action: "mark_invalid", locked: true },
  negative: { action: "notify_human", locked: true },
  auto_reply_other: { action: "ignore", locked: false },
  other: { action: "human", locked: false },
};

const replyRule = (category: ReplyCategory) =>
  z
    .object({
      action: z.enum(REPLY_ACTIONS).default(DEFAULT_REPLY_RULES[category].action),
      locked: z.boolean().default(DEFAULT_REPLY_RULES[category].locked),
    })
    .prefault({});

const replyRulesShape = Object.fromEntries(
  REPLY_CATEGORIES.map((category) => [category, replyRule(category)]),
) as { [K in ReplyCategory]: ReturnType<typeof replyRule> };

// --- Workspace -------------------------------------------------------------------------------

/** Per-task model override, keyed by prompt id (e.g. "campaigns.write_email") or tier name. */
const taskModelOverride = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  tier: z.enum(MODEL_TIERS).optional(),
});

export const workspaceSettingsSchema = z.object({
  company: z
    .object({
      name: z.string().default(""),
      website: z.string().default(""),
      postal_address: z.string().default("").describe("Printed in email footers (CAN-SPAM, GDPR)"),
      sender_company_line: z
        .string()
        .default("")
        .describe("e.g. 'Helix Outbound on behalf of ...'"),
    })
    .prefault({}),
  schedule: z
    .object({
      working_days: z.array(weekday).default([1, 2, 3, 4, 5]).describe("ISO weekdays, 1 = Monday"),
      holidays: z.array(isoDate).default([]),
      blackout_ranges: z.array(z.object({ from: isoDate, to: isoDate })).default([]),
    })
    .prefault({}),
  compliance: z
    .object({
      excluded_countries: z.array(countryCode).default([]),
      consent_required_countries: z
        .array(countryCode)
        .default(["DE", "AT", "IT", "ES", "NL", "DK", "PL", "BE"])
        .describe(
          "Countries that require prior consent even for B2B email: cold email is skipped unless person.custom.consent is true",
        ),
      publication_evidence_countries: z
        .array(countryCode)
        .default(["CA", "AU"])
        .describe(
          "Cold email only with evidence of where the address was published (person.email_source URL or person.custom.publication_url) or recorded consent",
        ),
      uk_sole_trader_check: z
        .boolean()
        .default(true)
        .describe(
          "UK (PECR): treat businesses without evidence of a corporate legal form as individuals and skip cold email unless consent is recorded",
        ),
      ad_disclosure: z
        .object({
          countries: z.array(countryCode).default(["US"]),
          text: z.string().default("This is a commercial message."),
        })
        .prefault({})
        .describe(
          "Footer line identifying the email as an advertisement (CAN-SPAM) for recipients in these countries",
        ),
      ai_disclosure: z
        .object({
          auto_replies: z.enum(["eu", "all", "off"]).default("eu"),
          text: z.string().default("This reply was written with AI assistance."),
        })
        .prefault({})
        .describe(
          "Line added to replies sent automatically without human review (EU AI Act Art. 50)",
        ),
      retention_days: z
        .number()
        .int()
        .min(30)
        .nullable()
        .default(1095)
        .describe(
          "Delete prospects with no contact or update for this many days (never customers or people with open opportunities); null keeps data",
        ),
      include_unsubscribe_link: z
        .boolean()
        .default(true)
        .describe(
          "System and notification email only; campaign email always carries the unsubscribe line and headers",
        ),
      include_postal_address: z
        .boolean()
        .default(true)
        .describe(
          "System and notification email only; campaign email always carries the postal address",
        ),
      gdpr_source_notice: z
        .boolean()
        .default(true)
        .describe("Adds one line naming the data source for EU contacts"),
      contact_cap_per_company: z
        .number()
        .int()
        .min(1)
        .default(3)
        .describe("Max active enrollments per company"),
      rest_days_after_campaign: z.number().int().min(0).default(30),
      one_active_campaign_per_person: z.boolean().default(true),
      privacy_response_days: z
        .number()
        .int()
        .min(1)
        .max(90)
        .default(30)
        .describe(
          "Days to answer a privacy request; the deadline is the earlier of this and one calendar month (GDPR)",
        ),
    })
    .prefault({}),
  sending: z
    .object({
      require_verified_email: z.boolean().default(true),
      catch_all: z
        .enum(["skip", "allow"])
        .default("skip")
        .describe("Catch-all addresses: skip them (default) or treat them as valid"),
      tracking: z
        .object({ opens: z.boolean().default(false), clicks: z.boolean().default(false) })
        .prefault({}),
      reply_delay_minutes: z
        .tuple([z.number().int().min(0), z.number().int().min(0)])
        .default([3, 12])
        .describe("Random human-like delay [min, max] before sending a reply"),
      daily_dns_check: z
        .boolean()
        .default(true)
        .describe(
          "Re-check MX, SPF, DKIM and DMARC once a day for the domain of every active or warming mailbox; a record that stops passing (green before, yellow or red now) or turns red opens a dns_failed problem, and mailboxes keep sending",
        ),
    })
    .prefault({}),
  ai: z
    .object({
      monthly_budget_usd: z.number().nonnegative().nullable().default(null),
      language: z.string().default("en"),
      tone_notes: z.string().default(""),
      task_models: z.record(z.string(), taskModelOverride).default({}),
      fallback_provider: z
        .string()
        .nullable()
        .default(null)
        .describe(
          "Brain provider id used when the main brain fails, or when the agent brain leaves a reply waiting longer than agent_timeout_minutes",
        ),
      agent_timeout_minutes: z
        .number()
        .int()
        .min(5)
        .max(1440)
        .default(30)
        .describe(
          "How long the agent brain may leave a reply unsorted (prompt inbox.reply.classify) before the fallback brain sorts it; other tasks keep waiting for the agent",
        ),
    })
    .prefault({}),
  data: z
    .object({
      monthly_credit_budget: z.number().nonnegative().nullable().default(null),
      auto_research_min_fit: z.number().int().min(0).max(100).default(70),
      enrichment: z
        .object({
          finders: z.array(z.string()).default([]).describe("email_finder provider ids, in order"),
          verifier: z.string().nullable().default(null).describe("email_verifier provider id"),
          verify_existing: z.boolean().default(true),
          pattern_guessing: z
            .boolean()
            .default(false)
            .describe(
              "Guess addresses like first.last@domain and verify them. Off by default: guessed addresses carry extra legal risk",
            ),
          website_crawler: z
            .boolean()
            .default(true)
            .describe(
              "Look for published addresses on the company website (contact, team, imprint pages)",
            ),
          crawler_excluded_countries: z
            .array(countryCode)
            .default([])
            .describe(
              "Never crawl websites for addresses of companies in these countries. Empty by default: the crawler records the page that publishes each address, the evidence CA and AU need",
            ),
        })
        .prefault({}),
    })
    .prefault({}),
  approvals: z
    .object({
      agent_launch_requires_approval: z.boolean().default(true),
      default_review_level: z.enum(REVIEW_LEVELS).default("first"),
      expire_days: z.number().int().min(1).max(90).default(7),
      agent_changes: z
        .enum(["approve", "auto"])
        .default("approve")
        .describe(
          "Whether proposed changes wait for an owner's approval when the proposer is not a person holding approve (agents, services, people without approve); auto applies them at once for everyone with the operation's scopes",
        ),
    })
    .prefault({}),
  replies: z.object(replyRulesShape).prefault({}),
  booking: z
    .object({
      mode: z
        .enum(BOOKING_MODES)
        .default("link")
        .describe(
          "link = replies share the booking link; handoff = a person or the agent books, the engine never proposes or confirms times; off = never offer meetings",
        ),
      default_url: z
        .url({ protocol: /^https?$/ })
        .nullable()
        .default(null)
        .describe("Booking link used when the offer a reply uses has none (or there is no offer)"),
      tag_links: z
        .boolean()
        .default(true)
        .describe(
          "Add a hidden per-person code to Calendly and Cal.com links so a booking matches the right lead, even from another address",
        ),
      assume_held_after_hours: z
        .number()
        .int()
        .min(0)
        .max(720)
        .default(24)
        .describe(
          "Count a meeting as held this many hours after it starts unless it was cancelled or marked no-show; 0 waits for an explicit mark",
        ),
      after_no_show: z
        .enum(["task", "draft", "nothing"])
        .default("task")
        .describe(
          "task = a follow-up task for a person; draft = a short follow-up with the booking link, always reviewed; nothing",
        ),
      after_cancel: z
        .enum(["task", "draft", "nothing"])
        .default("task")
        .describe(
          "What happens after a meeting is cancelled: task, draft or nothing, as for after_no_show",
        ),
    })
    .prefault({}),
  inbox: z
    .object({
      read_sent_folder: z
        .boolean()
        .default(true)
        .describe(
          "Read each mailbox's Sent folder to confirm sends and to notice replies you write yourself; the engine then steps back from that thread",
        ),
    })
    .prefault({}),
  lead_file: z
    .object({
      extract_facts: z
        .boolean()
        .default(true)
        .describe("Keep short business facts from replies, with their source, in the lead file"),
      extract_promises: z
        .boolean()
        .default(true)
        .describe("Turn promises in sent replies, like sending a case study on Monday, into tasks"),
      writer_context: z
        .boolean()
        .default(true)
        .describe("Give the writer a short summary of the lead file when drafting"),
    })
    .prefault({}),
  strategy: z
    .object({
      goals: z
        .string()
        .max(2000)
        .default("")
        .describe("The client's outbound goals in plain words"),
      qualified_meeting: z
        .string()
        .max(1000)
        .default("")
        .describe("What counts as a qualified meeting for this client"),
      agent_notes: z
        .string()
        .max(4000)
        .default("")
        .describe("The owner's standing instructions for any connected agent"),
    })
    .prefault({}),
  crm: z
    .object({
      mode: z
        .enum(["built_in", "agent", "off"])
        .default("built_in")
        .describe(
          "built_in = the engine syncs through the configured CRM providers; agent = the connected agent syncs any CRM with its own tools, following these preferences; off",
        ),
      sync_from: z
        .enum(["interested", "replied", "contacted"])
        .default("interested")
        .describe("When a person first goes to the CRM"),
      log: z
        .enum(["deals", "key_moments", "everything"])
        .default("deals")
        .describe(
          "What is written: deals only; plus replies and meetings as notes; plus every email sent and received",
        ),
      timing: z
        .enum(["live", "daily"])
        .default("live")
        .describe("live = sync as things happen; daily = sync once a day"),
      stage_owner: z
        .enum(["engine", "crm"])
        .default("engine")
        .describe("crm = after a deal exists the engine never overwrites its stage"),
      on_forget: z
        .enum(["task", "delete", "nothing"])
        .default("task")
        .describe(
          "When a person is forgotten: a task to delete them in the CRM, delete them there (built-in providers), or nothing",
        ),
      skip_owned_accounts: z
        .boolean()
        .default(false)
        .describe("Never contact companies the CRM says belong to a sales rep"),
      allow_outreach_with_open_deal: z
        .boolean()
        .default(false)
        .describe("Allow outreach to companies with an open deal in the CRM"),
      notes: z
        .string()
        .max(4000)
        .default("")
        .describe(
          "Free instructions for whoever syncs the CRM, for example which list to add people to",
        ),
    })
    .prefault({}),
  sandbox: z.object({ use_real_brain: z.boolean().default(false) }).prefault({}),
});

export type WorkspaceSettings = z.output<typeof workspaceSettingsSchema>;
/** What is stored in `workspaces.settings`: any subset of the settings. */
export type WorkspaceSettingsInput = z.input<typeof workspaceSettingsSchema>;

/** Fills defaults and enforces locked reply rules. Throws a ZodError on invalid values. */
export function parseWorkspaceSettings(raw: unknown): WorkspaceSettings {
  const settings = workspaceSettingsSchema.parse(raw ?? {});
  for (const category of REPLY_CATEGORIES) {
    if (DEFAULT_REPLY_RULES[category].locked) {
      settings.replies[category] = { ...DEFAULT_REPLY_RULES[category] };
    }
  }
  return settings;
}

// --- Campaign --------------------------------------------------------------------------------

export const campaignSettingsSchema = z.object({
  review_level: z.enum(REVIEW_LEVELS).default("first"),
  schedule: z
    .object({
      days: z.array(weekday).default([1, 2, 3, 4, 5]).describe("ISO weekdays, 1 = Monday"),
      start_hour: hour.default(8),
      end_hour: hour.default(17),
      timezone_mode: z
        .enum(["lead", "fixed"])
        .default("lead")
        .describe("lead = send in each lead's timezone; fixed = use `timezone`"),
      timezone: z.string().default("UTC").describe("IANA zone; fallback when a lead has none"),
      start_at: z.iso.datetime({ offset: true }).optional(),
      end_at: z.iso.datetime({ offset: true }).optional(),
    })
    .prefault({}),
  daily_new_leads: z.number().int().min(0).max(10_000).default(20),
  senders: z
    .object({
      mailbox_ids: z.array(z.string()).default([]),
      linkedin_account_ids: z.array(z.string()).default([]),
    })
    .prefault({}),
  priority: z.number().int().min(0).max(100).default(50),
  writing: z
    .object({
      language: z.string().optional().describe("Defaults to the workspace AI language"),
      length: z.enum(["short", "medium"]).default("short"),
      style_notes: z.string().default(""),
      instructions: z.string().default(""),
      rules: z.array(z.string()).default([]).describe("Rules learned from teach/corrections"),
    })
    .prefault({}),
  missing_data: z.enum(["skip_step", "skip_lead"]).default("skip_step"),
  end_action: z
    .object({
      type: z.enum(["none", "tag", "list"]).default("none"),
      value: z.string().optional().describe("Tag name or list id"),
    })
    .prefault({}),
  stop: z
    .object({
      on_reply: z.boolean().default(true),
      on_company_reply: z.boolean().default(true),
      on_meeting: z.boolean().default(true),
    })
    .prefault({}),
  tracking: z
    .object({ opens: z.boolean().default(false), clicks: z.boolean().default(false) })
    .prefault({}),
  ab_test: z
    .object({
      enabled: z.boolean().default(false),
      metric: z
        .enum(["positive_reply_rate", "reply_rate", "meeting_rate"])
        .default("positive_reply_rate"),
    })
    .prefault({}),
});

export type CampaignSettings = z.output<typeof campaignSettingsSchema>;
/** What is stored in `campaigns.settings`. */
export type CampaignSettingsInput = z.input<typeof campaignSettingsSchema>;

export function parseCampaignSettings(raw: unknown): CampaignSettings {
  return campaignSettingsSchema.parse(raw ?? {});
}

// --- Steps -----------------------------------------------------------------------------------

const writingStyle = z
  .enum(["exact", "guided", "free"])
  .describe("exact = template as is; guided = template with [[ai: ...]] slots; free = AI writes");

const emailVariant = z.object({
  key: z.string().min(1).max(20),
  subject: z.string().optional(),
  body: z.string().optional(),
  instruction: z.string().optional(),
});

const emailStep = z
  .object({
    type: z.literal("email"),
    mode: z.enum(["new_thread", "reply"]).default("new_thread"),
    style: writingStyle.default("free"),
    subject: z.string().optional(),
    body: z.string().optional(),
    instruction: z.string().optional(),
    variants: z.array(emailVariant).optional(),
    max_words: z.number().int().min(20).max(400).default(90),
  })
  .refine((step) => step.style === "free" || Boolean(step.body) || Boolean(step.variants?.length), {
    message: "exact and guided emails need a body (or variants with bodies)",
    path: ["body"],
  });

const linkedinInviteStep = z
  .object({
    type: z.literal("linkedin_invite"),
    note: z
      .enum(["none", "exact", "guided", "free"])
      .default("none")
      .describe("Invite note: max 200 chars for free accounts, 300 for premium"),
    text: z.string().max(300).optional(),
    instruction: z.string().optional(),
  })
  .refine((step) => !(step.note === "exact" || step.note === "guided") || Boolean(step.text), {
    message: "exact and guided invite notes need text",
    path: ["text"],
  });

const linkedinMessageStep = z
  .object({
    type: z.literal("linkedin_message"),
    style: writingStyle.default("free"),
    text: z.string().optional(),
    instruction: z.string().optional(),
  })
  .refine((step) => step.style === "free" || Boolean(step.text), {
    message: "exact and guided messages need text",
    path: ["text"],
  });

const linkedinCommentStep = z.object({
  type: z.literal("linkedin_comment"),
  instruction: z.string().optional(),
  review: z
    .enum(["always", "level"])
    .default("always")
    .describe("always = every comment needs approval; level = follow the campaign review level"),
});

const linkedinLikeStep = z.object({ type: z.literal("linkedin_like") });
const linkedinVisitStep = z.object({ type: z.literal("linkedin_visit") });
const waitStep = z.object({ type: z.literal("wait") });

const conditionStep = z
  .object({
    type: z.literal("condition"),
    if: z.enum([
      "linkedin_connected",
      "has_email",
      "has_linkedin",
      "signal_present",
      "replied",
      "custom",
    ]),
    signal_key: z.string().optional().describe("Required when if = signal_present"),
    custom_field: z
      .string()
      .optional()
      .describe("For if = custom: key in person.custom; true when set (or equal to custom_value)"),
    custom_value: z.string().optional(),
    then_step: z
      .number()
      .int()
      .min(0)
      .nullable()
      .default(null)
      .describe("Step position to jump to when true; null = continue with the next step"),
    else_step: z
      .number()
      .int()
      .min(0)
      .nullable()
      .default(null)
      .describe("Step position to jump to when false; null = continue with the next step"),
  })
  .refine((step) => step.if !== "signal_present" || Boolean(step.signal_key), {
    message: "signal_present conditions need signal_key",
    path: ["signal_key"],
  })
  .refine((step) => step.if !== "custom" || Boolean(step.custom_field), {
    message: "custom conditions need custom_field",
    path: ["custom_field"],
  });

const taskStep = z.object({
  type: z.literal("task"),
  task_type: z.enum(TASK_TYPES).default("other"),
  title: z.string().min(1),
  notes: z.string().default(""),
});

const webhookStep = z.object({
  type: z.literal("webhook"),
  url: z.url({ protocol: /^https?$/ }),
  secret_id: z.string().optional().describe("Vault secret used to sign the request"),
});

/** Step config, discriminated by `type`. Stored (including `type`) in `campaign_steps.config`. */
export const stepConfigSchema = z.discriminatedUnion("type", [
  emailStep,
  linkedinInviteStep,
  linkedinMessageStep,
  linkedinCommentStep,
  linkedinLikeStep,
  linkedinVisitStep,
  waitStep,
  conditionStep,
  taskStep,
  webhookStep,
]);

export type StepConfig = z.output<typeof stepConfigSchema>;
export type StepConfigInput = z.input<typeof stepConfigSchema>;
/** Config for one step type, e.g. `StepConfigOf<"email">`. */
export type StepConfigOf<T extends StepType> = Extract<StepConfig, { type: T }>;

/** Parses a step config for the given type (the `type` field is set from the argument). */
export function parseStepConfig<T extends StepType>(type: T, raw: unknown): StepConfigOf<T> {
  const base = typeof raw === "object" && raw !== null ? raw : {};
  return stepConfigSchema.parse({ ...base, type }) as StepConfigOf<T>;
}

/** Sanity check that every step type has a schema (kept in sync with STEP_TYPES). */
export const STEP_CONFIG_TYPES: readonly StepType[] = STEP_TYPES;

// --- Templates -------------------------------------------------------------------------------

/**
 * Variables available in exact and guided templates: `{{first_name}}`, fallbacks with
 * `{{first_name|there}}`, custom fields with `{{custom.x}}`. Guided AI slots: `[[ai: instruction]]`.
 */
export const TEMPLATE_VARIABLES = [
  "first_name",
  "last_name",
  "company",
  "title",
  "city",
  "sender_name",
  "offer",
  "booking_url",
] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

// --- Helpers ---------------------------------------------------------------------------------

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep-merges a settings patch into stored settings: objects merge, arrays and scalars replace,
 * `null` sets null (use it to clear nullable settings). Validate the result with the schema.
 */
export function mergeSettings<T extends PlainObject>(current: T, patch: PlainObject): T {
  const out: PlainObject = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const existing = out[key];
    out[key] =
      isPlainObject(value) && isPlainObject(existing) ? mergeSettings(existing, value) : value;
  }
  return out as T;
}
