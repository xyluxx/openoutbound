/**
 * Automation rules on `signal.detected`: filters decide whether a rule fires for a signal,
 * actions say what happens. Stored in `automation_rules` (trigger.filters, actions).
 */
import { z } from "zod";
import { idSchema } from "../../../core/ids.js";
import { signalKeySchema } from "../shapes.js";

export const SIGNAL_DETECTED = "signal.detected";
/** Event the campaigns module handles to enroll people (not in the core event map yet). */
export const ENROLL_REQUESTED = "automation.enroll_requested";

export const MAX_ACTIONS_PER_RULE = 5;
/** Actions run for one signal across every rule (the rest are recorded as skipped). */
export const MAX_ACTIONS_PER_SIGNAL = 20;
export const MAX_PEOPLE_PER_ACTION = 25;
export const DEFAULT_PEOPLE_PER_ACTION = 3;
export const DEFAULT_MAX_FIRES_PER_DAY = 50;

export const automationFiltersInput = z.object({
  definition_keys: z
    .array(signalKeySchema)
    .max(50)
    .optional()
    .describe("Only these signal keys (omit for every key)"),
  min_score: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe("Only signals that scored at least this when detected (0-100)"),
  min_fit: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe("ICP filter: only companies (or people) with fit_score at least this"),
  list_id: idSchema("ls").optional().describe("Only people in this list"),
  has_email: z.boolean().optional().describe("Only people with a usable email address"),
  max_fires_per_day: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe(`Safety cap per rule and UTC day (default ${DEFAULT_MAX_FIRES_PER_DAY})`),
});
export type AutomationFilters = z.infer<typeof automationFiltersInput>;

const maxPeople = z
  .number()
  .int()
  .min(1)
  .max(MAX_PEOPLE_PER_ACTION)
  .optional()
  .describe(
    `People per signal (default ${DEFAULT_PEOPLE_PER_ACTION}); a person-level signal always uses its own person`,
  );

export const automationActionInput = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("notify"),
    severity: z.enum(["info", "warning", "critical"]).optional(),
  }),
  z.object({ type: z.literal("add_to_list"), list_id: idSchema("ls"), max_people: maxPeople }),
  z.object({
    type: z.literal("research"),
    target: z
      .enum(["people", "company", "both"])
      .optional()
      .describe("What to research (default both)"),
    max_people: maxPeople,
  }),
  z.object({
    type: z.literal("webhook"),
    url: z.url({ protocol: /^https?$/ }).max(2000),
    secret: z
      .string()
      .min(16)
      .max(256)
      .optional()
      .describe("Signing secret (OpenOutbound-Signature header); stored in the vault, never shown"),
  }),
  z.object({
    type: z.literal("enroll"),
    campaign_id: idSchema("cmp"),
    max_people: maxPeople,
  }),
  z.object({
    type: z.literal("tag"),
    tag: z.string().trim().min(1).max(60),
    target: z
      .enum(["company", "people", "both"])
      .optional()
      .describe("Where to add the tag (default company)"),
  }),
]);
export type AutomationActionInput = z.infer<typeof automationActionInput>;

/** Stored action shapes (webhook secrets are replaced by a vault reference). */
export type StoredAction =
  | { type: "notify"; severity?: "info" | "warning" | "critical" }
  | { type: "add_to_list"; list_id: string; max_people?: number }
  | { type: "research"; target?: "people" | "company" | "both"; max_people?: number }
  | { type: "webhook"; url: string; secret_id?: string }
  | { type: "enroll"; campaign_id: string; max_people?: number }
  | { type: "tag"; tag: string; target?: "company" | "people" | "both" };

/** Reads filters stored in a rule's trigger, ignoring anything unknown. */
export function readFilters(value: unknown): AutomationFilters {
  const parsed = automationFiltersInput.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
}
