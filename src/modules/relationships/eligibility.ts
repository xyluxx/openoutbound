/**
 * Eligibility: may this go out now, and if not, why and what fixes it. A read-only answer from
 * the send gate (gate.ts), the same ordered checks the senders make before every email and
 * LinkedIn action, returned without what the sender would do about each blocker. It also says
 * what the relationship view must know: a thread a person took over, a pending approval, an
 * open privacy request and a company hold.
 *
 * Each channel has one ordered list of checks (`EMAIL_CHECKS`, `LINKEDIN_CHECKS`); each check
 * returns blockers with a stable code, plain words, `until`, `fix` and `hard`, from one table of
 * templates (blockers.ts).
 */
import type { OpContext } from "../../core/context.js";
import type { Blocker } from "./blockers.js";
import { EMAIL_CHECKS } from "./checks-email.js";
import { LINKEDIN_CHECKS } from "./checks-linkedin.js";
import type { EligibilityLoader } from "./eligibility-loader.js";
import type { EligibilityInput, EligibilityResult, GateBlocker } from "./eligibility-types.js";
import { evaluateGateMany } from "./gate.js";

export { personName } from "./blockers.js";
export type { EligibilityInput, EligibilityResult } from "./eligibility-types.js";
export { EMAIL_CHECKS, LINKEDIN_CHECKS };

/** A gate blocker as the views show it (without what the sender does about it). */
export function plainBlocker(item: GateBlocker): Blocker {
  return {
    code: item.code,
    message: item.message,
    until: item.until,
    fix: item.fix,
    hard: item.hard,
  };
}

/**
 * Checks whether a message (or a new one) may go out to the person on the channel now, as the
 * sender would decide, and returns every blocker in the sender's order. Read-only.
 */
export async function checkEligibility(
  ctx: OpContext,
  input: EligibilityInput,
): Promise<EligibilityResult> {
  const [result] = await checkEligibilityMany(ctx, [input]);
  return result ?? { ok: true, blockers: [] };
}

/** Several checks with shared, prefetched reads (for lists such as get_next_actions). */
export async function checkEligibilityMany(
  ctx: OpContext,
  inputs: readonly EligibilityInput[],
  options: { loader?: EligibilityLoader } = {},
): Promise<EligibilityResult[]> {
  const results = await evaluateGateMany(ctx, inputs, options);
  return results.map((blockers) => ({
    ok: blockers.length === 0,
    blockers: blockers.map(plainBlocker),
  }));
}
