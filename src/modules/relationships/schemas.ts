import { z } from "zod";
import { CHANNELS } from "../../core/enums.js";
import { isoDateTime } from "../../core/operation.js";
import { NEXT_ACTION_KINDS } from "./next-action.js";
import { RELATIONSHIP_STATES } from "./relationship.js";

export const blockerSchema = z.object({
  code: z.string().describe("Stable code, e.g. daily_cap_reached or company_on_hold"),
  message: z.string().describe("What blocks it, in plain words"),
  until: isoDateTime().nullable().describe("When it clears by itself; null when it does not"),
  fix: z.string().nullable().describe("The exact tool and action that fixes it, if any"),
  hard: z.boolean().describe("true when waiting will not clear it: someone must act"),
});

export const nextActionSchema = z.object({
  kind: z.enum(NEXT_ACTION_KINDS),
  due_at: isoDateTime().nullable(),
  channel: z.enum(CHANNELS).nullable(),
  campaign_id: z.string().nullable(),
  reason: z.string().describe("What happens next, in plain words"),
  ref: z
    .object({ type: z.string(), id: z.string() })
    .nullable()
    .describe("The record behind it: message, approval, enrollment, task, meeting or opportunity"),
});

export const relationshipViewSchema = z.object({
  person_id: z.string(),
  company_id: z.string().nullable(),
  opportunity_id: z.string().nullable(),
  state: z.enum(RELATIONSHIP_STATES),
  state_since: isoDateTime().nullable(),
  next_action: nextActionSchema.nullable(),
  blockers: z.array(blockerSchema),
  stuck: z.boolean(),
  stuck_reason: z.string().nullable(),
});
