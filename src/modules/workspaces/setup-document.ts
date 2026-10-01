/**
 * The setup document (`format: "openoutbound.setup"`): a client's reusable setup as plain JSON,
 * with names instead of ids so it can be imported into another workspace or instance. It never
 * holds leads, messages, mailboxes, LinkedIn accounts, providers, keys or credentials.
 */
import { z } from "zod";
import { KNOWLEDGE_KINDS, STEP_TYPES } from "../../core/enums.js";
import { OpenOutboundError } from "../../core/errors.js";
import { DEFAULT_REPLY_RULES } from "../../core/settings.js";

export const SETUP_FORMAT = "openoutbound.setup";
export const SETUP_VERSION = 1;

/** What an import creates, per record type. */
export const SETUP_ITEM_TYPES = [
  "offer",
  "icp",
  "knowledge",
  "lesson",
  "signal",
  "automation",
  "campaign_template",
] as const;
export type SetupItemType = (typeof SETUP_ITEM_TYPES)[number];

const name = z.string().trim().min(1).max(200);

export const setupOfferSchema = z.object({
  name,
  summary: z.string().default(""),
  details: z.string().default(""),
  value_props: z.array(z.string()).default([]),
  /** Proof and case study items by kind and title (resolved in the target workspace). */
  proof: z.array(z.object({ kind: z.enum(KNOWLEDGE_KINDS), title: z.string() })).default([]),
  cta: z.string().nullable().default(null),
  booking_url: z.string().nullable().default(null),
  is_default: z.boolean().default(false),
});
export type SetupOffer = z.output<typeof setupOfferSchema>;

export const setupIcpSchema = z.object({
  name,
  description: z.string().nullable().default(null),
  criteria: z.record(z.string(), z.unknown()).default({}),
  scoring: z.record(z.string(), z.unknown()).default({}),
  signal_keys: z.array(z.string()).default([]),
  is_default: z.boolean().default(false),
});
export type SetupIcp = z.output<typeof setupIcpSchema>;

export const setupKnowledgeSchema = z.object({
  kind: z.enum(KNOWLEDGE_KINDS),
  title: name,
  body: z.string().default(""),
  status: z.enum(["active", "suggested"]).default("active"),
  tags: z.array(z.string()).default([]),
  /** Where the item came from, when it is a web page. */
  source_url: z.string().nullable().default(null),
  /** Lessons stop guiding writing after this time. */
  expires_at: z.iso.datetime({ offset: true }).nullable().default(null),
});
export type SetupKnowledge = z.output<typeof setupKnowledgeSchema>;

export const setupCustomSignalSchema = z.object({
  key: z.string().trim().min(1).max(80),
  name: z.string(),
  description: z.string(),
  instructions: z.string().optional(),
  collectors: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
  urls: z.array(z.string()).optional(),
  weight: z.number().optional(),
  half_life_days: z.number().optional(),
  min_strength: z.number().optional(),
  tier: z.string().optional(),
  enabled: z.boolean().default(true),
});
export type SetupCustomSignal = z.output<typeof setupCustomSignalSchema>;

const maxPeople = z.number().int().optional();

/**
 * Automation actions, with list and campaign names instead of ids, no webhook secrets and, unless
 * the export kept client identity, no webhook URLs.
 */
export const setupAutomationActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("notify"),
    severity: z.enum(["info", "warning", "critical"]).optional(),
  }),
  z.object({ type: z.literal("add_to_list"), list: z.string(), max_people: maxPeople }),
  z.object({
    type: z.literal("research"),
    target: z.enum(["people", "company", "both"]).optional(),
    max_people: maxPeople,
  }),
  z.object({
    type: z.literal("webhook"),
    /** Null unless the export kept client identity (include_company): it is the client's endpoint. */
    url: z.string().nullable().default(null),
    /** The source rule signed its requests; the secret itself is never exported. */
    signed: z.boolean().default(false),
  }),
  z.object({ type: z.literal("enroll"), campaign: z.string(), max_people: maxPeople }),
  z.object({
    type: z.literal("tag"),
    tag: z.string(),
    target: z.enum(["company", "people", "both"]).optional(),
  }),
]);
export type SetupAutomationAction = z.output<typeof setupAutomationActionSchema>;

export const setupAutomationSchema = z.object({
  name,
  enabled: z.boolean().default(true),
  require_approval: z.boolean().default(false),
  filters: z
    .object({
      definition_keys: z.array(z.string()).optional(),
      min_score: z.number().optional(),
      min_fit: z.number().optional(),
      has_email: z.boolean().optional(),
      max_fires_per_day: z.number().optional(),
      /** List name. */
      list: z.string().optional(),
    })
    .default({}),
  actions: z.array(setupAutomationActionSchema).min(1),
});
export type SetupAutomation = z.output<typeof setupAutomationSchema>;

export const setupTemplateSchema = z.object({
  name,
  description: z.string().nullable().default(null),
  goal: z.string().nullable().default(null),
  why: z.string().default(""),
  settings: z.record(z.string(), z.unknown()).default({}),
  steps: z
    .array(
      z.object({
        type: z.enum(STEP_TYPES),
        delay_days: z.number().int().min(0).default(0),
        delay_hours: z.number().int().min(0).default(0),
        config: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .default([]),
});
export type SetupTemplate = z.output<typeof setupTemplateSchema>;

export const setupDocumentSchema = z.object({
  format: z.literal(SETUP_FORMAT),
  version: z.literal(SETUP_VERSION),
  exported_at: z.string(),
  settings: z.record(z.string(), z.unknown()).default({}),
  offers: z.array(setupOfferSchema).default([]),
  icps: z.array(setupIcpSchema).default([]),
  signals: z
    .object({
      custom: z.array(setupCustomSignalSchema).default([]),
      /** Built-in signal keys that are on; null = leave the built-ins as they are. */
      builtin_enabled: z.array(z.string()).nullable().default(null),
    })
    .prefault({}),
  automations: z.array(setupAutomationSchema).default([]),
  knowledge: z.array(setupKnowledgeSchema).default([]),
  lessons: z.array(setupKnowledgeSchema).default([]),
  campaign_templates: z.array(setupTemplateSchema).default([]),
});
export type SetupDocument = z.output<typeof setupDocumentSchema>;

/**
 * The setup document in `raw`: the document itself, or a whole export_setup result
 * (`{ setup, summary, path }`, as `--json` prints it).
 */
export function unwrapSetup(raw: unknown): unknown {
  if (isPlain(raw) && raw.format === undefined && isPlain(raw.setup)) return raw.setup;
  return raw;
}

/** Reads a setup document, with plain errors for a wrong format, version or shape. */
export function parseSetupDocument(raw: unknown): SetupDocument {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (record.format !== SETUP_FORMAT) {
    throw new OpenOutboundError("validation_failed", "This is not an OpenOutbound setup file.", {
      hint: `Pass the setup object returned by manage_workspaces action export_setup (format "${SETUP_FORMAT}").`,
      details: { field: "setup.format" },
    });
  }
  if (record.version !== SETUP_VERSION) {
    const newer = typeof record.version === "number" && record.version > SETUP_VERSION;
    throw new OpenOutboundError(
      "validation_failed",
      `This setup file has version ${JSON.stringify(record.version)}; this engine reads version ${SETUP_VERSION}.`,
      {
        hint: newer
          ? "It was exported by a newer OpenOutbound: upgrade this engine, then import again."
          : "Export the setup again with manage_workspaces action export_setup.",
        details: { field: "setup.version" },
      },
    );
  }
  const parsed = setupDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "setup"}: ${issue.message}`);
    throw new OpenOutboundError("validation_failed", "The setup file is not valid.", {
      hint: `Fix these and import again: ${issues.join("; ")}.`,
      details: { issues },
    });
  }
  return parsed.data;
}

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function without(value: unknown, keys: readonly string[]): Plain | undefined {
  if (!isPlain(value)) return undefined;
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return Object.keys(copy).length > 0 ? copy : undefined;
}

function setSection(target: Plain, key: string, value: Plain | undefined): void {
  if (value) target[key] = value;
  else delete target[key];
}

/**
 * Settings a setup carries: no sandbox section and no provider settings (brain routing, backup
 * brain, enrichment providers). Client identity (the company section and the booking link) only
 * with `includeCompany`. Locked reply rules are left out: they cannot differ anyway.
 */
export function setupSettings(stored: unknown, options: { includeCompany: boolean }): Plain {
  const settings: Plain = isPlain(stored) ? structuredClone(stored) : {};
  delete settings.sandbox;
  if (!options.includeCompany) {
    delete settings.company;
    setSection(settings, "booking", without(settings.booking, ["default_url"]));
  }
  setSection(settings, "ai", without(settings.ai, ["task_models", "fallback_provider"]));
  if (isPlain(settings.data)) {
    const data = { ...settings.data };
    setSection(data, "enrichment", without(data.enrichment, ["finders", "verifier"]));
    setSection(settings, "data", Object.keys(data).length > 0 ? data : undefined);
  }
  const locked = Object.entries(DEFAULT_REPLY_RULES)
    .filter(([, rule]) => rule.locked)
    .map(([category]) => category);
  setSection(settings, "replies", without(settings.replies, locked));
  return settings;
}

/** Top-level sections of a settings object, sorted. */
export function settingsSections(settings: Plain): string[] {
  return Object.keys(settings).sort();
}
