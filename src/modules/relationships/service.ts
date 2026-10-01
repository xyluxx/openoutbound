/**
 * Relationships service: the binding functions other modules call (upgrade plan, "Binding
 * signatures"). Implementations live in focused files of this module.
 */
export type { Blocker } from "./blockers.js";
export { BLOCKER_TEMPLATES, blocker, whenInWords } from "./blockers.js";
export { checkEligibility, checkEligibilityMany } from "./eligibility.js";
export type { EligibilityInput, EligibilityResult } from "./eligibility-types.js";
// The send gate (the senders call it right before every email and LinkedIn action).
export {
  companyHoldKey,
  type EmailGate,
  evaluateEmailGate,
  evaluateLinkedInGate,
  type GateBlocker,
  type GateDisposition,
  type GateInput,
  type GateOptions,
  type LinkedInGate,
} from "./gate.js";
export type { NextAction } from "./next-action.js";
export {
  getRelationship,
  RELATIONSHIP_STATES,
  type RelationshipState,
  type RelationshipView,
} from "./relationship.js";
