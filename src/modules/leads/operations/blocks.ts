/**
 * Statuses that keep outreach away for good: a person's own wish or the owner's decision. Only a
 * caller with the admin scope lifts them or deletes a record that holds one (an import would
 * bring the person or company back without the block), so an agent asks the human. Setting them
 * stays open to everyone.
 */
import type { OpContext } from "../../../core/context.js";
import { OpenOutboundError } from "../../../core/errors.js";

/** Person statuses only the admin scope lifts. */
export const PERSON_BLOCKS: ReadonlySet<string> = new Set(["do_not_contact", "unsubscribed"]);
/** Company statuses only the admin scope lifts. */
export const COMPANY_BLOCKS: ReadonlySet<string> = new Set(["do_not_contact"]);

/** Whether the caller may lift a block or delete a record that holds one. */
export function mayLiftBlocks(ctx: OpContext): boolean {
  return ctx.principal.scopes.includes("admin");
}

/** The `forbidden` error for lifting a block, naming the command the human runs instead. */
export function blockError(
  message: string,
  command: string,
  details: Record<string, unknown>,
): OpenOutboundError {
  return new OpenOutboundError("forbidden", message, {
    hint: `Only someone with the admin scope can do that. If it is right, ask the human to run: ${command}`,
    details,
  });
}
