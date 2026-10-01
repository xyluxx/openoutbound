/**
 * The one approval rule (spec 2, rule 4). Every gate that can hold a change for a person uses
 * it: campaign launch, mailbox volume increases, posts, strategy changes, replies sent by
 * someone who may not send them alone, lowering a campaign's review level and letting a signal
 * automation enroll people without approval. A setting that switches a gate off switches it
 * off for everyone; this rule only says who passes a gate that is on.
 */
import type { Principal } from "../core/context.js";

/**
 * True when the principal's gated change must wait for an approval: everyone except a human
 * holding the `approve` scope (agent and service keys, the local agent, people without
 * `approve`, and the engine itself). A change a person holding `approve` already approved as a
 * whole (`approvedBy`, set by the engine for approved strategy proposals) is not asked again.
 */
export function mustRequestApproval(
  principal: Pick<Principal, "type" | "scopes" | "approvedBy">,
): boolean {
  if (principal.approvedBy) return false;
  return !(principal.type === "human" && principal.scopes.includes("approve"));
}
