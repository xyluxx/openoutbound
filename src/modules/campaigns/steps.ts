import { z } from "zod";
import type { Channel, MessageAction, StepType } from "../../core/enums.js";
import { STEP_TYPES } from "../../core/enums.js";
import { OpenOutboundError } from "../../core/errors.js";
import {
  parseStepConfig,
  type StepConfig,
  type StepConfigInput,
  type StepConfigOf,
  stepConfigSchema,
} from "../../core/settings.js";
import type { CampaignStep } from "../../db/schema/index.js";

export const MAX_STEPS = 30;

/** One step in create/update inputs. `config` is validated against the step type. */
export const stepInput = z.object({
  id: z
    .string()
    .optional()
    .describe(
      "Existing step id (updates only). Keep ids when editing an active campaign so enrollments keep their place.",
    ),
  type: z.enum(STEP_TYPES).describe("Step type"),
  delay_days: z
    .number()
    .int()
    .min(0)
    .max(365)
    .default(0)
    .describe("Days to wait after the previous step (calendar days)"),
  delay_hours: z
    .number()
    .int()
    .min(0)
    .max(23)
    .default(0)
    .describe("Extra hours to wait after the previous step"),
  config: z
    .record(z.string(), z.unknown())
    .default({})
    .describe(
      "Settings for the type. email: { mode: new_thread|reply, style: exact|guided|free, subject, body, instruction, variants: [{ key, subject, body, instruction }], max_words }. linkedin_invite: { note: none|exact|guided|free, text, instruction }. linkedin_message: { style, text, instruction }. linkedin_comment: { instruction, review: always|level }. condition: { if: linkedin_connected|has_email|has_linkedin|signal_present|replied|custom, signal_key, custom_field, custom_value, then_step, else_step }. task: { task_type, title, notes }. webhook: { url, secret_id }. wait, linkedin_visit, linkedin_like: {}.",
    ),
});
export type StepInput = z.input<typeof stepInput>;
type ParsedStepInput = z.output<typeof stepInput>;

/** A validated step ready to store. */
export interface NormalizedStep {
  id?: string;
  type: StepType;
  delay_days: number;
  delay_hours: number;
  /** Stored config (what the user set, plus `type`). */
  config: StepConfigInput;
}

interface StepIssue {
  path: string;
  message: string;
}

/**
 * Validates a whole step list: every config against its type, condition jumps (forward only,
 * at most the step count, which means "finish"), and the step limit. Throws `validation_failed`
 * listing every problem with its path (steps.N.config.field).
 */
export function validateSteps(input: ParsedStepInput[]): NormalizedStep[] {
  const issues: StepIssue[] = [];
  if (input.length === 0) issues.push({ path: "steps", message: "Add at least one step." });
  if (input.length > MAX_STEPS) {
    issues.push({ path: "steps", message: `At most ${MAX_STEPS} steps per campaign.` });
  }
  const out: NormalizedStep[] = [];
  input.forEach((step, position) => {
    const raw = { ...step.config, type: step.type };
    const parsed = stepConfigSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path.map(String).join(".");
        issues.push({
          path: `steps.${position}.config${field ? `.${field}` : ""}`,
          message: issue.message,
        });
      }
      return;
    }
    const config = parsed.data;
    if (config.type === "condition") {
      for (const key of ["then_step", "else_step"] as const) {
        const target = config[key];
        if (target === null) continue;
        if (target <= position || target > input.length) {
          issues.push({
            path: `steps.${position}.config.${key}`,
            message: `Must be a later step position (${position + 1} to ${input.length}; ${input.length} ends the sequence).`,
          });
        }
      }
    }
    if (config.type === "email" && config.variants) {
      const keys = new Set<string>();
      for (const variant of config.variants) {
        if (keys.has(variant.key)) {
          issues.push({
            path: `steps.${position}.config.variants`,
            message: `Duplicate variant key "${variant.key}".`,
          });
        }
        keys.add(variant.key);
      }
    }
    const normalized: NormalizedStep = {
      type: step.type,
      delay_days: step.delay_days,
      delay_hours: step.delay_hours,
      config: raw as StepConfigInput,
    };
    if (step.id !== undefined) normalized.id = step.id;
    out.push(normalized);
  });
  if (issues.length > 0) {
    throw new OpenOutboundError(
      "validation_failed",
      `Invalid steps: ${issues
        .slice(0, 5)
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`,
      {
        hint: "Fix the listed step fields. Use get_campaigns with action templates to see valid step examples.",
        details: { issues },
      },
    );
  }
  return out;
}

/** Wait before a step, in milliseconds. */
export function stepDelayMs(step: Pick<CampaignStep, "delay_days" | "delay_hours">): number {
  return (step.delay_days * 24 + step.delay_hours) * 60 * 60 * 1000;
}

/** Parsed config of a stored step (defaults filled). */
export function stepConfig<T extends StepType>(step: {
  type: T;
  config: unknown;
}): StepConfigOf<T> {
  return parseStepConfig(step.type, step.config);
}

/** Parsed config of a stored step whose type is not narrowed. */
export function anyStepConfig(step: Pick<CampaignStep, "type" | "config">): StepConfig {
  return parseStepConfig(step.type, step.config) as StepConfig;
}

export const LINKEDIN_STEP_TYPES = [
  "linkedin_visit",
  "linkedin_like",
  "linkedin_comment",
  "linkedin_invite",
  "linkedin_message",
] as const satisfies readonly StepType[];
export type LinkedInStepType = (typeof LINKEDIN_STEP_TYPES)[number];

export function isLinkedInStep(type: StepType): type is LinkedInStepType {
  return (LINKEDIN_STEP_TYPES as readonly StepType[]).includes(type);
}

/** Steps that contact the person (and create message rows). */
export function isChannelStep(type: StepType): boolean {
  return type === "email" || isLinkedInStep(type);
}

export function stepChannel(type: StepType): Channel | null {
  if (type === "email") return "email";
  if (isLinkedInStep(type)) return "linkedin";
  return null;
}

const ACTIONS: Partial<Record<StepType, MessageAction>> = {
  email: "email",
  linkedin_visit: "visit",
  linkedin_like: "like",
  linkedin_comment: "comment",
  linkedin_invite: "invite",
  linkedin_message: "message",
};

export function stepAction(type: StepType): MessageAction {
  const action = ACTIONS[type];
  if (!action) throw new Error(`Step type ${type} has no message action`);
  return action;
}

/** True when the step produces text written by the AI (free or guided styles, AI notes). */
export function stepUsesAi(step: Pick<CampaignStep, "type" | "config">): boolean {
  const config = anyStepConfig(step);
  switch (config.type) {
    case "email":
      return config.style !== "exact";
    case "linkedin_invite":
      return config.note === "free" || config.note === "guided";
    case "linkedin_message":
      return config.style !== "exact";
    case "linkedin_comment":
      return true;
    default:
      return false;
  }
}
