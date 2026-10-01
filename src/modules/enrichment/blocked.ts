/**
 * Screening of addresses found by enrichment before they are verified or stored: system role
 * addresses (noreply@, postmaster@, ...) and suppressed addresses or domains, including the
 * hashed entries a GDPR forget leaves behind, so an erased person's address is never found,
 * verified or saved again.
 */
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { isBlockedRoleAddress } from "../leads/role-address.js";
import {
  findSuppressions,
  suppressionCandidates,
  suppressionReason,
} from "../leads/suppressions.js";

/** role_address, suppressed_email or suppressed_domain; null when the address may be used. */
export async function blockedAddressReason(ctx: OpContext, email: string): Promise<string | null> {
  if (isBlockedRoleAddress(email)) return "role_address";
  const workspace = requireWorkspace(ctx);
  const [hit] = await findSuppressions(ctx.db, workspace.id, suppressionCandidates({ email }));
  return hit ? suppressionReason(hit.type) : null;
}
