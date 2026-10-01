/**
 * The LinkedIn side of the `mailbox_down` problem (see email/send-problems.ts): an account that
 * LinkedIn restricted or whose session was lost stops every action until a person acts. Opened
 * when the account moves to that status (never for a pause a person made), resolved when it
 * works again (resume, a reconnect) or is removed. Failed actions record `send_failed` through
 * email/send-problems.ts (`recordSendFailed`), shared by both channels.
 */
import type { OpContext } from "../../core/context.js";
import type { LinkedInAccount } from "../../db/schema/index.js";
import { openSenderDown, type ProblemText, resolveSenderDown } from "../email/send-problems.js";

/** The words of an account's `mailbox_down` problem. */
export function accountDownText(
  account: Pick<LinkedInAccount, "id" | "name">,
  status: "restricted" | "disconnected",
  reason: string,
): ProblemText {
  const id = `(account_id ${account.id})`;
  const words = reason
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/, "")
    .slice(0, 300);
  const title = `LinkedIn account ${account.name ?? account.id} stopped sending`;
  if (status === "restricted") {
    return {
      title,
      reason: `LinkedIn restricted it${words ? `: ${words}` : ""}. Every queued action waits until it is resumed.`,
      remedy: `A person logs in to LinkedIn, completes any check and uses the account by hand for about 7 days, then resumes it with manage_linkedin action resume ${id} (only a person can resume a restricted account).`,
    };
  }
  return {
    title,
    reason: `Its LinkedIn session was lost${words ? `: ${words}` : ""}. Every queued action waits until it is reconnected.`,
    remedy: `Reconnect it with manage_linkedin action connect, then resume it with manage_linkedin action resume ${id}.`,
  };
}

/** Opens (or refreshes) the account's `mailbox_down` problem after a restriction or a lost session. */
export async function openAccountDown(
  ctx: OpContext,
  account: Pick<LinkedInAccount, "id" | "workspace_id" | "name">,
  status: "restricted" | "disconnected",
  reason: string,
): Promise<void> {
  await openSenderDown(
    ctx,
    { id: account.id, workspace_id: account.workspace_id, type: "linkedin_account" },
    accountDownText(account, status, reason),
    { account_id: account.id, name: account.name, status, error: reason.slice(0, 500) },
  );
}

/** Resolves the account's `mailbox_down` problem (it works again, or it was removed). */
export async function resolveAccountDown(
  ctx: OpContext,
  account: Pick<LinkedInAccount, "id" | "workspace_id">,
  resolution: string,
): Promise<void> {
  await resolveSenderDown(ctx, account, resolution);
}
